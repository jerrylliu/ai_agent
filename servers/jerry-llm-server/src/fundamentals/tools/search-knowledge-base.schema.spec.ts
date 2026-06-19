/**
 * fundamentals/tools/search-knowledge-base.schema.spec.ts
 *
 * search_knowledge_base 工具的 zod schema → OpenAI Function Schema 转换测试
 * 重点验证：内部 _options 字段不应出现在 LLM-facing 的 schema 中
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 屏蔽向量库 / 检索增强等链式 import，schema 测试不需要它们的运行时
jest.mock('../vector-store', () => ({
  hybridSearchKnowledgeBase: jest.fn(),
}));
jest.mock('../vector-store/query-rewriter', () => ({
  rewriteQuery: jest.fn(),
}));
jest.mock('../vector-store/multi-hop-search', () => ({
  multiHopSearch: jest.fn(),
}));
jest.mock('../vector-store/result-reranker', () => ({
  rerankResults: jest.fn(),
}));

import {
  searchKnowledgeBaseSchema,
  searchKnowledgeBaseParamsSchema,
} from './search-knowledge-base';

describe('searchKnowledgeBaseSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(searchKnowledgeBaseSchema.type).toBe('function');
    expect(searchKnowledgeBaseSchema.function.name).toBe('search_knowledge_base');
    expect(searchKnowledgeBaseSchema.function.description).toContain('知识库');
  });

  it('parameters 中应只暴露 query / top_k / document_id，绝不能含 _options', () => {
    const params = searchKnowledgeBaseSchema.function.parameters as any;
    expect(params.type).toBe('object');
    const propKeys = Object.keys(params.properties);
    expect(propKeys.sort()).toEqual(['document_id', 'query', 'top_k']);
    // 关键安全断言：_options 是服务端内部字段，不允许暴露给 LLM
    expect(propKeys).not.toContain('_options');
  });

  it('query 必填、top_k 默认 3、document_id optional', () => {
    const params = searchKnowledgeBaseSchema.function.parameters as any;
    expect(params.required).toEqual(['query']);
    expect(params.properties.top_k.default).toBe(3);
  });
});

describe('searchKnowledgeBaseParamsSchema 校验', () => {
  it('合法 query 应通过', () => {
    const r = searchKnowledgeBaseParamsSchema.safeParse({ query: 'hello' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.top_k).toBe(3);
    }
  });

  it('空 query 应被拦截', () => {
    const r = searchKnowledgeBaseParamsSchema.safeParse({ query: '' });
    expect(r.success).toBe(false);
  });

  it('top_k 为负数应被拦截', () => {
    const r = searchKnowledgeBaseParamsSchema.safeParse({ query: 'x', top_k: -1 });
    expect(r.success).toBe(false);
  });

  it('document_id 非整数应被拦截', () => {
    const r = searchKnowledgeBaseParamsSchema.safeParse({
      query: 'x',
      document_id: 1.5,
    });
    expect(r.success).toBe(false);
  });
});
