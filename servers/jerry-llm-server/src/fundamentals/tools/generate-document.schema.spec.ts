/**
 * fundamentals/tools/generate-document.schema.spec.ts
 *
 * generate_document 工具的 zod schema → OpenAI Function Schema 转换测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 阻断 document-generator 真实加载（依赖 puppeteer / docx / pdf-parse 等）
jest.mock('../document-generator', () => ({
  markdownToHtml: jest.fn(),
  markdownToPdf: jest.fn(),
  markdownToDocx: jest.fn(),
  markdownToMd: jest.fn(),
  getDocumentMimeType: jest.fn(),
  ensureExtension: jest.fn(),
}));

import {
  generateDocumentSchema,
  generateDocumentParamsSchema,
} from './generate-document';

describe('generateDocumentSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(generateDocumentSchema.type).toBe('function');
    expect(generateDocumentSchema.function.name).toBe('generate_document');
    expect(generateDocumentSchema.function.description).toContain('Markdown');
  });

  it('title / format 必填，content 为可选（P1：正文走回复正文通道）', () => {
    const params = generateDocumentSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['format', 'title']);
    expect(Object.keys(params.properties).sort()).toEqual(['content', 'format', 'title']);
  });

  it('format enum 应为 pdf / docx / html / md', () => {
    const params = generateDocumentSchema.function.parameters as any;
    expect(params.properties.format.enum).toEqual(['pdf', 'docx', 'html', 'md']);
  });
});

describe('generateDocumentParamsSchema 校验', () => {
  it('合法输入应通过', () => {
    const r = generateDocumentParamsSchema.safeParse({
      title: '报告',
      content: '# 标题',
      format: 'pdf',
    });
    expect(r.success).toBe(true);
  });

  it('md 格式应被接受', () => {
    const r = generateDocumentParamsSchema.safeParse({
      title: '报告',
      content: '# 标题',
      format: 'md',
    });
    expect(r.success).toBe(true);
  });

  it('format 越界应被拦截', () => {
    const r = generateDocumentParamsSchema.safeParse({
      title: 'x',
      content: 'x',
      format: 'txt',
    });
    expect(r.success).toBe(false);
  });

  it('空 title 应被拦截', () => {
    const r = generateDocumentParamsSchema.safeParse({
      title: '',
      content: 'x',
      format: 'pdf',
    });
    expect(r.success).toBe(false);
  });

  it('缺 content 应通过（延迟落盘场景，由执行器登记意图）', () => {
    const r = generateDocumentParamsSchema.safeParse({
      title: 'x',
      format: 'pdf',
    });
    expect(r.success).toBe(true);
  });

  it('空 content 也应通过（执行器按"无正文"处理，避免参数校验直接失败）', () => {
    const r = generateDocumentParamsSchema.safeParse({
      title: 'x',
      content: '',
      format: 'pdf',
    });
    expect(r.success).toBe(true);
  });

  it('缺失 format 应被拦截', () => {
    const r = generateDocumentParamsSchema.safeParse({
      title: 'x',
      content: 'x',
    });
    expect(r.success).toBe(false);
  });
});
