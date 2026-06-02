import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { logger } from './logger';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript']);

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
  links: string[];
}

export interface CrawlResult {
  pages: CrawlPage[];
  totalPages: number;
  errors: Array<{ url: string; error: string }>;
}

export interface WebCrawlConfig {
  startUrl: string;
  maxDepth?: number;
  maxPages?: number;
  urlPattern?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
}

function normalizeUrl(base: string, href: string): string | null {
  try {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      return null;
    }
    const url = new URL(href, base);
    url.hash = '';
    url.searchParams.delete('utm_source');
    url.searchParams.delete('utm_medium');
    url.searchParams.delete('utm_campaign');
    return url.toString();
  } catch {
    return null;
  }
}

function isSameDomain(baseUrl: string, targetUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const target = new URL(targetUrl);
    return base.hostname === target.hostname;
  } catch {
    return false;
  }
}

function matchesPatterns(url: string, includePatterns?: string[], excludePatterns?: string[]): boolean {
  if (excludePatterns && excludePatterns.length > 0) {
    for (const pattern of excludePatterns) {
      if (url.includes(pattern)) return false;
    }
  }
  if (includePatterns && includePatterns.length > 0) {
    for (const pattern of includePatterns) {
      if (url.includes(pattern)) return true;
    }
    return false;
  }
  return true;
}

async function fetchPage(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: abortController.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      logger.warn('网页爬取返回非200状态', { module: 'WebCrawler', url, status: response.status });
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      logger.warn('网页爬取跳过非HTML内容', { module: 'WebCrawler', url, contentType });
      return null;
    }

    return await response.text();
  } catch (error: any) {
    const isTimeout = error.name === 'AbortError';
    logger.warn('网页爬取失败', { module: 'WebCrawler', url, error: isTimeout ? '请求超时' : error.message });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractContent(html: string, url: string): CrawlPage {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || url;

  const mainContent =
    $('main').html() ||
    $('article').html() ||
    $('[role="main"]').html() ||
    $('.content').html() ||
    $('.documentation').html() ||
    $('#content').html() ||
    $('body').html() ||
    '';

  const markdown = turndown.turndown(mainContent);

  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const normalized = normalizeUrl(url, href);
    if (normalized && isSameDomain(url, normalized)) {
      links.push(normalized);
    }
  });

  return { url, title, markdown, links: [...new Set(links)] };
}

export async function crawlWebsite(config: WebCrawlConfig): Promise<CrawlResult> {
  const { startUrl, maxDepth = 2, maxPages = 50, includePatterns, excludePatterns } = config;

  const visited = new Set<string>();
  const pages: CrawlPage[] = [];
  const errors: Array<{ url: string; error: string }> = [];

  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];

  logger.info('开始网站爬取', {
    module: 'WebCrawler',
    startUrl,
    maxDepth,
    maxPages,
  });

  while (queue.length > 0 && pages.length < maxPages) {
    const item = queue.shift()!;

    if (visited.has(item.url)) continue;
    if (item.depth > maxDepth) continue;
    if (!matchesPatterns(item.url, includePatterns, excludePatterns)) continue;

    visited.add(item.url);

    const html = await fetchPage(item.url);
    if (!html) {
      errors.push({ url: item.url, error: '无法获取页面内容' });
      continue;
    }

    try {
      const page = extractContent(html, item.url);

      if (page.markdown && page.markdown.trim().length > 50) {
        pages.push(page);
        logger.info('网页爬取成功', {
          module: 'WebCrawler',
          url: item.url,
          title: page.title.substring(0, 50),
          contentLength: page.markdown.length,
          linkCount: page.links.length,
          depth: item.depth,
        });
      }

      if (item.depth < maxDepth) {
        for (const link of page.links) {
          if (!visited.has(link) && pages.length + queue.length < maxPages) {
            queue.push({ url: link, depth: item.depth + 1 });
          }
        }
      }
    } catch (error: any) {
      errors.push({ url: item.url, error: error.message });
      logger.warn('网页内容提取失败', { module: 'WebCrawler', url: item.url, error: error.message });
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  logger.info('网站爬取完成', {
    module: 'WebCrawler',
    startUrl,
    totalPages: pages.length,
    errorCount: errors.length,
    visitedCount: visited.size,
  });

  return { pages, totalPages: pages.length, errors };
}
