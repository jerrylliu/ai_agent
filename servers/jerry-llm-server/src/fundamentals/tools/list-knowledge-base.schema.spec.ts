/**
 * fundamentals/tools/list-knowledge-base.schema.spec.ts
 *
 * list_knowledge_base 工具的 zod schema → OpenAI Function Schema 转换测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../vector-store/index', () => ({
  getAllDocuments: jest.fn(),
}));

import {
  listKnowledgeBaseSchema,
  listKnowledgeBaseParamsSchema,
} from './list-knowledge-base';

describe('listKnowledgeBaseSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(listKnowledgeBaseSchema.type).toBe('function');
    expect(listKnowledgeBaseSchema.function.name).toBe('list_knowledge_base');
    expect(listKnowledgeBaseSchema.function.description).toContain('文档清单');
  });

  it('detail_level enum 应为 brief / detailed 且默认 brief', () => {
    const params = listKnowledgeBaseSchema.function.parameters as any;
    expect(params.type).toBe('object');
    expect(params.properties.detail_level.enum).toEqual(['brief', 'detailed']);
    expect(params.properties.detail_level.default).toBe('brief');
    // 因为有 default，io: 'input' 模式下不应进入 required
    expect(params.required ?? []).not.toContain('detail_level');
  });

  it('detail_level 字段应有中文 description', () => {
    const params = listKnowledgeBaseSchema.function.parameters as any;
    expect(params.properties.detail_level.description).toContain('详细程度');
  });
});

describe('listKnowledgeBaseParamsSchema 校验', () => {
  it('空对象应通过并 fallback 到 brief', () => {
    const r = listKnowledgeBaseParamsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.detail_level).toBe('brief');
    }
  });

  it('合法 detail_level=detailed 应通过', () => {
    const r = listKnowledgeBaseParamsSchema.safeParse({ detail_level: 'detailed' });
    expect(r.success).toBe(true);
  });

  it('非法 detail_level 应被拦截', () => {
    const r = listKnowledgeBaseParamsSchema.safeParse({ detail_level: 'verbose' });
    expect(r.success).toBe(false);
  });
});
