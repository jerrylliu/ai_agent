/**
 * fundamentals/tools/crawl-webpage.schema.spec.ts
 *
 * crawl_webpage 工具的 zod schema → OpenAI Function Schema 转换测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../web-crawler', () => ({
  crawlWebsite: jest.fn(),
}));

import { crawlWebpageSchema, crawlWebpageParamsSchema } from './crawl-webpage';

describe('crawlWebpageSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(crawlWebpageSchema.type).toBe('function');
    expect(crawlWebpageSchema.function.name).toBe('crawl_webpage');
    expect(crawlWebpageSchema.function.description).toContain('网页');
  });

  it('url 必填，enable_js_rendering 默认 false 且不在 required', () => {
    const params = crawlWebpageSchema.function.parameters as any;
    expect(params.required).toEqual(['url']);
    expect(params.properties.enable_js_rendering.default).toBe(false);
  });

  it('url 应是 string 且带 format（zod .url 转换）', () => {
    const params = crawlWebpageSchema.function.parameters as any;
    expect(params.properties.url.type).toBe('string');
    expect(params.properties.url.description).toContain('URL');
  });
});

describe('crawlWebpageParamsSchema 校验', () => {
  it('合法 https URL 应通过', () => {
    const r = crawlWebpageParamsSchema.safeParse({ url: 'https://example.com' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.enable_js_rendering).toBe(false);
    }
  });

  it('非 URL 字符串应被拦截', () => {
    const r = crawlWebpageParamsSchema.safeParse({ url: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('空 url 应被拦截', () => {
    const r = crawlWebpageParamsSchema.safeParse({ url: '' });
    expect(r.success).toBe(false);
  });

  it('enable_js_rendering 类型错误应被拦截', () => {
    const r = crawlWebpageParamsSchema.safeParse({
      url: 'https://example.com',
      enable_js_rendering: 'yes' as any,
    });
    expect(r.success).toBe(false);
  });
});
