/**
 * LLM 请求限流模块
 *
 * 使用信号量 + 令牌桶实现双池限流，保护后端 LLM API 不被突发流量打爆。
 *
 * 设计思路：
 * - 快速池：查询改写、追问判断、重排序等短时 LLM 调用（1-3 秒）
 * - 流式池：主对话 SSE 流式生成等长时 LLM 调用（10-30 秒）
 * - Ollama 本地模型不限流（没有 API 速率限制）
 * - 令牌桶按 provider 分别配置速率（DeepSeek 30 RPM，智谱 60 RPM）
 *
 * 信号量在流结束时释放（SSE 场景下，流式响应可能持续数十秒），
 * 而不是在请求开始时占用整个信号量周期。
 */

import { logger } from './logger.js';
import { getRuntimeConfig, updateRuntimeConfig } from './runtime-config.js';
import type { ModelProvider } from './model-provider.js';

// ==================== 信号量 ====================

/**
 * 兜底常量：runtime-config 中字段缺失或非法时使用
 *
 * 缺了它们会出现两类致命故障：池容量为 0 导致所有请求永久挂起、
 * 排队无超时导致 HTTP 连接与前端 fetch 一起堆积。
 */
const FALLBACK = {
  fastPoolMax: 10,
  streamingPoolMax: 5,
  tokenWaitTimeout: 10000,
  queueWaitTimeout: 120000,
} as const;

/**
 * 消费端兜底：非法的正数配置一律回退到 fallback 并告警
 *
 * 这是三层防御的最后一层（写入校验 → 加载校验 → 消费端 clamp）。
 * runtime-config.json 可能被外部工具直接改写，绕过所有写入校验，
 * 所以消费端必须自己守住底线。
 */
function sanitizePositive(
  value: number,
  fallback: number,
  name: string,
): number {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  logger.warn('限流配置非法，已回退默认值', {
    module: 'LLMRateLimiter',
    field: name,
    invalidValue: value,
    fallback,
  });
  return fallback;
}

/** 等待队列条目：timer 用于排队超时时把条目摘出并 reject */
interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  callerId: string;
  enqueuedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

class Semaphore {
  private queue: QueueEntry[] = [];
  private running = 0;
  private nextId = 0;

  constructor(
    private max: number,
    private name: string,
  ) {}

  /** 池名的中文可读形式，仅用于拼装给用户看的错误文案 */
  private get poolLabel(): string {
    return this.name === 'fast' ? '快速' : '流式';
  }

  /**
   * 获取并发槽位
   * @param callerTag 调用方标识，便于日志追踪
   * @param timeoutMs 排队等待上限（毫秒），超时抛错而不是永久挂起
   */
  async acquire(callerTag?: string, timeoutMs?: number): Promise<string> {
    const callerId = callerTag ?? `${this.name}_${this.nextId++}`;

    if (this.running < this.max) {
      this.running++;
      logger.debug('限流信号量：获取成功', {
        module: 'LLMRateLimiter',
        pool: this.name,
        callerId,
        running: this.running,
        max: this.max,
        queueLength: this.queue.length,
      });
      return callerId;
    }

    const enqueuedAt = Date.now();
    logger.info('限流信号量：并发已满，进入等待队列', {
      module: 'LLMRateLimiter',
      pool: this.name,
      callerId,
      running: this.running,
      max: this.max,
      queueLength: this.queue.length + 1,
    });

    const effectiveTimeout = sanitizePositive(
      timeoutMs ?? FALLBACK.queueWaitTimeout,
      FALLBACK.queueWaitTimeout,
      'queueWaitTimeout',
    );

    return new Promise<string>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve: () => resolve(callerId),
        reject,
        callerId,
        enqueuedAt,
      };
      // 排队超时兜底：没有它的话，池子被打满 + 上游长时间不释放会让请求
      // 永久挂起，连接一直堆着，最终整个服务不可用（前端表现为一直转圈）
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        logger.warn('限流信号量：排队超时，请求被拒绝', {
          module: 'LLMRateLimiter',
          pool: this.name,
          callerId,
          waitedMs: Date.now() - enqueuedAt,
          timeoutMs: effectiveTimeout,
          running: this.running,
          max: this.max,
          queueLength: this.queue.length,
        });
        reject(
          new Error(
            `${this.poolLabel}请求排队超时（${Math.round(effectiveTimeout / 1000)}s），并发已满，请稍后重试`,
          ),
        );
      }, effectiveTimeout);
      this.queue.push(entry);
    });
  }

  /**
   * 取出队首等待者并清掉它的超时定时器
   *
   * 定时器必须清掉，否则槽位已经发出去了、超时回调还会再执行一次，
   * 触发「已放行的请求又被 reject」的诡异错误。
   */
  private dequeueNext(): QueueEntry | undefined {
    const next = this.queue.shift();
    if (next?.timer) clearTimeout(next.timer);
    return next;
  }

  release(callerId: string): void {
    this.running--;

    const next = this.dequeueNext();
    if (next) {
      const waitMs = Date.now() - next.enqueuedAt;
      this.running++;
      logger.info('限流信号量：释放后唤醒等待者', {
        module: 'LLMRateLimiter',
        pool: this.name,
        releasedBy: callerId,
        awakened: next.callerId,
        waitMs,
        running: this.running,
        queueLength: this.queue.length,
      });
      next.resolve();
    } else {
      logger.debug('限流信号量：释放，无等待者', {
        module: 'LLMRateLimiter',
        pool: this.name,
        releasedBy: callerId,
        running: this.running,
      });
    }
  }

  getStatus(): { running: number; max: number; queueLength: number } {
    return {
      running: this.running,
      max: this.max,
      queueLength: this.queue.length,
    };
  }

  /**
   * 调整并发上限
   *
   * 扩容后必须立刻 drain 队列：只改 max 的话新增槽位一直空着，
   * 排队者要等到下一次 release 才被唤醒，用户侧表现为
   * 「明明调大了并发数，请求还在排队」。
   */
  updateMax(newMax: number): void {
    const oldMax = this.max;
    this.max = newMax;

    let awakened = 0;
    while (this.running < this.max && this.queue.length > 0) {
      const next = this.dequeueNext();
      if (!next) break;
      this.running++;
      awakened++;
      logger.info('限流信号量：扩容后唤醒等待者', {
        module: 'LLMRateLimiter',
        pool: this.name,
        awakened: next.callerId,
        waitMs: Date.now() - next.enqueuedAt,
        running: this.running,
      });
      next.resolve();
    }

    logger.info('限流信号量：并发上限已变更', {
      module: 'LLMRateLimiter',
      pool: this.name,
      oldMax,
      newMax,
      awakened,
      running: this.running,
      queueLength: this.queue.length,
    });
  }
}

// ==================== 令牌桶 ====================

class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    /** 桶容量（最大令牌数） */
    private capacity: number,
    /** 每分钟补充的令牌数 */
    private refillPerMinute: number,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  /**
   * 尝试消费一个令牌
   * @returns true 表示消费成功，false 表示令牌不足
   */
  tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * 退还令牌（用于请求被 abort 时回收）
   * 不会超过桶容量
   */
  refund(): void {
    this.tokens = Math.min(this.tokens + 1, this.capacity);
  }

  /**
   * 等待直到获取令牌
   * @param timeoutMs 最大等待时间（毫秒）
   */
  async waitForToken(timeoutMs: number = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.tryConsume()) {
        return true;
      }

      // 计算下一个令牌补充时间
      const msPerToken = 60000 / this.refillPerMinute;
      const waitTime = Math.min(msPerToken, deadline - Date.now());
      if (waitTime <= 0) break;

      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    return false;
  }

  /**
   * 补充令牌
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    const tokensToAdd = (elapsed / 60000) * this.refillPerMinute;

    if (tokensToAdd >= 1) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefillAt = now;
    }
  }

  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * 原地调整速率（保留当前已积累的令牌）
   *
   * 不能用 `new TokenBucket(rpm, rpm)` 替换实例：新建的桶是满的，
   * 等于每次改配置都白送一整个桶容量的突发额度——用户把 RPM 从 30 调到 60
   * 的瞬间会立刻放行 60 个请求，正好打爆上游配额。
   */
  updateRate(newRPM: number): void {
    // 先按旧速率把这段时间的令牌结算掉，避免时间差被新速率重复计算
    this.refill();
    this.refillPerMinute = newRPM;
    this.capacity = newRPM;
    // 缩容时截断：原桶里攒的令牌不能超出新容量
    this.tokens = Math.min(this.tokens, this.capacity);
  }
}

// ==================== 限流器配置 ====================

interface RateLimiterConfig {
  /** 快速池最大并发数 */
  fastPoolMax: number;
  /** 流式池最大并发数 */
  streamingPoolMax: number;
  /** 各 provider 的 RPM 限制 */
  providerRPM: Record<string, number>;
  /** 等待 provider RPM 令牌的超时时间（毫秒） */
  tokenWaitTimeout: number;
  /** 等待并发槽位的排队超时时间（毫秒） */
  queueWaitTimeout: number;
}

const _rc = getRuntimeConfig().rateLimiter;
const DEFAULT_CONFIG: RateLimiterConfig = {
  fastPoolMax: sanitizePositive(
    _rc.fastPoolMax,
    FALLBACK.fastPoolMax,
    'fastPoolMax',
  ),
  streamingPoolMax: sanitizePositive(
    _rc.streamingPoolMax,
    FALLBACK.streamingPoolMax,
    'streamingPoolMax',
  ),
  providerRPM: {
    deepseek: 30, // DeepSeek 默认 30 RPM
    zhipu: 60, // 智谱默认 60 RPM
  },
  tokenWaitTimeout: sanitizePositive(
    _rc.tokenWaitTimeout,
    FALLBACK.tokenWaitTimeout,
    'tokenWaitTimeout',
  ),
  queueWaitTimeout: sanitizePositive(
    _rc.queueWaitTimeout,
    FALLBACK.queueWaitTimeout,
    'queueWaitTimeout',
  ),
};

// ==================== 限流器 ====================

export class LLMRateLimiter {
  private fastPool: Semaphore;
  private streamingPool: Semaphore;
  private tokenBuckets = new Map<string, TokenBucket>();
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    // 调用方（含单元测试）可能传入非法值，逐个 clamp，
    // 池容量为 0 会让 acquire 永久挂起，属于不可接受的故障模式
    this.config = {
      ...merged,
      fastPoolMax: sanitizePositive(
        merged.fastPoolMax,
        DEFAULT_CONFIG.fastPoolMax,
        'fastPoolMax',
      ),
      streamingPoolMax: sanitizePositive(
        merged.streamingPoolMax,
        DEFAULT_CONFIG.streamingPoolMax,
        'streamingPoolMax',
      ),
      tokenWaitTimeout: sanitizePositive(
        merged.tokenWaitTimeout,
        DEFAULT_CONFIG.tokenWaitTimeout,
        'tokenWaitTimeout',
      ),
      queueWaitTimeout: sanitizePositive(
        merged.queueWaitTimeout,
        DEFAULT_CONFIG.queueWaitTimeout,
        'queueWaitTimeout',
      ),
    };
    this.fastPool = new Semaphore(this.config.fastPoolMax, 'fast');
    this.streamingPool = new Semaphore(
      this.config.streamingPoolMax,
      'streaming',
    );

    // 初始化各 provider 的令牌桶
    for (const [provider, rpm] of Object.entries(this.config.providerRPM)) {
      this.tokenBuckets.set(provider, new TokenBucket(rpm, rpm));
    }
  }

  /**
   * 执行受限流保护的 LLM 调用
   *
   * @param provider 模型提供者（ollama 不限流）
   * @param pool 池类型：fast（快速操作）或 streaming（流式生成）
   * @param fn 实际的 LLM 调用函数
   * @param callerTag 调用者标识（用于日志）
   * @returns LLM 调用结果
   */
  async execute<T>(
    provider: ModelProvider | string,
    pool: 'fast' | 'streaming',
    fn: () => Promise<T>,
    callerTag?: string,
  ): Promise<T> {
    const tag = callerTag || `${pool}_${provider}`;

    // Ollama 本地模型不限流
    if (provider === 'ollama') {
      logger.debug('限流跳过：Ollama 本地模型不限流', {
        module: 'LLMRateLimiter',
        provider,
        pool,
        callerTag: tag,
      });
      return fn();
    }

    // 1. 信号量并发控制
    //
    // 必须先拿并发槽、再扣 provider 令牌（原实现顺序相反）：
    // 反过来的话，请求在并发队列里干等时已经白占了 RPM 配额，
    // 队列越长浪费越多，最终把桶抽干，导致后续请求即使拿到槽位
    // 也拿不到令牌而超时——表现为「并发没满却一直提示速率超限」。
    const semaphore = pool === 'fast' ? this.fastPool : this.streamingPool;
    const callerId = await semaphore.acquire(tag, this.config.queueWaitTimeout);

    // 2. 令牌桶限流：等待获取令牌
    const bucket = this.tokenBuckets.get(provider);
    if (bucket) {
      const tokenStart = Date.now();
      const availableBefore = bucket.getAvailableTokens();
      const acquired = await bucket.waitForToken(this.config.tokenWaitTimeout);
      const tokenWaitMs = Date.now() - tokenStart;

      if (!acquired) {
        // 拿不到令牌必须先归还并发槽，否则槽位泄漏、池子越用越小，
        // 泄漏到 running 恒等于 max 后所有请求都会排队直至超时
        semaphore.release(callerId);
        logger.warn('限流拒绝：令牌桶超时，请求被丢弃', {
          module: 'LLMRateLimiter',
          provider,
          pool,
          callerTag: tag,
          tokenWaitMs,
          availableBefore,
          timeoutMs: this.config.tokenWaitTimeout,
        });
        throw new Error(`${provider} API 请求速率超限，请稍后重试`);
      }

      logger.debug('限流令牌桶：获取成功', {
        module: 'LLMRateLimiter',
        provider,
        pool,
        callerTag: tag,
        tokenWaitMs,
        availableBefore,
        availableAfter: bucket.getAvailableTokens(),
      });
    } else {
      logger.debug('限流令牌桶：未配置，跳过', {
        module: 'LLMRateLimiter',
        provider,
        pool,
        callerTag: tag,
      });
    }

    const execStart = Date.now();
    try {
      const result = await fn();
      const execMs = Date.now() - execStart;
      logger.debug('限流执行完成', {
        module: 'LLMRateLimiter',
        provider,
        pool,
        callerTag: tag,
        execMs,
        status: 'success',
      });
      return result;
    } catch (error: any) {
      const execMs = Date.now() - execStart;
      // abort 判定必须覆盖各家 SDK 的命名：
      // - AbortError：标准 DOMException
      // - APIUserAbortError：openai SDK 主动取消时抛出的名字（DeepSeek 走同一 SDK）
      // - 消息含 abort（如 AbortSignal.timeout 的 "The operation was aborted due to timeout"）
      // 漏判会让「被取消的调用」既不退还令牌又被记为异常，桶被白白抽干、后续排队加剧
      const isAbort =
        error.name === 'AbortError' ||
        error.name === 'APIUserAbortError' ||
        error.message === 'This operation was aborted' ||
        /abort/i.test(String(error.message ?? ''));

      if (isAbort) {
        // abort 是正常行为（用户继续打字触发新请求），退还令牌避免耗尽
        bucket?.refund();
        logger.debug('限流执行被取消', {
          module: 'LLMRateLimiter',
          provider,
          pool,
          callerTag: tag,
          execMs,
          status: 'aborted',
        });
      } else {
        logger.warn('限流执行异常', {
          module: 'LLMRateLimiter',
          provider,
          pool,
          callerTag: tag,
          execMs,
          status: 'error',
          error: error.message,
        });
      }
      throw error;
    } finally {
      semaphore.release(callerId);
    }
  }

  /**
   * 获取限流器状态（用于监控和调试）
   */
  getStatus(): {
    fastPool: { running: number; max: number; queueLength: number };
    streamingPool: { running: number; max: number; queueLength: number };
    tokenBuckets: Record<string, number>;
  } {
    const buckets: Record<string, number> = {};
    for (const [provider, bucket] of this.tokenBuckets.entries()) {
      buckets[provider] = bucket.getAvailableTokens();
    }

    return {
      fastPool: this.fastPool.getStatus(),
      streamingPool: this.streamingPool.getStatus(),
      tokenBuckets: buckets,
    };
  }

  /**
   * 更新配置（运行时立即生效）
   *
   * 每个数值字段都过一遍 sanitizePositive：设置面板传进来的值可能是
   * 用户清空输入框产生的 0（`Number('') === 0`），落到池容量上就是永久挂起。
   */
  updateConfig(options: {
    fastPoolMax?: number;
    streamingPoolMax?: number;
    providerRPM?: Record<string, number>;
    tokenWaitTimeout?: number;
    queueWaitTimeout?: number;
  }): void {
    const oldConfig = {
      fastPoolMax: this.config.fastPoolMax,
      streamingPoolMax: this.config.streamingPoolMax,
      tokenWaitTimeout: this.config.tokenWaitTimeout,
      queueWaitTimeout: this.config.queueWaitTimeout,
      providerRPM: { ...this.config.providerRPM },
    };

    if (options.fastPoolMax !== undefined) {
      this.config.fastPoolMax = sanitizePositive(
        options.fastPoolMax,
        oldConfig.fastPoolMax,
        'fastPoolMax',
      );
      this.fastPool.updateMax(this.config.fastPoolMax);
    }
    if (options.streamingPoolMax !== undefined) {
      this.config.streamingPoolMax = sanitizePositive(
        options.streamingPoolMax,
        oldConfig.streamingPoolMax,
        'streamingPoolMax',
      );
      this.streamingPool.updateMax(this.config.streamingPoolMax);
    }
    // 令牌等待超时：原实现漏了这个分支，导致设置面板保存后 UI 回显新值、
    // 但实际限流仍按旧值执行，重启后才「莫名生效」
    if (options.tokenWaitTimeout !== undefined) {
      this.config.tokenWaitTimeout = sanitizePositive(
        options.tokenWaitTimeout,
        oldConfig.tokenWaitTimeout,
        'tokenWaitTimeout',
      );
    }
    if (options.queueWaitTimeout !== undefined) {
      this.config.queueWaitTimeout = sanitizePositive(
        options.queueWaitTimeout,
        oldConfig.queueWaitTimeout,
        'queueWaitTimeout',
      );
    }
    if (options.providerRPM) {
      for (const [provider, rpm] of Object.entries(options.providerRPM)) {
        if (!Number.isFinite(rpm) || rpm <= 0) {
          logger.warn('限流配置非法：provider RPM 必须为正数，已跳过', {
            module: 'LLMRateLimiter',
            provider,
            invalidValue: rpm,
          });
          continue;
        }
        this.config.providerRPM[provider] = rpm;
        const existing = this.tokenBuckets.get(provider);
        if (existing) {
          // 原地改速率，保留当前令牌余量（新建满桶等于白送一桶突发额度）
          existing.updateRate(rpm);
        } else {
          this.tokenBuckets.set(provider, new TokenBucket(rpm, rpm));
        }
      }
    }
    logger.info('限流器配置已变更', {
      module: 'LLMRateLimiter',
      oldConfig,
      newConfig: options,
      currentStatus: this.getStatus(),
    });
  }
}

// ==================== 全局限流器实例 ====================

export const llmRateLimiter = new LLMRateLimiter();

/**
 * 获取限流器状态（供 API 接口调用）
 */
export function getRateLimiterStatus() {
  return llmRateLimiter.getStatus();
}

/**
 * 获取限流器当前配置（供 API 接口调用）
 */
export function getRateLimiterConfig() {
  return getRuntimeConfig().rateLimiter;
}

/**
 * 更新限流器配置（供 API 接口调用，同时持久化到文件）
 *
 * @throws RuntimeConfigValidationError 参数非法时抛出，且不会改动内存状态
 */
export function updateRateLimiterConfig(options: {
  fastPoolMax?: number;
  streamingPoolMax?: number;
  tokenWaitTimeout?: number;
  queueWaitTimeout?: number;
}): void {
  // 先持久化（内部含严格校验，非法值抛错），再改内存：
  // 反过来的话内存已被改坏、抛错后与磁盘不一致，只能靠重启才能恢复
  updateRuntimeConfig({ rateLimiter: options });
  llmRateLimiter.updateConfig(options);
}
