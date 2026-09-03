/**
 * LRU 缓存模块
 *
 * 基于内存的 LRU（Least Recently Used）缓存，用于缓存向量检索结果，
 * 避免相同查询重复执行 Embedding 计算和向量检索。
 *
 * 特性：
 * - LRU 淘汰策略：容量满时自动淘汰最久未访问的条目
 * - TTL 过期：每个条目可设置生存时间，过期自动失效
 * - 单条大小限制：超过 maxSize 的结果不缓存，防止内存膨胀
 * - 缓存统计：记录命中/未命中次数，提供统计查询接口
 * - 事件驱动失效：监听 knowledge-base-updated 事件自动清缓存
 *
 * 缓存 key 设计：hash(query + JSON.stringify(filter))
 * 确保不同过滤条件的查询不会串结果
 */

import { createHash } from 'crypto';
import { logger } from './logger.js';
import { eventBus } from './event-bus.js';
import { getRuntimeConfig, updateRuntimeConfig } from './runtime-config.js';
import { metrics } from './metrics.js';

// ==================== 缓存条目 ====================

interface CacheEntry<V> {
  /** 缓存值 */
  value: V;
  /** 过期时间戳（ms），0 表示永不过期 */
  expireAt: number;
  /** 条目大小（字节，近似值） */
  size: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  accessedAt: number;
}

// ==================== 缓存统计 ====================

export interface CacheStats {
  /** 命中次数 */
  hits: number;
  /** 未命中次数 */
  misses: number;
  /** 命中率（0-1） */
  hitRate: number;
  /** 当前条目数 */
  size: number;
  /** 最大条目数 */
  maxSize: number;
  /** 估算内存占用（KB） */
  memoryUsageKB: number;
}

// ==================== LRU 缓存 ====================

/**
 * 缓存 key 文本归一化（L1 方案）
 *
 * 对查询文本做规范化处理，消除微小差异导致的缓存不命中：
 * - 多空格合并为单空格
 * - 前后空白去除
 * - 统一小写
 *
 * 进阶方案参考：
 * - L2 语义缓存（Semantic Cache）：用 embedding 余弦相似度匹配，如 GPTCache / RedisVL
 *   "什么是机器学习" ≈ "机器学习的定义" → 命中（语义相似而非文本相同）
 * - L3 分布式语义缓存（Distributed Semantic Cache）：Redis + embedding + 多实例共享
 *   适用于多节点部署，缓存跨实例共享，避免冷启动问题
 */
function normalizeCacheKeyText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class LRUCache<V> {
  private cache = new Map<string, CacheEntry<V>>();
  private totalSize = 0; // 估算总内存占用（字节）

  // 统计
  private hits = 0;
  private misses = 0;

  constructor(
    /** 最大缓存条目数 */
    private maxEntries: number = 200,
    /** 单条结果最大大小（字节），超过的不缓存，默认 5KB */
    private maxItemSize: number = 5 * 1024,
    /** 默认 TTL（毫秒），0 表示永不过期，默认 5 分钟 */
    private defaultTTL: number = 5 * 60 * 1000,
    /** 缓存命名空间，用于 Prometheus 指标区分不同缓存实例 */
    private namespace: string = 'rag-search',
  ) {
    // 监听知识库更新事件，自动清缓存
    eventBus.on('knowledge-base-updated', (reason: string) => {
      this.clear(reason);
    });
  }

  /**
   * 生成缓存 key
   * 将查询文本归一化后与过滤条件拼接，取 SHA256 哈希
   * 归一化确保 "AI Agent开发" 和 "AI Agent 开发" 生成相同的 key
   */
  static makeKey(query: string, filter?: Record<string, any>): string {
    const normalized = normalizeCacheKeyText(query);
    const raw = `${normalized}|||${filter ? JSON.stringify(filter) : ''}`;
    return createHash('sha256').update(raw, 'utf-8').digest('hex').substring(0, 16);
  }

  /**
   * 获取缓存值
   * 命中时将条目移到 Map 末尾（LRU 特性：最近访问的排后面）
   */
  get(key: string): V | undefined {
    const startTime = performance.now();
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      metrics.cacheGetDuration.observe(
        { namespace: this.namespace, layer: 'miss' },
        (performance.now() - startTime) / 1000,
      );
      logger.debug('缓存未命中', {
        module: 'LRUCache',
        key,
        totalEntries: this.cache.size,
        hits: this.hits,
        misses: this.misses,
      });
      return undefined;
    }

    // 检查是否过期
    if (entry.expireAt > 0 && Date.now() > entry.expireAt) {
      this.cache.delete(key);
      this.totalSize -= entry.size;
      this.misses++;
      metrics.cacheGetDuration.observe(
        { namespace: this.namespace, layer: 'miss' },
        (performance.now() - startTime) / 1000,
      );
      const ageMs = Date.now() - entry.createdAt;
      logger.debug('缓存条目已过期', {
        module: 'LRUCache',
        key,
        ageMs,
        ttlMs: entry.expireAt - entry.createdAt,
        sizeKB: (entry.size / 1024).toFixed(1),
      });
      return undefined;
    }

    // LRU：删除后重新插入，移到末尾
    this.cache.delete(key);
    entry.accessedAt = Date.now();
    this.cache.set(key, entry);

    this.hits++;
    metrics.cacheGetDuration.observe(
      { namespace: this.namespace, layer: 'L1' },
      (performance.now() - startTime) / 1000,
    );
    const ageMs = Date.now() - entry.createdAt;
    logger.debug('缓存命中', {
      module: 'LRUCache',
      key,
      ageMs,
      sizeKB: (entry.size / 1024).toFixed(1),
      totalEntries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    });
    return entry.value;
  }

  /**
   * 设置缓存值
   * 如果缓存已满，淘汰最久未访问的条目（Map 迭代顺序：先插入的在前）
   */
  set(key: string, value: V, ttl?: number): void {
    // 估算条目大小
    const size = this.estimateSize(value);

    // 超过单条大小限制，不缓存
    if (size > this.maxItemSize) {
      logger.warn('缓存条目过大，跳过缓存', {
        module: 'LRUCache',
        key,
        sizeKB: (size / 1024).toFixed(1),
        maxItemSizeKB: (this.maxItemSize / 1024).toFixed(1),
      });
      return;
    }

    // 如果 key 已存在，先删除旧条目
    const existing = this.cache.get(key);
    if (existing) {
      this.totalSize -= existing.size;
      this.cache.delete(key);
    }

    // 淘汰最久未访问的条目，直到有空间
    let evictedCount = 0;
    while (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestEntry = this.cache.get(oldestKey);
        if (oldestEntry) {
          this.totalSize -= oldestEntry.size;
        }
        this.cache.delete(oldestKey);
        evictedCount++;
      }
    }

    if (evictedCount > 0) {
      logger.info('缓存 LRU 淘汰', {
        module: 'LRUCache',
        evictedCount,
        reason: '容量已满',
        totalEntries: this.cache.size,
        maxEntries: this.maxEntries,
      });
    }

    const now = Date.now();
    const effectiveTTL = ttl ?? this.defaultTTL;

    this.cache.set(key, {
      value,
      expireAt: effectiveTTL > 0 ? now + effectiveTTL : 0,
      size,
      createdAt: now,
      accessedAt: now,
    });

    this.totalSize += size;

    logger.debug('缓存写入', {
      module: 'LRUCache',
      key,
      sizeKB: (size / 1024).toFixed(1),
      ttlMs: effectiveTTL,
      totalEntries: this.cache.size,
      memoryUsageKB: Math.round(this.totalSize / 1024),
    });
  }

  /**
   * 清空缓存
   */
  clear(reason?: string): void {
    const count = this.cache.size;
    const memoryKB = Math.round(this.totalSize / 1024);
    this.cache.clear();
    this.totalSize = 0;

    logger.info('缓存已清空', {
      module: 'LRUCache',
      reason: reason || '手动清空',
      clearedEntries: count,
      freedMemoryKB: memoryKB,
    });
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
      maxSize: this.maxEntries,
      memoryUsageKB: Math.round(this.totalSize / 1024),
    };
  }

  /**
   * 获取 Prometheus 指标兼容的统计数据
   * 与 MultiLevelCache 的 CacheStatsProvider 接口对齐，
   * 供 metrics.registerCacheInstance 采集命中率/容量等 Gauge
   */
  getMetricsStats() {
    const total = this.hits + this.misses;
    return {
      namespace: this.namespace,
      l1Hits: this.hits,
      l2Hits: 0, // 纯内存缓存，无 L2
      misses: this.misses,
      l2Errors: 0,
      total,
      l1HitRate: total > 0 ? +(this.hits / total).toFixed(4) : 0,
      overallHitRate: total > 0 ? +(this.hits / total).toFixed(4) : 0,
      l1Size: this.cache.size,
      l1MaxSize: this.maxEntries,
    };
  }

  /**
   * 重置统计计数器
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 更新配置
   */
  updateConfig(options: { maxEntries?: number; maxItemSize?: number; defaultTTL?: number }): void {
    const oldConfig = {
      maxEntries: this.maxEntries,
      maxItemSize: this.maxItemSize,
      defaultTTL: this.defaultTTL,
    };

    if (options.maxEntries !== undefined) {
      this.maxEntries = options.maxEntries;
      // 如果新容量小于当前条目数，淘汰多余的
      let evictedCount = 0;
      while (this.cache.size > this.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          const entry = this.cache.get(oldestKey);
          if (entry) this.totalSize -= entry.size;
          this.cache.delete(oldestKey);
          evictedCount++;
        }
      }
      if (evictedCount > 0) {
        logger.info('缓存配置变更触发 LRU 淘汰', {
          module: 'LRUCache',
          evictedCount,
          oldMaxEntries: oldConfig.maxEntries,
          newMaxEntries: options.maxEntries,
        });
      }
    }
    if (options.maxItemSize !== undefined) {
      this.maxItemSize = options.maxItemSize;
    }
    if (options.defaultTTL !== undefined) {
      this.defaultTTL = options.defaultTTL;
    }

    logger.info('缓存配置已变更', {
      module: 'LRUCache',
      oldConfig,
      newConfig: options,
      currentEntries: this.cache.size,
    });
  }

  /**
   * 估算值的大小（字节）
   * 使用 JSON.stringify 粗略估算，对于大多数场景足够准确
   */
  private estimateSize(value: V): number {
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf-8');
    } catch {
      return 1024; // 序列化失败时给默认 1KB
    }
  }
}

// ==================== 全局缓存实例 ====================

/** 向量检索结果缓存（配置从 runtime-config 读取，支持前端动态修改） */
const _rc = getRuntimeConfig().cache;
export const searchCache = new LRUCache<any>(
  _rc.maxEntries,
  _rc.maxItemSizeKB * 1024,
  _rc.defaultTTLMinutes * 60 * 1000,
);

// 注册到 Prometheus 指标系统，每次 scrape /api/metrics 时自动采集命中率
metrics.registerCacheInstance('rag-search', {
  getStats: () => searchCache.getMetricsStats(),
});

/**
 * 获取缓存统计信息（供 API 接口调用）
 */
export function getCacheStats(): CacheStats {
  return searchCache.getStats();
}

/**
 * 更新缓存配置（供 API 接口调用，同时持久化到文件）
 */
export function updateCacheConfig(options: { maxEntries?: number; maxItemSizeKB?: number; defaultTTLMinutes?: number }): void {
  searchCache.updateConfig({
    maxEntries: options.maxEntries,
    maxItemSize: options.maxItemSizeKB !== undefined ? options.maxItemSizeKB * 1024 : undefined,
    defaultTTL: options.defaultTTLMinutes !== undefined ? options.defaultTTLMinutes * 60 * 1000 : undefined,
  });
  // 持久化到文件
  updateRuntimeConfig({ cache: options });
  logger.info('缓存配置已更新并持久化', { module: 'LRUCache', ...options });
}

/**
 * 获取缓存当前配置（供 API 接口调用）
 */
export function getCacheConfig() {
  return getRuntimeConfig().cache;
}

/**
 * 手动清空缓存（供 API 接口调用）
 */
export function clearCache(reason?: string): void {
  searchCache.clear(reason || 'API 手动清空');
}
