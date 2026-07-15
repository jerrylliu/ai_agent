/**
 * 语义缓存（Semantic Cache）—— L3
 *
 * 基于嵌入向量的相似度匹配缓存，专为 RAG 检索结果设计。
 *
 * 与 MultiLevelCache 的区别：
 *   - MultiLevelCache 是精确 key 匹配（query 字符串完全一致才命中）
 *   - SemanticCache 是语义匹配（"今天天气怎么样" 和 "今日天气如何" 可命中同一缓存）
 *
 * 工作流程：
 *   1. get(query) → 计算查询的嵌入向量 → 与缓存中所有向量做余弦相似度 → 最高分超过阈值即命中
 *   2. set(query, value) → 计算嵌入 → 存入内存数组
 *   3. 超过 maxEntries 时淘汰最旧条目
 *
 * 设计取舍：
 *   - 仅 L1 内存（不写 Redis）：语义缓存条目少（通常 < 100），暴力遍历足够快（< 1ms）
 *   - 嵌入计算依赖 Ollama，如果 Ollama 不可用则降级为"始终 miss"（不影响业务）
 *   - 不与 MultiLevelCache 耦合：语义缓存是 RAG 专用，其他场景不需要
 */

import { logger } from './logger.js';

/** 缓存条目 */
interface CacheEntry<V> {
  /** 查询文本（仅用于调试日志） */
  query: string;
  /** 查询的嵌入向量 */
  embedding: number[];
  /** 缓存值 */
  value: V;
  /** 过期时间戳（毫秒） */
  expireAt: number;
}

export interface SemanticCacheOptions {
  /** 缓存命名空间（用于日志区分） */
  namespace: string;
  /** 最大条目数（超过即淘汰最旧） */
  maxEntries: number;
  /** 缓存生存时间（秒） */
  ttlSec: number;
  /** 余弦相似度命中阈值（0~1，越高越严格） */
  similarityThreshold: number;
}

export interface SemanticCacheStats {
  namespace: string;
  hits: number;
  misses: number;
  errors: number;
  size: number;
  maxEntries: number;
  hitRate: number;
}

/**
 * 计算两个向量的余弦相似度
 *
 * cos(A, B) = (A·B) / (|A| × |B|)
 *
 * 值域 [-1, 1]，越接近 1 表示越相似。
 * 向量为空或模为 0 时返回 0（避免除零）。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

export class SemanticCache<V> {
  private readonly namespace: string;
  private readonly maxEntries: number;
  private readonly ttlSec: number;
  private readonly similarityThreshold: number;

  /** 缓存条目数组（按插入顺序，最旧在前） */
  private entries: CacheEntry<V>[] = [];

  /** 嵌入计算函数（由调用方注入，避免直接依赖 Ollama） */
  private readonly embedFn: (text: string) => Promise<number[]>;

  // 统计
  private hits = 0;
  private misses = 0;
  private errors = 0;

  constructor(
    options: SemanticCacheOptions,
    embedFn: (text: string) => Promise<number[]>,
  ) {
    this.namespace = options.namespace;
    this.maxEntries = options.maxEntries;
    this.ttlSec = options.ttlSec;
    this.similarityThreshold = options.similarityThreshold;
    this.embedFn = embedFn;
  }

  /**
   * 查询语义缓存
   *
   * 流程：
   *   1. 计算查询的嵌入向量（失败则 miss）
   *   2. 清理过期条目
   *   3. 遍历所有有效条目，找余弦相似度最高的
   *   4. 最高分超过阈值 → 命中，返回缓存的值
   *   5. 否则 → miss
   */
  async get(query: string): Promise<V | null> {
    if (!query || query.trim().length === 0) return null;

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedFn(query);
    } catch (e: any) {
      this.errors++;
      // 嵌入计算失败用 warn 级别，便于排查（Ollama 未启动 / bge-large 未拉取时会出现）
      logger.warn('语义缓存：嵌入计算失败，降级为 miss', {
        module: 'SemanticCache',
        namespace: this.namespace,
        err: (e?.message || String(e)).slice(0, 200),
      });
      return null;
    }

    if (!queryEmbedding || queryEmbedding.length === 0) {
      return null;
    }

    // 清理过期条目
    const now = Date.now();
    this.entries = this.entries.filter((e) => e.expireAt > now);

    // 暴力遍历找最相似
    let bestScore = -1;
    let bestEntry: CacheEntry<V> | null = null;

    for (const entry of this.entries) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestScore >= this.similarityThreshold) {
      this.hits++;
      logger.debug('语义缓存：命中', {
        module: 'SemanticCache',
        namespace: this.namespace,
        score: +bestScore.toFixed(4),
        originalQuery: bestEntry.query.substring(0, 80),
        newQuery: query.substring(0, 80),
      });
      return bestEntry.value;
    }

    this.misses++;
    return null;
  }

  /**
   * 写入语义缓存
   *
   * 计算查询的嵌入向量并存储。嵌入计算失败则跳过（不缓存）。
   */
  async set(query: string, value: V): Promise<void> {
    if (!query || value === null || value === undefined) return;

    let embedding: number[];
    try {
      embedding = await this.embedFn(query);
    } catch (e: any) {
      this.errors++;
      logger.debug('语义缓存：写入时嵌入计算失败，跳过', {
        module: 'SemanticCache',
        namespace: this.namespace,
        err: (e?.message || String(e)).slice(0, 100),
      });
      return;
    }

    if (!embedding || embedding.length === 0) return;

    this.entries.push({
      query,
      embedding,
      value,
      expireAt: Date.now() + this.ttlSec * 1000,
    });

    // 淘汰最旧条目
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /** 获取缓存统计 */
  getStats(): SemanticCacheStats {
    const total = this.hits + this.misses;
    return {
      namespace: this.namespace,
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      size: this.entries.length,
      maxEntries: this.maxEntries,
      hitRate: total === 0 ? 0 : +(this.hits / total).toFixed(4),
    };
  }

  /** 仅测试用：清空缓存和统计 */
  clearForTest(): void {
    this.entries = [];
    this.hits = 0;
    this.misses = 0;
    this.errors = 0;
  }
}
