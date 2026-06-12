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

class Semaphore {
  private queue: Array<{ resolve: () => void; callerId: string; enqueuedAt: number }> = [];
  private running = 0;
  private nextId = 0;

  constructor(
    private max: number,
    private name: string,
  ) {}

  async acquire(callerTag?: string): Promise<string> {
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

    return new Promise<string>((resolve) => {
      this.queue.push({ resolve: () => resolve(callerId), callerId, enqueuedAt });
    });
  }

  release(callerId: string): void {
    this.running--;

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
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
    return { running: this.running, max: this.max, queueLength: this.queue.length };
  }

  updateMax(newMax: number): void {
    this.max = newMax;
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

      await new Promise(resolve => setTimeout(resolve, waitTime));
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
}

// ==================== 限流器配置 ====================

interface RateLimiterConfig {
  /** 快速池最大并发数 */
  fastPoolMax: number;
  /** 流式池最大并发数 */
  streamingPoolMax: number;
  /** 各 provider 的 RPM 限制 */
  providerRPM: Record<string, number>;
  /** 等待令牌的超时时间（毫秒） */
  tokenWaitTimeout: number;
}

const _rc = getRuntimeConfig().rateLimiter;
const DEFAULT_CONFIG: RateLimiterConfig = {
  fastPoolMax: _rc.fastPoolMax,
  streamingPoolMax: _rc.streamingPoolMax,
  providerRPM: {
    deepseek: 30,  // DeepSeek 默认 30 RPM
    zhipu: 60,     // 智谱默认 60 RPM
  },
  tokenWaitTimeout: _rc.tokenWaitTimeout,
};

// ==================== 限流器 ====================

export class LLMRateLimiter {
  private fastPool: Semaphore;
  private streamingPool: Semaphore;
  private tokenBuckets = new Map<string, TokenBucket>();
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fastPool = new Semaphore(this.config.fastPoolMax, 'fast');
    this.streamingPool = new Semaphore(this.config.streamingPoolMax, 'streaming');

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

    // 1. 令牌桶限流：等待获取令牌
    const bucket = this.tokenBuckets.get(provider as string);
    if (bucket) {
      const tokenStart = Date.now();
      const availableBefore = bucket.getAvailableTokens();
      const acquired = await bucket.waitForToken(this.config.tokenWaitTimeout);
      const tokenWaitMs = Date.now() - tokenStart;

      if (!acquired) {
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

    // 2. 信号量并发控制
    const semaphore = pool === 'fast' ? this.fastPool : this.streamingPool;
    const callerId = await semaphore.acquire(tag);

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
      logger.warn('限流执行异常', {
        module: 'LLMRateLimiter',
        provider,
        pool,
        callerTag: tag,
        execMs,
        status: 'error',
        error: error.message,
      });
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
   * 更新配置
   */
  updateConfig(options: {
    fastPoolMax?: number;
    streamingPoolMax?: number;
    providerRPM?: Record<string, number>;
  }): void {
    const oldConfig = {
      fastPoolMax: this.config.fastPoolMax,
      streamingPoolMax: this.config.streamingPoolMax,
      providerRPM: { ...this.config.providerRPM },
    };

    if (options.fastPoolMax !== undefined) {
      this.config.fastPoolMax = options.fastPoolMax;
      this.fastPool.updateMax(options.fastPoolMax);
    }
    if (options.streamingPoolMax !== undefined) {
      this.config.streamingPoolMax = options.streamingPoolMax;
      this.streamingPool.updateMax(options.streamingPoolMax);
    }
    if (options.providerRPM) {
      for (const [provider, rpm] of Object.entries(options.providerRPM)) {
        this.config.providerRPM[provider] = rpm;
        this.tokenBuckets.set(provider, new TokenBucket(rpm, rpm));
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
 */
export function updateRateLimiterConfig(options: {
  fastPoolMax?: number;
  streamingPoolMax?: number;
  tokenWaitTimeout?: number;
}): void {
  llmRateLimiter.updateConfig(options);
  // 持久化到文件
  updateRuntimeConfig({ rateLimiter: options });
}
