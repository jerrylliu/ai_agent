import { logger } from '../logger';
import { config } from '../config';

const SEARCH_API_URL = config.searchApiUrl;
const SEARCH_API_KEY = config.searchApiKey;

const VALID_ENGINES = ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'] as const;
const MAX_SNIPPET_LENGTH = 500;
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

function truncateSnippet(text: string, maxLength: number = MAX_SNIPPET_LENGTH): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

export const searchWebSchema = {
  type: 'function' as const,
  function: {
    name: 'search_web',
    description: '联网搜索实时信息。当用户的问题涉及最新新闻、实时数据、当前事件或本地知识库中没有的实时信息时，使用此工具进行网络搜索。不要对知识库中已有的静态内容使用此工具。注意：查询天气信息时请使用 get_weather 工具，不要使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询语句，应该是一个精确的、能获取相关结果的搜索词',
        },
        engine: {
          type: 'string',
          description: '搜索引擎选择：search_std（标准搜索，通用场景速度快）、search_pro（专业搜索，深度搜索结果更全面）、search_pro_sogou（搜狗专业搜索，中文内容更优）、search_pro_quark（夸克专业搜索，国内内容覆盖好）',
          enum: ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'],
          default: 'search_std',
        },
        max_results: {
          type: 'number',
          description: '返回的最大搜索结果数量，默认5',
          default: 5,
          minimum: 1,
          maximum: 20,
        },
        recency_filter: {
          type: 'string',
          description: '搜索结果的时间范围过滤：oneDay（一天内）、oneWeek（一周内）、oneMonth（一个月内）、oneYear（一年内）、noLimit（不限，默认）。当用户问"今天""最近""最新"等时效性问题时，应设置对应的时间范围',
          enum: ['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'],
          default: 'noLimit',
        },
      },
      required: ['query'],
    },
  },
};

export interface SearchWebParams {
  query: string;
  engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';
  max_results?: number;
  recency_filter?: 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear' | 'noLimit';
}

export interface SearchWebResult {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
  }>;
  total: number;
  query: string;
  engine: string;
  error?: string;
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
      snippet: truncateSnippet(item.content || item.snippet || item.description || ''),
      source: item.media || item.source || item.engine || engine,
    });
  }

  return results;
}

export async function executeSearchWeb(
  params: SearchWebParams,
): Promise<SearchWebResult> {
  const startTime = Date.now();

  if (!searchWebAvailable) {
    logger.warn('FC工具 [search_web] 工具未配置，无法执行搜索', {
      module: 'Tool:SearchWeb',
    });
    return {
      results: [],
      total: 0,
      query: params.query || '',
      engine: params.engine || 'search_std',
      error: '联网搜索功能未配置，请检查 SEARCH_API_URL 和 SEARCH_API_KEY 环境变量',
    };
  }

  let engine = params.engine || 'search_std';
  if (!VALID_ENGINES.includes(engine as any)) {
    logger.warn('FC工具 [search_web] engine 参数无效，回退为默认值', {
      module: 'Tool:SearchWeb',
      invalidEngine: engine,
      fallbackEngine: 'search_std',
    });
    engine = 'search_std';
  }

  const maxResults = Math.min(Math.max(params.max_results || 5, 1), 20);

  logger.info('FC工具 [search_web] 开始执行', {
    module: 'Tool:SearchWeb',
    rawParams: JSON.stringify(params),
    query: params.query,
    engine,
    maxResults,
    recencyFilter: params.recency_filter || 'noLimit',
  });

  if (!params.query || !params.query.trim()) {
    logger.warn('FC工具 [search_web] 参数校验失败：query 为空', {
      module: 'Tool:SearchWeb',
    });
    return {
      results: [],
      total: 0,
      query: params.query || '',
      engine,
    };
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SEARCH_API_TIMEOUT_MS);

  try {
    const requestBody: Record<string, any> = {
      search_query: params.query.trim(),
      search_engine: engine,
      count: maxResults,
    };

    const recencyFilter = params.recency_filter || 'noLimit';
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

    const responseData = await response.json();
    const duration = Date.now() - startTime;

    const apiCreatedTimestamp = responseData.created;
    const apiCreatedDate = apiCreatedTimestamp
      ? new Date(apiCreatedTimestamp * 1000).toISOString()
      : null;

    const searchIntent = responseData.search_intent
      ? responseData.search_intent.map((intent: any) => ({
          query: intent.query,
          keywords: intent.keywords,
          intent: intent.intent,
        }))
      : null;

    const rawResultCount = responseData.search_result?.length || 0;
    const resultPublishDates = responseData.search_result
      ? responseData.search_result.map((item: any) => ({
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
