/**
 * 网页深度内容抓取工具
 *
 * 让 Agent 可以对搜索到的网页进行深度内容抓取，
 * 获取完整的页面正文内容（Markdown 格式），而非仅搜索摘要。
 *
 * 复用 web-crawler.ts 的 crawlWebsite 函数，限制为单页抓取。
 */

import { crawlWebsite, type CrawlResult } from '../web-crawler';
import { logger } from '../logger';

export const crawlWebpageSchema = {
  type: 'function' as const,
  function: {
    name: 'crawl_webpage',
    description: '抓取指定网页的完整内容。当搜索结果中的摘要信息不够详细，需要获取网页全文时使用此工具。返回网页的标题和正文（Markdown 格式）。注意：此工具较慢，仅在需要深度阅读网页内容时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要抓取的网页 URL',
        },
        enable_js_rendering: {
          type: 'boolean',
          description: '是否启用 JS 渲染（用于动态加载内容的页面），默认 false',
          default: false,
        },
      },
      required: ['url'],
    },
  },
};

export interface CrawlWebpageParams {
  url: string;
  enable_js_rendering?: boolean;
}

export interface CrawlWebpageResult {
  url: string;
  title: string;
  content: string;
  contentLength: number;
  error?: string;
}

export async function executeCrawlWebpage(
  params: CrawlWebpageParams,
): Promise<CrawlWebpageResult> {
  const startTime = Date.now();

  logger.info('FC工具 [crawl_webpage] 开始执行', {
    module: 'Tool:CrawlWebpage',
    url: params.url,
    enableJsRendering: params.enable_js_rendering,
  });

  if (!params.url || !params.url.trim()) {
    return {
      url: params.url || '',
      title: '',
      content: '',
      contentLength: 0,
      error: 'URL 不能为空',
    };
  }

  try {
    const result: CrawlResult = await crawlWebsite({
      startUrl: params.url,
      maxDepth: 0, // 只抓取当前页面，不跟随链接
      maxPages: 1,
      enableJsRendering: params.enable_js_rendering || false,
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
