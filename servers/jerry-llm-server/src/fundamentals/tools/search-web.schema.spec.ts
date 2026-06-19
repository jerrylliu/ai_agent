/**
 * fundamentals/tools/search-web.schema.spec.ts
 *
 * search_web 工具的 zod schema → OpenAI Function Schema 转换测试
 * 重点验证：复杂 enum + default + min/max 的转换正确性
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    searchApiUrl: 'https://example.com/search',
    searchApiKey: 'TEST_KEY',
  },
}));

import { searchWebSchema, searchWebParamsSchema } from './search-web';

describe('searchWebSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(searchWebSchema.type).toBe('function');
    expect(searchWebSchema.function.name).toBe('search_web');
    expect(searchWebSchema.function.description).toContain('联网搜索');
  });

  it('engine enum 含 4 个引擎且默认 search_std', () => {
    const params = searchWebSchema.function.parameters as any;
    expect(params.properties.engine.enum).toEqual([
      'search_std',
      'search_pro',
      'search_pro_sogou',
      'search_pro_quark',
    ]);
    expect(params.properties.engine.default).toBe('search_std');
  });

  it('max_results 应保留 minimum/maximum/default', () => {
    const params = searchWebSchema.function.parameters as any;
    expect(params.properties.max_results.minimum).toBe(1);
    expect(params.properties.max_results.maximum).toBe(20);
    expect(params.properties.max_results.default).toBe(5);
  });

  it('recency_filter enum 应保留 5 个值且默认 noLimit', () => {
    const params = searchWebSchema.function.parameters as any;
    expect(params.properties.recency_filter.enum).toEqual([
      'oneDay',
      'oneWeek',
      'oneMonth',
      'oneYear',
      'noLimit',
    ]);
    expect(params.properties.recency_filter.default).toBe('noLimit');
  });

  it('因为 default 关系，required 应只含 query', () => {
    const params = searchWebSchema.function.parameters as any;
    expect(params.required).toEqual(['query']);
  });
});

describe('searchWebParamsSchema 校验', () => {
  it('合法 query 应通过并 fallback 到所有 default', () => {
    const r = searchWebParamsSchema.safeParse({ query: 'AI news' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.engine).toBe('search_std');
      expect(r.data.max_results).toBe(5);
      expect(r.data.recency_filter).toBe('noLimit');
    }
  });

  it('engine 越界应被拦截', () => {
    const r = searchWebParamsSchema.safeParse({
      query: 'x',
      engine: 'search_unknown',
    });
    expect(r.success).toBe(false);
  });

  it('max_results 超过 20 应被拦截', () => {
    const r = searchWebParamsSchema.safeParse({ query: 'x', max_results: 21 });
    expect(r.success).toBe(false);
  });

  it('max_results 小于 1 应被拦截', () => {
    const r = searchWebParamsSchema.safeParse({ query: 'x', max_results: 0 });
    expect(r.success).toBe(false);
  });

  it('recency_filter 越界应被拦截', () => {
    const r = searchWebParamsSchema.safeParse({
      query: 'x',
      recency_filter: 'oneHour',
    });
    expect(r.success).toBe(false);
  });
});
