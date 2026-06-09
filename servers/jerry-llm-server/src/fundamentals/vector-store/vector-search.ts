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
  getBM25Index,
  getBM25DocumentStore,
} from './store-state.js';
import {
  initializeBM25Index,
} from './bm25-index.js';

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
): Promise<Array<{ content: string; metadata: any; score: number }>> {
  const store = await initializeVectorStore();

  logger.info('搜索知识库', { module: 'VectorStore', query });
  if (filter) {
    logger.debug('搜索过滤条件', { module: 'VectorStore', filter });
  }

  try {
    // 向量检索：不在 where 中过滤 versionStatus，改为结果后过滤（兼容旧数据无 versionStatus 字段）
    const searchFilter = { ...filter };
    delete searchFilter.versionStatus;
    const results = await store.similaritySearchWithScore(query, topK * 3, Object.keys(searchFilter).length > 0 ? searchFilter : undefined);

    logger.info('检索到结果', { module: 'VectorStore', resultCount: results.length });

    results.forEach(([doc, score], i) => {
      logger.debug('搜索结果', { module: 'VectorStore', index: i, score: score.toFixed(4), docType: doc.metadata?.doc_type, versionStatus: doc.metadata?.versionStatus });
    });

    // 后过滤：只保留 active 版本（无 versionStatus 的旧数据视为 active）
    const filtered = results
      .filter(([doc, score]) => {
        // 相似度过滤
        if (score > minSimilarity) return false;
        // 版本状态过滤：无 versionStatus 或 versionStatus=active
        const vs = doc.metadata?.versionStatus;
        return !vs || vs === 'active';
      })
      .slice(0, topK);

    logger.info('搜索结果过滤完成', { module: 'VectorStore', minSimilarity, filteredCount: filtered.length });

    return filtered.map(([doc, score]) => ({
      content: doc.pageContent,
      metadata: doc.metadata,
      score,
    }));
  } catch (error: any) {
    logger.error('搜索失败', { module: 'VectorStore', error: error.message });
    return [];
  }
}

// ==================== 混合搜索 ====================

/**
 * 混合搜索（向量检索 + BM25 关键词检索）
 * 使用 RRF (Reciprocal Rank Fusion) 融合两种检索结果
 *
 * @param query 查询文本
 * @param topK 返回结果数量
 * @param vectorWeight 向量检索权重 (0-1)，默认 0.7
 * @param bm25Weight BM25 检索权重 (0-1)，默认 0.3
 * @param filter 元数据过滤条件
 */
export async function hybridSearchKnowledgeBase(
  query: string,
  topK: number = 5,
  vectorWeight: number = 0.7,
  bm25Weight: number = 0.3,
  filter?: Record<string, any>,
): Promise<Array<{ content: string; metadata: any; score: number; vectorScore: number; sources: string[] }>> {
  logger.info('混合搜索知识库', { module: 'VectorStore', query, vectorWeight, bm25Weight });

  // 并行执行向量检索和 BM25 检索
  const [vectorResults, bm25Results] = await Promise.all([
    searchKnowledgeBase(query, topK * 2, 0.55, filter),
    bm25Search(query, topK * 2, filter),
  ]);

  // RRF (Reciprocal Rank Fusion) 融合
  // 每个文档的融合分数 = 向量权重 / (k + 向量排名) + BM25权重 / (k + BM25排名)
  // k=60 是 RRF 论文中的经验值，防止排名靠前的文档权重过大
  const K = 60;
  const fusedScores = new Map<string, { content: string; metadata: any; vectorRank?: number; bm25Rank?: number; score: number }>();

  // 向量检索结果
  vectorResults.forEach((result, rank) => {
    const key = result.content;
    const existing = fusedScores.get(key);
    const rrfScore = vectorWeight / (K + rank + 1);

    if (existing) {
      existing.vectorRank = rank + 1;
      existing.score += rrfScore;
    } else {
      fusedScores.set(key, {
        content: result.content,
        metadata: result.metadata,
        vectorRank: rank + 1,
        score: rrfScore,
      });
    }
  });

  // BM25 检索结果
  bm25Results.forEach((result, rank) => {
    const key = result.content;
    const existing = fusedScores.get(key);
    const rrfScore = bm25Weight / (K + rank + 1);

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
    bm25ResultCount: bm25Results.length,
    fusedResultCount: results.length,
  });

  results.forEach((result, i) => {
    logger.debug('混合搜索结果', {
      module: 'VectorStore',
      index: i + 1,
      score: result.score.toFixed(6),
      vectorRank: result.vectorRank || '-',
      bm25Rank: result.bm25Rank || '-',
      content: result.content.substring(0, 50),
    });
  });

  return results.map(result => ({
    content: result.content,
    metadata: result.metadata,
    score: result.score,
    // 向量检索分数（用于调试，RRF 融合后为融合分数）
    vectorScore: result.vectorRank ? result.score : 0,
    // 来源列表（从 metadata.source 提取）
    sources: result.metadata?.source ? [result.metadata.source] : [],
  }));
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

    const bm25Index = getBM25Index();
    const bm25DocumentStore = getBM25DocumentStore();

    if (!bm25Index || bm25Index.documentCount === 0) {
      logger.info('BM25 索引为空，跳过关键词检索', { module: 'VectorStore' });
      return [];
    }

    const searchResults = bm25Index.search(query, { limit: topK * 2 });

    let results = searchResults
      .map((result: any) => {
        const doc = bm25DocumentStore.get(result.id);
        return {
          content: doc?.content || result.content,
          metadata: doc?.metadata || {},
          score: result.score,
        };
      });

    // 元数据过滤
    if (filter) {
      results = results.filter((result: any) => {
        for (const [key, value] of Object.entries(filter)) {
          if (key === 'versionStatus') continue; // versionStatus 在后过滤中处理
          if (result.metadata?.[key] !== value) return false;
        }
        return true;
      });
    }

    // 版本状态过滤：仅返回 active 版本
    results = results.filter((result: any) => {
      const vs = result.metadata?.versionStatus;
      return !vs || vs === 'active';
    });

    return results.slice(0, topK);
  } catch (error: any) {
    logger.warn('BM25 搜索失败', { module: 'VectorStore', error: error.message });
    return [];
  }
}
