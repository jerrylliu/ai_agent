/**
 * 网页深度内容抓取工具
 *
 * 让 Agent 可以对搜索到的网页进行深度内容抓取，
 * 获取完整的页面正文内容（Markdown 格式），而非仅搜索摘要。
 *
 * 复用 web-crawler.ts 的 crawlWebsite 函数，限制为单页抓取。
 */

import { z } from 'zod';
import { crawlWebsite, type CrawlResult } from '../web-crawler';
import { logger } from '../logger';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== Zod Schema ====================

export const crawlWebpageParamsSchema = z.object({
  url: z
    .string()
    .min(1)
    .url('url 必须是合法的 HTTP/HTTPS 地址')
    .describe('要抓取的网页 URL'),
  enable_js_rendering: z
    .boolean()
    .default(false)
    .describe('是否启用 JS 渲染（用于动态加载内容的页面），默认 false'),
});

export type CrawlWebpageParams = z.infer<typeof crawlWebpageParamsSchema>;

// ==================== OpenAI Function Calling Schema ====================

export const crawlWebpageSchema = buildToolJsonSchema(
  'crawl_webpage',
  '抓取指定网页的完整内容。当搜索结果中的摘要信息不够详细，需要获取网页全文时使用此工具。返回网页的标题和正文（Markdown 格式）。注意：此工具较慢，仅在需要深度阅读网页内容时使用。',
  crawlWebpageParamsSchema,
);

// ==================== Result 类型 ====================

export interface CrawlWebpageResult {
  url: string;
  title: string;
  content: string;
  contentLength: number;
  error?: string;
}

export async function executeCrawlWebpage(
  rawParams: unknown,
): Promise<CrawlWebpageResult> {
  const startTime = Date.now();

  // zod 校验：url 必填且为合法 URL，enable_js_rendering 默认 false
  const parsed = safeParseToolParams(crawlWebpageParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [crawl_webpage] 参数校验失败', {
      module: 'Tool:CrawlWebpage',
      error: parsed.error,
    });
    return {
      url: (rawParams as { url?: string })?.url || '',
      title: '',
      content: '',
      contentLength: 0,
      error: `参数校验失败: ${parsed.error}`,
    };
  }

  const params = parsed.data;

  logger.info('FC工具 [crawl_webpage] 开始执行', {
    module: 'Tool:CrawlWebpage',
    url: params.url,
    enableJsRendering: params.enable_js_rendering,
  });
  
  try {
    const result: CrawlResult = await crawlWebsite({
      startUrl: params.url,
      maxDepth: 0, // 只抓取当前页面，不跟随链接
      maxPages: 1,
      enableJsRendering: params.enable_js_rendering,
    });

    const duration = Date.now() - startTime;

    if (result.errors.length > 0 && result.pages.length === 0) {
      logger.warn('FC工具 [crawl_webpage] 抓取失败', {
        module: 'Tool:CrawlWebpage',
        url: params.url,
        errors: result.errors,
        duration,
      });

      return {
        url: params.url,
        title: '',
        content: '',
        contentLength: 0,
        error: result.errors.map(e => e.error).join('; '),
      };
    }

    if (result.pages.length === 0) {
      return {
        url: params.url,
        title: '',
        content: '',
        contentLength: 0,
        error: '未能获取页面内容',
      };
    }

    const page = result.pages[0];
    // 截断过长内容，避免消耗过多 token
    const maxContentLength = 8000;
    const content = page.markdown.length > maxContentLength
      ? page.markdown.substring(0, maxContentLength) + '\n\n...（内容已截断）'
      : page.markdown;

    logger.info('FC工具 [crawl_webpage] 执行完成', {
      module: 'Tool:CrawlWebpage',
      url: params.url,
      title: page.title,
      originalLength: page.markdown.length,
      truncatedLength: content.length,
      duration,
    });

    return {
      url: params.url,
      title: page.title,
      content,
      contentLength: page.markdown.length,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error('FC工具 [crawl_webpage] 执行异常', {
      module: 'Tool:CrawlWebpage',
      url: params.url,
      duration,
      error: error.message,
    });

    return {
      url: params.url,
      title: '',
      content: '',
      contentLength: 0,
      error: `网页抓取失败: ${error.message}`,
    };
  }
}
