/**
 * 飞书富产物同步工具
 *
 * 背景：AI 回复里除了纯文本和 Markdown 图片，还可能包含三类"非文本产物"：
 *   1. ```echarts``` 代码块  —— generate_chart 生成的交互式图表
 *   2. ```mermaid``` 代码块  —— create_mindmap 生成的思维导图
 *   3. generate_document 生成的 PDF/Word/HTML/MD —— 不在正文里，存 generated_document 表
 *
 * 这些产物在飞书 text/lark_md 里会显示成"一大段代码 / 链接"，体验很差。
 * 本模块把它们统一转成飞书原生消息：
 *   - 图表/思维导图：用 puppeteer 渲染 PNG → uploadImage → image 消息
 *   - 文档：从持久化服务读 buffer → uploadFile → file 消息
 *
 * Web→飞书同步（chat.controller）和飞书入站回复（feishu-event-processor）共用此模块，
 * 避免两处各写一遍、正则与发送逻辑漂移。
 */

import { createHash } from 'crypto';
import { logger } from '../logger.js';
import { getRedis, isRedisReady } from '../redis-client.js';
import {
  uploadImage,
  uploadFile,
  sendImageMessage,
  sendFileMessage,
  type FeishuReceiveIdType,
} from '../feishu-notify.service.js';

/**
 * 懒加载图表/思维导图 PNG 渲染器。
 * multimodal-output 依赖 puppeteer（ESM），静态 import 会拖垮单测的模块加载，
 * 改为动态 import：只有真正需要渲染时才加载，单测无需引入 puppeteer。
 *
 * 暴露 __setRenderersForTest 作为测试注入点，避免单测被动态 import 的 ESM 解析卡住。
 */
type Renderers = {
  chartPngDataUri: (option: Record<string, any>) => Promise<string | null>;
  mindmapPngDataUri: (code: string) => Promise<string | null>;
};

let renderersOverride: Renderers | null = null;

async function loadRenderers(): Promise<Renderers> {
  if (renderersOverride) return renderersOverride;
  const mod = await import('../tools/multimodal-output.js');
  return { chartPngDataUri: mod.chartPngDataUri, mindmapPngDataUri: mod.mindmapPngDataUri };
}

/** 仅测试用：注入渲染器，避免动态 import puppeteer */
export function __setRenderersForTest(r: Renderers | null): void {
  renderersOverride = r;
}

/** ```echarts``` 代码块正则（单一来源，供提取与剥离共用） */
const ECHARTS_BLOCK_REGEX = /```echarts\s*\n([\s\S]*?)```/g;
/** ```mermaid``` 代码块正则 */
const MERMAID_BLOCK_REGEX = /```mermaid\s*\n([\s\S]*?)```/g;

export interface ExtractedAssets {
  /** 剥离图表/思维导图代码块后的纯文本（图片由调用方另行处理） */
  text: string;
  /** 图表的 ECharts option 原始 JSON 字符串 */
  charts: string[];
  /** 思维导图的 mermaid 源码 */
  mindmaps: string[];
}

/**
 * 从 assistant 文本里提取图表/思维导图代码块，并返回去掉这些代码块后的文本。
 * 注意：Markdown 图片不在这里处理，仍由 feishu-markdown-image 负责。
 */
export function extractRichAssets(content: string): ExtractedAssets {
  const charts: string[] = [];
  const mindmaps: string[] = [];

  let text = content.replace(ECHARTS_BLOCK_REGEX, (_m, code: string) => {
    charts.push(code.trim());
    return '';
  });
  text = text.replace(MERMAID_BLOCK_REGEX, (_m, code: string) => {
    mindmaps.push(code.trim());
    return '';
  });
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { text, charts, mindmaps };
}

/** 把 data:image/png;base64,xxx 转成 Buffer */
function dataUriToBuffer(dataUri: string): Buffer | null {
  const match = /^data:[^;]+;base64,(.+)$/.exec(dataUri);
  if (!match) return null;
  return Buffer.from(match[1], 'base64');
}

/** 文档产物（来自 generated_document 表 / GeneratedDocumentService） */
export interface AssetDocument {
  key: string;
  filename: string;
  /** 文件二进制；调用方从持久化服务读出后传入 */
  buffer: Buffer;
}

/** 文档"已同步飞书"去重窗口：同一文档不重复发，覆盖时间窗口竞态与重试 */
const DOC_SENT_TTL_SEC = 24 * 60 * 60;
const DOC_SENT_KEY_PREFIX = 'feishu:doc-sent:';
const localDocSent = new Map<string, number>();
const LOCAL_DOC_SENT_MAX = 500;

/**
 * 标记某会话的某文档已同步过飞书；返回 true 表示这是首次（应发送），false 表示已发过（跳过）。
 * Redis 用 SETNX + TTL；Redis 不可用时降级到进程内 Map（简化 LRU）。
 */
async function markDocSentOnce(sessionId: string, docKey: string): Promise<boolean> {
  const id = `${sessionId}:${docKey}`;
  if (isRedisReady()) {
    try {
      const redis = getRedis();
      if (redis) {
        const ok = await redis.set(`${DOC_SENT_KEY_PREFIX}${id}`, '1', 'EX', DOC_SENT_TTL_SEC, 'NX');
        return ok === 'OK';
      }
    } catch {
      // 落到本地降级
    }
  }
  const now = Date.now();
  if (localDocSent.has(id)) return false;
  if (localDocSent.size >= LOCAL_DOC_SENT_MAX) {
    const oldestKey = localDocSent.keys().next().value;
    if (oldestKey !== undefined) localDocSent.delete(oldestKey);
  }
  localDocSent.set(id, now);
  return true;
}

/** 仅测试用：重置本地文档去重 */
export function __resetDocSentForTest(): void {
  localDocSent.clear();
}

export interface SyncRichAssetsParams {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  charts: string[];
  mindmaps: string[];
  documents: AssetDocument[];
  /** 幂等基线：同一条消息派生稳定前缀，避免重试发重复（飞书 uuid 仅 [0-9a-zA-Z]，≤50） */
  idempotencyBase: string;
  /** 日志用：会话标识 */
  sessionId: string;
}

/**
 * 把图表/思维导图/文档统一同步为飞书原生消息。
 * 单条产物失败只 warn 不抛，避免一个产物失败拖垮整条消息同步。
 */
export async function syncRichAssetsToFeishu(params: SyncRichAssetsParams): Promise<void> {
  const { receiveId, receiveIdType, charts, mindmaps, documents, idempotencyBase, sessionId } = params;

  const derive = (kind: string, idx: number): string =>
    createHash('md5').update(`${idempotencyBase}|${kind}|${idx}`).digest('hex');

  // 仅当存在图表/思维导图时才加载渲染器（避免无谓引入 puppeteer）
  const renderers = charts.length > 0 || mindmaps.length > 0 ? await loadRenderers() : null;

  // 1) 图表 → PNG → image 消息
  for (let i = 0; i < charts.length; i++) {
    try {
      const option = JSON.parse(charts[i]);
      const dataUri = await renderers!.chartPngDataUri(option);
      const buffer = dataUri ? dataUriToBuffer(dataUri) : null;
      if (!buffer) {
        logger.warn('飞书图表同步：PNG 渲染失败，跳过', { module: 'FeishuAssetSync', sessionId, index: i });
        continue;
      }
      await uploadAndSendImage(receiveId, receiveIdType, buffer, derive('chart', i), sessionId, '图表');
    } catch (e: any) {
      logger.warn('飞书图表同步：异常，跳过', {
        module: 'FeishuAssetSync',
        sessionId,
        index: i,
        error: (e?.message || String(e)).slice(0, 200),
      });
    }
  }

  // 2) 思维导图 → PNG → image 消息
  for (let i = 0; i < mindmaps.length; i++) {
    try {
      const dataUri = await renderers!.mindmapPngDataUri(mindmaps[i]);
      const buffer = dataUri ? dataUriToBuffer(dataUri) : null;
      if (!buffer) {
        logger.warn('飞书思维导图同步：PNG 渲染失败，跳过', { module: 'FeishuAssetSync', sessionId, index: i });
        continue;
      }
      await uploadAndSendImage(receiveId, receiveIdType, buffer, derive('mindmap', i), sessionId, '思维导图');
    } catch (e: any) {
      logger.warn('飞书思维导图同步：异常，跳过', {
        module: 'FeishuAssetSync',
        sessionId,
        index: i,
        error: (e?.message || String(e)).slice(0, 200),
      });
    }
  }

  // 3) 文档 → file 消息
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    try {
      // 去重：同一会话同一文档只同步一次，避免"最近 N 分钟"时间窗口把旧文档重复发出
      const firstTime = await markDocSentOnce(sessionId, doc.key);
      if (!firstTime) {
        logger.info('飞书文档同步：该文档已同步过，跳过', {
          module: 'FeishuAssetSync',
          sessionId,
          filename: doc.filename,
        });
        continue;
      }
      const uploadResult = await uploadFile(`fc://document/${doc.key}`, doc.filename, doc.buffer);
      if (!uploadResult.success || !uploadResult.key) {
        logger.warn('飞书文档同步：上传失败，跳过', {
          module: 'FeishuAssetSync',
          sessionId,
          filename: doc.filename,
          error: uploadResult.error,
        });
        continue;
      }
      const sendResult = await sendFileMessage(receiveId, receiveIdType, uploadResult.key, derive('doc', i));
      if (sendResult.success) {
        logger.info('飞书文档同步：发送成功', {
          module: 'FeishuAssetSync',
          sessionId,
          filename: doc.filename,
          messageId: sendResult.messageId,
        });
      } else {
        logger.warn('飞书文档同步：发送失败', {
          module: 'FeishuAssetSync',
          sessionId,
          filename: doc.filename,
          error: sendResult.error,
        });
      }
    } catch (e: any) {
      logger.warn('飞书文档同步：异常，跳过', {
        module: 'FeishuAssetSync',
        sessionId,
        filename: doc.filename,
        error: (e?.message || String(e)).slice(0, 200),
      });
    }
  }
}

/** 上传 PNG buffer 并发送 image 消息 */
async function uploadAndSendImage(
  receiveId: string,
  receiveIdType: FeishuReceiveIdType,
  buffer: Buffer,
  uuid: string,
  sessionId: string,
  label: string,
): Promise<void> {
  const uploadResult = await uploadImage('', buffer);
  if (!uploadResult.success || !uploadResult.key) {
    logger.warn(`飞书${label}同步：上传失败，跳过`, {
      module: 'FeishuAssetSync',
      sessionId,
      error: uploadResult.error,
    });
    return;
  }
  const sendResult = await sendImageMessage(receiveId, receiveIdType, uploadResult.key, uuid);
  if (sendResult.success) {
    logger.info(`飞书${label}同步：发送成功`, {
      module: 'FeishuAssetSync',
      sessionId,
      messageId: sendResult.messageId,
    });
  } else {
    logger.warn(`飞书${label}同步：发送失败`, {
      module: 'FeishuAssetSync',
      sessionId,
      error: sendResult.error,
    });
  }
}
