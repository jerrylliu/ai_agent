/**
 * 知识库检索工具（增强版）
 *
 * 集成三阶段检索增强策略：
 * 1. Query Rewriting：LLM 改写用户查询，提升召回率
 * 2. Multi-hop Search：多跳检索，根据首轮结果追问式二次检索
 * 3. Result Reranking：对检索结果相关性重排
 *
 * 所有增强策略均可通过参数独立开关，降级时自动回退到原始混合检索。
 */

import { z } from 'zod';
import { hybridSearchKnowledgeBase } from '../vector-store';
import { rewriteQuery, type RewrittenQuery } from '../vector-store/query-rewriter';
import { multiHopSearch, type MultiHopResult } from '../vector-store/multi-hop-search';
import { rerankResults, type RerankedResult } from '../vector-store/result-reranker';
import { logger } from '../logger';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== Zod Schema（仅暴露给 LLM 的字段）====================

/**
 * 注意：`_options` 是服务端内部使用的扩展配置，**不能**暴露给 LLM，
 * 因此不在此 schema 中声明。executor 会单独从原始 params 中提取 _options。
 */
export const searchKnowledgeBaseParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('搜索查询语句，应该是一个精确的、能匹配知识库内容的问题或关键词'),
  top_k: z
    .number()
    .int()
    .positive()
    .default(3)
    .describe('返回的最相关文档数量，默认3'),
  document_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('限定搜索的文档ID，不传则搜索所有文档'),
});

export type SearchKnowledgeBaseLLMParams = z.infer<typeof searchKnowledgeBaseParamsSchema>;

// ==================== OpenAI Function Calling Schema ====================

export const searchKnowledgeBaseSchema = buildToolJsonSchema(
  'search_knowledge_base',
  '搜索知识库中与查询相关的文档内容。当用户的问题可能涉及已上传的文档、知识库中的信息时，使用此工具进行精确搜索。不要对与知识库无关的通用问题使用此工具。',
  searchKnowledgeBaseParamsSchema,
);

// ==================== Runtime 类型（含内部 _options）====================

export interface SearchKnowledgeBaseParams {
  query: string;
  top_k?: number;
  document_id?: number;
  /** 检索增强选项（内部使用，不暴露给 LLM） */
  _options?: SearchEnhancementOptions;
}

export interface SearchEnhancementOptions {
  /** 是否启用查询改写，默认 true */
  enableQueryRewrite?: boolean;
  /** 是否启用多跳检索，默认 true */
  enableMultiHop?: boolean;
  /** 是否启用结果重排，默认 true */
  enableRerank?: boolean;
  /** 重排策略：dashscope（默认）、llm、keyword */
  rerankStrategy?: 'dashscope' | 'llm' | 'keyword';
  /** 多跳最大跳数，默认 2 */
  maxHops?: number;
  /** LLM 模型 ID，默认 deepseek:deepseek-v4-flash */
  modelId?: string;
}

export interface SearchKnowledgeBaseResult {
  results: Array<{
    content: string;
    source: string;
    score: number;
    documentId: string;
    versionId: string;
    /** 来自第几跳（多跳检索时有效） */
    hop?: number;
    /** 重排相关性分数（启用重排时有效） */
    rerankScore?: number;
  }>;
  total: number;
  query: string;
  /** 检索增强元信息 */
  meta?: {
    /** 查询是否被改写 */
    queryRewritten: boolean;
    /** 改写后的主查询 */
    rewrittenQuery?: string;
    /** 实际执行的跳数 */
    hopsExecuted?: number;
    /** 是否进行了重排 */
    reranked: boolean;
    /** 各阶段耗时(ms) */
    timings: {
      queryRewrite?: number;
      search?: number;
      rerank?: number;
      total: number;
    };
  };
}

export async function executeSearchKnowledgeBase(
  params: unknown,
  context?: { originalQuery?: string },
): Promise<SearchKnowledgeBaseResult> {
  const totalStartTime = Date.now();
  const timings: NonNullable<SearchKnowledgeBaseResult['meta']>['timings'] = { total: 0 };

  // 1. 用 zod 校验 LLM 暴露字段（query / top_k / document_id）
  const parsed = safeParseToolParams(searchKnowledgeBaseParamsSchema, params);
  if (!parsed.success) {
    logger.warn('FC工具 [search_knowledge_base] 参数校验失败', {
      module: 'Tool:SearchKnowledgeBase',
      error: parsed.error,
      rawParams: JSON.stringify(params),
    });
    return {
      results: [],
      total: 0,
      query: (params as { query?: string })?.query || '',
      meta: {
        queryRewritten: false,
        reranked: false,
        timings: { total: 0 },
      },
    };
  }

  // 2. 单独从原始 params 中提取内部 _options（zod schema 中不声明，避免被
  //    OpenAI Function Calling Schema 暴露给 LLM）
  const opts: SearchEnhancementOptions =
    (params as { _options?: SearchEnhancementOptions })?._options ?? {};

  const query = parsed.data.query;
  const topK = parsed.data.top_k;
  const documentId = parsed.data.document_id;

  logger.info('FC工具 [search_knowledge_base] 开始执行（增强版）', {
    module: 'Tool:SearchKnowledgeBase',
    query,
    top_k: topK,
    document_id: documentId,
    options: opts,
  });

  const enableQueryRewrite = opts.enableQueryRewrite ?? true;
  const enableMultiHop = opts.enableMultiHop ?? true;
  const enableRerank = opts.enableRerank ?? true;
  const filter: Record<string, string> = {};

  if (documentId) {
    filter.documentId = String(documentId);
  }

  // ==================== 阶段 1：查询改写 ====================
  let rewrittenQuery: RewrittenQuery | undefined;
  if (enableQueryRewrite) {
    const rewriteStart = Date.now();
    try {
      rewrittenQuery = await rewriteQuery(query, {
        enabled: true,
        modelId: opts.modelId,
      });
      timings.queryRewrite = Date.now() - rewriteStart;

      logger.info('FC工具 [search_knowledge_base] 查询改写完成', {
        module: 'Tool:SearchKnowledgeBase',
        originalQuery: query.substring(0, 100),
        mainQuery: rewrittenQuery.mainQuery.substring(0, 100),
        subQueryCount: rewrittenQuery.subQueries.length,
        wasRewritten: rewrittenQuery.wasRewritten,
        duration: timings.queryRewrite,
      });
    } catch (error: any) {
      timings.queryRewrite = Date.now() - rewriteStart;
      logger.warn('FC工具 [search_knowledge_base] 查询改写失败，使用原始查询', {
        module: 'Tool:SearchKnowledgeBase',
        error: error.message,
      });
    }
  }

  // ==================== 阶段 2：多跳检索 ====================
  let searchResult: MultiHopResult;
  const searchStart = Date.now();

  // 缓存 key 用用户原始输入（context.originalQuery），而非 LLM 生成的工具参数（query）
  // 因为 LLM 每次生成的 query 可能有微小差异（如多一个空格），导致缓存 key 不一致
  const cacheKeyOverride = context?.originalQuery || query;

  logger.info('FC工具 [search_knowledge_base] 进入检索阶段', {
    module: 'Tool:SearchKnowledgeBase',
    originalQuery: query.substring(0, 100),
    rewrittenMainQuery: rewrittenQuery?.mainQuery?.substring(0, 100),
    enableMultiHop,
    cacheKeyOverride: cacheKeyOverride.substring(0, 100),
    cacheKeyOverrideSource: context?.originalQuery ? 'context.originalQuery(用户原始输入)' : 'params.query(LLM生成)',
  });

  try {
    if (enableMultiHop) {
      searchResult = await multiHopSearch(
        query,
        rewrittenQuery,
        topK,
        {
          maxHops: opts.maxHops ?? 2,
          enabled: true,
          modelId: opts.modelId,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
          cacheKeyOverride,
        },
      );
    } else {
      // 单跳：直接用改写后的查询检索
      // 传入 cacheKeyOverride = 用户原始输入，确保同一用户输入命中缓存
      // （改写后的查询每次可能不同，导致缓存 key 不一致）
      const effectiveQuery = rewrittenQuery?.mainQuery ?? query;
      const rawResults = await hybridSearchKnowledgeBase(
        effectiveQuery,
        topK,
        0.7,
        0.3,
        Object.keys(filter).length > 0 ? filter : undefined,
        cacheKeyOverride,
      );
      searchResult = {
        results: rawResults.map(r => ({ ...r, hop: 1 })),
        hopsExecuted: 1,
        hopDetails: [{ hop: 1, query: effectiveQuery, resultCount: rawResults.length }],
      };

      // 子查询也检索
      if (rewrittenQuery?.subQueries && rewrittenQuery.subQueries.length > 0) {
        for (const subQ of rewrittenQuery.subQueries) {
          const subResults = await hybridSearchKnowledgeBase(
            subQ,
            topK,
            0.7,
            0.3,
            Object.keys(filter).length > 0 ? filter : undefined,
          );
          for (const r of subResults) {
            if (!searchResult.results.some(existing => existing.content === r.content)) {
              searchResult.results.push({ ...r, hop: 1 });
            }
          }
          searchResult.hopDetails.push({ hop: 1, query: subQ, resultCount: subResults.length });
        }
        // 重新排序取 topK
        searchResult.results.sort((a, b) => b.score - a.score);
        searchResult.results = searchResult.results.slice(0, topK);
      }
    }

    timings.search = Date.now() - searchStart;

    logger.info('FC工具 [search_knowledge_base] 检索完成', {
      module: 'Tool:SearchKnowledgeBase',
      resultCount: searchResult.results.length,
      hopsExecuted: searchResult.hopsExecuted,
      duration: timings.search,
    });
  } catch (searchError: any) {
    timings.search = Date.now() - searchStart;
    const duration = Date.now() - totalStartTime;
    timings.total = duration;

    logger.error('FC工具 [search_knowledge_base] 检索失败', {
      module: 'Tool:SearchKnowledgeBase',
      query,
      duration,
      error: searchError.message,
      errorStack: searchError.stack?.substring(0, 500),
    });
    throw searchError;
  }

  // ==================== 阶段 3：结果重排 ====================
  let rerankedResults: RerankedResult[];
  let wasReranked = false;

  if (enableRerank && searchResult.results.length > 1) {
    const rerankStart = Date.now();
    try {
      rerankedResults = await rerankResults(
        query,
        searchResult.results,
        {
          enabled: true,
          strategy: opts.rerankStrategy ?? 'dashscope',
          modelId: opts.modelId,
        },
      );
      timings.rerank = Date.now() - rerankStart;
      wasReranked = true;

      logger.info('FC工具 [search_knowledge_base] 结果重排完成', {
        module: 'Tool:SearchKnowledgeBase',
        resultCount: rerankedResults.length,
        duration: timings.rerank,
        topRerankScores: rerankedResults.slice(0, 3).map(r => r.rerankScore.toFixed(3)),
      });
    } catch (error: any) {
      timings.rerank = Date.now() - rerankStart;
      logger.warn('FC工具 [search_knowledge_base] 结果重排失败，使用原始排序', {
        module: 'Tool:SearchKnowledgeBase',
        error: error.message,
      });
      rerankedResults = searchResult.results.map(r => ({
        ...r,
        originalScore: r.score,
        rerankScore: r.score,
      }));
    }
  } else {
    rerankedResults = searchResult.results.map(r => ({
      ...r,
      originalScore: r.score,
      rerankScore: r.score,
    }));
  }

  // ==================== 构建最终结果 ====================
  const totalDuration = Date.now() - totalStartTime;
  timings.total = totalDuration;

  const mappedResults = rerankedResults.map((r, idx) => {
    const contentPreview = r.content.length > 100 ? r.content.substring(0, 100) + '...' : r.content;
    logger.debug(`FC工具 [search_knowledge_base] 结果 #${idx + 1}`, {
      module: 'Tool:SearchKnowledgeBase',
      index: idx + 1,
      score: r.score,
      rerankScore: r.rerankScore,
      hop: r.hop,
      source: r.metadata?.source || '未知来源',
      documentId: r.metadata?.documentId || '',
      versionId: r.metadata?.versionId || '',
      contentPreview,
    });

    return {
      content: r.content,
      source: r.metadata?.source || '未知来源',
      score: r.score,
      documentId: r.metadata?.documentId || '',
      versionId: r.metadata?.versionId || '',
      hop: r.hop,
      rerankScore: wasReranked ? r.rerankScore : undefined,
    };
  });

  const finalResult: SearchKnowledgeBaseResult = {
    results: mappedResults,
    total: mappedResults.length,
    query,
    meta: {
      queryRewritten: rewrittenQuery?.wasRewritten ?? false,
      rewrittenQuery: rewrittenQuery?.wasRewritten ? rewrittenQuery.mainQuery : undefined,
      hopsExecuted: searchResult.hopsExecuted,
      reranked: wasReranked,
      timings,
    },
  };

  logger.info('FC工具 [search_knowledge_base] 执行完成（增强版）', {
    module: 'Tool:SearchKnowledgeBase',
    query,
    totalResults: finalResult.total,
    duration: totalDuration,
    meta: finalResult.meta,
    resultScores: mappedResults.map(r => r.score.toFixed(4)),
  });

  return finalResult;
}
