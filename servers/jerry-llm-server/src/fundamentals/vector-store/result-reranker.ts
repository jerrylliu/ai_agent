/**
 * 检索结果重排模块
 *
 * 对检索结果进行相关性重排（Rerank），提升最终返回结果的质量：
 * - DashScope Reranker（默认）：调用 qwen3-vl-rerank 线上 API，精度最高
 * - LLM-based Reranker：让 LLM 对每个结果与查询的相关性打分
 * - 降级方案：基于关键词命中率的简单重排
 *
 * 重排不改变结果数量，只调整顺序，将最相关的结果排到前面。
 */

import { logger } from '../logger.js';
import { createRateLimitedLLM, buildModelConfig } from '../model-provider.js';
import { HumanMessage } from '@langchain/core/messages';
import { config } from '../config.js';
import { z } from 'zod';
import { parseLlmJson, parseToolResultJson } from '../llm-json-parser.js';

export interface RerankableResult {
  content: string;
  metadata: any;
  score: number;
  [key: string]: any;
}

export interface RerankedResult extends RerankableResult {
  /** 原始检索分数 */
  originalScore: number;
  /** 重排后的相关性分数 (0-1) */
  rerankScore: number;
}

const RERANK_PROMPT = `你是一个文档相关性评估专家。请评估每个文档片段与用户查询的相关性，给出 0-1 的分数。

评分标准：
- 1.0：完全相关，直接回答了查询
- 0.8：高度相关，包含查询的核心信息
- 0.5：部分相关，包含一些相关信息但不完整
- 0.2：略微相关，只有边缘信息
- 0.0：完全不相关

用户查询："__QUERY__"

文档片段：
__DOCUMENTS__

请输出 JSON 数组，每个元素包含 index（从0开始）和 score（0-1）：
[{"index": 0, "score": 0.9}, {"index": 1, "score": 0.3}, ...]`;

/**
 * 对检索结果进行重排
 *
 * @param query 用户查询
 * @param results 检索结果列表
 * @param options 配置选项
 * @returns 重排后的结果列表（按相关性降序）
 */
export async function rerankResults(
  query: string,
  results: RerankableResult[],
  options?: {
    /** 是否启用重排，默认 true */
    enabled?: boolean;
    /** 使用的模型 ID，默认 deepseek:deepseek-v4-flash */
    modelId?: string;
    /** LLM 超时(ms)，默认 5000 */
    timeout?: number;
    /** 重排策略：dashscope（默认）、llm、keyword */
    strategy?: 'dashscope' | 'llm' | 'keyword';
    /** 原始分数与重排分数的混合权重 (0-1)，0=纯重排，1=纯原始分数，默认 0.3 */
    originalScoreWeight?: number;
  },
): Promise<RerankedResult[]> {
  const enabled = options?.enabled ?? true;
  const strategy = options?.strategy ?? 'dashscope';
  const originalScoreWeight = options?.originalScoreWeight ?? 0.3;

  // 未启用或结果为空，直接返回
  if (!enabled || results.length === 0) {
    return results.map(r => ({
      ...r,
      originalScore: r.score,
      rerankScore: r.score,
    }));
  }

  // 只有 1 个结果，无需重排
  if (results.length === 1) {
    return [{
      ...results[0],
      originalScore: results[0].score,
      rerankScore: 1.0,
    }];
  }

  logger.info('结果重排开始', {
    module: 'ResultReranker',
    query: query.substring(0, 100),
    resultCount: results.length,
    strategy,
  });

  try {
    let reranked: RerankedResult[];

    if (strategy === 'dashscope') {
      reranked = await dashscopeRerank(query, results);
    } else if (strategy === 'llm') {
      reranked = await llmRerank(query, results, options);
    } else {
      reranked = keywordRerank(query, results);
    }

    // 混合原始分数和重排分数
    // 最终分数 = (1 - w) * rerankScore + w * normalizedOriginalScore
    if (originalScoreWeight > 0) {
      const maxOriginal = Math.max(...reranked.map(r => r.originalScore));
      const minOriginal = Math.min(...reranked.map(r => r.originalScore));

      if (maxOriginal === minOriginal) {
        // 所有原始分数相同：原始信号无区分度，直接采用 rerankScore。
        // 显式处理避免 min-max 除零后走 `range || 1` 兜底，把所有候选错误归一化成 0
        for (const r of reranked) {
          r.score = r.rerankScore;
        }
      } else {
        // rank-based 归一化：按 originalScore 降序排名线性映射到 [1, 0]。
        // 不用 min-max：RRF 融合分数分布扁平且密集（典型差距 <0.001），
        // min-max 会把毫厘级噪声放大成数量级差异，扭曲第 1 名与其后结果的相对距离；
        // rank-based 只保留检索序信息，对分数幅度不敏感
        const n = reranked.length;
        const sortedIndices = reranked
          .map((_, i) => i)
          .sort((a, b) => reranked[b].originalScore - reranked[a].originalScore);
        const normalizedByIndex = new Array<number>(n).fill(0);
        sortedIndices.forEach((idx, rank) => {
          normalizedByIndex[idx] = 1 - rank / (n - 1);
        });

        for (let i = 0; i < n; i++) {
          reranked[i].score =
            (1 - originalScoreWeight) * reranked[i].rerankScore +
            originalScoreWeight * normalizedByIndex[i];
        }
      }

      // 按混合分数重新排序
      reranked.sort((a, b) => b.score - a.score);
    } else {
      // originalScoreWeight === 0：纯重排模式，score 字段同步为 rerankScore。
      // 否则消费方（如 knowledge.controller）拿到的 r.score 仍是原始检索分数而非重排分数
      for (const r of reranked) {
        r.score = r.rerankScore;
      }
    }

    logger.info('结果重排完成', {
      module: 'ResultReranker',
      resultCount: reranked.length,
      strategy,
      topScores: reranked.slice(0, 3).map(r => ({
        rerankScore: r.rerankScore.toFixed(3),
        originalScore: r.originalScore.toFixed(4),
        finalScore: r.score.toFixed(4),
      })),
    });

    return reranked;
  } catch (error: any) {
    logger.warn('结果重排失败，返回原始排序', {
      module: 'ResultReranker',
      strategy,
      error: error.message,
    });

    return results.map(r => ({
      ...r,
      originalScore: r.score,
      rerankScore: r.score,
    }));
  }
}

// ==================== DashScope Reranker ====================

interface DashScopeRerankResult {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

interface DashScopeRerankResponse {
  output?: {
    results?: DashScopeRerankResult[];
  };
  usage?: { total_tokens: number };
  request_id?: string;
  code?: string;
  message?: string;
}

// ==================== DashScope Rerank API 响应 schema ====================
//
// 用 looseObject + 全 optional：仅校验形状，业务字段（results / code）由调用方判断
const DashScopeRerankResponseSchema = z.looseObject({
  output: z
    .looseObject({
      results: z
        .array(
          z.looseObject({
            index: z.number(),
            relevance_score: z.number(),
          }),
        )
        .optional(),
    })
    .optional(),
  usage: z.looseObject({ total_tokens: z.number() }).optional(),
  request_id: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

/**
 * DashScope Reranker：调用 qwen3-vl-rerank 线上 API
 *
 * API 文档：https://help.aliyun.com/zh/model-studio/text-rerank-api
 * 端点：POST {baseUrl}/api/v1/services/rerank/text-rerank/text-rerank
 */
async function dashscopeRerank(
  query: string,
  results: RerankableResult[],
): Promise<RerankedResult[]> {
  const apiKey = config.dashscopeApiKey;
  if (!apiKey) {
    throw new Error('DashScope API Key 未配置，请在 .env 中设置 DASHSCOPE_API_KEY');
  }

  const baseUrl = config.dashscopeBaseUrl;
  const endpoint = `${baseUrl}/api/v1/services/rerank/text-rerank/text-rerank`;

  // qwen3-vl-rerank 最多支持 100 个文本文档
  const maxDocs = 100;
  const docsToRerank = results.slice(0, maxDocs);
  const remainingDocs = results.slice(maxDocs);

  const documents = docsToRerank.map(r => r.content);

  logger.debug('DashScope Reranker 请求', {
    module: 'ResultReranker',
    endpoint,
    documentCount: documents.length,
    queryPreview: query.substring(0, 100),
  });

  const requestBody = {
    model: 'qwen3-vl-rerank',
    input: {
      query,
      documents,
    },
    parameters: {
      return_documents: false,
      top_n: docsToRerank.length,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DashScope Rerank API 请求失败 (${response.status}): ${errorText}`);
  }

  const responseText = await response.text();
  const parsed = parseToolResultJson(responseText, DashScopeRerankResponseSchema, {
    module: 'ResultReranker',
    api: 'dashscope-rerank',
  });
  if (!parsed.success) {
    throw new Error(`DashScope Rerank API 响应结构异常: ${parsed.reason}`);
  }
  const data = parsed.data;

  if (data.code) {
    throw new Error(`DashScope Rerank API 错误: [${data.code}] ${data.message}`);
  }

  const apiResults = data.output?.results || [];

  logger.debug('DashScope Reranker 响应', {
    module: 'ResultReranker',
    requestId: data.request_id,
    resultCount: apiResults.length,
    totalTokens: data.usage?.total_tokens,
  });

  // 构建 index -> relevance_score 映射
  const scoreMap = new Map<number, number>();
  for (const item of apiResults) {
    scoreMap.set(item.index, item.relevance_score);
  }

  // 构建重排结果
  const reranked: RerankedResult[] = docsToRerank.map((r, i) => ({
    ...r,
    originalScore: r.score,
    rerankScore: scoreMap.get(i) ?? 0.0,
  }));

  // 按 rerankScore 降序排序
  reranked.sort((a, b) => b.rerankScore - a.rerankScore);

  // 追加未参与重排的文档（保持原始顺序）
  for (const r of remainingDocs) {
    reranked.push({
      ...r,
      originalScore: r.score,
      rerankScore: 0.0,
    });
  }

  return reranked;
}

// ==================== LLM-based Reranker ====================

/**
 * LLM-based 重排：让 LLM 对每个结果打分
 */
async function llmRerank(
  query: string,
  results: RerankableResult[],
  options?: {
    modelId?: string;
    timeout?: number;
  },
): Promise<RerankedResult[]> {
  const modelId = options?.modelId ?? 'deepseek:deepseek-v4-flash';
  const timeout = options?.timeout ?? 5000;

  // 限制传入 LLM 的文档数量，避免 token 过长
  const maxDocsForLLM = 10;
  const docsToRerank = results.slice(0, maxDocsForLLM);
  const remainingDocs = results.slice(maxDocsForLLM);

  const documentsStr = docsToRerank
    .map((r, i) => `[${i}] ${r.content.substring(0, 200)}`)
    .join('\n\n');

  const modelConfig = buildModelConfig(modelId, { isFCMode: false });
  modelConfig.temperature = 0.1;
  const llm = createRateLimitedLLM(modelConfig, 'fast');

  const prompt = RERANK_PROMPT
    .replace('__QUERY__', query)
    .replace('__DOCUMENTS__', documentsStr);

  const result = await Promise.race([
    llm.invoke([new HumanMessage(prompt)]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('重排 LLM 调用超时')), timeout)
    ),
  ]);

  const content = typeof result.content === 'string' ? result.content : '';
  const scores = parseRerankResponse(content, docsToRerank.length);

  // 构建重排结果
  const reranked: RerankedResult[] = docsToRerank.map((r, i) => ({
    ...r,
    originalScore: r.score,
    rerankScore: scores[i] ?? 0.5,
  }));

  // 按 rerankScore 降序排序
  reranked.sort((a, b) => b.rerankScore - a.rerankScore);

  // 追加未参与 LLM 重排的文档：用关键词匹配度兜底打分并乘 0.5 衰减系数。
  // 此前固定给 0.1，在 originalScoreWeight=0.3 混合下 final ≤ 0.4，
  // 尾部文档被一刀切压死（等价于硬截断 10 条）；
  // keyword 兜底让高质量尾部文档仍有机会进入 topK，
  // 0.5 衰减保证它们整体排在 LLM 评估为高分的文档之后
  const keywordScoredRemaining = keywordRerank(query, remainingDocs);
  for (const r of keywordScoredRemaining) {
    reranked.push({
      ...r,
      rerankScore: r.rerankScore * 0.5,
    });
  }

  // 尾部文档可能获得较高 keyword 分（最高 0.5），需要重新排序。
  // dashscopeRerank 不需要这一步：其 tail 固定 0.0 分自然垫底
  reranked.sort((a, b) => b.rerankScore - a.rerankScore);

  return reranked;
}

// ==================== 关键词重排（降级方案） ====================

/**
 * 关键词命中重排（降级方案，不依赖 LLM / API）
 */
function keywordRerank(
  query: string,
  results: RerankableResult[],
): RerankedResult[] {
  const queryTerms = extractTerms(query);

  const scored = results.map(r => {
    const contentTerms = extractTerms(r.content);
    let matchCount = 0;

    for (const term of queryTerms) {
      if (contentTerms.has(term)) {
        matchCount++;
      } else {
        // 模糊匹配：查询词与内容词互为子串。
        // 权重 0.2（原 0.5 过高：子串误触率高，如英文 "data"⊂"database"、
        // 中文单字"图"⊂"试图/图像/地图"，过高会稀释精确匹配信号）；
        // 英文仅对长度 ≥ 3 的词启用，避免 "of/the" 等短词大量误触；
        // 中文词项（bigram/单字退化）长度天然短，不设长度门槛
        const isChineseTerm = /[\u4e00-\u9fff]/.test(term);
        if (isChineseTerm || term.length >= 3) {
          for (const ct of contentTerms) {
            if (ct.includes(term) || term.includes(ct)) {
              matchCount += 0.2;
              break;
            }
          }
        }
      }
    }

    const rerankScore = queryTerms.size > 0
      ? Math.min(matchCount / queryTerms.size, 1.0)
      : 0.5;

    return {
      ...r,
      originalScore: r.score,
      rerankScore,
    } as RerankedResult;
  });

  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  return scored;
}

// ==================== 工具函数 ====================

/**
 * 提取文本中的词项（中文按字/词，英文按空格分词）
 */
function extractTerms(text: string): Set<string> {
  const terms = new Set<string>();

  // 英文词
  const englishWords = text.match(/[a-zA-Z]{2,}/g) || [];
  for (const w of englishWords) {
    terms.add(w.toLowerCase());
  }

  // 中文二元组（bigram）：中文单字歧义大（"中"会误匹配"中间/中心/中文"），
  // 默认只用 bigram；仅当整段文本只含单个汉字时退化为单字，
  // 保证极短查询（如"图"）仍有词项可参与匹配（借助子串匹配命中 bigram）
  const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
  if (chineseChars.length === 1) {
    terms.add(chineseChars[0]);
  } else {
    for (let i = 0; i < chineseChars.length - 1; i++) {
      terms.add(chineseChars[i] + chineseChars[i + 1]);
    }
  }

  return terms;
}

/**
 * 解析 LLM 返回的重排分数
 *
 * 用 zod 校验代替裸 JSON.parse；解析失败一律降级为均分 0.5（保持原行为）。
 */
const RerankScoreItemSchema = z.object({
  index: z.number(),
  score: z.number(),
});
const RerankResponseSchema = z.array(RerankScoreItemSchema);

function parseRerankResponse(content: string, expectedCount: number): number[] {
  const fallback = () => new Array(expectedCount).fill(0.5);

  const result = parseLlmJson(content, RerankResponseSchema, {
    module: 'ResultReranker',
    expectedCount,
  });
  if (!result.success) {
    return fallback();
  }

  // 构建 index -> score 映射
  const scoreMap = new Map<number, number>();
  for (const item of result.data) {
    scoreMap.set(item.index, Math.max(0, Math.min(1, item.score)));
  }

  // 按顺序返回分数，缺失的给默认 0.5
  const scores: number[] = [];
  for (let i = 0; i < expectedCount; i++) {
    scores.push(scoreMap.get(i) ?? 0.5);
  }
  return scores;
}
