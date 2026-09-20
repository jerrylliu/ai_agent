/**
 * 向量存储 — 检索（纯向量 + 混合搜索）
 *
 * 提供两种检索策略：
 * - searchKnowledgeBase：纯向量相似度检索
 * - hybridSearchKnowledgeBase：向量 + BM25 混合检索（RRF 融合）
 *
 * 检索结果统一过滤：
 * - 相似度阈值过滤
 * - 版本状态过滤（仅返回 active 版本）
 */

import { logger } from '../logger.js';
import {
  initializeVectorStore,
} from './store-state.js';
import {
  initializeBM25Index,
} from './bm25-index.js';
import { getBM25Engine } from './bm25-engine.js';
import { LRUCache, searchCache } from '../cache.js';
import { cacheFuzzyMatcher, type CacheSlots } from '../cache-fuzzy-matcher.js';
import { cacheAliasLearner } from '../cache-alias-learner.js';

// ==================== 基础设施失败计数（评测熔断判据） ====================

/**
 * 检索基础设施（Chroma 向量库 / BM25 索引）累计失败次数。
 *
 * 检索失败会在下方两个 catch 中被吞掉并返回空结果（生产弹性设计：单路失败不阻断
 * 另一路），但评测场景下静默退化会污染数据——向量路 0 命中 → RRF 退化为纯 BM25
 * 单路，题目不报错但 Document Recall 失真（2026-09-17 HyDE 第 4 轮实测 161 题污染）。
 * 评测 runner 在每题开始前轮询此计数，超阈值即熔断中止（已有结果保留，--resume 续传）。
 */
let searchInfraFailureCount = 0;

/** 读取检索基础设施累计失败次数（评测 runner 熔断判据） */
export function getSearchInfraFailureCount(): number {
  return searchInfraFailureCount;
}

/** 重置计数（评测 runner 启动时归零基线用） */
export function resetSearchInfraFailureCount(): void {
  searchInfraFailureCount = 0;
}

// ==================== 纯向量检索 ====================

/**
 * 搜索知识库（支持元数据过滤）
 *
 * @param query 查询文本
 * @param topK 返回结果数量
 * @param minSimilarity 最小相似度阈值（score越低越相似，建议 cosine: <=1.0, l2: 越小越好）
 * @param filter 元数据过滤条件，例如 { doc_type: "技术文档" } 或 { source: "xxx" }
 */
export async function searchKnowledgeBase(
  query: string,
  topK: number = 5,
  // 相似度阈值：ChromaDB cosine 距离下 score 越小越相似，0.55 为经验阈值
  // 与 hybridSearchKnowledgeBase 保持一致，避免不同搜索路径结果差异过大
  minSimilarity: number = 0.55,
  filter?: Record<string, any>,
  /** 缓存 key 覆盖：默认用 query 生成缓存 key，传入此参数则用此值生成 key。
   *  FC 模式下查询会被改写，改写结果每次不同导致缓存永远命中不了，
   *  传入原始查询作为 cacheKeyOverride 可确保同一用户输入命中缓存。 */
  cacheKeyOverride?: string,
): Promise<Array<{ content: string; metadata: any; score: number }>> {
  const store = await initializeVectorStore();

  logger.info('搜索知识库', { module: 'VectorStore', query: query.substring(0, 100), cacheKeyOverride: cacheKeyOverride?.substring(0, 100) });
  if (filter) {
    logger.debug('搜索过滤条件', { module: 'VectorStore', filter });
  }

  // 缓存查询：优先用 cacheKeyOverride 生成 key（FC 模式下确保同一用户输入命中缓存）
  const cacheKey = cacheKeyOverride
    ? LRUCache.makeKey(cacheKeyOverride, filter)
    : LRUCache.makeKey(query, filter);
  logger.info('搜索缓存key生成', {
    module: 'VectorStore',
    usedOverride: !!cacheKeyOverride,
    cacheKeySource: cacheKeyOverride ? 'cacheKeyOverride(归一化keywords)' : 'query(改写查询)',
    actualQueryForHash: (cacheKeyOverride || query).substring(0, 100),
    filterKeys: filter ? Object.keys(filter).sort().join(',') : 'none',
    cacheKey,
  });
  const cached = searchCache.get(cacheKey);
  if (cached) {
    logger.info('搜索命中缓存', { module: 'VectorStore', query: query.substring(0, 100), cacheKey });
    return cached;
  }

  try {
    // 向量检索：不在 where 中过滤 versionStatus，改为结果后过滤（兼容旧数据无 versionStatus 字段）
    const searchFilter = { ...filter };
    delete searchFilter.versionStatus;
    const effectiveFilter = Object.keys(searchFilter).length > 0 ? searchFilter : undefined;

    logger.info('执行向量检索', {
      module: 'VectorStore',
      query: query.substring(0, 100),
      topK,
      minSimilarity,
      effectiveFilter,
      requestCount: topK * 3,
    });

    const results = await store.similaritySearchWithScore(query, topK * 3, effectiveFilter);

    logger.info('向量检索原始结果', {
      module: 'VectorStore',
      resultCount: results.length,
      scoreRange: results.length > 0
        ? { min: Math.min(...results.map(r => r[1])).toFixed(4), max: Math.max(...results.map(r => r[1])).toFixed(4) }
        : 'N/A',
    });

    results.forEach(([doc, score], i) => {
      logger.debug('搜索结果', { module: 'VectorStore', index: i, score: score.toFixed(4), docType: doc.metadata?.doc_type, versionStatus: doc.metadata?.versionStatus });
    });

    // 后过滤：只保留 active 版本（无 versionStatus 的旧数据视为 active）
    const beforeFilterCount = results.length;
    const filtered = results
      .filter(([doc, score]) => {
        // 相似度过滤
        if (score > minSimilarity) return false;
        // 版本状态过滤：无 versionStatus 或 versionStatus=active
        const vs = doc.metadata?.versionStatus;
        return !vs || vs === 'active';
      })
      .slice(0, topK);

    const similarityFilteredOut = beforeFilterCount - results.filter(([doc, score]) => score <= minSimilarity).length;
    const versionFilteredOut = results.filter(([doc, score]) => score <= minSimilarity).length - filtered.length;

    logger.info('搜索结果过滤完成', {
      module: 'VectorStore',
      minSimilarity,
      beforeFilter: beforeFilterCount,
      similarityFilteredOut,
      versionFilteredOut,
      finalCount: filtered.length,
    });

    // Parent-Child 展开：如果命中 child chunk，返回 parent 内容
    const finalResults = filtered.map(([doc, score]) => {
      const meta = doc.metadata || {};
      if (meta.chunk_role === 'child' && meta.parent_content) {
        return {
          content: meta.parent_content,
          metadata: { ...meta, _childContent: doc.pageContent },
          score,
        };
      }
      return {
        content: doc.pageContent,
        metadata: doc.metadata,
        score,
      };
    });

    // 写入缓存
    searchCache.set(cacheKey, finalResults);

    return finalResults;
  } catch (error: any) {
    searchInfraFailureCount++;
    logger.error('搜索失败', {
      module: 'VectorStore',
      query: query.substring(0, 100),
      error: error.message,
      errorStack: error.stack?.substring(0, 300),
      infraFailureCount: searchInfraFailureCount,
    });
    return [];
  }
}

// ==================== 混合搜索 ====================

/**
 * 混合搜索（向量检索 + BM25 关键词检索）
 * 使用 RRF (Reciprocal Rank Fusion) 融合两种检索结果
 *
 * 三层缓存容错架构：
 * - Level 1（精确匹配）：归一化 cacheKeyOverride SHA256 精确比对，O(1)
 * - Level 2（模糊匹配）：Jaccard 相似度比对 keywords + 槽位兼容性检查，O(N)
 * - Level 3（Alias 自学习）：Level 2 命中时记录 alias 候选，多次命中后稳定
 *
 * @param query 查询文本
 * @param topK 返回结果数量
 * @param vectorWeight 向量检索权重 (0-1)，默认 0.7
 * @param bm25Weight BM25 检索权重 (0-1)，默认 0.3
 * @param filter 元数据过滤条件
 * @param cacheKeyOverride 缓存 key 覆盖
 * @param minSimilarity 向量检索最小相似度阈值（cosine 距离，越小越相似），默认 0.55
 * @param keywords 查询关键词（Level 2 模糊匹配用，来自查询改写的 keywords 字段）
 * @param sessionId 会话 ID（Level 2 模糊匹配按会话维度索引）
 * @param vectorQueryText 向量路独立嵌入文本（HyDE 假想答案，集成模式）：传入时主查询与
   *        该文本各做一次向量检索并 RRF 融合（主查询信号永不丢失，假想答案为增量信号），
   *        BM25 仍用 query（关键词匹配需要真实术语）。语义类查询问题与文档用词不重叠，
   *        用假想答案嵌入与真文档的向量相似度更高。缺省 = 仅主查询单路（行为与改造前一致）。
 */
export async function hybridSearchKnowledgeBase(
  query: string,
  topK: number = 5,
  vectorWeight: number = 0.7,
  bm25Weight: number = 0.3,
  filter?: Record<string, any>,
  /** 缓存 key 覆盖：默认用 query 生成缓存 key，传入此参数则用此值生成 key。
   *  FC 模式下查询会被改写，改写结果每次不同导致缓存永远命中不了，
   *  传入归一化 keywords 指纹作为 cacheKeyOverride 可确保相同语义查询命中缓存。 */
  cacheKeyOverride?: string,
  minSimilarity: number = 0.55,
  /** 查询关键词（Level 2 模糊匹配用）：来自查询改写的 keywords 字段。
   *  Level 1 精确匹配未命中时，用 keywords 做 Jaccard 相似度比对找相似缓存。 */
  keywords?: string[],
  /** 会话 ID（Level 2 模糊匹配按会话维度索引） */
  sessionId?: string,
  /** 向量路独立嵌入文本（HyDE 假想答案，可空）：非空时启用主查询+HyDE 双向量路 RRF 融合 */
  vectorQueryText?: string,
): Promise<Array<{ content: string; metadata: any; score: number; vectorScore?: number; sources: string[] }>> {
  logger.info('混合搜索知识库', { module: 'VectorStore', query: query.substring(0, 100), vectorWeight, bm25Weight, cacheKeyOverride: cacheKeyOverride?.substring(0, 100), hasKeywords: !!(keywords && keywords.length > 0) });

  // ==================== 权重归一化 ====================
  // vectorWeight + bm25Weight 应为 1。RRF 公式对权重和单调，即使不为 1 也不影响单次请求内的排序，
  // 但会让融合分数失去物理意义（跨请求不可比）、缓存 key 与 Level 2 槽位比对失真。
  // 必须在缓存 key 生成之前归一化，否则相同归一化结果的请求会分裂成不同缓存 key。
  const rawWeightSum = vectorWeight + bm25Weight;
  const vw = rawWeightSum <= 0 ? 0.7 : vectorWeight / rawWeightSum;
  const bw = rawWeightSum <= 0 ? 0.3 : bm25Weight / rawWeightSum;
  if (rawWeightSum <= 0 || Math.abs(rawWeightSum - 1) > 0.001) {
    logger.warn('混合检索权重之和偏离 1，已自动归一化', {
      module: 'VectorStore',
      originalVectorWeight: vectorWeight,
      originalBm25Weight: bm25Weight,
      weightSum: rawWeightSum,
      normalizedVectorWeight: vw,
      normalizedBm25Weight: bw,
    });
  }

  // ==================== 缓存 key 生成 ====================
  // HyDE 状态必须参与缓存 key：同一请求第一次改写超时（无 HyDE）、第二次改写成功（有 HyDE）时，
  // 若 key 不区分会命中 L1 缓存返回无 HyDE 的旧结果，增量信号被静默吞掉。
  // 用布尔标志而非假想答案全文哈希——LLM 生成文本每次略有差异，全文哈希会让 FC 缓存几乎永久失效
  const hydeText = vectorQueryText?.trim() || '';
  const cacheKey = cacheKeyOverride
    ? LRUCache.makeKey(cacheKeyOverride, { ...filter, _type: 'hybrid', _vw: vw, _bw: bw, _hyde: hydeText ? 1 : 0 })
    : LRUCache.makeKey(query, { ...filter, _type: 'hybrid', _vw: vw, _bw: bw, _hyde: hydeText ? 1 : 0 });
  logger.info('混合搜索缓存key生成', {
    module: 'VectorStore',
    caller: cacheKeyOverride ? 'FC工具路径' : '非FC路径(子查询/2跳/RAG)',
    usedOverride: !!cacheKeyOverride,
    cacheKeySource: cacheKeyOverride ? 'cacheKeyOverride(归一化keywords)' : 'query(改写查询)',
    actualQueryForHash: (cacheKeyOverride || query).substring(0, 100),
    filterKeys: filter ? Object.keys(filter).sort().join(',') : 'none',
    cacheKey,
  });

  // ==================== Level 3: Alias 解析（在 Level 1 之前）====================
  // 如果 sourceKey 有稳定 alias，解析到 targetKey 后走 Level 1 精确匹配
  const aliasedKey = cacheAliasLearner.resolve(cacheKey);
  if (aliasedKey !== cacheKey) {
    logger.info('缓存 Alias 解析命中（Level 3）', {
      module: 'VectorStore',
      originalKey: cacheKey,
      aliasedKey,
    });
  }

  // ==================== Level 1: 精确匹配 ====================
  const cached = searchCache.get(aliasedKey);
  if (cached) {
    logger.info('混合搜索命中缓存', { module: 'VectorStore', query: query.substring(0, 100), cacheKey: aliasedKey, level: aliasedKey !== cacheKey ? 'L1+L3(alias)' : 'L1' });
    return cached;
  }

  // ==================== Level 2: 模糊匹配（Level 1 miss 时）====================
  // 用 keywords 做 Jaccard 相似度比对 + 槽位兼容性检查
  if (keywords && keywords.length > 0 && sessionId) {
    const slots: CacheSlots = {
      filter,
      vectorWeight: vw,
      bm25Weight: bw,
      type: 'hybrid',
      hyde: !!hydeText,
    };
    const fuzzyMatch = cacheFuzzyMatcher.findFuzzyMatch(sessionId, keywords, slots);
    if (fuzzyMatch.matched && fuzzyMatch.cacheKey) {
      const fuzzyCached = searchCache.get(fuzzyMatch.cacheKey);
      if (fuzzyCached) {
        logger.info('混合搜索模糊匹配命中缓存（Level 2）', {
          module: 'VectorStore',
          query: query.substring(0, 100),
          cacheKey: fuzzyMatch.cacheKey,
          similarity: fuzzyMatch.similarity.toFixed(3),
          matchedKeywords: fuzzyMatch.matchedKeywords,
        });

        // ==================== Level 3: 行为验证（记录 alias 候选）====================
        // Level 2 命中同一 targetKey 多次后，alias 稳定，下次走 Level 1 直接命中
        const aliasStable = cacheAliasLearner.recordAliasHit(cacheKey, fuzzyMatch.cacheKey);
        if (aliasStable) {
          logger.info('缓存 Alias 已稳定（Level 3），下次将走 Level 1 直接命中', {
            module: 'VectorStore',
            sourceKey: cacheKey,
            targetKey: fuzzyMatch.cacheKey,
          });
        }

        // 将模糊匹配结果也写入当前 cacheKey，下次相同查询走 Level 1 直接命中
        // （无需等 alias 稳定，短期内在 TTL 内直接命中）
        searchCache.set(cacheKey, fuzzyCached);
        // 同时记录到模糊匹配器索引（Level 2 命中后直接 return 不会走到后面的 record）
        cacheFuzzyMatcher.record(sessionId, cacheKey, keywords, slots);

        return fuzzyCached;
      }
    }
  }

  // 并行执行主查询向量、HyDE 向量与 BM25 三路检索
  // 向量检索内部也有缓存，主查询传入 cacheKeyOverride 保持一致
  // HyDE 集成模式（S4.2 第三轮迭代）：主查询与假想答案各检索一次、RRF 融合——
  // 主查询信号永不丢失（keyword 题不受损），假想答案作为增量信号（semantic 题受益，
  // 与真文档用词重叠度更高）；BM25 路仍用 query（关键词匹配需要真实术语）
  if (hydeText) {
    logger.info('混合检索启用 HyDE 集成模式（主查询+假想答案双向量路）', {
      module: 'VectorStore',
      hydeTextPreview: hydeText.substring(0, 100),
      hydeTextLength: hydeText.length,
    });
  }
  const [vectorResults, hydeVectorResults, bm25Results] = await Promise.all([
    searchKnowledgeBase(query, topK * 2, minSimilarity, filter, cacheKeyOverride),
    hydeText
      ? searchKnowledgeBase(hydeText, topK * 2, minSimilarity, filter)
      : Promise.resolve([] as Array<{ content: string; metadata: any; score: number }>),
    bm25Search(query, topK * 2, filter),
  ]);

  logger.info('混合搜索多路检索完成', {
    module: 'VectorStore',
    vectorResultCount: vectorResults.length,
    hydeVectorResultCount: hydeVectorResults.length,
    bm25ResultCount: bm25Results.length,
  });

  // RRF (Reciprocal Rank Fusion) 融合
  // 每个文档的融合分数 = 向量权重 / (k + 向量排名) + BM25权重 / (k + BM25排名)
  // k=60 是 RRF 论文中的经验值，防止排名靠前的文档权重过大
  const K = 60;
  // vectorScore 保留原始向量相似度分数，已从 ChromaDB cosine 距离转换为相似度：
  // similarity = 1 - distance（越大越相似），与 RRF 融合分数 score 区分开，供上层调试/重排使用。
  // 统一"越大越相似"方向，避免上层把距离当相似度使用导致排序反转
  const fusedScores = new Map<string, { content: string; metadata: any; vectorRank?: number; bm25Rank?: number; score: number; vectorScore?: number }>();

  // 向量路权重分配（HyDE 集成模式）：有假想答案时主向量路与 HyDE 向量路各占 vw 的一半，
  // 无假想答案时主向量路独占 vw（行为与改造前完全一致）
  const mainVectorWeight = hydeText ? vw * 0.5 : vw;
  const hydeVectorWeight = vw * 0.5;

  // 主查询向量检索结果
  vectorResults.forEach((result, rank) => {
    const key = result.content;
    const existing = fusedScores.get(key);
    const rrfScore = mainVectorWeight / (K + rank + 1);

    if (existing) {
      existing.vectorRank = rank + 1;
      // result.score 是 searchKnowledgeBase 返回的 cosine 距离，转成相似度后存储
      existing.vectorScore = 1 - result.score;
      existing.score += rrfScore;
    } else {
      fusedScores.set(key, {
        content: result.content,
        metadata: result.metadata,
        vectorRank: rank + 1,
        // result.score 是 searchKnowledgeBase 返回的 cosine 距离，转成相似度后存储
        vectorScore: 1 - result.score,
        score: rrfScore,
      });
    }
  });

  // HyDE 假想答案向量检索结果（增量信号：与主查询命中同一文档时 RRF 分数叠加）
  hydeVectorResults.forEach((result, rank) => {
    const key = result.content;
    const existing = fusedScores.get(key);
    const rrfScore = hydeVectorWeight / (K + rank + 1);

    if (existing) {
      // vectorRank/vectorScore 保留主向量路的值（上层阈值过滤以主查询口径为准），
      // 仅当文档未被主查询命中时才采用 HyDE 路的分数
      if (existing.vectorRank === undefined) {
        existing.vectorRank = rank + 1;
        existing.vectorScore = 1 - result.score;
      }
      existing.score += rrfScore;
    } else {
      fusedScores.set(key, {
        content: result.content,
        metadata: result.metadata,
        vectorRank: rank + 1,
        vectorScore: 1 - result.score,
        score: rrfScore,
      });
    }
  });

  // BM25 检索结果
  bm25Results.forEach((result, rank) => {
    const key = result.content;
    const existing = fusedScores.get(key);
    const rrfScore = bw / (K + rank + 1);

    if (existing) {
      existing.bm25Rank = rank + 1;
      existing.score += rrfScore;
    } else {
      fusedScores.set(key, {
        content: result.content,
        metadata: result.metadata,
        bm25Rank: rank + 1,
        score: rrfScore,
      });
    }
  });

  // 按融合分数排序，取 topK
  const results = Array.from(fusedScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  logger.info('混合搜索完成', {
    module: 'VectorStore',
    vectorResultCount: vectorResults.length,
    hydeVectorResultCount: hydeVectorResults.length,
    bm25ResultCount: bm25Results.length,
    fusedResultCount: results.length,
  });

  results.forEach((result, i) => {
    logger.debug('混合搜索结果', {
      module: 'VectorStore',
      index: i + 1,
      score: result.score.toFixed(6),
      vectorScore: result.vectorScore?.toFixed(4) ?? '-',
      vectorRank: result.vectorRank || '-',
      bm25Rank: result.bm25Rank || '-',
      content: result.content.substring(0, 50),
    });
  });

  const finalResults = results.map(result => ({
    content: result.content,
    metadata: result.metadata,
    score: result.score,
    // 原始向量相似度分数（cosine 相似度 = 1 - 距离，越大越相似）。
    // undefined 表示该结果未命中向量检索（仅 BM25 命中），上层可据此区分检索来源。
    vectorScore: result.vectorScore,
    // 来源列表（从 metadata.source 提取）
    sources: result.metadata?.source ? [result.metadata.source] : [],
  }));

  // 写入缓存
  searchCache.set(cacheKey, finalResults);

  // ==================== Level 2: 记录到模糊匹配器索引 ====================
  // 为后续查询的 Level 2 模糊匹配建立索引
  if (keywords && keywords.length > 0 && sessionId) {
    const slots: CacheSlots = {
      filter,
      vectorWeight: vw,
      bm25Weight: bw,
      type: 'hybrid',
      hyde: !!hydeText,
    };
    cacheFuzzyMatcher.record(sessionId, cacheKey, keywords, slots);
    logger.debug('缓存模糊匹配索引已记录', {
      module: 'VectorStore',
      sessionId,
      cacheKey,
      keywords,
    });
  }

  return finalResults;
}

// ==================== BM25 检索（内部） ====================

/**
 * BM25 关键词检索
 * 使用 MiniSearch 在 BM25 索引中搜索，按元数据过滤结果
 *
 * @param query 查询文本
 * @param topK 返回结果数量
 * @param filter 元数据过滤条件
 */
async function bm25Search(
  query: string,
  topK: number = 10,
  filter?: Record<string, any>,
): Promise<Array<{ content: string; metadata: any; score: number }>> {
  try {
    await initializeBM25Index();

    logger.debug('BM25 检索开始', {
      module: 'VectorStore',
      query: query.substring(0, 100),
      topK,
    });

    // 经 BM25Engine 窄接口检索，使 MiniSearch / Tantivy 双引擎均可用（红线 #10：进程内单例统一）
    const searchResults = await getBM25Engine().search(query, topK * 2);

    if (searchResults.length === 0) {
      logger.info('BM25 索引无命中，跳过关键词检索', { module: 'VectorStore' });
      return [];
    }

    logger.debug('BM25 检索原始结果', { module: 'VectorStore', resultCount: searchResults.length });

    let results = searchResults.map((r) => ({
      content: r.content,
      metadata: r.metadata,
      score: r.score,
    }));

    // 元数据过滤
    if (filter) {
      const beforeMetaFilter = results.length;
      results = results.filter((result: any) => {
        for (const [key, value] of Object.entries(filter)) {
          if (key === 'versionStatus') continue; // versionStatus 在后过滤中处理
          if (result.metadata?.[key] !== value) return false;
        }
        return true;
      });
      logger.debug('BM25 元数据过滤', {
        module: 'VectorStore',
        beforeFilter: beforeMetaFilter,
        afterFilter: results.length,
        filter,
      });
    }

    // 版本状态过滤：仅返回 active 版本
    const beforeVersionFilter = results.length;
    results = results.filter((result: any) => {
      const vs = result.metadata?.versionStatus;
      return !vs || vs === 'active';
    });
    if (beforeVersionFilter !== results.length) {
      logger.debug('BM25 版本状态过滤', {
        module: 'VectorStore',
        beforeFilter: beforeVersionFilter,
        afterFilter: results.length,
        versionFilteredOut: beforeVersionFilter - results.length,
      });
    }

    return results.slice(0, topK).map((r: any) => {
      // Parent-Child 展开：如果命中 child chunk，返回 parent 内容
      if (r.metadata?.chunk_role === 'child' && r.metadata?.parent_content) {
        return {
          content: r.metadata.parent_content,
          metadata: { ...r.metadata, _childContent: r.content },
          score: r.score,
        };
      }
      return r;
    });
  } catch (error: any) {
    searchInfraFailureCount++;
    logger.warn('BM25 搜索失败', {
      module: 'VectorStore',
      query: query.substring(0, 100),
      error: error.message,
      errorStack: error.stack?.substring(0, 300),
      infraFailureCount: searchInfraFailureCount,
    });
    return [];
  }
}
