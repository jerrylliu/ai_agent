import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import * as fs from 'fs';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { logger } from './logger';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript']);

const DEFAULT_TIMEOUT_MS = 15000;
const PUPPETEER_TIMEOUT_MS = 30000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
  links: string[];
  sourceType: 'html' | 'markdown';
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
  preferMarkdown?: boolean;
  enableJsRendering?: boolean;
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

function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.endsWith('.md')) {
      u.pathname = u.pathname.slice(0, -3);
    }
    if (u.pathname.endsWith('/index')) {
      u.pathname = u.pathname.slice(0, -5);
    }
    if (!u.pathname.endsWith('/')) {
      u.pathname += '/';
    }
    return u.toString();
  } catch {
    return url;
  }
}

type FetchedContent = {
  raw: string;
  contentType: 'html' | 'markdown' | 'plain';
  url: string;
};

async function fetchPage(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<FetchedContent | null> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/markdown,text/html,text/plain,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: abortController.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      logger.warn('网页爬取返回非200状态', { module: 'WebCrawler', url, status: response.status });
      return null;
    }

    const contentTypeHeader = response.headers.get('content-type') || '';
    let contentType: FetchedContent['contentType'];

    if (contentTypeHeader.includes('text/markdown')) {
      contentType = 'markdown';
    } else if (contentTypeHeader.includes('text/html') || contentTypeHeader.includes('application/xhtml')) {
      contentType = 'html';
    } else if (contentTypeHeader.includes('text/plain')) {
      if (url.endsWith('.md')) {
        contentType = 'markdown';
      } else {
        contentType = 'plain';
      }
    } else {
      if (url.endsWith('.md')) {
        contentType = 'markdown';
      } else {
        logger.warn('网页爬取跳过不支持的内容类型', { module: 'WebCrawler', url, contentType: contentTypeHeader });
        return null;
      }
    }

    const raw = await response.text();
    return { raw, contentType, url };
  } catch (error: any) {
    const isTimeout = error.name === 'AbortError';
    logger.warn('网页爬取失败', { module: 'WebCrawler', url, error: isTimeout ? '请求超时' : error.message });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function tryFetchMarkdownVersion(htmlUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<FetchedContent | null> {
  try {
    const u = new URL(htmlUrl);
    // 对已有明确文件后缀的 URL（如 .txt, .json, .xml），不尝试追加 .md
    const pathname = u.pathname;
    const ext = pathname.substring(pathname.lastIndexOf('.'));
    if (ext && ext !== '.html' && ext !== '.htm' && ext.length <= 10) {
      return null;
    }
    if (u.pathname.endsWith('/')) {
      u.pathname += 'index.md';
    } else {
      u.pathname += '.md';
    }
    const mdUrl = u.toString();
    const result = await fetchPage(mdUrl, timeoutMs);
    if (result && (result.contentType === 'markdown' || result.contentType === 'plain')) {
      logger.info('发现 Markdown 优化版本', { module: 'WebCrawler', htmlUrl, mdUrl });
      return { ...result, url: htmlUrl };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 查找系统已安装的 Chrome/Edge 可执行文件路径
 * 优先使用系统浏览器，避免下载 Puppeteer 自带的 Chromium
 */
function findSystemChrome(): string | undefined {
  const paths = [
    // Windows Chrome
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    // Windows Edge
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter(Boolean) as string[];

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return undefined;
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = await findSystemChrome();
  if (executablePath) {
    logger.info('使用系统浏览器', { module: 'WebCrawler', path: executablePath });
  } else {
    logger.info('使用 Puppeteer 自带浏览器', { module: 'WebCrawler' });
  }

  return puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  });
}

async function renderWithPuppeteer(url: string, browser: Browser): Promise<string | null> {
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PUPPETEER_TIMEOUT_MS,
    });

    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        if (document.readyState === 'complete') {
          setTimeout(resolve, 1000);
        } else {
          window.addEventListener('load', () => setTimeout(resolve, 1000));
        }
      });
    });

    const html = await page.content();
    logger.info('Puppeteer 渲染完成', { module: 'WebCrawler', url, htmlLength: html.length });
    return html;
  } catch (error: any) {
    logger.warn('Puppeteer 渲染失败', { module: 'WebCrawler', url, error: error.message });
    return null;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

function extractTitleFromMarkdown(md: string): string {
  const match = md.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function extractMarkdownLinks(md: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(md)) !== null) {
    const href = match[2];
    const normalized = normalizeUrl(baseUrl, href);
    if (normalized && isSameDomain(baseUrl, normalized)) {
      links.push(normalized);
    }
  }
  return [...new Set(links)];
}

function extractFromHtml(html: string, url: string): CrawlPage {
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

  return { url, title, markdown, links: [...new Set(links)], sourceType: 'html' };
}

function extractFromMarkdown(md: string, url: string): CrawlPage {
  const title = extractTitleFromMarkdown(md) || url;
  const links = extractMarkdownLinks(md, url);
  return { url, title, markdown: md, links, sourceType: 'markdown' };
}

function extractContent(fetched: FetchedContent): CrawlPage {
  if (fetched.contentType === 'html') {
    return extractFromHtml(fetched.raw, fetched.url);
  }
  return extractFromMarkdown(fetched.raw, fetched.url);
}

export async function crawlWebsite(config: WebCrawlConfig): Promise<CrawlResult> {
  const {
    startUrl,
    maxDepth = 2,
    maxPages = 50,
    includePatterns,
    excludePatterns,
    preferMarkdown = true,
    enableJsRendering = false,
  } = config;

  const visited = new Set<string>();
  const pages: CrawlPage[] = [];
  const errors: Array<{ url: string; error: string }> = [];

  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];

  let browser: Browser | null = null;

  if (enableJsRendering) {
    try {
      browser = await launchBrowser();
    } catch (error: any) {
      logger.error('Puppeteer 浏览器启动失败，将回退到普通模式', { module: 'WebCrawler', error: error.message });
    }
  }

  logger.info('开始网站爬取', {
    module: 'WebCrawler',
    startUrl,
    maxDepth,
    maxPages,
    preferMarkdown,
    enableJsRendering,
  });

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const item = queue.shift()!;

      const canonical = canonicalizeUrl(item.url);
      if (visited.has(canonical)) continue;
      if (item.depth > maxDepth) continue;
      if (!matchesPatterns(item.url, includePatterns, excludePatterns)) continue;

      visited.add(canonical);

      // 优先尝试 Markdown 版本（轻量，无需 JS 渲染）
      let fetched: FetchedContent | null = null;
      if (preferMarkdown) {
        const mdResult = await tryFetchMarkdownVersion(item.url);
        if (mdResult) {
          fetched = mdResult;
        }
      }

      // 当 enableJsRendering 开启时，直接用 Puppeteer 渲染 HTML 页面
      if (!fetched && enableJsRendering && browser) {
        logger.info('JS 渲染模式：使用 Puppeteer 抓取', { module: 'WebCrawler', url: item.url });
        const renderedHtml = await renderWithPuppeteer(item.url, browser);
        if (renderedHtml) {
          fetched = { raw: renderedHtml, contentType: 'html', url: item.url };
        }
      }

      // 回退到普通 fetch
      if (!fetched) {
        fetched = await fetchPage(item.url);
      }

      if (!fetched) {
        errors.push({ url: item.url, error: '无法获取页面内容' });
        continue;
      }

      try {
        const page = extractContent(fetched);

        if (page.markdown && page.markdown.trim().length > 50) {
          pages.push(page);
          logger.info('网页爬取成功', {
            module: 'WebCrawler',
            url: item.url,
            title: page.title.substring(0, 50),
            contentLength: page.markdown.length,
            linkCount: page.links.length,
            depth: item.depth,
            sourceType: page.sourceType,
          });
        }

        if (item.depth < maxDepth) {
          for (const link of page.links) {
            const linkCanonical = canonicalizeUrl(link);
            if (!visited.has(linkCanonical) && pages.length + queue.length < maxPages) {
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
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      logger.info('Puppeteer 浏览器已关闭', { module: 'WebCrawler' });
    }
  }

  logger.info('网站爬取完成', {
    module: 'WebCrawler',
    startUrl,
    totalPages: pages.length,
    errorCount: errors.length,
    visitedCount: visited.size,
    markdownPages: pages.filter(p => p.sourceType === 'markdown').length,
    htmlPages: pages.filter(p => p.sourceType === 'html').length,
  });

  return { pages, totalPages: pages.length, errors };
}
