/**
 * Doc Tree v1 — 文档级摘要节点
 *
 * 在 Parent-Child 两层结构之上补一层「文档级摘要」节点（RAPTOR-lite 单层版）：
 * - 解决的问题：Parent-Child 只能答「文档某一段讲了什么」，「这份文档整体讲什么」
 *   类全局性问题没有任何 chunk 能命中（没有子块概括全文）
 * - 落地方式：发布到知识库时对全文生成 1 个 chunk_role='summary' 的摘要块，
 *   参与常规向量/BM25 检索；命中后不做 Parent 展开（摘要本身就是高层语义单元）
 * - 检索侧配合：search-knowledge-base 收口段对同文档摘要块做让位去重——
 *   同文档正文块入选时摘要让位，只在「该文档没有任何正文块入选」时保留
 *   （此时正是全局性问题的兜底入口），避免摘要挤占 topK
 *
 * 关键设计决策：
 * 1. 不复用 addDocuments 写摘要块：其 BM25 去重按 source+chunk_index 匹配，
 *    摘要块 flat 切分后 chunk_index=0 会撞掉正文 chunk_index=0 的 BM25 条目，
 *    因此走独立的单块写入（镜像 addImageChunks 模式），chunk_index=-1 哨兵隔离
 * 2. LLM 失败降级为抽取式兜底（正文头部截断），摘要生成永不阻断入库主流程
 * 3. 删除链路零改动：摘要块继承 baseMetadata（documentId/versionId/versionStatus），
 *    removeDocumentVersion 按 versionId 删除时自动连带清理，无需专门处理
 * 4. 总开关 config.docTreeEnabled（默认 false，显式 opt-in），关闭时零行为差异
 */

import { Document } from '@langchain/core/documents';
import { HumanMessage } from '@langchain/core/messages';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { eventBus } from '../event-bus.js';
import { createRateLimitedLLM, buildModelConfig } from '../model-provider.js';
import {
  initializeVectorStore,
  getEmbeddingSemaphore,
  getBM25Index,
  getBM25DocumentStore,
} from './store-state.js';
import {
  initializeBM25Index,
  addToBM25Index,
  saveBM25Index,
} from './bm25-index.js';
import { computeChunkHash } from './vector-crud.js';

// ==================== 常量 ====================

/** 摘要生成模型（速度快、成本低，与查询改写同一档位） */
const SUMMARY_MODEL_ID = 'deepseek:deepseek-v4-flash';

/** LLM 摘要超时（ms）：送入最多 6000 字符，8s 足够；超时走抽取式兜底 */
const SUMMARY_TIMEOUT_MS = 8000;

/** 送入 LLM 的正文截断上限（字符）：防巨型文档撑爆请求；头部信息密度最高 */
export const SUMMARY_SOURCE_MAX_CHARS = 6000;

/** 摘要成品长度上限（字符）：LLM 输出超长时硬截断，保证单块入库 */
export const SUMMARY_MAX_CHARS = 500;

/** 抽取式兜底的正文截取长度（字符） */
export const EXTRACTIVE_FALLBACK_CHARS = 400;

/** 文档最小长度门槛：过短文档（如单条 FAQ）自身已是完整语义单元，摘要纯冗余 */
export const MIN_DOC_CHARS_FOR_SUMMARY = 500;

const MODULE = 'DocSummary';

/** 统一错误信息提取（unknown 收窄，替代 catch err: any 的不安全访问） */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SUMMARY_PROMPT = `你是文档摘要专家。为以下文档生成一段供知识库检索用的摘要，要求：
1. 200-400 字（中文），概括文档的核心主题、关键结论/要点与适用场景
2. 保留文档中的关键术语原文（便于关键词检索命中）
3. 只输出摘要正文，禁止任何前言、标题、编号或解释
4. 信息不足时如实概括已知内容，禁止编造文档中不存在的结论

文档标题：__TITLE__
文档内容（可能截断）：
__CONTENT__`;

// ==================== 纯函数（可单测） ====================

/**
 * 截断送入 LLM 的正文：压缩空白后取头部（头部定主题，信息密度最高）
 * @param text 文档全文
 * @param maxChars 截断上限
 */
export function truncateSummarySource(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars) + '…【后文因超长已省略】';
}

/**
 * 抽取式兜底摘要：LLM 不可用/超时/输出为空时使用
 * 取正文头部原文（不加工不改写，保证零编造）
 * @param title 文档标题（纳入摘要头部，补全局语义）
 * @param text 文档全文
 */
export function extractiveSummaryFallback(title: string, text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return title.trim();
  const body = collapsed.slice(0, EXTRACTIVE_FALLBACK_CHARS);
  const ellipsis = collapsed.length > EXTRACTIVE_FALLBACK_CHARS ? '…' : '';
  const t = title.trim();
  // 标题已含于正文开头时避免重复拼接
  const head = t && !collapsed.startsWith(t) ? `${t}：` : '';
  return `${head}${body}${ellipsis}`.slice(0, SUMMARY_MAX_CHARS);
}

/**
 * 构造摘要块元数据
 *
 * chunk_index=-1 是语义哨兵：标记「非正文切分块」，并避开 addDocuments
 * BM25 去重的 source+chunk_index 匹配维度（正文块 index 从 0 起）
 *
 * @param baseMetadata 入库基础元数据（documentId/versionId/versionStatus/source/fileType）
 * @param summaryText 摘要正文（用于内容级 hash）
 */
export function buildSummaryChunkMetadata(
  baseMetadata: Record<string, unknown>,
  summaryText: string,
): Record<string, unknown> {
  return {
    ...baseMetadata,
    chunk_index: -1,
    doc_type: 'summary',
    chunk_role: 'summary',
    chunk_hash: computeChunkHash(summaryText),
  };
}

// ==================== LLM 摘要生成 ====================

/**
 * 生成摘要文本：LLM 优先，失败降级抽取式兜底（永不抛出）
 * @returns summary 摘要文本；byLLM 是否由 LLM 生成（可观测降级率）
 */
export async function generateSummaryText(
  title: string,
  docText: string,
): Promise<{ summary: string; byLLM: boolean }> {
  const source = truncateSummarySource(docText, SUMMARY_SOURCE_MAX_CHARS);
  // 替换串必须用函数形式：标题/正文含 $&、$' 等 $ 模式时，字符串替换会被
  // 特殊解释导致 prompt 污染（query-rewriter 同款问题的防御）
  const prompt = SUMMARY_PROMPT.replace('__TITLE__', () => title).replace(
    '__CONTENT__',
    () => source,
  );

  try {
    const modelConfig = buildModelConfig(SUMMARY_MODEL_ID, {
      isFCMode: false,
    });
    modelConfig.temperature = 0.2;
    const llm = createRateLimitedLLM(modelConfig, 'fast');

    // AbortSignal.timeout 真取消在途请求（与 query-rewriter 同款：防幽灵负载占住令牌桶）
    const signal = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
    const result = await llm.invoke([new HumanMessage(prompt)], { signal });
    const raw = typeof result.content === 'string' ? result.content.trim() : '';

    if (!raw) {
      logger.warn('LLM 摘要输出为空，降级抽取式兜底', {
        module: MODULE,
        title: title.substring(0, 80),
      });
      return {
        summary: extractiveSummaryFallback(title, docText),
        byLLM: false,
      };
    }

    return { summary: raw.slice(0, SUMMARY_MAX_CHARS), byLLM: true };
  } catch (err) {
    logger.warn('LLM 摘要生成失败，降级抽取式兜底', {
      module: MODULE,
      title: title.substring(0, 80),
      error: errMsg(err),
    });
    return { summary: extractiveSummaryFallback(title, docText), byLLM: false };
  }
}

// ==================== 摘要块写入 ====================

/**
 * 删除该文档已有的旧摘要块（幂等去重）
 *
 * 去重维度：documentId + chunk_role='summary'（不用 versionId——
 * 与图片块去重同理：跨版本重发/重试场景下旧版本摘要可能残留）
 * 同时清理 ChromaDB 与 BM25 索引；单侧失败不影响另一侧
 */
async function deduplicateSummaryChunks(
  store: Awaited<ReturnType<typeof initializeVectorStore>>,
  documentId: string,
): Promise<void> {
  // 1. ChromaDB：查询并删除旧摘要块
  try {
    const collection = store.collection;
    if (collection) {
      const existing = await collection.get({
        where: { $and: [{ documentId }, { chunk_role: 'summary' }] },
      });
      if (existing.ids.length > 0) {
        await collection.delete({ ids: existing.ids });
        logger.debug('已删除旧摘要块（ChromaDB）', {
          module: MODULE,
          documentId,
          deleted: existing.ids.length,
        });
      }
    }
  } catch (err) {
    logger.warn('ChromaDB 旧摘要块清理失败（不影响本次入库）', {
      module: MODULE,
      documentId,
      error: errMsg(err),
    });
  }

  // 2. BM25 索引：按元数据匹配删除
  try {
    await initializeBM25Index();
    // getBM25Index 返回值未细化类型，此处收窄到本函数用到的最小接口
    const bm25Index = getBM25Index() as { remove: (id: string) => void } | null;
    const bm25DocumentStore = getBM25DocumentStore();
    if (bm25Index) {
      const idsToRemove: string[] = [];
      for (const [id, doc] of bm25DocumentStore.entries()) {
        // BM25 doc store 元数据未细化类型，收窄到本判定用到的字段
        const meta = doc?.metadata as
          | { chunk_role?: unknown; documentId?: unknown }
          | undefined;
        if (meta?.chunk_role === 'summary' && meta?.documentId === documentId) {
          idsToRemove.push(id);
        }
      }
      for (const id of idsToRemove) {
        try {
          bm25Index.remove(id);
          bm25DocumentStore.delete(id);
        } catch {
          // 旧条目可能已不存在，忽略
        }
      }
      if (idsToRemove.length > 0) {
        await saveBM25Index();
        logger.debug('已删除旧摘要块（BM25）', {
          module: MODULE,
          documentId,
          deleted: idsToRemove.length,
        });
      }
    }
  } catch (err) {
    logger.warn('BM25 旧摘要块清理失败（不影响本次入库）', {
      module: MODULE,
      documentId,
      error: errMsg(err),
    });
  }
}

/**
 * 为文档生成并入库 1 个摘要块（Doc Tree v1 入库侧入口）
 *
 * 调用时机：publishToVectorStore 正文入库成功之后（图片块入库流程同级）。
 * 整体永不抛出：任何失败只记日志并返回 false，绝不阻断文档发布主流程。
 *
 * @param baseMetadata 入库基础元数据（与正文块同源，含 documentId/versionId/
 *                     versionStatus/source/fileType，继承版本过滤与删除联动）
 * @param title 文档标题
 * @param docText 文档全文（发布正文，与入库切块同源）
 * @returns true=摘要块已入库；false=跳过（开关关闭/文本过短/生成或写入失败）
 */
export async function addDocSummaryChunk(
  baseMetadata: Record<string, unknown>,
  title: string,
  docText: string,
): Promise<boolean> {
  // 开关关闭：直接跳过（零行为差异）
  if (!config.docTreeEnabled) return false;

  const documentId =
    typeof baseMetadata?.documentId === 'string' ? baseMetadata.documentId : '';
  if (!documentId) {
    logger.warn('摘要块入库跳过：baseMetadata 缺少 documentId', {
      module: MODULE,
    });
    return false;
  }

  // 过短文档跳过：自身已是完整语义单元，摘要纯冗余且浪费一次 LLM 调用
  if (!docText || docText.trim().length < MIN_DOC_CHARS_FOR_SUMMARY) {
    logger.debug('摘要块入库跳过：文档过短', {
      module: MODULE,
      documentId,
      textLength: docText?.length ?? 0,
      threshold: MIN_DOC_CHARS_FOR_SUMMARY,
    });
    return false;
  }

  try {
    // 1. 生成摘要（LLM 优先，兜底永不失败）
    const { summary, byLLM } = await generateSummaryText(title, docText);
    if (!summary.trim()) {
      logger.warn('摘要文本为空（含兜底），跳过入库', {
        module: MODULE,
        documentId,
      });
      return false;
    }

    const store = await initializeVectorStore();

    // 2. 幂等去重：清理旧摘要块（重发/重试场景）
    await deduplicateSummaryChunks(store, documentId);

    // 3. 构造单块 Document（继承 baseMetadata：版本过滤/删除联动自动生效）
    const metadata = buildSummaryChunkMetadata(baseMetadata, summary);
    const doc = new Document({ pageContent: summary, metadata });

    // 4. 写入 ChromaDB（信号量保护，与 addDocuments/addImageChunks 一致；
    //    单块不需要批量降级逻辑，一次失败即整体失败返回 false）
    const semaphore = getEmbeddingSemaphore();
    const callerId = await semaphore.acquire('addDocSummary');
    let added = false;
    try {
      await store.addDocuments([doc]);
      added = true;
    } finally {
      semaphore.release(callerId);
    }

    // 5. 写入 BM25 索引（失败不影响 ChromaDB 已入库的事实）
    try {
      await initializeBM25Index();
      const id = `summary_${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${documentId}`;
      await addToBM25Index(id, summary, metadata, true);
      await saveBM25Index();
    } catch (bm25Error) {
      logger.warn('摘要块 BM25 索引添加失败，不影响主流程', {
        module: MODULE,
        documentId,
        error: errMsg(bm25Error),
      });
    }

    // 6. 通知缓存：知识库已更新
    eventBus.emit('knowledge-base-updated', '文档摘要节点添加');

    logger.info('文档摘要节点入库成功', {
      module: MODULE,
      documentId,
      versionId: baseMetadata?.versionId,
      summaryLength: summary.length,
      byLLM,
    });
    return added;
  } catch (error) {
    logger.warn('摘要块入库失败（不影响文档发布主流程）', {
      module: MODULE,
      documentId,
      error: errMsg(error),
      errorStack:
        error instanceof Error ? error.stack?.substring(0, 300) : undefined,
    });
    return false;
  }
}
