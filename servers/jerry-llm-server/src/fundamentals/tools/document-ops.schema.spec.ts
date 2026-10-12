/**
 * fundamentals/tools/document-ops.schema.spec.ts
 *
 * create_document / update_document / summarize_document / compare_documents
 * 四个 Tool 的 zod schema 测试
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// 阻断 model-provider / langchain 真实加载（schema 测试不需要它们）
jest.mock('../model-provider', () => ({
  createLLM: jest.fn(),
  buildModelConfig: jest.fn(),
}));

import {
  createDocumentSchema,
  createDocumentParamsSchema,
  updateDocumentSchema,
  updateDocumentParamsSchema,
  summarizeDocumentSchema,
  summarizeDocumentParamsSchema,
  compareDocumentsSchema,
  compareDocumentsParamsSchema,
} from './document-ops';

describe('createDocumentSchema', () => {
  it('title / content 必填，description / tags 可选', () => {
    const params = createDocumentSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['content', 'title']);
    expect(params.required).not.toContain('description');
    expect(params.required).not.toContain('tags');
  });

  it('tags 应为 array<string>', () => {
    const params = createDocumentSchema.function.parameters as any;
    expect(params.properties.tags.type).toBe('array');
    expect(params.properties.tags.items.type).toBe('string');
  });

  it('合法输入应通过', () => {
    const r = createDocumentParamsSchema.safeParse({
      title: '笔记',
      content: '正文',
      tags: ['a', 'b'],
    });
    expect(r.success).toBe(true);
  });

  it('空 title 应被拦截', () => {
    const r = createDocumentParamsSchema.safeParse({ title: '', content: 'x' });
    expect(r.success).toBe(false);
  });

  it('tags 含非字符串项应被拦截', () => {
    const r = createDocumentParamsSchema.safeParse({
      title: 'x',
      content: 'x',
      tags: [1 as any],
    });
    expect(r.success).toBe(false);
  });

  // ==================== content 形态容错回归（生产案例 2026-10-12 12:24） ====================

  it('content 传对象（含 text 字段）应提取为字符串并通过', () => {
    const r = createDocumentParamsSchema.safeParse({
      title: '笔记',
      content: { text: '搜索结果正文', source: 'web' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.content).toBe('搜索结果正文');
    }
  });

  it('content 传对象（含 content 字段）应提取为字符串并通过', () => {
    const r = createDocumentParamsSchema.safeParse({
      title: '笔记',
      content: { content: '# 标题\n正文' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.content).toBe('# 标题\n正文');
    }
  });

  it('content 传数组应 join 为字符串并通过', () => {
    const r = createDocumentParamsSchema.safeParse({
      title: '笔记',
      content: ['第一段', '第二段'],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.content).toBe('第一段\n\n第二段');
    }
  });

  it('content 传无有效字段的对象应 JSON.stringify 兜底', () => {
    const r = createDocumentParamsSchema.safeParse({
      title: '笔记',
      content: { foo: 'bar' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.content).toContain('foo');
    }
  });

  it('content 空字符串仍应被拦截', () => {
    const r = createDocumentParamsSchema.safeParse({ title: 'x', content: '' });
    expect(r.success).toBe(false);
  });
});

describe('updateDocumentSchema', () => {
  it('documentId / content 必填', () => {
    const params = updateDocumentSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['content', 'documentId']);
  });

  it('tags 可选且为 array<string>（整体替换语义，含空数组清空）', () => {
    const params = updateDocumentSchema.function.parameters as any;
    expect(params.required).not.toContain('tags');
    expect(params.properties.tags.type).toBe('array');
    expect(params.properties.tags.items.type).toBe('string');
  });

  it('tags 空数组应通过（合法的清空操作）', () => {
    const r = updateDocumentParamsSchema.safeParse({
      documentId: 1,
      content: 'x',
      tags: [],
    });
    expect(r.success).toBe(true);
  });

  it('documentId=0 应被拦截（必须 positive）', () => {
    const r = updateDocumentParamsSchema.safeParse({
      documentId: 0,
      content: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('documentId 为字符串应被拦截', () => {
    const r = updateDocumentParamsSchema.safeParse({
      documentId: '1' as any,
      content: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('content 传对象应归一化为字符串并通过', () => {
    const r = updateDocumentParamsSchema.safeParse({
      documentId: 1,
      content: { text: '新的正文内容' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.content).toBe('新的正文内容');
    }
  });
});

describe('summarizeDocumentSchema', () => {
  it('documentId 必填，maxLength 默认 200', () => {
    const params = summarizeDocumentSchema.function.parameters as any;
    expect(params.required).toEqual(['documentId']);
    expect(params.properties.maxLength.default).toBe(200);
  });

  it('合法输入应通过且填充默认值', () => {
    const r = summarizeDocumentParamsSchema.safeParse({ documentId: 1 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.maxLength).toBe(200);
    }
  });

  it('maxLength=0 应被拦截', () => {
    const r = summarizeDocumentParamsSchema.safeParse({
      documentId: 1,
      maxLength: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe('compareDocumentsSchema', () => {
  it('两个 documentId 必填', () => {
    const params = compareDocumentsSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['documentId1', 'documentId2']);
  });

  it('合法输入应通过', () => {
    const r = compareDocumentsParamsSchema.safeParse({
      documentId1: 1,
      documentId2: 2,
    });
    expect(r.success).toBe(true);
  });

  it('缺少 documentId2 应被拦截', () => {
    const r = compareDocumentsParamsSchema.safeParse({ documentId1: 1 });
    expect(r.success).toBe(false);
  });
});
