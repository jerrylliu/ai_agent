/**
 * fundamentals/tools/document-ops.schema.spec.ts
 *
 * create_document / update_document / summarize_document / compare_documents
 * 四个 Tool 的 zod schema 测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
});

describe('updateDocumentSchema', () => {
  it('documentId / content 必填', () => {
    const params = updateDocumentSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['content', 'documentId']);
  });

  it('documentId=0 应被拦截（必须 positive）', () => {
    const r = updateDocumentParamsSchema.safeParse({ documentId: 0, content: 'x' });
    expect(r.success).toBe(false);
  });

  it('documentId 为字符串应被拦截', () => {
    const r = updateDocumentParamsSchema.safeParse({
      documentId: '1' as any,
      content: 'x',
    });
    expect(r.success).toBe(false);
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
