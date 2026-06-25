/**
 * generate-document.spec.ts —— executor 端到端测试（聚焦 md 分支）
 *
 * 覆盖：
 *   - format='md' 时调用 markdownToMd 而非其他生成器
 *   - 注入的 documentStorageService 收到正确的 mimeType / filename / format
 *   - 返回值包含 fileUrl / downloadUrl / previewUrl / mimeType 透传
 *   - service 未注入时返回失败
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 阻断真实 document-generator（含 puppeteer / marked / docx）
jest.mock('../document-generator', () => ({
  markdownToHtml: jest.fn(() => '<p>html</p>'),
  markdownToPdf: jest.fn(async () => Buffer.from('pdf-bytes')),
  markdownToDocx: jest.fn(async () => Buffer.from('docx-bytes')),
  markdownToMd: jest.fn((md: string, opts: { title?: string }) => {
    const needTitle = opts.title && !/^#\s+/.test(md.trimStart());
    return Buffer.from(needTitle ? `# ${opts.title}\n\n${md}` : md, 'utf-8');
  }),
  getDocumentMimeType: (format: string) => {
    switch (format) {
      case 'pdf': return 'application/pdf';
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'html': return 'text/html';
      case 'md': return 'text/markdown';
      default: return 'application/octet-stream';
    }
  },
  ensureExtension: (filename: string, format: string) => {
    const target = `.${format}`;
    return filename.toLowerCase().endsWith(target) ? filename : `${filename}${target}`;
  },
}));

import {
  executeGenerateDocument,
  initGenerateDocumentTool,
} from './generate-document';
import * as docGen from '../document-generator';

describe('executeGenerateDocument —— md 输出端到端', () => {
  const savedKey = 'abc123';
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  let saveSpy: jest.Mock;

  beforeEach(() => {
    // 清理跨用例残留的调用计数
    (docGen.markdownToHtml as jest.Mock).mockClear();
    (docGen.markdownToPdf as jest.Mock).mockClear();
    (docGen.markdownToDocx as jest.Mock).mockClear();
    (docGen.markdownToMd as jest.Mock).mockClear();

    saveSpy = jest.fn(async () => ({ key: savedKey, expiresAt }));
    initGenerateDocumentTool({
      save: saveSpy,
      read: jest.fn(),
    });
  });

  it('format=md 时调用 markdownToMd，且 service 收到 text/markdown', async () => {
    const result = await executeGenerateDocument({
      title: '周报',
      content: '本周完成 3 件事',
      format: 'md',
    });

    expect(result.success).toBe(true);
    expect(result.type).toBe('document');
    expect(result.format).toBe('md');
    expect(result.filename).toBe('周报.md');
    expect(result.fileUrl).toBe(`fc://document/${savedKey}`);
    expect(result.downloadUrl).toBe(`/chat/documents/download/${savedKey}`);
    expect(result.previewUrl).toBe(`/chat/documents/preview/${savedKey}`);
    expect(result.expiresAt).toBe(expiresAt.getTime());

    // 校验 service 调用参数：mimeType / format / filename / buffer 内容
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const args = saveSpy.mock.calls[0][0];
    expect(args.format).toBe('md');
    expect(args.mimeType).toBe('text/markdown');
    expect(args.filename).toBe('周报.md');
    expect(args.buffer).toBeInstanceOf(Buffer);
    // markdownToMd mock 行为：未含 H1 时补 "# title\n\n"
    expect(args.buffer.toString('utf-8')).toBe('# 周报\n\n本周完成 3 件事');

    // 校验其他生成器没被调用
    expect(docGen.markdownToHtml).not.toHaveBeenCalled();
    expect(docGen.markdownToPdf).not.toHaveBeenCalled();
    expect(docGen.markdownToDocx).not.toHaveBeenCalled();
    expect(docGen.markdownToMd).toHaveBeenCalledTimes(1);
  });

  it('format=md 同其他格式互斥：format=pdf 时不调 markdownToMd', async () => {
    const result = await executeGenerateDocument({
      title: '报告',
      content: '# 内容',
      format: 'pdf',
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe('pdf');
    expect(docGen.markdownToPdf).toHaveBeenCalledTimes(1);
    expect(docGen.markdownToMd).not.toHaveBeenCalled();
  });

  it('format=md 但 service 未注入：返回失败', async () => {
    // 显式清空注入
    initGenerateDocumentTool(null as any);
    const result = await executeGenerateDocument({
      title: 'x',
      content: 'y',
      format: 'md',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('文档服务未初始化');
  });

  it('参数缺失 format 时返回失败（不调用任何生成器）', async () => {
    const result = await executeGenerateDocument({
      title: 'x',
      content: 'y',
    });
    expect(result.success).toBe(false);
    expect(docGen.markdownToMd).not.toHaveBeenCalled();
  });
});
