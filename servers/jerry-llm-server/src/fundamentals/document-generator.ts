/**
 * 文档生成器 —— Markdown → HTML / PDF / DOCX / MD
 *
 * 设计目标：
 *   提供统一的 Markdown 转换入口，让 generate_document 工具可以输出四种主流文档格式。
 *
 * 实现方案：
 *   - HTML：marked 渲染 Markdown，再包一层基础排版样式
 *   - PDF ：复用 multimodal-output 中的 puppeteer 单例，加载 HTML 后调用 page.pdf()
 *   - DOCX：使用 docx 库逐段构造段落（支持标题/段落/列表/粗体/代码块基础元素）
 *   - MD  ：原样输出 Markdown 字节（UTF-8，不写 BOM，参考 markdownToMd）
 *
 * 中文渲染：
 *   PDF 在 Docker 中依赖 fonts-noto-cjk（已在 Dockerfile 中安装）。
 *   本地 Windows 默认走系统字体，无需额外处理。
 *
 * 安全说明：
 *   marked 默认会保留内联 HTML，不要把不可信 content 直接传入；
 *   工具调用方应仅传递 LLM 生成的或可信的 Markdown 内容。
 */

import { marked } from 'marked';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  LevelFormat,
} from 'docx';
import { getBrowser } from './tools/multimodal-output';
import { logger } from './logger';
import { config } from './config';

// ==================== HTML 生成 ====================

/** 内置文档样式：黑白稳重，便于 PDF 打印和邮件查看 */
const DEFAULT_HTML_STYLE = `
  body { font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.7; color: #1f2937; max-width: 760px; margin: 40px auto; padding: 0 24px; }
  h1, h2, h3, h4 { color: #111827; line-height: 1.3; margin-top: 1.6em; }
  h1 { font-size: 1.9rem; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
  h2 { font-size: 1.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  h3 { font-size: 1.2rem; }
  p { margin: 0.8em 0; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.3em 0; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 3px; font-family: "JetBrains Mono", Consolas, monospace; font-size: 0.9em; }
  pre { background: #f3f4f6; padding: 12px 16px; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 4px solid #d1d5db; padding-left: 14px; color: #6b7280; margin: 1em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  .doc-title { text-align: center; font-size: 2.2rem; margin-bottom: 0; }
  .doc-meta { text-align: center; color: #6b7280; font-size: 0.9rem; margin-bottom: 2.4em; }
`;

export interface MarkdownToHtmlOptions {
  /** 文档标题（不传则使用内容中的第一个标题） */
  title?: string;
  /** 是否在正文上方插入标题与生成时间 */
  withHeader?: boolean;
  /** 自定义额外样式（追加在默认样式之后） */
  extraStyle?: string;
}

/** Markdown → 完整 HTML 字符串 */
export function markdownToHtml(markdown: string, options: MarkdownToHtmlOptions = {}): string {
  const { title = '', withHeader = true, extraStyle = '' } = options;
  // marked 11+ 默认同步，但类型签名是 string | Promise<string>，统一转字符串
  const body = String(marked.parse(markdown, { async: false }));

  const headerHtml = withHeader && title
    ? `<h1 class="doc-title">${escapeHtml(title)}</h1>
       <div class="doc-meta">生成时间：${new Date().toLocaleString('zh-CN')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title || 'Document')}</title>
  <style>${DEFAULT_HTML_STYLE}${extraStyle}</style>
</head>
<body>
  ${headerHtml}
  ${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== PDF 生成 ====================

export interface MarkdownToPdfOptions extends MarkdownToHtmlOptions {
  /** 纸张尺寸：默认读取 config.document.pdfFormat */
  format?: 'A4' | 'Letter' | 'Legal';
  /** 页边距 */
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
}

/** Markdown → PDF Buffer（用 Puppeteer 渲染 HTML 为 PDF） */
export async function markdownToPdf(
  markdown: string,
  options: MarkdownToPdfOptions = {},
): Promise<Buffer> {
  const html = markdownToHtml(markdown, options);
  const format = options.format || (config.document.pdfFormat as 'A4' | 'Letter' | 'Legal');
  const margin = options.margin || { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' };

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 等待字体加载，避免 PDF 中文字体未就绪
    await page.evaluateHandle('document.fonts.ready');

    const pdfData = await page.pdf({
      format,
      margin,
      printBackground: true,
    });
    // 统一返回 Node Buffer（在不同 puppeteer 版本中 page.pdf() 可能返回 Uint8Array）
    return Buffer.from(pdfData);
  } finally {
    try {
      await page.close();
    } catch {
      /* ignore */
    }
  }
}

// ==================== DOCX 生成 ====================

export interface MarkdownToDocxOptions {
  title?: string;
}

/** 有序列表使用的 numbering reference 名称 */
const ORDERED_LIST_REF = 'doc-gen-ordered-list';

/**
 * Markdown → DOCX Buffer
 * 简易实现：逐行解析，识别标题/列表/代码块/引用/普通段落
 *
 * 行内 Markdown 仅支持简单的 **粗体** / *斜体* / `code`，
 * 不处理嵌套、转义（如 \*）或链接，复杂场景请用 PDF / HTML。
 *
 * 不支持：表格、图片、复杂嵌套列表
 */
export async function markdownToDocx(
  markdown: string,
  options: MarkdownToDocxOptions = {},
): Promise<Buffer> {
  const { title = '' } = options;
  const paragraphs: Paragraph[] = [];

  if (title) {
    paragraphs.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `生成时间：${new Date().toLocaleString('zh-CN')}`,
            color: '6B7280',
            size: 18,
          }),
        ],
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({ text: '' }),
    );
  }

  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;
  const codeBuffer: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine;

    // 代码块（```）
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // 代码块结束：合并为一个等宽段落
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: codeBuffer.join('\n'),
                font: 'Consolas',
                size: 20,
              }),
            ],
            shading: { type: 'clear', color: 'auto', fill: 'F3F4F6' },
          }),
        );
        codeBuffer.length = 0;
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // 空行
    if (!line.trim()) {
      paragraphs.push(new Paragraph({ text: '' }));
      continue;
    }

    // 标题 # ## ### ####
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const heading = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ][level - 1];
      paragraphs.push(new Paragraph({ text, heading }));
      continue;
    }

    // 引用 > xxx
    if (/^>\s+/.test(line)) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: line.replace(/^>\s+/, ''), italics: true, color: '6B7280' })],
          indent: { left: 360 },
        }),
      );
      continue;
    }

    // 无序列表 - * +
    const ulMatch = /^[-*+]\s+(.+)$/.exec(line);
    if (ulMatch) {
      paragraphs.push(
        new Paragraph({
          children: parseInlineRuns(ulMatch[1]),
          bullet: { level: 0 },
        }),
      );
      continue;
    }

    // 有序列表 1. 2.
    const olMatch = /^\d+\.\s+(.+)$/.exec(line);
    if (olMatch) {
      paragraphs.push(
        new Paragraph({
          children: parseInlineRuns(olMatch[1]),
          numbering: { reference: ORDERED_LIST_REF, level: 0 },
        }),
      );
      continue;
    }

    // 普通段落（支持 **粗体** / *斜体* / `code`）
    paragraphs.push(new Paragraph({ children: parseInlineRuns(line) }));
  }

  // 兜底：未闭合的代码块
  if (inCodeBlock && codeBuffer.length > 0) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: codeBuffer.join('\n'), font: 'Consolas', size: 20 })],
      }),
    );
  }

  const doc = new Document({
    creator: 'jerry-llm-server',
    title: title || 'Document',
    // 注册有序列表 numbering 配置，与上方 ORDERED_LIST_REF 引用对应
    numbering: {
      config: [
        {
          reference: ORDERED_LIST_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 360, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children: paragraphs }],
  });

  // Packer.toBuffer 在 node 环境返回 Buffer，但类型在某些版本下声明为 Uint8Array
  // 显式包一层 Buffer.from 保证 nodemailer 等下游消费方拿到标准 Buffer
  const out = await Packer.toBuffer(doc);
  return Buffer.isBuffer(out) ? out : Buffer.from(out as unknown as Uint8Array);
}

/**
 * 解析行内 Markdown 标记为 docx TextRun 数组
 * 支持：**bold** / *italic* / `code`
 *
 * 已知局限：不处理 \* 转义、不处理嵌套（如 ***bold italic***）
 * 当输入包含复杂格式时，会以最外层正则匹配结果为准，未匹配部分作为纯文本输出
 */
function parseInlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // 用一个统一正则切分行内格式，**粗体** 优先于 *斜体* 是因为正则按顺序尝试
  const regex = /(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*?)\*)|(`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], italics: true }));
    } else if (match[6]) {
      runs.push(new TextRun({ text: match[6], font: 'Consolas' }));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }

  return runs.length > 0 ? runs : [new TextRun({ text })];
}

// ==================== MD 生成 ====================

/**
 * Markdown → Markdown Buffer
 *
 * 不做任何转换，直接把原始 Markdown 字符串作为 UTF-8 字节返回。
 * 如果传入了 title 且正文未以一级标题开头，则在最前面补一行 `# {title}`，
 * 保证文件打开后有清晰的标题。
 *
 * 注：不写 BOM —— GitHub / VSCode / Typora 等主流场景对无 BOM UTF-8 兼容性最佳，
 * 写 BOM 反而会让某些 Markdown 渲染器把首个 # 当作普通字符。
 */
export function markdownToMd(markdown: string, options: { title?: string } = {}): Buffer {
  const { title = '' } = options;
  const trimmed = markdown.trimStart();
  // 若用户已经在内容里写了 H1 则不重复加；否则用 title 补一个
  const needTitle = title && !/^#\s+/.test(trimmed);
  const finalText = needTitle ? `# ${title}\n\n${markdown}` : markdown;
  return Buffer.from(finalText, 'utf-8');
}

// ==================== 工具函数 ====================

/** 文档格式联合类型：与 generate_document 工具 schema 保持一致 */
export type DocumentFormat = 'pdf' | 'docx' | 'html' | 'md';

/** 根据格式获取标准 MIME 类型 */
export function getDocumentMimeType(format: DocumentFormat): string {
  switch (format) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'html':
      return 'text/html';
    case 'md':
      // RFC 7763 定义 text/markdown 为标准 MIME 类型
      return 'text/markdown';
  }
}

/**
 * 在文件名末尾确保有正确的扩展名
 * - 已经是目标扩展名：原样返回
 * - 已有其他文件扩展名（如 .txt / .md）：剥离后追加目标扩展名
 * - 没有扩展名：直接追加
 */
export function ensureExtension(filename: string, format: DocumentFormat): string {
  const target = `.${format}`;
  if (filename.toLowerCase().endsWith(target)) return filename;

  // 仅当末尾点号后是 1-5 个非空白字符时才视作扩展名（避免误删 "v1.0 报告" 末尾的 ".0 报告"）
  const extMatch = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  if (extMatch) {
    return filename.slice(0, filename.length - extMatch[0].length) + target;
  }
  return filename + target;
}

logger.info('文档生成器模块已加载', { module: 'DocumentGenerator' });
