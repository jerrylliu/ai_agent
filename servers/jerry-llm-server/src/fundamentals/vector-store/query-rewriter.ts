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
  /**
   * 查询类型分类（HyDE 路由用，S4.2）：
   * - 'keyword'：事实/实体/指标类，问题用词与文档用词会重叠，常规改写检索即可
   * - 'semantic'：概念/原理/场景/因果类，问题与文档用词可能完全不重叠，
   *   建议用 hypotheticalAnswer 做向量检索（HyDE），BM25 仍走关键词
   */
  queryType: 'keyword' | 'semantic';
  /**
   * HyDE 假想答案（所有查询生成，集成模式）：用文档最可能采用的表述写出
   * 「答案原文长什么样」。向量路做主查询 + 假想答案双路检索并 RRF 融合——
   * 主查询信号永不丢失，假想答案为增量信号（与真文档用词重叠度更高），
   * BM25 路仍用 mainQuery/keywords（关键词匹配需要真实术语）。降级/缺失时为空串。
   */
  hypotheticalAnswer: string;
}

const REWRITE_PROMPT = `你是查询改写专家。将用户查询改写为适合知识库检索的形式，输出严格 JSON。

规则：
1. query_type："keyword"=事实/实体/指标类（问题用词与文档重叠）；"semantic"=概念/原理/场景/因果类（问题与文档用词可能不重叠）
2. main_query：核心实体+同义词，空格分隔
3. sub_queries：多视角扩展查询数组（所有查询都必须输出 2-3 条，包括单一问题）——每条用不同的表述视角重述同一信息需求：换同义词、换句式（问句/陈述句）、换抽象层级（具体实例/上位概念）、换相关场景词。禁止与 main_query 用词完全重复
4. keywords：核心关键词数组
5. hypothetical_answer：所有查询都必须输出，不超过 40 词，用「知识库文档中最可能包含答案的原文段落」的专业表述写出假想答案，禁止复述问题
6. 保持原意，只输出 JSON，不要解释

示例：
输入："项目部署和监控怎么做"
输出：{"query_type":"keyword","main_query":"项目 部署 监控 deploy monitor","sub_queries":["项目部署流程和方法","deploy pipeline 监控告警方案","release monitoring best practices"],"keywords":["项目","部署","监控"],"hypothetical_answer":"Projects follow a staged pipeline with CI build, staging validation and canary release, while centralized dashboards track QPS, latency percentiles and error budgets."}

输入："为什么高峰期系统卡顿但监控看起来正常？"
输出：{"query_type":"semantic","main_query":"高峰期 性能卡顿 监控盲区 peak load latency p99 monitoring blind spot","sub_queries":["系统在负载大时变慢但仪表盘没有异常的原因","生产环境延迟尖峰与平均值掩盖问题","user-perceived slowdown despite healthy metrics"],"keywords":["高峰期","卡顿","监控"],"hypothetical_answer":"Peak-hour latency spikes from connection pool exhaustion and GC pauses are masked by average utilization dashboards; p99 per-endpoint tracing reveals user-facing degradation."}

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
      queryType: 'keyword',
      hypotheticalAnswer: '',
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

    // 带超时的 LLM 调用。
    // 关键：超时必须「真正取消在途请求」——原实现用 Promise.race 只放弃等待、不取消请求，
    // 被放弃的调用仍会跑完并继续占用 DeepSeek 令牌桶与 fast 池槽位，
    // 在评测/高并发下形成幽灵负载、把排队时间进一步推高（实测 500 题主跑改写降级率 38.5%）。
    // AbortSignal.timeout 交给 fetch 层强制中断，限流器捕获 abort 后会退还令牌。
    const signal = AbortSignal.timeout(timeout);
    const result = await llm.invoke([new HumanMessage(prompt)], { signal });

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
    // AbortSignal.timeout 触发时抛 AbortError，转成明确的中文原因便于日志统计与定位
    const aborted =
      error?.name === 'AbortError' ||
      error?.name === 'APIUserAbortError' ||
      /abort/i.test(String(error?.message ?? ''));
    logger.warn('查询改写失败，回退到原始查询', {
      module: 'QueryRewriter',
      originalQuery: query.substring(0, 100),
      error: aborted ? `查询改写超时（${timeout}ms）` : error.message,
    });

    return {
      mainQuery: query,
      subQueries: [],
      keywords: extractKeywordsSimple(query),
      wasRewritten: false,
      queryType: 'keyword',
      hypotheticalAnswer: '',
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
  query_type: z.enum(['keyword', 'semantic']).optional(),
  hypothetical_answer: z.string().optional(),
});

function parseRewriteResponse(content: string, originalQuery: string): RewrittenQuery {
  const fallback = (): RewrittenQuery => ({
    mainQuery: originalQuery,
    subQueries: [],
    keywords: extractKeywordsSimple(originalQuery),
    wasRewritten: false,
    queryType: 'keyword',
    hypotheticalAnswer: '',
  });

  const result = parseLlmJson(content, RewriteResponseSchema, {
    module: 'QueryRewriter',
    originalQueryPreview: originalQuery.substring(0, 100),
  });
  if (!result.success) {
    return fallback();
  }

  const { main_query, sub_queries, keywords, query_type, hypothetical_answer } = result.data;

  const mainQuery =
    main_query && main_query.trim() ? main_query.trim() : originalQuery;

  const subQueries = (sub_queries || []).filter((q) => q && q.trim());
  const keywordList = (keywords || []).filter((k) => k && k.trim());
  // HyDE 假想答案（集成模式）：取消 query_type 门控——实测分类器把含实体词的语义题
  // 几乎全判为 keyword（评测 0/201 触发），门控让 HyDE 完全失效；改为所有查询保留
  // 假想答案，向量路做主查询 + HyDE 双路 RRF 融合（主查询信号不丢失）。
  // 解析缺失/降级时为空串，下游按空串判断退回单路检索，行为与改造前一致
  const hypotheticalAnswer = hypothetical_answer?.trim() ?? '';

  return {
    mainQuery,
    subQueries,
    keywords: keywordList,
    wasRewritten: mainQuery !== originalQuery,
    queryType: query_type ?? 'keyword',
    hypotheticalAnswer,
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
