/**
 * 多跳检索模块
 *
 * 根据首轮检索结果，让 LLM 判断是否需要追问式二次检索：
 * - 如果首轮结果不完整或不相关，自动生成追问查询
 * - 逐层深入，最多 N 跳
 * - 合并去重所有跳的结果
 *
 * 适用场景：
 * - 用户问题涉及多个概念（如"对比 A 和 B"）
 * - 首轮检索只覆盖了部分信息
 * - 需要跨文档关联推理
 */

import { logger } from '../logger.js';
import { createRateLimitedLLM, buildModelConfig } from '../model-provider.js';
import { HumanMessage } from '@langchain/core/messages';
import { hybridSearchKnowledgeBase } from './vector-search.js';
import type { RewrittenQuery } from './query-rewriter.js';
import { z } from 'zod';
import { parseLlmJson } from '../llm-json-parser.js';

export interface MultiHopResult {
  /** 合并去重后的最终结果 */
  results: Array<{
    content: string;
    metadata: any;
    score: number;
    vectorScore: number;
    sources: string[];
    /** 来自第几跳（1-based） */
    hop: number;
  }>;
  /** 实际执行的跳数 */
  hopsExecuted: number;
  /** 每跳的查询和结果摘要 */
  hopDetails: Array<{
    hop: number;
    query: string;
    resultCount: number;
  }>;
}

interface SearchResult {
  content: string;
  metadata: any;
  score: number;
  vectorScore: number;
  sources: string[];
}

const FOLLOW_UP_PROMPT = `你是一个检索策略专家。根据用户的原始问题和第一轮检索结果，判断是否需要进一步检索。

规则：
1. 如果检索结果已经完整回答了用户问题，输出 {"need_follow_up": false}
2. 如果检索结果不完整、不相关或缺少关键信息，输出 {"need_follow_up": true, "follow_up_queries": ["查询1", "查询2"]}
3. follow_up_queries 最多 3 个，每个查询应该从不同角度或关键词切入
4. 查询应该简洁、精确，适合知识库检索
5. 只输出 JSON，不要任何解释

用户问题："__QUERY__"

第一轮检索结果：
__RESULTS__`;

/**
 * 多跳检索
 *
 * @param originalQuery 原始用户查询
 * @param rewrittenQuery 改写后的查询（可选，来自 query-rewriter）
 * @param topK 最终返回的结果数量
 * @param options 配置选项
 */
export async function multiHopSearch(
  originalQuery: string,
  rewrittenQuery?: RewrittenQuery,
  topK: number = 5,
  options?: {
    /** 最大跳数，默认 2（即最多 2 轮追问检索） */
    maxHops?: number;
    /** 每跳检索的结果数量，默认 topK * 2 */
    hopTopK?: number;
    /** 是否启用多跳，默认 true */
    enabled?: boolean;
    /** 使用的模型 ID */
    modelId?: string;
    /** LLM 超时(ms)，默认 5000 */
    timeout?: number;
    /** 向量检索权重 */
    vectorWeight?: number;
    /** BM25 检索权重 */
    bm25Weight?: number;
    /** 元数据过滤条件 */
    filter?: Record<string, any>;
    /** 缓存 key 覆盖：传入原始查询确保 FC 模式下同一用户输入命中缓存 */
    cacheKeyOverride?: string;
  },
): Promise<MultiHopResult> {
  const maxHops = options?.maxHops ?? 2;
  const enabled = options?.enabled ?? true;
  const modelId = options?.modelId ?? 'deepseek:deepseek-v4-flash';
  const timeout = options?.timeout ?? 8000;
  const vectorWeight = options?.vectorWeight ?? 0.7;
  const bm25Weight = options?.bm25Weight ?? 0.3;
  const filter = options?.filter;
  const hopTopK = options?.hopTopK ?? topK * 2;
  const cacheKeyOverride = options?.cacheKeyOverride;

  logger.info('多跳检索入口', {
    module: 'MultiHopSearch',
    originalQuery: originalQuery.substring(0, 100),
    rewrittenMainQuery: rewrittenQuery?.mainQuery?.substring(0, 100),
    enabled,
    cacheKeyOverride: cacheKeyOverride?.substring(0, 100),
  });

  // 未启用多跳，直接执行单次检索
  if (!enabled) {
    return singleHopSearch(originalQuery, rewrittenQuery, topK, vectorWeight, bm25Weight, filter, cacheKeyOverride);
  }

  logger.info('多跳检索开始', {
    module: 'MultiHopSearch',
    originalQuery: originalQuery.substring(0, 100),
    maxHops,
    topK,
  });

  const allResults = new Map<string, SearchResult & { hop: number }>();
  const hopDetails: MultiHopResult['hopDetails'] = [];

  // 第 1 跳：使用改写后的主查询，缓存 key 用原始查询确保命中
  const firstQuery = rewrittenQuery?.mainQuery ?? originalQuery;
  const firstResults = await hybridSearchKnowledgeBase(firstQuery, hopTopK, vectorWeight, bm25Weight, filter, cacheKeyOverride);

  // 记录第 1 跳结果
  for (const r of firstResults) {
    if (!allResults.has(r.content)) {
      allResults.set(r.content, { ...r, hop: 1 });
    }
  }
  hopDetails.push({ hop: 1, query: firstQuery, resultCount: firstResults.length });

  // 如果改写产生了子查询，也一并检索
  if (rewrittenQuery?.subQueries && rewrittenQuery.subQueries.length > 0) {
    for (const subQ of rewrittenQuery.subQueries) {
      const subResults = await hybridSearchKnowledgeBase(subQ, hopTopK, vectorWeight, bm25Weight, filter);
      for (const r of subResults) {
        if (!allResults.has(r.content)) {
          allResults.set(r.content, { ...r, hop: 1 });
        }
      }
      hopDetails.push({ hop: 1, query: subQ, resultCount: subResults.length });
    }
  }

  logger.info('第 1 跳完成', {
    module: 'MultiHopSearch',
    query: firstQuery,
    resultCount: firstResults.length,
    totalUniqueResults: allResults.size,
  });

  // 后续跳：LLM 判断是否需要追问
  let currentHop = 1;
  while (currentHop < maxHops) {
    // 构建当前结果摘要供 LLM 判断
    const resultsSummary = Array.from(allResults.values())
      .slice(0, 5)
      .map((r, i) => `[${i + 1}] ${r.content.substring(0, 150)}`)
      .join('\n');

    const followUp = await generateFollowUpQueries(
      originalQuery,
      resultsSummary,
      modelId,
      timeout,
    );

    if (!followUp.needFollowUp || followUp.queries.length === 0) {
      logger.info('LLM 判断无需追问，多跳检索结束', {
        module: 'MultiHopSearch',
        hopsExecuted: currentHop,
      });
      break;
    }

    currentHop++;
    logger.info(`第 ${currentHop} 跳：LLM 生成追问查询`, {
      module: 'MultiHopSearch',
      followUpQueries: followUp.queries,
    });

    // 执行追问检索
    for (const q of followUp.queries) {
      const hopResults = await hybridSearchKnowledgeBase(q, hopTopK, vectorWeight, bm25Weight, filter);
      let newCount = 0;
      for (const r of hopResults) {
        if (!allResults.has(r.content)) {
          allResults.set(r.content, { ...r, hop: currentHop });
          newCount++;
        }
      }
      hopDetails.push({ hop: currentHop, query: q, resultCount: hopResults.length });
    }

    logger.info(`第 ${currentHop} 跳完成`, {
      module: 'MultiHopSearch',
      totalUniqueResults: allResults.size,
    });
  }

  // 按分数排序，取 topK
  const finalResults = Array.from(allResults.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  logger.info('多跳检索完成', {
    module: 'MultiHopSearch',
    hopsExecuted: currentHop,
    totalUniqueResults: allResults.size,
    finalResultCount: finalResults.length,
  });

  return {
    results: finalResults,
    hopsExecuted: currentHop,
    hopDetails,
  };
}

/**
 * 单跳检索（多跳未启用时的降级路径）
 */
async function singleHopSearch(
  originalQuery: string,
  rewrittenQuery: RewrittenQuery | undefined,
  topK: number,
  vectorWeight: number,
  bm25Weight: number,
  filter?: Record<string, any>,
  cacheKeyOverride?: string,
): Promise<MultiHopResult> {
  const mainQuery = rewrittenQuery?.mainQuery ?? originalQuery;
  const results = await hybridSearchKnowledgeBase(mainQuery, topK, vectorWeight, bm25Weight, filter, cacheKeyOverride);

  const allResults = new Map<string, SearchResult & { hop: number }>();
  for (const r of results) {
    if (!allResults.has(r.content)) {
      allResults.set(r.content, { ...r, hop: 1 });
    }
  }

  // 子查询也检索
  if (rewrittenQuery?.subQueries) {
    for (const subQ of rewrittenQuery.subQueries) {
      const subResults = await hybridSearchKnowledgeBase(subQ, topK, vectorWeight, bm25Weight, filter);
      for (const r of subResults) {
        if (!allResults.has(r.content)) {
          allResults.set(r.content, { ...r, hop: 1 });
        }
      }
    }
  }

  const finalResults = Array.from(allResults.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    results: finalResults,
    hopsExecuted: 1,
    hopDetails: [{ hop: 1, query: mainQuery, resultCount: results.length }],
  };
}

/**
 * 使用 LLM 判断是否需要追问检索
 */
async function generateFollowUpQueries(
  originalQuery: string,
  resultsSummary: string,
  modelId: string,
  timeout: number,
): Promise<{ needFollowUp: boolean; queries: string[] }> {
  try {
    const modelConfig = buildModelConfig(modelId, { isFCMode: false });
    modelConfig.temperature = 0.1;
    const llm = createRateLimitedLLM(modelConfig, 'fast');

    const prompt = FOLLOW_UP_PROMPT
      .replace('__QUERY__', originalQuery)
      .replace('__RESULTS__', resultsSummary || '（无检索结果）');

    const result = await Promise.race([
      llm.invoke([new HumanMessage(prompt)], {
        // 限制输出 token 数，追问判断只需短 JSON
        signal: AbortSignal.timeout(timeout),
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('追问查询生成超时')), timeout + 1000);
        // 防止 timer 泄漏：如果 AbortSignal 先触发，清理 setTimeout
        timer.unref?.();
      }),
    ]);

    const content = typeof result.content === 'string' ? result.content : '';
    return parseFollowUpResponse(content);
  } catch (error: any) {
    logger.warn('追问查询生成失败，跳过追问', {
      module: 'MultiHopSearch',
      error: error.message,
    });
    return { needFollowUp: false, queries: [] };
  }
}

/**
 * 解析 LLM 返回的追问判断
 *
 * 用 zod 替代裸 JSON.parse；解析失败一律视为"不需要追问"（保留原行为）。
 */
const FollowUpResponseSchema = z.object({
  need_follow_up: z.boolean().optional(),
  follow_up_queries: z.array(z.string()).optional(),
});

function parseFollowUpResponse(content: string): { needFollowUp: boolean; queries: string[] } {
  const result = parseLlmJson(content, FollowUpResponseSchema, {
    module: 'MultiHopSearch',
  });
  if (!result.success) {
    return { needFollowUp: false, queries: [] };
  }

  const needFollowUp = !!result.data.need_follow_up;
  const queries = (result.data.follow_up_queries || [])
    .filter((q) => q && q.trim())
    .slice(0, 3);

  return { needFollowUp, queries };
}
