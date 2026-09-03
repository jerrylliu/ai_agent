/**
 * 多级缓存（Multi-Level Cache）—— L1 内存 + L2 Redis
 *
 * 缓存层级：
 *   ┌────────────┐  ① 命中 → 立即返回（< 0.1 ms，无网络 IO）
 *   │ L1 LRU内存  │
 *   └─────┬──────┘
 *         │ ② 未命中
 *         ▼
 *   ┌────────────┐  ③ 命中 → 回填 L1 → 返回（~ 1-3 ms 网络 IO）
 *   │ L2 Redis   │
 *   └─────┬──────┘
 *         │ ④ 未命中（或 Redis 不可用）
 *         ▼
 *   ┌────────────┐
 *   │ 业务回源    │  ⑤ 调用方 fallback 重新计算
 *   └────────────┘
 *
 * 核心特性：
 *   1. **降级安全**：Redis 任何异常都自动 fallback 到 L1，业务无感知
 *   2. **TTL 抖动**：每次写入 L2 时给 TTL 加 ±10% 随机偏移，防止缓存雪崩
 *   3. **空值不写**：业务返回 null/undefined 时不写入缓存，避免穿透污染
 *   4. **批量过期清理**：L1 LRU 自动淘汰，无需后台扫描线程
 *   5. **泛型类型安全**：值类型 V 由调用方指定，编译期检查
 *
 * 使用示例：
 *   const cache = new MultiLevelCache<UserInfo>({
 *     namespace: 'user-info',  // 自动拼接为 jerry:user-info:{key}
 *     ttlSec: 600,
 *     l1MaxSize: 1000,
 *   });
 *   const user = await cache.get(userId);
 *   await cache.set(userId, userData);
 *
 * 设计取舍：
 *   - 没有用 LangChain 风格的"装饰器"模式（cache.wrap(loader)），因为业务侧有时
 *     需要"先查 cache，没命中再决定要不要回源"的细粒度控制
 *   - 没有引入语义缓存（embedding 相似度匹配），那是 RAG 检索缓存才需要的能力
 */

import { logger } from './logger';
import { getRedis, isRedisReady } from './redis-client';
import { metrics } from './metrics';

/** 单条 L1 缓存条目 */
interface L1Entry<V> {
  value: V;
  /** 过期时间戳（毫秒）。> Date.now() 视为有效 */
  expireAt: number;
}

export interface MultiLevelCacheOptions {
  /**
   * 缓存命名空间，作为 Redis Key 的中间段（jerry:{namespace}:{key}）。
   * 必须保持业务唯一，避免不同业务串结果。
   * 命名建议：kebab-case，如 'session-asset' / 'user-info' / 'rate-limit'。
   */
  namespace: string;

  /**
   * 缓存生存时间（秒）。
   * Redis 用原生 EX 设置；L1 用 expireAt = Date.now() + ttlSec*1000。
   */
  ttlSec: number;

  /**
   * L1 LRU 最大条目数。超过即淘汰最久未访问项。
   * 推荐：高频访问 1000 ~ 5000；低频可设 200。
   */
  l1MaxSize?: number;

  /**
   * TTL 抖动比例（0 ~ 1）。0 = 不抖动；0.1 = ±10%。
   *
   * 防雪崩原理：大量 key 同时过期时，请求会瞬间穿透到回源层（如 LLM 调用），
   * 引发雪崩。给 TTL 加随机偏移，把过期时间打散到一个时间窗口里，避免共振。
   */
  ttlJitterRatio?: number;

  /**
   * 是否打印缓存命中/未命中日志。默认 false（避免日志刷屏）。
   * 调优阶段建议临时打开，观察命中率。
   */
  debug?: boolean;
}

export class MultiLevelCache<V> {
  private readonly namespace: string;
  private readonly ttlSec: number;
  private readonly l1MaxSize: number;
  private readonly ttlJitterRatio: number;
  private readonly debug: boolean;

  /** L1：基于 Map 的简易 LRU（Map 在 V8 中维持插入顺序，可用作 LRU 基础结构） */
  private readonly l1 = new Map<string, L1Entry<V>>();

  // 统计
  private l1Hits = 0;
  private l2Hits = 0;
  private misses = 0;
  private l2Errors = 0;

  constructor(options: MultiLevelCacheOptions) {
    this.namespace = options.namespace;
    this.ttlSec = options.ttlSec;
    this.l1MaxSize = options.l1MaxSize ?? 1000;
    this.ttlJitterRatio = options.ttlJitterRatio ?? 0.1;
    this.debug = options.debug ?? false;
  }

  /**
   * 完整 Redis Key：业务 keyPrefix（如 'jerry:'）由 ioredis 自动追加，
   * 这里只拼 'namespace:rawKey'。
   */
  private buildRedisKey(rawKey: string): string {
    return `${this.namespace}:${rawKey}`;
  }

  /** 计算带抖动的实际 TTL（秒） */
  private computeTtlWithJitter(): number {
    if (this.ttlJitterRatio <= 0) return this.ttlSec;
    // ±jitterRatio 范围内的随机偏移
    const jitter = this.ttlSec * this.ttlJitterRatio * (Math.random() * 2 - 1);
    return Math.max(1, Math.floor(this.ttlSec + jitter));
  }

  /** L1 LRU：访问后把 key 移到 Map 末尾，标记为"最近使用" */
  private touchL1(key: string, entry: L1Entry<V>): void {
    this.l1.delete(key);
    this.l1.set(key, entry);
  }

  /** L1 LRU 淘汰：超过容量时删除"最久未使用"项（Map 第一个 key） */
  private evictL1IfNeeded(): void {
    while (this.l1.size > this.l1MaxSize) {
      const oldestKey = this.l1.keys().next().value;
      if (oldestKey === undefined) break;
      this.l1.delete(oldestKey);
    }
  }

  /**
   * 读缓存。命中返回值，未命中返回 null。
   *
   * 流程：
   *   1. 先查 L1，命中且未过期 → 返回
   *   2. L1 miss → 查 L2 Redis
   *   3. L2 命中 → 反序列化 → 回填 L1 → 返回
   *   4. L2 miss / 不可用 / 异常 → 返回 null（让业务决定是否回源）
   */
  async get(rawKey: string): Promise<V | null> {
    const startTime = performance.now();
    // ===== L1 =====
    const l1Entry = this.l1.get(rawKey);
    if (l1Entry) {
      if (l1Entry.expireAt > Date.now()) {
        this.l1Hits++;
        this.touchL1(rawKey, l1Entry);
        metrics.cacheGetDuration.observe(
          { namespace: this.namespace, layer: 'L1' },
          (performance.now() - startTime) / 1000,
        );
        if (this.debug) {
          logger.debug('MultiLevelCache: L1 命中', {
            module: 'MultiLevelCache',
            namespace: this.namespace,
            key: rawKey,
          });
        }
        return l1Entry.value;
      }
      // 过期：清掉 L1，继续查 L2
      this.l1.delete(rawKey);
    }

    // ===== L2 =====
    const redis = getRedis();
    if (redis && isRedisReady()) {
      try {
        const raw = await redis.get(this.buildRedisKey(rawKey));
        if (raw !== null) {
          const value = JSON.parse(raw) as V;
          this.l2Hits++;
          // 回填 L1：注意 L1 用本地 ttl，与 L2 实际剩余 TTL 不必严格一致
          this.touchL1(rawKey, {
            value,
            expireAt: Date.now() + this.ttlSec * 1000,
          });
          this.evictL1IfNeeded();
          metrics.cacheGetDuration.observe(
            { namespace: this.namespace, layer: 'L2' },
            (performance.now() - startTime) / 1000,
          );
          if (this.debug) {
            logger.debug('MultiLevelCache: L2 命中', {
              module: 'MultiLevelCache',
              namespace: this.namespace,
              key: rawKey,
            });
          }
          return value;
        }
      } catch (e: any) {
        // Redis 异常：记录但不抛，让业务认为是 miss，由调用方决定回源
        this.l2Errors++;
        logger.warn('MultiLevelCache: L2 读失败，降级为 miss', {
          module: 'MultiLevelCache',
          namespace: this.namespace,
          key: rawKey,
          err: (e.message || String(e)).slice(0, 200),
        });
      }
    }

    this.misses++;
    metrics.cacheGetDuration.observe(
      { namespace: this.namespace, layer: 'miss' },
      (performance.now() - startTime) / 1000,
    );
    return null;
  }

  /**
   * 写缓存。null/undefined 不写入（防穿透污染）。
   *
   * 写策略：先写 L1（同步、必成功），再异步写 L2。
   * L2 失败不影响 L1，下次读还能命中 L1。
   */
  async set(rawKey: string, value: V | null | undefined): Promise<void> {
    if (value === null || value === undefined) {
      // 不缓存空值：避免被恶意请求或一次失败污染缓存
      // 如需"防穿透"的空值缓存，请显式传入哨兵值（如空对象）
      return;
    }

    // ===== L1 =====
    this.touchL1(rawKey, {
      value,
      expireAt: Date.now() + this.ttlSec * 1000,
    });
    this.evictL1IfNeeded();

    // ===== L2 =====
    const redis = getRedis();
    if (!redis || !isRedisReady()) return;

    try {
      const ttl = this.computeTtlWithJitter();
      await redis.set(this.buildRedisKey(rawKey), JSON.stringify(value), 'EX', ttl);
      if (this.debug) {
        logger.debug('MultiLevelCache: 已写入 L2', {
          module: 'MultiLevelCache',
          namespace: this.namespace,
          key: rawKey,
          ttl,
        });
      }
    } catch (e: any) {
      this.l2Errors++;
      logger.warn('MultiLevelCache: L2 写失败（L1 仍生效）', {
        module: 'MultiLevelCache',
        namespace: this.namespace,
        key: rawKey,
        err: (e.message || String(e)).slice(0, 200),
      });
    }
  }

  /**
   * 仅刷新 TTL（不修改值）。常用场景：
   *   - 业务判定"本轮没新内容，但旧缓存仍然有效"，希望延期而非覆盖
   *   - 实现"滑动过期"：每次访问都续期，长期不访问才过期
   */
  async touch(rawKey: string): Promise<void> {
    // ===== L1 续期 =====
    const l1Entry = this.l1.get(rawKey);
    if (l1Entry) {
      l1Entry.expireAt = Date.now() + this.ttlSec * 1000;
      this.touchL1(rawKey, l1Entry);
    }

    // ===== L2 续期 =====
    const redis = getRedis();
    if (!redis || !isRedisReady()) return;
    try {
      const ttl = this.computeTtlWithJitter();
      // EXPIRE 返回 0 表示 key 不存在；不存在就不续期，由后续 set 重新写入
      await redis.expire(this.buildRedisKey(rawKey), ttl);
    } catch (e: any) {
      this.l2Errors++;
      logger.warn('MultiLevelCache: L2 续期失败', {
        module: 'MultiLevelCache',
        namespace: this.namespace,
        key: rawKey,
        err: (e.message || String(e)).slice(0, 200),
      });
    }
  }

  /**
   * 删除缓存（双写：L1 + L2）。
   * 用于"主动失效"，如用户更新资料后清除其个人信息缓存。
   */
  async delete(rawKey: string): Promise<void> {
    this.l1.delete(rawKey);

    const redis = getRedis();
    if (!redis || !isRedisReady()) return;
    try {
      // UNLINK 比 DEL 快：异步释放内存，对大 key 友好
      await redis.unlink(this.buildRedisKey(rawKey));
    } catch (e: any) {
      this.l2Errors++;
      logger.warn('MultiLevelCache: L2 删除失败', {
        module: 'MultiLevelCache',
        namespace: this.namespace,
        key: rawKey,
        err: (e.message || String(e)).slice(0, 200),
      });
    }
  }

  /**
   * 命中率统计（用于调优 / 监控大盘）。
   * 命中率低 → 可能 TTL 太短、key 设计有问题、或者业务本身就不适合缓存。
   */
  getStats() {
    const total = this.l1Hits + this.l2Hits + this.misses;
    return {
      namespace: this.namespace,
      l1Hits: this.l1Hits,
      l2Hits: this.l2Hits,
      misses: this.misses,
      l2Errors: this.l2Errors,
      total,
      l1HitRate: total === 0 ? 0 : +(this.l1Hits / total).toFixed(4),
      overallHitRate: total === 0 ? 0 : +((this.l1Hits + this.l2Hits) / total).toFixed(4),
      l1Size: this.l1.size,
      l1MaxSize: this.l1MaxSize,
    };
  }

  /** 仅供测试：清空 L1（不影响 L2） */
  clearL1ForTest(): void {
    this.l1.clear();
    this.l1Hits = 0;
    this.l2Hits = 0;
    this.misses = 0;
    this.l2Errors = 0;
  }
}
