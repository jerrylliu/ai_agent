/**
 * Word 文档图片提取器
 *
 * 职责：
 * 1. 使用 mammoth.convertToHtml 将 .docx 转为 HTML
 * 2. 用 cheerio 解析 HTML，提取 <img> 标签中的 base64 图片
 * 3. 将 HTML 转为纯文本（保留 [图片] 占位符）
 * 4. 按 [图片] 占位符分割纯文本，为每张图片建立精确的、不重叠的上下文
 *
 * 核心设计：
 * - 图片的上下文（surroundingText）通过纯文本分割确定，而非 DOM 兄弟元素查找
 * - 第 i 张图片的前文 = 纯文本中第 i 个 [图片] 之前的文本（到上一个 [图片] 为止）
 * - 第 i 张图片的后文 = 纯文本中第 i 个 [图片] 之后的文本（到下一个 [图片] 为止）
 * - 这样每张图片的上下文是独占的、不重叠的，标题和图片的对应关系由文档顺序天然确定
 *
 * 调用方：document-parser.ts 的 parseWordFile
 */

import * as cheerio from 'cheerio';
import type { ImageAsset } from './index.js';
import { logger } from '../logger.js';

/** mammoth convertToHtml 的返回类型 */
interface MammothHtmlResult {
  value: string;
  messages: Array<{ type: string; message: string }>;
}

/** 从 data URL 中提取 MIME 和 base64 数据 */
function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  try {
    const buffer = Buffer.from(base64, 'base64');
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

/**
 * S4-6 修复：根据 MIME 类型推断文件扩展名
 *
 * mammoth 保留 docx 中原始图片格式，可能是 JPEG/GIF/BMP 等，
 * originalPath 的扩展名应与实际格式匹配
 */
function mimeToExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    case 'image/webp':
      return 'webp';
    case 'image/tiff':
      return 'tiff';
    default:
      return 'png';
  }
}

/** 图片大小阈值：小于 1KB 的图片视为图标/装饰图，不提取 */
const MIN_IMAGE_SIZE = 1024;

/**
 * 从 Word 文档提取文本和图片
 *
 * 流程：
 * 1. mammoth 将 .docx 转为 HTML
 * 2. cheerio 加载 HTML
 * 3. 遍历 <img>，提取 >= 1KB 的大图片（记录 buffer、sourceIndex）
 * 4. 替换 <img> 为 [图片] 占位符（只替换 >= 1KB 的，小图标移除）
 * 5. 转换为纯文本
 * 6. 按 [图片] 分割纯文本，为每张图片分配精确的、不重叠的前后文
 *
 * @param filePath .docx 文件路径
 * @returns { text: 纯文本, images: 图片资源数组 }
 */
export async function extractFromWord(
  filePath: string,
): Promise<{ text: string; images: ImageAsset[] }> {
  // 动态 import mammoth 避免在非 Word 路径下加载
  const mammoth = await import('mammoth');

  const result = (await mammoth.convertToHtml({ path: filePath })) as MammothHtmlResult;

  if (result.messages && result.messages.length > 0) {
    const warnings = result.messages.filter((m) => m.type === 'warning').length;
    const errors = result.messages.filter((m) => m.type === 'error').length;
    if (warnings > 0 || errors > 0) {
      logger.debug('mammoth 转换产生消息', {
        module: 'WordExtractor',
        warnings,
        errors,
      });
    }
  }

  const html = result.value;
  const $ = cheerio.load(html);

  // 1. 提取图片（只记录 buffer、sourceIndex、originalPath，上下文后续通过文本分割确定）
  const images: ImageAsset[] = [];
  let sourceIndex = 0;

  $('img').each((_, elem) => {
    const src = $(elem).attr('src') || '';
    const parsed = parseDataUrl(src);
    if (!parsed) return;

    // 跳过过小的图片（如图标、装饰图，小于 1KB）
    if (parsed.buffer.length < MIN_IMAGE_SIZE) return;

    // S4-6 修复：根据实际 MIME 类型推断扩展名，而非固定 .png
    const ext = mimeToExtension(parsed.mimeType);
    images.push({
      buffer: parsed.buffer,
      sourceIndex: sourceIndex++,
      caption: null, // 上下文后续通过文本分割确定
      page: null, // Word 没有 PDF 那样的页码概念
      section: null,
      surroundingText: '', // 上下文后续通过文本分割确定
      originalPath: `word_img_${sourceIndex - 1}.${ext}`,
      sourceType: 'embedded' as const,
    });
  });

  // 2. 替换 <img> 为 [图片] 占位符（只替换 >= 1KB 的，小图标移除）
  // 保持占位符数量与提取的图片数量一致，避免索引错位
  $('img').each((_, elem) => {
    const src = $(elem).attr('src') || '';
    const parsed = parseDataUrl(src);
    if (parsed && parsed.buffer.length >= MIN_IMAGE_SIZE) {
      $(elem).replaceWith('[图片]');
    } else {
      $(elem).remove();
    }
  });

  // 3. 转换为纯文本（保留段落结构）
  const text = htmlToText($);

  // 4. 按 [图片] 分割纯文本，为每张图片分配精确的、不重叠的前后文
  assignImageContextFromText(text, images);

  logger.info('Word 文档解析完成', {
    module: 'WordExtractor',
    fileName: filePath.split(/[\\/]/).pop(),
    textLength: text.length,
    imagesCount: images.length,
  });

  return { text, images };
}

/**
 * 按 [图片] 占位符分割纯文本，为每张图片分配精确的、不重叠的上下文
 *
 * 核心逻辑：
 * - 纯文本中 [图片] 占位符的位置就是图片在文档中的位置
 * - 按 [图片] 分割文本，得到 N+1 段（N 张图片）
 * - 第 i 张图片的前文 = 第 i 段文本（到上一张图片为止的内容）
 * - 第 i 张图片的后文 = 第 i+1 段文本（到下一张图片为止的内容）
 *
 * 这样每张图片的上下文是独占的、不重叠的：
 * - "地下城市：鲜血君王的领地 [图片] 雪山：前往独眼巨人..." 中
 * - 第 0 张图片的前文 = "地下城市：鲜血君王的领地"
 * - 第 0 张图片的后文 = "雪山：前往独眼巨人..."（属于下一张图片的前文）
 *
 * @param text 纯文本（含 [图片] 占位符）
 * @param images 图片数组（会被原地修改 surroundingText 和 caption）
 */
function assignImageContextFromText(text: string, images: ImageAsset[]): void {
  if (images.length === 0) return;

  // 按 [图片] 或 [图片 N] 分割
  const parts = text.split(/\[图片(?:\s*\d+)?\]/);

  for (let i = 0; i < images.length; i++) {
    // 前文：第 i 段（到上一张图片为止的内容）
    // 取最后 500 字符，保留最近的上下文
    const beforeText = (parts[i] || '').trim().slice(-500);

    // 后文：第 i+1 段（到下一张图片为止的内容）
    // 取最前 500 字符，保留最近的上下文
    const afterText = (parts[i + 1] || '').trim().slice(0, 500);

    const surroundingText = `${beforeText}\n[图片位置]\n${afterText}`.slice(0, 1000);
    images[i].surroundingText = surroundingText;

    // caption：取前文的最后一个非空行作为标题
    // 这是最自然的"图片标题"——文档中紧挨图片前面的那行文字
    const beforeLines = beforeText.split('\n').filter((l) => l.trim().length > 0);
    const lastLine = beforeLines[beforeLines.length - 1] || '';
    if (lastLine.length >= 2 && lastLine.length <= 100) {
      images[i].caption = lastLine.trim();
    }

    // section：取前文中第一个看起来像章节标题的行（以 # 开头或全大写或含"章"字）
    for (const line of beforeLines) {
      const trimmed = line.trim();
      if (trimmed.length >= 2 && trimmed.length <= 50) {
        // 匹配 "# 标题" 或 "第N章" 或 "N. 标题" 格式
        if (/^#{1,6}\s+/.test(trimmed) || /^第.+章/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
          images[i].section = trimmed.replace(/^#{1,6}\s+/, '');
          break;
        }
      }
    }
  }
}

/**
 * 将 HTML 转为纯文本，保留段落结构
 *
 * 策略：
 * - <img> 已在调用前替换为 [图片] 占位符，此处不再处理
 * - 块级元素后加换行
 * - 行内元素保留空格分隔
 * - 去除多余空白
 */
function htmlToText($: cheerio.CheerioAPI): string {
  // 块级元素后加换行
  const blockTags = [
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'tr', 'table', 'br', 'hr',
  ];
  for (const tag of blockTags) {
    $(tag).each((_, elem) => {
      $(elem).after('\n');
    });
  }

  // 提取 body 文本
  let text = $('body').text() || $.html();

  // 清理多余空白
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}
