import { z } from 'zod';
import { logger } from '../logger';
import { config } from '../config';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';
import { parseToolResultJson } from '../llm-json-parser';

// ==================== 联网搜索 API 响应 schema ====================
//
// 搜索 API（自部署 SearXNG 兼容服务）：响应字段较多且各 engine 字段差异大，
// 用 looseObject 仅校验最关键的"search_result 必须是数组（或缺失）"，
// 其余完全透传给 extractResultsFromResponse 内部处理。
const SearchApiResponseSchema = z.looseObject({
  created: z.number().optional(),
  request_id: z.string().optional(),
  search_intent: z.array(z.looseObject({})).optional(),
  search_result: z.array(z.looseObject({})).optional(),
});

const SEARCH_API_URL = config.searchApiUrl;
const SEARCH_API_KEY = config.searchApiKey;

const SEARCH_API_TIMEOUT_MS = 15000;

let searchWebAvailable = false;

export function validateSearchWebConfig(): boolean {
  if (!SEARCH_API_URL || SEARCH_API_URL.startsWith('TODO')) {
    logger.warn('search_web 工具未配置：SEARCH_API_URL 未设置或仍为占位符，联网搜索功能不可用', {
      module: 'Tool:SearchWeb',
    });
    searchWebAvailable = false;
    return false;
  }
  if (!SEARCH_API_KEY || SEARCH_API_KEY.startsWith('TODO')) {
    logger.warn('search_web 工具未配置：SEARCH_API_KEY 未设置或仍为占位符，联网搜索功能不可用', {
      module: 'Tool:SearchWeb',
    });
    searchWebAvailable = false;
    return false;
  }
  searchWebAvailable = true;
  logger.info('search_web 工具配置校验通过，联网搜索功能可用', {
    module: 'Tool:SearchWeb',
  });
  return true;
}

export function isSearchWebAvailable(): boolean {
  return searchWebAvailable;
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/***`;
  } catch {
    return '***';
  }
}

// ==================== Zod Schema ====================

export const searchWebParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('搜索查询语句，应该是一个精确的、能获取相关结果的搜索词'),
  engine: z
    .enum(['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'])
    .default('search_std')
    .describe(
      '搜索引擎选择：search_std（标准搜索，通用场景速度快）、search_pro（专业搜索，深度搜索结果更全面）、search_pro_sogou（搜狗专业搜索，中文内容更优）、search_pro_quark（夸克专业搜索，国内内容覆盖好）',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('返回的最大搜索结果数量，默认5'),
  recency_filter: z
    .enum(['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'])
    .default('noLimit')
    .describe(
      '搜索结果的时间范围过滤：oneDay（一天内）、oneWeek（一周内）、oneMonth（一个月内）、oneYear（一年内）、noLimit（不限，默认）。当用户问"今天""最近""最新"等时效性问题时，应设置对应的时间范围',
    ),
});

export type SearchWebParams = z.infer<typeof searchWebParamsSchema>;

// ==================== OpenAI Function Calling Schema ====================

export const searchWebSchema = buildToolJsonSchema(
  'search_web',
  '联网搜索实时信息。当用户的问题涉及最新新闻、实时数据、当前事件或本地知识库中没有的实时信息时，使用此工具进行网络搜索。不要对知识库中已有的静态内容使用此工具。注意：查询天气信息时请使用 get_weather 工具，不要使用此工具。',
  searchWebParamsSchema,
);

// ==================== Result Schema ====================

/**
 * search_web 工具的返回结构 schema
 * 用 looseObject：保留 Tool 内部可能扩展的额外字段，避免 prompt.ts reparse 时被剥离
 */
export const searchWebResultSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      source: z.string(),
    }),
  ),
  total: z.number(),
  query: z.string(),
  engine: z.string(),
  error: z.string().optional(),
});

export type SearchWebResult = z.infer<typeof searchWebResultSchema>;

/**
 * 将搜索结果格式化为结构化摘要，供模型直接理解
 * 保留 url（方便用户点击），去掉 engine/total（对回答无用）
 * snippet 保持完整不截断，只保留 Top-K 条
 */
export function formatSearchResultAsSummary(result: SearchWebResult, maxResults: number): string {
  if (result.error) {
    return `搜索"${result.query}"失败：${result.error}`;
  }

  if (!result.results || result.results.length === 0) {
    return `搜索"${result.query}"未找到相关结果。`;
  }

  const kept = result.results.slice(0, maxResults);
  const lines: string[] = [`搜索"${result.query}"找到${result.results.length}条结果${kept.length < result.results.length ? `，展示前${kept.length}条` : ''}：`];

  for (let i = 0; i < kept.length; i++) {
    const r = kept[i];
    const title = r.title || '无标题';
    const snippet = r.snippet || '';
    const url = r.url || '';
    const source = r.source || '';

    let line = `${i + 1}. ${title}`;
    if (source) line += `（${source}）`;
    if (snippet) line += `\n   ${snippet}`;
    if (url) line += `\n   链接：${url}`;
    lines.push(line);
  }

  return lines.join('\n');
}

function extractResultsFromResponse(responseData: any, maxResults: number, engine: string): SearchWebResult['results'] {
  const results: SearchWebResult['results'] = [];
  let items: any[] | null = null;

  if (responseData?.search_result && Array.isArray(responseData.search_result)) {
    items = responseData.search_result;
  } else if (Array.isArray(responseData)) {
    items = responseData;
  } else if (responseData?.results && Array.isArray(responseData.results)) {
    items = responseData.results;
  } else if (responseData?.data && Array.isArray(responseData.data)) {
    items = responseData.data;
  }

  if (items === null) {
    logger.warn('FC工具 [search_web] 搜索API返回了无法识别的数据格式', {
      module: 'Tool:SearchWeb',
      responseKeys: Object.keys(responseData || {}),
      responseType: typeof responseData,
    });
    return results;
  }

  for (const item of items.slice(0, maxResults)) {
    results.push({
      title: item.title || item.name || '',
      url: item.link || item.url || '',
      snippet: item.content || item.snippet || item.description || '',
      source: item.media || item.source || item.engine || engine,
    });
  }

  return results;
}

export async function executeSearchWeb(
  rawParams: unknown,
): Promise<SearchWebResult> {
  const startTime = Date.now();

  if (!searchWebAvailable) {
    logger.warn('FC工具 [search_web] 工具未配置，无法执行搜索', {
      module: 'Tool:SearchWeb',
    });
    return {
      results: [],
      total: 0,
      query: (rawParams as { query?: string })?.query || '',
      engine: (rawParams as { engine?: string })?.engine || 'search_std',
      error: '联网搜索功能未配置，请检查 SEARCH_API_URL 和 SEARCH_API_KEY 环境变量',
    };
  }

  // zod 校验：query 必填、enum / default / min / max 一并校验
  const parsed = safeParseToolParams(searchWebParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [search_web] 参数校验失败', {
      module: 'Tool:SearchWeb',
      error: parsed.error,
    });
    return {
      results: [],
      total: 0,
      query: (rawParams as { query?: string })?.query || '',
      engine: 'search_std',
      error: `参数校验失败: ${parsed.error}`,
    };
  }

  // 用解析后的 params 替换原 params 引用，下游业务逻辑保持原样
  const params = parsed.data;
  // engine 已被 zod 校验为合法 enum 值，这里去掉历史回退分支
  const engine = params.engine;
  const maxResults = params.max_results;

  logger.info('FC工具 [search_web] 开始执行', {
    module: 'Tool:SearchWeb',
    query: params.query,
    engine,
    maxResults,
    recencyFilter: params.recency_filter,
  });

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SEARCH_API_TIMEOUT_MS);

  try {
    const requestBody: Record<string, any> = {
      search_query: params.query.trim(),
      search_engine: engine,
      count: maxResults,
    };

    const recencyFilter = params.recency_filter;
    if (recencyFilter !== 'noLimit') {
      requestBody.search_recency_filter = recencyFilter;
    }

    logger.info('FC工具 [search_web] 调用搜索API', {
      module: 'Tool:SearchWeb',
      apiUrl: maskUrl(SEARCH_API_URL),
      requestBody: JSON.stringify(requestBody),
      query: params.query,
      engine,
      maxResults,
      recencyFilter,
    });

    const response = await fetch(SEARCH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SEARCH_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const duration = Date.now() - startTime;
      logger.error('FC工具 [search_web] 搜索API返回错误', {
        module: 'Tool:SearchWeb',
        query: params.query,
        engine,
        statusCode: response.status,
        statusText: response.statusText,
        errorBody: errorText.substring(0, 500),
        duration,
      });
      return {
        results: [],
        total: 0,
        query: params.query,
        engine,
        error: `搜索API返回错误 (HTTP ${response.status}): ${response.statusText}`,
      };
    }

    const responseText = await response.text();
    const parsed = parseToolResultJson(responseText, SearchApiResponseSchema, {
      module: 'Tool:SearchWeb',
      api: 'search',
      query: params.query,
    });
    if (!parsed.success) {
      logger.error('FC工具 [search_web] 响应结构异常', {
        module: 'Tool:SearchWeb',
        reason: parsed.reason,
      });
      return {
        results: [],
        total: 0,
        query: params.query,
        engine,
        error: `搜索 API 响应结构异常: ${parsed.reason}`,
      };
    }
    const responseData = parsed.data;
    const duration = Date.now() - startTime;

    const apiCreatedTimestamp = responseData.created;
    const apiCreatedDate = apiCreatedTimestamp
      ? new Date(apiCreatedTimestamp * 1000).toISOString()
      : null;

    const searchIntent = responseData.search_intent
      ? (responseData.search_intent as any[]).map((intent: any) => ({
          query: intent.query,
          keywords: intent.keywords,
          intent: intent.intent,
        }))
      : null;

    const rawResultCount = responseData.search_result?.length || 0;
    const resultPublishDates = responseData.search_result
      ? (responseData.search_result as any[]).map((item: any) => ({
          title: (item.title || '').substring(0, 40),
          publishDate: item.publish_date || null,
          media: item.media || null,
        }))
      : [];

    logger.info('FC工具 [search_web] 搜索API返回成功', {
      module: 'Tool:SearchWeb',
      query: params.query,
      engine,
      duration,
      apiCreatedTimestamp,
      apiCreatedDate,
      requestId: responseData.request_id || null,
      searchIntent,
      rawResultCount,
      resultPublishDates,
    });

    const results = extractResultsFromResponse(responseData, maxResults, engine);

    const finalResult: SearchWebResult = {
      results,
      total: results.length,
      query: params.query,
      engine,
    };

    logger.info('FC工具 [search_web] 执行完成，返回结果摘要', {
      module: 'Tool:SearchWeb',
      query: params.query,
      engine,
      totalResults: finalResult.total,
      duration,
      resultTitles: results.map(r => r.title.substring(0, 50)),
    });

    return finalResult;
  } catch (error: any) {
    const duration = Date.now() - startTime;
    const isTimeout = error.name === 'AbortError';
    const errorMessage = isTimeout
      ? `搜索请求超时 (${SEARCH_API_TIMEOUT_MS}ms)`
      : error.message;

    logger.error('FC工具 [search_web] 执行异常', {
      module: 'Tool:SearchWeb',
      query: params.query,
      engine,
      duration,
      isTimeout,
      error: errorMessage,
      errorStack: error.stack?.substring(0, 500),
    });

    return {
      results: [],
      total: 0,
      query: params.query,
      engine,
      error: `联网搜索失败: ${errorMessage}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
