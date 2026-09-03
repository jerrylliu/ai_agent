/**
 * 缓存模糊匹配器（Level 2：语义模糊匹配 + 槽位兼容性检查）
 *
 * 目标：当 Level 1 精确匹配未命中时，在最近 N 个 cache key 中找语义相似的，
 * 结合槽位兼容性检查（filter/weight/document_id 必须兼容），复用已有缓存。
 *
 * 三层容错架构定位：
 * - Level 1（精确匹配）：归一化 keywords 指纹 SHA256 精确比对，O(1) 快速路径
 * - Level 2（本模块）：Jaccard 相似度比对 keywords + 槽位兼容性检查，O(N) 兜底
 * - Level 3（alias-learner）：结果验证 + Alias 自学习，越用越准
 *
 * 为什么需要 Level 2？
 * 归一化只能处理语序/停用词差异，无法处理不同词但相同语义的查询：
 * - "干员液氮 技能" keywords=["干员","液氮","技能"] → 归一化 key A
 * - "干员液氮 技能介绍" keywords=["干员","液氮","技能介绍"] → 归一化 key B
 * Level 1 精确匹配 A≠B，但 Jaccard 相似度高 + 槽位兼容 → Level 2 复用 A 的缓存
 */

import { logger } from './logger.js';
import { eventBus } from './event-bus.js';

// ==================== 常量 ====================

/** Jaccard 相似度阈值：keywords 集合相似度超过此值才认为语义相近 */
const FUZZY_MATCH_THRESHOLD = 0.6;

/** 每个会话最多索引的 cache key 数量 */
const MAX_INDEX_SIZE = 50;

/** 槽位兼容性检查的类型定义 */
export interface CacheSlots {
  /** 元数据过滤条件（document_id 等） */
  filter?: Record<string, unknown>;
  /** 向量检索权重 */
  vectorWeight: number;
  /** BM25 检索权重 */
  bm25Weight: number;
  /** 检索类型标识 */
  type: string;
}

/** cache key 索引条目 */
interface CacheKeyIndexEntry {
  /** LRUCache.makeKey 生成的 hash key */
  cacheKey: string;
  /** 原始 keywords 列表 */
  keywords: string[];
  /** keywords 集合（用于 Jaccard 比对） */
  keywordsSet: Set<string>;
  /** 槽位信息 */
  slots: CacheSlots;
  /** 创建时间戳 */
  createdAt: number;
}

/** 模糊匹配结果 */
export interface FuzzyMatchResult {
  /** 是否找到模糊匹配 */
  matched: boolean;
  /** 匹配到的 cache key（matched=true 时有效） */
  cacheKey: string | null;
  /** Jaccard 相似度（0-1） */
  similarity: number;
  /** 匹配到的历史 keywords（matched=true 时有效） */
  matchedKeywords: string[] | null;
}

// ==================== 字符级分词 ====================

/**
 * 对 keywords 列表做字符级分词（中文单字 + bigram + 英文单词）
 *
 * 不直接用词级 Jaccard（"技能" vs "技能介绍" 词级完全不匹配），
 * 而是拆成字符级 token，让"技能"和"技能介绍"有足够重叠：
 * - "技能" → {"技","能","技能"}
 * - "技能介绍" → {"技","能","技能","介","绍","能介","介绍"}
 * - 交集 = {"技","能","技能"} = 3，Jaccard = 3/7 ≈ 0.43（词级 0% vs 字符级 43%）
 *
 * @param keywords 关键词列表
 * @returns 字符级 token 集合
 */
function tokenizeKeywords(keywords: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const kw of keywords) {
    const trimmed = kw.toLowerCase().trim();
    if (trimmed.length === 0) continue;

    // 英文单词
    const englishWords = trimmed.match(/[a-z]{2,}/g) || [];
    for (const w of englishWords) {
      tokens.add(w);
    }

    // 中文字符
    const chineseChars = trimmed.match(/[\u4e00-\u9fff]/g) || [];
    // 单字
    for (const c of chineseChars) {
      tokens.add(c);
    }
    // bigram（相邻二元组）
    for (let i = 0; i < chineseChars.length - 1; i++) {
      tokens.add(chineseChars[i] + chineseChars[i + 1]);
    }
  }
  return tokens;
}

// ==================== Jaccard 相似度 ====================

/**
 * 计算两个集合的 Jaccard 相似度
 *
 * Jaccard = 交集大小 / 并集大小
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersectionCount = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersectionCount++;
  }

  const unionCount = a.size + b.size - intersectionCount;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

// ==================== 槽位兼容性检查 ====================

/**
 * 检查两个槽位是否兼容（可复用缓存）
 *
 * 兼容规则：
 * - type 必须相同（hybrid vs pure-vector 不能复用）
 * - vectorWeight / bm25Weight 必须相同（权重不同排序结果不同）
 * - filter 必须深度相等（document_id 等过滤条件不同结果不同）
 *
 * @param a 查询槽位
 * @param b 缓存槽位
 * @returns 是否兼容
 */
function isSlotsCompatible(a: CacheSlots, b: CacheSlots): boolean {
  // type 必须相同
  if (a.type !== b.type) return false;

  // 权重必须相同（浮点数精确比较，因为同一配置来源值相同）
  if (a.vectorWeight !== b.vectorWeight) return false;
  if (a.bm25Weight !== b.bm25Weight) return false;

  // filter 深度比较
  const filterA = JSON.stringify(a.filter ?? {});
  const filterB = JSON.stringify(b.filter ?? {});
  if (filterA !== filterB) return false;

  return true;
}

// ==================== 缓存模糊匹配器 ====================

/**
 * 缓存模糊匹配器
 *
 * 按 sessionId 维度维护最近 N 个 cache key 的索引（keywords + slots），
 * Level 1 精确匹配未命中时，用 Jaccard 相似度找语义相近且槽位兼容的 cache key。
 *
 * 生命周期：全局单例（跨 FC 循环复用，积累索引提高命中率）。
 */
export class CacheFuzzyMatcher {
  /** sessionId → cache key 索引列表 */
  private index: Map<string, CacheKeyIndexEntry[]> = new Map();

  /**
   * 查找模糊匹配的 cache key
   *
   * @param sessionId 会话 ID
   * @param keywords 当前查询的 keywords
   * @param slots 当前查询的槽位信息
   * @returns 匹配结果
   */
  findFuzzyMatch(
    sessionId: string,
    keywords: string[],
    slots: CacheSlots,
  ): FuzzyMatchResult {
    const entries = this.index.get(sessionId);
    if (!entries || entries.length === 0 || keywords.length === 0) {
      return { matched: false, cacheKey: null, similarity: 0, matchedKeywords: null };
    }

    const currentKeywordsSet = tokenizeKeywords(keywords);
    if (currentKeywordsSet.size === 0) {
      return { matched: false, cacheKey: null, similarity: 0, matchedKeywords: null };
    }

    // 遍历索引，找相似度最高且槽位兼容的
    let bestMatch: { entry: CacheKeyIndexEntry; similarity: number } | null = null;

    for (const entry of entries) {
      // 槽位不兼容直接跳过（防止误伤不同意图）
      if (!isSlotsCompatible(slots, entry.slots)) continue;

      const similarity = jaccardSimilarity(currentKeywordsSet, entry.keywordsSet);
      if (similarity >= FUZZY_MATCH_THRESHOLD) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { entry, similarity };
        }
      }
    }

    if (bestMatch) {
      logger.info('缓存模糊匹配命中（Level 2）', {
        module: 'CacheFuzzyMatcher',
        sessionId,
        queryKeywords: keywords,
        matchedKeywords: bestMatch.entry.keywords,
        similarity: bestMatch.similarity.toFixed(3),
        threshold: FUZZY_MATCH_THRESHOLD,
        cacheKey: bestMatch.entry.cacheKey,
      });
      return {
        matched: true,
        cacheKey: bestMatch.entry.cacheKey,
        similarity: bestMatch.similarity,
        matchedKeywords: bestMatch.entry.keywords,
      };
    }

    logger.debug('缓存模糊匹配未命中（Level 2）', {
      module: 'CacheFuzzyMatcher',
      sessionId,
      queryKeywords: keywords,
      indexedCount: entries.length,
      threshold: FUZZY_MATCH_THRESHOLD,
    });
    return { matched: false, cacheKey: null, similarity: 0, matchedKeywords: null };
  }

  /**
   * 记录新的 cache key 到索引
   *
   * 在缓存 set 后调用，为后续模糊匹配建立索引。
   *
   * @param sessionId 会话 ID
   * @param cacheKey LRUCache hash key
   * @param keywords 查询 keywords
   * @param slots 槽位信息
   */
  record(
    sessionId: string,
    cacheKey: string,
    keywords: string[],
    slots: CacheSlots,
  ): void {
    if (keywords.length === 0) return;

    let entries = this.index.get(sessionId);
    if (!entries) {
      entries = [];
      this.index.set(sessionId, entries);
    }

    // 去重：如果 cacheKey 已存在，不重复记录
    if (entries.some((e) => e.cacheKey === cacheKey)) return;

    const keywordsSet = tokenizeKeywords(keywords);

    entries.push({
      cacheKey,
      keywords,
      keywordsSet,
      slots,
      createdAt: Date.now(),
    });

    // 超过上限时淘汰最旧的（FIFO，保证索引不无限增长）
    if (entries.length > MAX_INDEX_SIZE) {
      entries.shift();
    }
  }

  /**
   * 清除指定会话的索引
   */
  clearSession(sessionId: string): void {
    this.index.delete(sessionId);
  }

  /**
   * 清除所有索引
   */
  clearAll(): void {
    this.index.clear();
  }

  /**
   * 获取索引统计信息（调试用）
   */
  getStats(): { totalSessions: number; totalEntries: number } {
    let total = 0;
    for (const entries of this.index.values()) {
      total += entries.length;
    }
    return { totalSessions: this.index.size, totalEntries: total };
  }
}

// ==================== 全局单例 ====================

/**
 * 全局缓存模糊匹配器单例
 *
 * 跨 FC 循环复用，积累索引提高命中率。
 * 监听 knowledge-base-updated 事件自动清空索引（与 searchCache 一致），
 * 防止知识库更新后匹配到已失效的 cacheKey。
 */
export const cacheFuzzyMatcher = new CacheFuzzyMatcher();

// 知识库更新时清空索引（与 searchCache 保持一致）
eventBus.on('knowledge-base-updated', (reason: string) => {
  cacheFuzzyMatcher.clearAll();
  logger.info('缓存模糊匹配索引已清空（知识库更新）', {
    module: 'CacheFuzzyMatcher',
    reason,
  });
});
