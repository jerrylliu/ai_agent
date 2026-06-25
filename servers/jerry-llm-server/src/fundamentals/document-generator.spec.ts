/**
 * document-generator.spec.ts
 *
 * 覆盖 generate_document 工具新增 md 输出后的核心工具函数：
 *   - markdownToMd：原样输出 + 自动补 H1 标题
 *   - getDocumentMimeType：md → text/markdown
 *   - ensureExtension：md 扩展名补全 / 替换
 *
 * 显式 mock 重依赖（puppeteer / config / logger），避免单测拉起浏览器。
 */

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('./config', () => ({
  config: { document: { pdfFormat: 'A4' } },
}));

// 阻断 puppeteer 真实加载（document-generator 顶层 import 了 getBrowser）
jest.mock('./tools/multimodal-output', () => ({
  getBrowser: jest.fn(),
}));

// marked 是 ESM-only 包，jest 默认不转换 node_modules → 必须 mock
jest.mock('marked', () => ({
  marked: { parse: (s: string) => s },
}));

// docx 在测试环境也无需真实加载
jest.mock('docx', () => ({
  Document: class {},
  Packer: { toBuffer: async () => Buffer.from('') },
  Paragraph: class {},
  TextRun: class {},
  HeadingLevel: { TITLE: 0, HEADING_1: 1, HEADING_2: 2, HEADING_3: 3, HEADING_4: 4 },
  AlignmentType: { CENTER: 'center', START: 'start' },
  LevelFormat: { DECIMAL: 'decimal' },
}));

import {
  markdownToMd,
  getDocumentMimeType,
  ensureExtension,
} from './document-generator';

describe('markdownToMd', () => {
  it('内容已包含 H1 时不重复补标题', () => {
    const buf = markdownToMd('# 已存在标题\n\n正文', { title: '不应被使用' });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString('utf-8')).toBe('# 已存在标题\n\n正文');
  });

  it('内容未含 H1 且提供 title 时，自动补一行 H1', () => {
    const buf = markdownToMd('正文段落', { title: '我的报告' });
    expect(buf.toString('utf-8')).toBe('# 我的报告\n\n正文段落');
  });

  it('未提供 title 时，原样输出', () => {
    const buf = markdownToMd('随便写点什么');
    expect(buf.toString('utf-8')).toBe('随便写点什么');
  });

  it('输出为 UTF-8 字节且不含 BOM（首字节非 0xEF）', () => {
    const buf = markdownToMd('# 中文标题\n\n内容含中文', { title: 't' });
    expect(buf[0]).not.toBe(0xef);
    // 中文应能完整还原
    expect(buf.toString('utf-8')).toContain('中文标题');
    expect(buf.toString('utf-8')).toContain('内容含中文');
  });

  it('content 前导空白不影响 H1 检测', () => {
    // 前导空行 + H1，不应被再次补标题
    const buf = markdownToMd('\n\n# 已有标题', { title: '不要补' });
    expect(buf.toString('utf-8').startsWith('\n\n# 已有标题')).toBe(true);
    expect(buf.toString('utf-8').includes('# 不要补')).toBe(false);
  });
});

describe('getDocumentMimeType', () => {
  it.each([
    ['pdf', 'application/pdf'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['html', 'text/html'],
    ['md', 'text/markdown'],
  ] as const)('%s → %s', (format, expected) => {
    expect(getDocumentMimeType(format)).toBe(expected);
  });
});

describe('ensureExtension', () => {
  it('已是目标扩展名时原样返回', () => {
    expect(ensureExtension('报告.md', 'md')).toBe('报告.md');
    expect(ensureExtension('plan.MD', 'md')).toBe('plan.MD');
  });

  it('目标 md 但当前是其他扩展名时，替换扩展名', () => {
    expect(ensureExtension('报告.pdf', 'md')).toBe('报告.md');
    expect(ensureExtension('plan.docx', 'md')).toBe('plan.md');
  });

  it('无扩展名时直接追加 .md', () => {
    expect(ensureExtension('报告', 'md')).toBe('报告.md');
  });

  it('文件名末尾的非扩展名"点"不被误识别', () => {
    // "v1.0 报告" 末尾的 ".0 报告" 不是扩展名，应直接追加
    expect(ensureExtension('v1.0 报告', 'md')).toBe('v1.0 报告.md');
  });
});
