/**
 * fundamentals/tools/crawl-webpage.spec.ts
 *
 * crawl_webpage 工具单元测试
 * Mock web-crawler，测试 schema 和参数校验
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../web-crawler', () => ({
  crawlWebsite: jest.fn(),
}));

import { executeCrawlWebpage, crawlWebpageSchema } from './crawl-webpage';

describe('crawl_webpage 工具', () => {
  describe('crawlWebpageSchema', () => {
    it('应定义正确的函数名', () => {
      expect(crawlWebpageSchema.function.name).toBe('crawl_webpage');
    });

    it('url 应为必填参数', () => {
      expect(crawlWebpageSchema.function.parameters.required).toContain('url');
    });

    it('enable_js_rendering 默认应为 false', () => {
      const props = crawlWebpageSchema.function.parameters.properties as any;
      expect(props.enable_js_rendering.default).toBe(false);
    });
  });

  describe('executeCrawlWebpage', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('URL 为空时应返回错误', async () => {
      const r = await executeCrawlWebpage({ url: '' });
      expect(r.error).toBe('URL 不能为空');
      expect(r.content).toBe('');
    });

    it('URL 为空白时应返回错误', async () => {
      const r = await executeCrawlWebpage({ url: '   ' });
      expect(r.error).toBe('URL 不能为空');
    });

    it('应委托 crawlWebsite 并返回结果', async () => {
      const { crawlWebsite } = require('../web-crawler');
      crawlWebsite.mockResolvedValue({
        pages: [{ url: 'https://example.com', title: 'Test', markdown: '# Hello' }],
        errors: [],
      });

      const r = await executeCrawlWebpage({ url: 'https://example.com' });
      expect(r.url).toBe('https://example.com');
      expect(r.title).toBe('Test');
      expect(r.content).toBe('# Hello');
      expect(r.contentLength).toBe(7);
      expect(r.error).toBeUndefined();
    });

    it('抓取失败时应返回错误', async () => {
      const { crawlWebsite } = require('../web-crawler');
      crawlWebsite.mockRejectedValue(new Error('Network error'));

      const r = await executeCrawlWebpage({ url: 'https://fail.com' });
      expect(r.error).toContain('抓取失败');
    });
  });
});
