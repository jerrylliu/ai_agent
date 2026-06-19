/**
 * 查询改写模块
 *
 * 使用 LLM 将用户的自然语言查询改写为更适合检索的形式：
 * - 提取核心实体和关键词
 * - 补充同义词和相关术语
 * - 拆解复合问题为多个子查询
 *
 * 改写后的查询能显著提升向量检索和 BM25 检索的召回率。
 */

import { logger } from '../logger.js';
import { createRateLimitedLLM, buildModelConfig } from '../model-provider.js';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { parseLlmJson } from '../llm-json-parser.js';

export interface RewrittenQuery {
  /** 改写后的主查询 */
  mainQuery: string;
  /** 拆解的子查询（复合问题时生成） */
  subQueries: string[];
  /** 提取的关键词 */
  keywords: string[];
  /** 是否发生了改写 */
  wasRewritten: boolean;
}

const REWRITE_PROMPT = `你是一个查询改写专家。你的任务是将用户的自然语言查询改写为更适合知识库检索的形式。

规则：
1. 提取核心实体和关键概念，去除口语化表达
2. 补充同义词和相关术语，用空格分隔
3. 如果是复合问题，拆解为多个独立的子查询
4. 保持原意不变，不要添加原文没有的信息
5. 输出严格的 JSON 格式

示例：
输入："怎么配置数据库连接？"
输出：{"main_query": "数据库 连接 配置 database connection configuration", "sub_queries": ["数据库连接配置方法", "database connection setup"], "keywords": ["数据库", "连接", "配置"]}

输入："项目部署和监控怎么做"
输出：{"main_query": "项目 部署 监控 deploy monitor", "sub_queries": ["项目部署流程和方法", "项目监控方案和工具"], "keywords": ["项目", "部署", "监控"]}

输入："什么是RAG"
输出：{"main_query": "RAG 检索增强生成 retrieval augmented generation", "sub_queries": [], "keywords": ["RAG", "检索增强生成"]}

现在请改写以下查询，只输出 JSON，不要任何解释：
输入："__QUERY__"`;

/**
 * 使用 LLM 改写查询
 *
 * @param query 原始用户查询
 * @param options 配置选项
 * @returns 改写后的查询结果
 */
export async function rewriteQuery(
  query: string,
  options?: {
    /** 是否启用改写，默认 true。设为 false 则直接返回原始查询 */
    enabled?: boolean;
    /** 使用的模型 ID，默认 deepseek:deepseek-v4-flash（速度快、成本低） */
    modelId?: string;
    /** 超时时间(ms)，默认 5000 */
    timeout?: number;
  },
): Promise<RewrittenQuery> {
  const enabled = options?.enabled ?? true;
  const modelId = options?.modelId ?? 'deepseek:deepseek-v4-flash';
  const timeout = options?.timeout ?? 5000;

  // 未启用或查询过短，直接返回
  if (!enabled || !query || query.trim().length < 3) {
    return {
      mainQuery: query,
      subQueries: [],
      keywords: extractKeywordsSimple(query),
      wasRewritten: false,
    };
  }

  logger.info('查询改写开始', {
    module: 'QueryRewriter',
    originalQuery: query.substring(0, 100),
    modelId,
  });

  try {
    const modelConfig = buildModelConfig(modelId, { isFCMode: false });
    // 改写不需要高温度，降低随机性
    modelConfig.temperature = 0.1;
    const llm = createRateLimitedLLM(modelConfig, 'fast');

    const prompt = REWRITE_PROMPT.replace('__QUERY__', query);

    // 带超时的 LLM 调用
    const result = await Promise.race([
      llm.invoke([new HumanMessage(prompt)]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('查询改写超时')), timeout)
      ),
    ]);

    const content = typeof result.content === 'string' ? result.content : '';
    const parsed = parseRewriteResponse(content, query);

    logger.info('查询改写完成', {
      module: 'QueryRewriter',
      originalQuery: query.substring(0, 100),
      mainQuery: parsed.mainQuery.substring(0, 100),
      subQueryCount: parsed.subQueries.length,
      keywordCount: parsed.keywords.length,
      wasRewritten: parsed.wasRewritten,
    });

    return parsed;
  } catch (error: any) {
    logger.warn('查询改写失败，回退到原始查询', {
      module: 'QueryRewriter',
      originalQuery: query.substring(0, 100),
      error: error.message,
    });

    return {
      mainQuery: query,
      subQueries: [],
      keywords: extractKeywordsSimple(query),
      wasRewritten: false,
    };
  }
}

/**
 * 解析 LLM 返回的改写结果
 *
 * 用 zod 替代裸 JSON.parse；解析失败回退到原始查询（保留原行为）。
 */
const RewriteResponseSchema = z.object({
  main_query: z.string().optional(),
  sub_queries: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
});

function parseRewriteResponse(content: string, originalQuery: string): RewrittenQuery {
  const fallback = (): RewrittenQuery => ({
    mainQuery: originalQuery,
    subQueries: [],
    keywords: extractKeywordsSimple(originalQuery),
    wasRewritten: false,
  });

  const result = parseLlmJson(content, RewriteResponseSchema, {
    module: 'QueryRewriter',
    originalQueryPreview: originalQuery.substring(0, 100),
  });
  if (!result.success) {
    return fallback();
  }

  const { main_query, sub_queries, keywords } = result.data;

  const mainQuery =
    main_query && main_query.trim() ? main_query.trim() : originalQuery;

  const subQueries = (sub_queries || []).filter((q) => q && q.trim());
  const keywordList = (keywords || []).filter((k) => k && k.trim());

  return {
    mainQuery,
    subQueries,
    keywords: keywordList,
    wasRewritten: mainQuery !== originalQuery,
  };
}

/**
 * 简单关键词提取（不依赖 LLM 的降级方案）
 * 按标点和停用词拆分，去除短词
 */
function extractKeywordsSimple(query: string): string[] {
  if (!query) return [];

  // 中文停用词
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
    '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
    '着', '没有', '看', '好', '自己', '这', '他', '她', '它', '吗', '呢',
    '什么', '怎么', '如何', '哪', '哪些', '为什么', '可以', '能', '还是',
    '那个', '这个', '那个', '哪个', '多少', '几', '做', '把', '让', '被',
  ]);

  return query
    .split(/[\s,，。？?！!、；;：:""''（）()\[\]【】{}]+/)
    .filter(word => word.length >= 2 && !stopWords.has(word));
}
