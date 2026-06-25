/**
 * 飞书发送可靠性层（F4：重试 + 限流 + 死信）
 *
 * 背景：飞书 OpenAPI 有 QPS 限制（im/v1/messages 约 5 QPS/应用），且网络抖动、
 * 服务端 5xx、token 偶发失效都会导致单次发送失败。此前所有 fetch 调用"失败即放弃"，
 * 没有重试、没有退避、失败也无处可查。
 *
 * 本模块提供统一的发送可靠性包装：
 *   1. **限流**：进程内令牌桶，把对飞书的请求压到 ≤ FEISHU_QPS，避免触发 429。
 *   2. **重试 + 指数退避 + 抖动**：对"可重试错误"（429 / 5xx / 网络超时 / token 失效）
 *      自动重试，退避 base * 2^n ± 抖动，最多 MAX_RETRIES 次。
 *   3. **死信队列**：重试耗尽仍失败的发送，落到 Redis list（降级到内存环形缓冲），
 *      便于人工排查与后续补偿。
 *
 * 幂等前提：所有写消息接口都带 uuid（调用方派生稳定 uuid），因此重试不会产生重复消息——
 * 这是 F4 能安全开启重试的基础（F1 幂等基线已就位）。
 */

import { logger } from './logger.js';
import { getRedis, isRedisReady } from './redis-client.js';

// ==================== 配置 ====================

/** 飞书 im/v1/messages 应用级 QPS 上限（保守取 5） */
const FEISHU_QPS = 5;
/** 令牌桶容量（允许的瞬时突发） */
const BUCKET_CAPACITY = FEISHU_QPS;
/** 最大重试次数（不含首次） */
const MAX_RETRIES = 3;
/** 退避基数（毫秒） */
const BACKOFF_BASE_MS = 300;
/** 退避上限（毫秒） */
const BACKOFF_MAX_MS = 5000;

/** 死信队列 Redis key */
const DEAD_LETTER_KEY = 'feishu:dead-letter';
/** 死信队列最大长度（Redis LTRIM / 内存环形缓冲都用它） */
const DEAD_LETTER_MAX = 1000;

// ==================== 可重试错误判定 ====================

/**
 * 飞书可重试错误码（节选）：
 *   - 99991400：请求频率超限（限流）
 *   - 99991661 / 99991663 / 99991664：tenant_access_token 无效/过期（重试前会重新取 token）
 * HTTP 维度：429（限流）、5xx（服务端错误）、网络异常/超时 → 可重试
 */
const RETRYABLE_FEISHU_CODES = new Set([99991400, 99991661, 99991663, 99991664]);

export interface FeishuApiResult {
  /** 飞书业务错误码，0 表示成功 */
  code: number;
  /** HTTP 状态码（若由网络异常触发则为 undefined） */
  httpStatus?: number;
  /** 是否网络层异常（超时、连接失败等） */
  networkError?: boolean;
}

/** 判断一次飞书调用结果是否值得重试 */
export function isRetryable(result: FeishuApiResult): boolean {
  if (result.networkError) return true;
  if (result.httpStatus === 429) return true;
  if (result.httpStatus !== undefined && result.httpStatus >= 500) return true;
  if (RETRYABLE_FEISHU_CODES.has(result.code)) return true;
  return false;
}

// ==================== 令牌桶限流 ====================

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

function refill(): void {
  const now = Date.now();
  const elapsedSec = (now - lastRefill) / 1000;
  if (elapsedSec <= 0) return;
  tokens = Math.min(BUCKET_CAPACITY, tokens + elapsedSec * FEISHU_QPS);
  lastRefill = now;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取一个令牌（限流）。令牌不足时等待到下一个令牌可用，保证整体速率 ≤ FEISHU_QPS。
 * 进程内令牌桶：单实例精确，多实例下每实例独立（保守，仍远低于触发 429 的概率）。
 */
async function acquireToken(): Promise<void> {
  // 最多自旋等待几轮，避免极端情况下无限等待
  for (let i = 0; i < 100; i++) {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    // 还差多少令牌 → 等待相应时间
    const needed = 1 - tokens;
    const waitMs = Math.ceil((needed / FEISHU_QPS) * 1000);
    await sleep(Math.min(waitMs, 1000));
  }
  // 兜底：实在拿不到也放行，避免卡死主流程（宁可偶发限流也不阻塞）
  tokens = 0;
}

/** 仅测试用：重置令牌桶 */
export function __resetRateLimiterForTest(): void {
  tokens = BUCKET_CAPACITY;
  lastRefill = Date.now();
}

// ==================== 退避计算 ====================

/** 第 attempt 次重试（从 1 开始）的退避时长：base * 2^(attempt-1) ± 25% 抖动 */
function backoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1); // ±25%
  return Math.max(0, Math.round(exp + jitter));
}

// ==================== 死信队列 ====================

export interface DeadLetterEntry {
  /** 操作类型，如 'sendCardMessage' / 'sendImageMessage' */
  op: string;
  /** 接收方（open_id / chat_id 等），仅用于排查 */
  receiveId?: string;
  /** 幂等 uuid，便于人工补偿时复用，避免重复 */
  uuid?: string;
  /** 最后一次错误描述 */
  lastError: string;
  /** 已尝试次数 */
  attempts: number;
  /** 落库时间戳 */
  at: number;
}

/** 内存环形缓冲（Redis 不可用时的死信兜底） */
const localDeadLetters: DeadLetterEntry[] = [];

async function pushDeadLetter(entry: DeadLetterEntry): Promise<void> {
  logger.error('飞书发送进入死信队列（重试耗尽）', {
    module: 'FeishuDelivery',
    op: entry.op,
    receiveId: entry.receiveId,
    attempts: entry.attempts,
    lastError: entry.lastError.slice(0, 200),
  });

  if (isRedisReady()) {
    try {
      const redis = getRedis();
      if (redis) {
        await redis.lpush(DEAD_LETTER_KEY, JSON.stringify(entry));
        await redis.ltrim(DEAD_LETTER_KEY, 0, DEAD_LETTER_MAX - 1);
        return;
      }
    } catch (e: any) {
      logger.warn('飞书死信写入 Redis 失败，降级到内存', {
        module: 'FeishuDelivery',
        err: (e?.message || String(e)).slice(0, 200),
      });
    }
  }
  // 内存兜底（环形）
  localDeadLetters.unshift(entry);
  if (localDeadLetters.length > DEAD_LETTER_MAX) {
    localDeadLetters.length = DEAD_LETTER_MAX;
  }
}

/** 读取死信（运维 / 排查 / 补偿用） */
export async function peekDeadLetters(limit = 50): Promise<DeadLetterEntry[]> {
  if (isRedisReady()) {
    try {
      const redis = getRedis();
      if (redis) {
        const raw = await redis.lrange(DEAD_LETTER_KEY, 0, limit - 1);
        return raw.map((s) => JSON.parse(s) as DeadLetterEntry);
      }
    } catch {
      // 落到内存
    }
  }
  return localDeadLetters.slice(0, limit);
}

/** 仅测试用：清空内存死信 */
export function __resetDeadLettersForTest(): void {
  localDeadLetters.length = 0;
}

// ==================== 重试执行器 ====================

export interface DeliverOptions {
  /** 操作名（用于日志与死信） */
  op: string;
  receiveId?: string;
  uuid?: string;
}

/**
 * 在限流 + 重试 + 死信保护下执行一次飞书发送。
 *
 * @param fn 实际的发送函数，返回 FeishuApiResult（须包含 code / httpStatus / networkError）
 *           以及调用方关心的载荷 T。
 * @returns fn 的返回值；重试耗尽仍失败时返回最后一次结果（不抛错，保持与现有调用方兼容）。
 */
export async function deliverWithRetry<T extends FeishuApiResult>(
  fn: () => Promise<T>,
  options: DeliverOptions,
): Promise<T> {
  let lastResult: T | null = null;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquireToken();
    try {
      const result = await fn();
      // 成功判定：业务码 0 且 HTTP 状态非错误（>=400 视为失败，即使 code 解析为 0）
      const httpOk = result.httpStatus === undefined || result.httpStatus < 400;
      if (result.code === 0 && httpOk) {
        if (attempt > 0) {
          logger.info('飞书发送重试成功', {
            module: 'FeishuDelivery',
            op: options.op,
            attempt,
          });
        }
        return result;
      }
      lastResult = result;
      lastError = `code=${result.code} httpStatus=${result.httpStatus ?? '-'}`;
      if (!isRetryable(result) || attempt === MAX_RETRIES) {
        if (isRetryable(result)) {
          // 可重试但已到上限 → 死信
          await pushDeadLetter({
            op: options.op,
            receiveId: options.receiveId,
            uuid: options.uuid,
            lastError,
            attempts: attempt + 1,
            at: Date.now(),
          });
        }
        return result;
      }
    } catch (e: any) {
      lastError = (e?.message || String(e)).slice(0, 200);
      lastResult = { code: -1, networkError: true } as T;
      if (attempt === MAX_RETRIES) {
        await pushDeadLetter({
          op: options.op,
          receiveId: options.receiveId,
          uuid: options.uuid,
          lastError,
          attempts: attempt + 1,
          at: Date.now(),
        });
        return lastResult;
      }
    }

    // 还有重试机会 → 退避后再来
    const wait = backoffMs(attempt + 1);
    logger.warn('飞书发送失败，退避重试', {
      module: 'FeishuDelivery',
      op: options.op,
      attempt: attempt + 1,
      nextWaitMs: wait,
      lastError,
    });
    await sleep(wait);
  }

  return lastResult as T;
}
