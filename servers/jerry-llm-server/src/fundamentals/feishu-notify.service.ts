/**
 * 飞书通知服务 —— 集中管理飞书通道的素材上传、卡片发送、卡片更新
 *
 * 设计目标：
 *   将 send-notification.ts 中飞书通道的 API 调用逻辑抽离为独立服务，
 *   供 send_notification 工具、HITL 确认、事件回调等多处复用。
 *
 * 职责：
 *   1. tenant_access_token 缓存（复用 send-notification 的内存缓存策略）
 *   2. 图片上传（image/v1/images）→ 返回 image_key
 *   3. 文件上传（file/v1/files）→ 返回 file_key
 *   4. 发送互动卡片消息（msg_type=interactive）替代纯文本 post
 *   5. 更新已发送卡片（card/v1/update）→ 实现卡片状态机
 *   6. 构建飞书卡片 JSON 模板
 */

import { config } from './config';
import { logger } from './logger';
import { getRedis, isRedisReady } from './redis-client';
import { deliverWithRetry, registerRetryHandler, retryDeadLetters, type FeishuApiResult, type DeadLetterEntry } from './feishu-delivery.js';
import crypto from 'crypto';

// 注：飞书 App ID / Secret / 域名等配置项通过函数内访问 config.notify，
// 而不是在模块顶层 destructure。这样可以延迟到首次调用时再触发 config 解析，
// 避免单元测试场景下因为顶层导入触发 fail-fast（JWT_SECRET 缺失）。

// ==================== 配置常量 ====================

/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 15000;

/** 飞书 / Lark API 域名 */
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const LARK_API_BASE = 'https://open.larksuite.com/open-apis';

/**
 * 飞书 tenant_access_token 两级缓存（F2 模块升级）
 *
 * L1 进程内 Map：纳秒级读取，命中后直接返回
 * L2 Redis（带降级）：水平扩展时多实例共享同一份 token，避免每个实例独立换 token，
 *                     减轻飞书 OpenAPI 调用压力（限流 / 配额 / 单点故障半径）
 * 单飞（single-flight）：同进程内对同一 cacheKey 的并发请求共享同一个 Promise，
 *                       防止冷启动瞬间的 Token 接口击穿
 *
 * Redis 不可用时静默降级到 L1 + 远端拉取，业务零感知。
 */
const tenantTokenCache = new Map<string, { token: string; expiresAt: number }>();
const inflightTokenRequests = new Map<string, Promise<string>>();

/** Redis 中保存 tenant_access_token 的 key 前缀（与全局 keyPrefix 拼接） */
const REDIS_TOKEN_KEY_PREFIX = 'feishu:tenant_token:';

// ==================== 类型定义 ====================

/** 飞书卡片按钮定义 */
export interface FeishuCardButton {
  text: string;
  value: Record<string, string>;
  type?: 'primary' | 'default' | 'danger';
}

/** 飞书卡片模板参数 */
export interface FeishuCardTemplate {
  title: string;
  content: string;
  headerColor?: 'blue' | 'red' | 'green' | 'yellow' | 'grey';
  imageKey?: string;
  fields?: Array<{ label: string; value: string }>;
  buttons?: FeishuCardButton[];
  /** 卡片更新时需要传 cardId，首次发送无需传 */
  cardId?: string;
  /** 消息去重 key（幂等） */
  uuid?: string;
}

/** 发送消息通用返回 */
export interface FeishuSendResult {
  success: boolean;
  messageId?: string;
  cardId?: string;
  error?: string;
}

/** 上传素材返回 */
export interface FeishuUploadResult {
  success: boolean;
  key?: string;
  error?: string;
}

/** 接收人 ID 类型 */
export type FeishuReceiveIdType = 'email' | 'open_id' | 'user_id' | 'chat_id';

// ==================== Token 管理 ====================

/** 获取 API 域名 */
function getApiBase(): string {
  return (config.notify.feishuDomain || '').toLowerCase().includes('larksuite')
    ? LARK_API_BASE
    : FEISHU_API_BASE;
}

/** 获取飞书 tenant_access_token，5 分钟内复用缓存
 *
 * 读取顺序：L1 进程内 Map → L2 Redis → 远端飞书 OpenAPI
 * 写入策略：远端拿到后同时回填 L1 + L2，L2 失败不阻塞
 * 并发保护：同进程内对同一 cacheKey 的并发请求共享同一个 Promise（单飞）
 */
async function getTenantToken(): Promise<string> {
  const appId = config.notify.feishuAppId;
  const appSecret = config.notify.feishuAppSecret;
  const apiBase = getApiBase();
  const cacheKey = `${apiBase}:${appId}`;

  // L1：进程内缓存
  const cached = tenantTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // 单飞：同 cacheKey 的并发请求共享同一个 Promise，避免冷启瞬间击穿
  const existing = inflightTokenRequests.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      // L2：Redis 共享缓存（多实例部署时同一 App 复用同一份 token）
      const fromRedis = await readTokenFromRedis(cacheKey);
      if (fromRedis) {
        tenantTokenCache.set(cacheKey, fromRedis);
        return fromRedis.token;
      }

      // L3：远端拉取
      const fresh = await fetchTokenFromFeishu(apiBase, appId, appSecret);
      tenantTokenCache.set(cacheKey, fresh);
      // L2 回填：失败仅降级，不影响主流程
      void writeTokenToRedis(cacheKey, fresh).catch(() => {});
      return fresh.token;
    } finally {
      inflightTokenRequests.delete(cacheKey);
    }
  })();

  inflightTokenRequests.set(cacheKey, promise);
  return promise;
}

/** 远端拉取 tenant_access_token */
async function fetchTokenFromFeishu(
  apiBase: string,
  appId: string,
  appSecret: string,
): Promise<{ token: string; expiresAt: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: ctrl.signal,
    });
    const data = (await resp.json()) as {
      code: number;
      msg: string;
      tenant_access_token: string;
      expire: number;
    };
    if (data.code !== 0) {
      throw new Error(`飞书获取 token 失败：${data.msg}`);
    }
    // 提前 5 分钟过期，规避 NTP 误差和网络抖动
    return {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire - 300) * 1000,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 Redis 读取 tenant_access_token
 * 任何异常都视为缓存未命中并降级，不抛错
 */
async function readTokenFromRedis(
  cacheKey: string,
): Promise<{ token: string; expiresAt: number } | null> {
  const redis = getRedis();
  if (!redis || !isRedisReady()) return null;
  const key = `${REDIS_TOKEN_KEY_PREFIX}${cacheKey}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token: string; expiresAt: number };
    if (!parsed.token || !parsed.expiresAt) return null;
    // Redis 端虽然有 EXPIRE 兜底，但本地再校验一次时间，防止时钟漂移
    if (parsed.expiresAt <= Date.now()) return null;
    return parsed;
  } catch (e: any) {
    logger.warn('飞书 token L2 缓存读取失败，降级到远端拉取', {
      module: 'FeishuNotify:TokenCache',
      err: (e?.message || String(e)).slice(0, 200),
    });
    return null;
  }
}

/**
 * 把 tenant_access_token 写入 Redis
 * TTL 与 expiresAt 对齐，Redis 端到期自动清理；失败仅 warn 不抛
 */
async function writeTokenToRedis(
  cacheKey: string,
  entry: { token: string; expiresAt: number },
): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisReady()) return;
  const key = `${REDIS_TOKEN_KEY_PREFIX}${cacheKey}`;
  const ttlMs = entry.expiresAt - Date.now();
  if (ttlMs <= 0) return;
  try {
    // PX = 毫秒级 TTL，避免秒级取整带来的早过期
    await redis.set(key, JSON.stringify(entry), 'PX', ttlMs);
  } catch (e: any) {
    logger.warn('飞书 token L2 缓存写入失败，仅 L1 生效', {
      module: 'FeishuNotify:TokenCache',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

// ==================== 素材上传 ====================

/** 下载文件二进制内容 */
async function downloadFile(url: string): Promise<Buffer | null> {
  // 内部协议 fc://mindmap/xxx 和 fc://document/xxx 的处理
  // 这些由调用方在 send-notification 中先解析成 base64 再传入
  if (url.startsWith('fc://')) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 上传图片到飞书素材库
 * POST /im/v1/images
 * 返回 image_key，用于后续发送图片消息
 *
 * 注意：飞书图片消息有两种方式：
 *   1. 上传素材 → 拿 image_key → 发 msg_type=image 消息（本函数）
 *   2. 把图片 URL 嵌入卡片 header 的 img_key 字段（卡片格式）
 * 本函数实现方式 1，方式 2 在 buildCardJson 中处理
 */
export async function uploadImage(
  imageUrl: string,
  imageBinary?: Buffer,
): Promise<FeishuUploadResult> {
  const token = await getTenantToken();
  const apiBase = getApiBase();

  let buffer: Buffer | undefined = imageBinary;
  if (!buffer) {
    const downloaded = await downloadFile(imageUrl);
    if (!downloaded) {
      return { success: false, error: '无法下载图片文件' };
    }
    buffer = downloaded;
  }

  // 飞书要求上传图片的 Content-Type 为 multipart/form-data
  const formData = new FormData();
  formData.append('image_type', 'message');
  // 将 Buffer 转为 Uint8Array → Blob，规避 SharedArrayBuffer 类型冲突
  const blob = new Blob([new Uint8Array(buffer)]);
  formData.append('image', blob, 'image.png');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(`${apiBase}/im/v1/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // 不要手动设置 Content-Type，让浏览器/Node 自动生成带 boundary 的 multipart/form-data
      },
      body: formData,
      signal: ctrl.signal,
    });
    const data = (await resp.json()) as {
      code: number;
      msg: string;
      data?: { image_key: string };
    };
    if (data.code !== 0) {
      return { success: false, error: `图片上传失败: ${data.msg}` };
    }
    return { success: true, key: data.data?.image_key };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 根据文件名后缀推断飞书 file_type。
 *
 * 飞书 `/im/v1/files` 接口的 file_type 是枚举：opus/mp4/pdf/doc/docx/xls/xlsx/ppt/pptx/stream。
 * 之前固定传 'stream' 会导致手机端文件没有后缀、无法识别类型（PDF 显示成无后缀的文件）。
 * 这里按文件名后缀映射到对应类型，其他类型回退到 'stream'。
 */
function inferFeishuFileType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const supported = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4', 'opus'];
  return supported.includes(ext) ? ext : 'stream';
}

/**
 * 上传文件到飞书素材库
 * POST /im/v1/files
 * 返回 file_key，用于后续发送文件消息
 */
export async function uploadFile(
  fileUrl: string,
  filename: string,
  fileBinary?: Buffer,
): Promise<FeishuUploadResult> {
  const token = await getTenantToken();
  const apiBase = getApiBase();

  let buffer: Buffer | undefined = fileBinary;
  if (!buffer) {
    const downloaded = await downloadFile(fileUrl);
    if (!downloaded) {
      return { success: false, error: '无法下载文件' };
    }
    buffer = downloaded;
  }

  const formData = new FormData();
  // 按后缀传飞书识别的 file_type，让手机端能展示文件图标和后缀
  formData.append('file_type', inferFeishuFileType(filename));
  formData.append('file_name', filename);
  const blob = new Blob([new Uint8Array(buffer)]);
  formData.append('file', blob, filename);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(`${apiBase}/im/v1/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
      signal: ctrl.signal,
    });
    const data = (await resp.json()) as {
      code: number;
      msg: string;
      data?: { file_key: string };
    };
    if (data.code !== 0) {
      return { success: false, error: `文件上传失败: ${data.msg}` };
    }
    return { success: true, key: data.data?.file_key };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 卡片构建 ====================

/**
 * 构建飞书互动卡片 JSON
 *
 * 卡片结构：
 *   config          — 全局设置（宽屏模式）
 *   header.title    — 标题（纯文本）+ 颜色模板
 *   elements[]      — 正文（lark_md）、附件列表（fields）、按钮（actions）
 *   若指定 cardId   — 则输出更新卡片格式（仅 elements + header）
 */
export function buildCardJson(params: FeishuCardTemplate): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  // 正文：使用 lark_md 标签，支持 Markdown 子集（加粗、斜体、链接、代码块）
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: params.content || '（无正文）',
    },
  });

  // 附件 / 字段列表
  if (params.fields && params.fields.length > 0) {
    elements.push({ tag: 'hr' });
    for (const field of params.fields) {
      elements.push({
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**${field.label}**` } },
          { is_short: true, text: { tag: 'lark_md', content: field.value } },
        ],
      });
    }
  }

  // 按钮
  if (params.buttons && params.buttons.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: params.buttons.map((btn) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: btn.text },
        type: btn.type || 'default',
        value: btn.value,
      })),
    });
  }

  // 卡片头部
  const header: Record<string, unknown> = {
    title: { tag: 'plain_text', content: params.title },
  };
  if (params.headerColor) {
    header.template = params.headerColor;
  } else {
    header.template = 'blue';
  }

  // 如果指定了 cardId，返回更新卡片格式（仅 elements + header）
  if (params.cardId) {
    return { elements, header };
  }

  // 否则返回完整卡片
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    header,
    elements,
  };

  // 图片封面（使用已上传的 image_key）
  if (params.imageKey) {
    card.header = {
      ...header,
      ud_icon: {
        tag: 'img_v2',
        img_key: params.imageKey,
      },
    };
  }

  return card;
}

// ==================== 消息发送 ====================

/** 推断接收人 ID 类型 */
export function detectReceiveIdType(id: string): FeishuReceiveIdType {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return 'email';
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('oc_')) return 'chat_id';
  return 'user_id';
}

// ==================== 邮箱反查 open_id（C1）====================

/**
 * 邮箱 → open_id 缓存（LRU 简化版：Map 自带插入顺序）
 * - 命中：直接返回 open_id
 * - 未命中：调 `contact/v3/users/batch_get_id` 反查
 * - 上限 500 条，超出移除最早插入项
 * - TTL 1 小时（飞书租户内邮箱-open_id 几乎不变，但保留过期保险）
 */
const EMAIL_TO_OPENID_CACHE_MAX = 500;
const EMAIL_TO_OPENID_TTL_MS = 60 * 60 * 1000;
const emailToOpenIdCache = new Map<string, { openId: string; expiresAt: number }>();

/** 内部：缓存写入（带 LRU 淘汰） */
function setEmailCache(email: string, openId: string): void {
  if (emailToOpenIdCache.size >= EMAIL_TO_OPENID_CACHE_MAX) {
    const firstKey = emailToOpenIdCache.keys().next().value;
    if (firstKey) emailToOpenIdCache.delete(firstKey);
  }
  emailToOpenIdCache.set(email, {
    openId,
    expiresAt: Date.now() + EMAIL_TO_OPENID_TTL_MS,
  });
}

/**
 * 通过邮箱反查飞书 open_id
 *
 * 使用场景：
 *   - 邮箱直发飞书消息失败（飞书侧未识别该邮箱）时的兜底
 *   - 调用方拿到 open_id 后用 `receive_id_type=open_id` 重发即可
 *
 * 飞书 API：POST /contact/v3/users/batch_get_id?user_id_type=open_id
 *   body: { emails: ["a@b.com", ...] }
 *   resp: { code, data: { user_list: [{ email, user_id }] } }
 *     - user_id 字段在 user_id_type=open_id 时返回的就是 open_id
 *
 * 注意：本接口需要应用拥有 `contact:user.email:readonly` 权限
 * （这是用户视角"邮箱发不出去"时的备份能力，非必需权限）
 *
 * @returns open_id；如果飞书查不到该邮箱（用户不在租户内）则返回 null
 */
export async function resolveOpenIdByEmail(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();

  // 1) 缓存命中
  const cached = emailToOpenIdCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.openId;
  }
  if (cached) {
    // 过期清理
    emailToOpenIdCache.delete(normalized);
  }

  // 2) 调飞书反查
  let token: string;
  try {
    token = await getTenantToken();
  } catch {
    return null;
  }
  const apiBase = getApiBase();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(
      `${apiBase}/contact/v3/users/batch_get_id?user_id_type=open_id`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: [normalized] }),
        signal: ctrl.signal,
      },
    );
    const data = (await resp.json()) as {
      code: number;
      msg: string;
      data?: {
        user_list?: Array<{
          email?: string;
          user_id?: string;
        }>;
      };
    };
    if (data.code !== 0) {
      return null;
    }
    const found = data.data?.user_list?.find(
      (u) => u.email?.toLowerCase() === normalized && u.user_id,
    );
    if (!found?.user_id) {
      return null;
    }
    setEmailCache(normalized, found.user_id);
    return found.user_id;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 仅测试用：清空邮箱缓存 */
export function clearEmailCache(): void {
  emailToOpenIdCache.clear();
}

// ==================== F4 死信补偿消费 ====================

/**
 * 补偿重试载荷结构（与 postImMessage 的参数一一对应）
 */
interface RetryPayload {
  op: string;
  idType: FeishuReceiveIdType;
  body: Record<string, unknown>;
  errLabel: string;
}

/**
 * 注册飞书死信补偿处理器
 *
 * 当死信队列中有条目时，补偿消费者会调用此处理器，
 * 处理器通过 entry.retryPayload 重建 postImMessage 调用进行重试。
 *
 * 重试成功（code=0）返回 true，死信将被移除；否则返回 false，放回队列。
 */
registerRetryHandler(async (entry: DeadLetterEntry): Promise<boolean> => {
  const payload = entry.retryPayload as RetryPayload | undefined;
  if (!payload) {
    // 旧版死信无 retryPayload，无法自动补偿
    logger.warn('飞书死信补偿：条目无 retryPayload，跳过', {
      module: 'FeishuNotify',
      op: entry.op,
      at: entry.at,
    });
    return false;
  }

  try {
    const result = await postImMessage(
      payload.op,
      payload.idType,
      payload.body,
      payload.errLabel,
    );
    if (result.success) {
      logger.info('飞书死信补偿：重试成功', {
        module: 'FeishuNotify',
        op: entry.op,
        originalAttempts: entry.attempts,
      });
      return true;
    }
    return false;
  } catch (e: any) {
    logger.debug('飞书死信补偿：重试异常', {
      module: 'FeishuNotify',
      op: entry.op,
      err: (e?.message || String(e)).slice(0, 200),
    });
    return false;
  }
});

/**
 * 定时补偿消费：每 5 分钟扫描一次死信队列，尝试重试
 *
 * 使用 setInterval 而非 @nestjs/schedule，因为 feishu-notify.service.ts
 * 是 fundamentals 模块（不在 NestJS DI 容器中），与 redis-client.ts
 * 管理自身生命周期的模式一致。
 */
const COMPENSATION_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
let compensationTimer: NodeJS.Timeout | null = null;

/**
 * 启动死信补偿定时任务
 */
export function startDeadLetterCompensation(): void {
  if (compensationTimer) return;
  compensationTimer = setInterval(async () => {
    try {
      await retryDeadLetters(20);
    } catch (e: any) {
      logger.warn('飞书死信补偿：定时任务异常', {
        module: 'FeishuNotify',
        err: (e?.message || String(e)).slice(0, 200),
      });
    }
  }, COMPENSATION_INTERVAL_MS);
  logger.info('飞书死信补偿定时任务已启动', {
    module: 'FeishuNotify',
    intervalMs: COMPENSATION_INTERVAL_MS,
  });
}

/**
 * 停止死信补偿定时任务（用于测试 / 优雅关闭）
 */
export function stopDeadLetterCompensation(): void {
  if (compensationTimer) {
    clearInterval(compensationTimer);
    compensationTimer = null;
  }
}

// 模块加载时自动启动补偿定时任务
startDeadLetterCompensation();

/**
 * 统一的 im/v1/messages 发送器（F4：限流 + 重试 + 死信）。
 *
 * 把"取 token → POST → 解析飞书响应"封装为一次可重试单元，交给 deliverWithRetry。
 * card / text / image / file 四类消息只是 body 不同，全部复用此函数，
 * 避免每个发送函数各写一遍 fetch + 重试逻辑（消除漂移）。
 *
 * @param op       操作名（用于日志/死信，如 'sendCardMessage'）
 * @param idType   接收人 ID 类型
 * @param body     消息体（含 receive_id / msg_type / content / 可选 uuid）
 * @param errLabel 业务错误前缀（如 '飞书发送消息失败'）
 */
async function postImMessage(
  op: string,
  idType: FeishuReceiveIdType,
  body: Record<string, unknown>,
  errLabel: string,
): Promise<FeishuSendResult> {
  const apiBase = getApiBase();

  const result = await deliverWithRetry<FeishuApiResult & { messageId?: string; msg?: string }>(
    async () => {
      let token: string;
      try {
        token = await getTenantToken();
      } catch (e: any) {
        // token 获取失败按网络错误处理 → 可重试
        return { code: -1, networkError: true, msg: `获取 token 失败: ${e?.message || String(e)}` };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const resp = await fetch(`${apiBase}/im/v1/messages?receive_id_type=${idType}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const data = (await resp.json()) as {
          code: number;
          msg: string;
          data?: { message_id: string };
        };
        return {
          code: data.code,
          httpStatus: resp.status,
          messageId: data.data?.message_id,
          msg: data.msg,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      op,
      receiveId: String(body.receive_id ?? ''),
      uuid: body.uuid as string | undefined,
      // 补偿重试所需的载荷：重建 postImMessage 调用的全部参数
      retryPayload: { op, idType, body, errLabel },
    },
  );

  if (result.code !== 0 || (result.httpStatus !== undefined && result.httpStatus >= 400)) {
    return { success: false, error: `${errLabel}: ${result.msg || `code=${result.code}`}` };
  }
  return { success: true, messageId: result.messageId };
}

/**
 * 发送互动卡片消息
 * 替代原有的 post 文本格式，支持卡片 UI
 */
export async function sendCardMessage(
  receiveId: string,
  idType: FeishuReceiveIdType,
  card: Record<string, unknown>,
  uuid?: string,
): Promise<FeishuSendResult> {
  const body: Record<string, unknown> = {
    receive_id: receiveId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  };
  if (uuid) {
    body.uuid = uuid;
  }
  return postImMessage('sendCardMessage', idType, body, '飞书发送消息失败');
}

/**
 * 发送纯文本消息（降级方案，保持向后兼容）
 */
export async function sendTextMessage(
  receiveId: string,
  idType: FeishuReceiveIdType,
  title: string,
  content: string,
  uuid?: string,
): Promise<FeishuSendResult> {
  const msgContent = JSON.stringify({
    zh_cn: {
      title,
      content: [[{ tag: 'text', text: content }]],
    },
  });

  const body: Record<string, unknown> = {
    receive_id: receiveId,
    msg_type: 'post',
    content: msgContent,
  };
  if (uuid) {
    body.uuid = uuid;
  }
  return postImMessage('sendTextMessage', idType, body, '飞书发送消息失败');
}

/**
 * 发送图片消息（msg_type=image）
 * 需先调用 uploadImage 获取 image_key
 */
export async function sendImageMessage(
  receiveId: string,
  idType: FeishuReceiveIdType,
  imageKey: string,
  uuid?: string,
): Promise<FeishuSendResult> {
  const body: Record<string, unknown> = {
    receive_id: receiveId,
    msg_type: 'image',
    content: JSON.stringify({ image_key: imageKey }),
  };
  if (uuid) {
    body.uuid = uuid;
  }
  return postImMessage('sendImageMessage', idType, body, '飞书发送图片失败');
}

/**
 * 发送文件消息（msg_type=file）
 * 需先调用 uploadFile 获取 file_key
 */
export async function sendFileMessage(
  receiveId: string,
  idType: FeishuReceiveIdType,
  fileKey: string,
  uuid?: string,
): Promise<FeishuSendResult> {
  const body: Record<string, unknown> = {
    receive_id: receiveId,
    msg_type: 'file',
    content: JSON.stringify({ file_key: fileKey }),
  };
  if (uuid) {
    body.uuid = uuid;
  }
  return postImMessage('sendFileMessage', idType, body, '飞书发送文件失败');
}

// ==================== 卡片更新 ====================

/**
 * 更新已发送的卡片（B3 卡片状态机）
 *
 * 飞书消息卡片更新端点：PATCH /im/v1/messages/{message_id}
 * 注意：不是 /im/v1/cards/{card_id}（那个端点不存在）。
 * messageId 即 sendCardMessage 返回的 messageId（飞书的 om_xxxx 形式）。
 *
 * 请求体格式：{ content: JSON.stringify(card) }
 * 其中 card 必须是完整的卡片 JSON（包含 elements/header），不是 patch 增量。
 *
 * 典型场景：HITL 确认后，把卡片按钮替换为"✓ 已确认 by 张三 12:34"
 */
export async function updateCard(
  messageId: string,
  updatedCard: Record<string, unknown>,
): Promise<FeishuSendResult> {
  let token: string;
  try {
    token = await getTenantToken();
  } catch (e: any) {
    return { success: false, error: `获取 token 失败: ${e.message || String(e)}` };
  }
  const apiBase = getApiBase();

  // 网络抖动重试：fetch failed/network error 时最多重试 2 次（共 3 次尝试）
  // 间隔 300ms / 800ms，避免请求堆积；飞书业务错误（code !== 0）不重试
  const MAX_ATTEMPTS = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(`${apiBase}/im/v1/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: JSON.stringify(updatedCard) }),
        signal: ctrl.signal,
      });
      const data = (await resp.json()) as { code: number; msg: string };
      if (data.code !== 0) {
        // 业务错误，无须重试
        return { success: false, error: `卡片更新失败: ${data.msg}` };
      }
      return { success: true };
    } catch (e: any) {
      lastError = e.message || String(e);
      // 仅对网络类错误重试（fetch failed / AbortError / ECONNRESET 等）
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt === 1 ? 300 : 800));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { success: false, error: `卡片更新失败（${MAX_ATTEMPTS} 次尝试后放弃）: ${lastError}` };
}

// ==================== 纯文本消息（D1/D2 长聊天流式） ====================

/**
 * 发送 msg_type=text 的纯文本消息，返回 messageId 给后续流式编辑使用。
 *
 * 与 sendTextMessage（post 富文本）的区别：
 *   - 这里用 `text` 而不是 `post`，因为飞书 PATCH 接口对 text 消息支持更稳定
 *   - 没有标题、不分段、纯字符串内容
 *   - D1/D2 场景下用来发占位消息（"🤔 思考中..."）和最终回复
 */
export async function sendPlainTextMessage(
  receiveId: string,
  idType: FeishuReceiveIdType,
  content: string,
  uuid?: string,
): Promise<FeishuSendResult> {
  const body: Record<string, unknown> = {
    receive_id: receiveId,
    msg_type: 'text',
    content: JSON.stringify({ text: content }),
  };
  if (uuid) {
    body.uuid = uuid;
  }
  // F4：限流 + 指数退避重试 + 死信，统一走 postImMessage（取代原 3 次抖动重试）
  return postImMessage('sendPlainTextMessage', idType, body, '飞书发送文本失败');
}

/**
 * 流式编辑已发送的文本消息（D1/D2 流式输出核心 API）
 *
 * 飞书端点：PATCH /im/v1/messages/{message_id}
 * body：{ msg_type: 'text', content: JSON.stringify({ text }) }
 *
 * 与 updateCard 的区别：
 *   - updateCard 走 content + 卡片 JSON
 *   - 这里走 msg_type + 纯文本 content
 *
 * 同样附带 3 次网络抖动重试（间隔 300ms / 800ms），业务错误不重试。
 */
export async function updateTextMessage(
  messageId: string,
  text: string,
): Promise<FeishuSendResult> {
  let token: string;
  try {
    token = await getTenantToken();
  } catch (e: any) {
    return { success: false, error: `获取 token 失败: ${e.message || String(e)}` };
  }
  const apiBase = getApiBase();

  const MAX_ATTEMPTS = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(`${apiBase}/im/v1/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
        signal: ctrl.signal,
      });
      const data = (await resp.json()) as { code: number; msg: string };
      if (data.code !== 0) {
        return { success: false, error: `文本消息更新失败: ${data.msg}` };
      }
      return { success: true };
    } catch (e: any) {
      lastError = e.message || String(e);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt === 1 ? 300 : 800));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { success: false, error: `文本消息更新失败（${MAX_ATTEMPTS} 次尝试后放弃）: ${lastError}` };
}

// ==================== 事件回调验证 ====================

/**
 * 验证飞书事件回调 Token（F3 安全加固）
 *
 * 飞书事件订阅有两种模式：
 *   1. **不加密模式**（默认）：每条事件 body 中都带 `token`/`header.token` 字段，
 *      值就是开发者后台配置的 Verification Token。校验该字段即可。
 *   2. **加密模式**（需在开放平台开启 Encrypt Key）：body 是密文，请求头带
 *      `X-Lark-Signature`，需要用 sha256(timestamp+nonce+body+encryptKey) 验证。
 *
 * 本项目目前只使用不加密模式，所以只实现 token 字段校验。
 * 如未来要支持加密订阅，再增加 verifyEventSignature 函数。
 */
export function verifyEventToken(
  bodyToken: string | undefined,
  verificationToken: string,
): boolean {
  if (!verificationToken) return true; // 未配置 = 跳过校验（开发模式）
  if (!bodyToken) return false;
  // 时序安全比较，避免计时攻击
  try {
    const a = Buffer.from(bodyToken);
    const b = Buffer.from(verificationToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * 飞书事件回调 URL 验证
 *
 * 兼容两种 schema：
 *   - v1（旧）：{ type: "url_verification", challenge, token }
 *   - v2（新，schema=2.0）：{ schema: "2.0", header: { event_type: ... }, event: ... }
 *     - URL 验证依然走 v1 格式，所以这里只需要识别 v1 即可
 *
 * 返回 { challenge } 表示是 URL 验证请求；返回 null 表示不是。
 */
export function handleEventVerification(body: {
  type?: string;
  challenge?: string;
  token?: string;
}): { challenge: string } | null {
  if (body.type === 'url_verification' && body.challenge) {
    return { challenge: body.challenge };
  }
  return null;
}

// ==================== 统计信息 ====================

/** 获取当前 Token 缓存大小（用于调试） */
export function getTokenCacheSize(): number {
  return tenantTokenCache.size;
}

/** 清理 Token 缓存（用于测试）
 *
 * 仅清理进程内 L1 + 单飞 Map。L2 Redis 自带 TTL，不在测试中直接操作（避免依赖 Redis）
 */
export function clearTokenCache(): void {
  tenantTokenCache.clear();
  inflightTokenRequests.clear();
}