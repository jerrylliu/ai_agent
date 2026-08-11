/**
 * MinerU 路径图片提取器
 *
 * MinerU SDK 返回的 images 数组元素结构：{ name, data: Uint8Array, path }
 * 本模块负责：
 * 1. 从 MinerU markdown 中提取每张图片的图注、所在章节、前后文
 * 2. 将 Uint8Array 转为 Buffer，构造统一的 ImageAsset
 *
 * 调用方：document-parser.ts 的 parsePdfWithMineru
 */

import type { ImageAsset } from './index.js';

/** MinerU SDK 返回的图片元素结构 */
interface MineruImage {
  name: string;
  data: Uint8Array;
  path: string;
}

/** MinerU SDK 返回的解析结果结构（仅声明本模块用到的字段） */
export interface MineruExtractResult {
  markdown: string | null;
  images: MineruImage[];
}

/**
 * 从 MinerU markdown 中提取图片及其上下文
 *
 * MinerU 返回的 markdown 中图片以 `![](images/xxx.jpg)` 形式引用，
 * images 数组的 path 字段对应 markdown 中的引用路径。
 *
 * 上下文提取策略：
 * - 图注：图片引用前一行如果是"图N：xxx"格式，则提取为 caption
 * - 章节：向上查找最近的 `## ` 或 `# ` 标题行
 * - 前后文：图片引用位置前后各取 250 字符
 *
 * @param markdown MinerU 返回的 markdown 文本
 * @param images MinerU 返回的 images 数组
 * @returns 统一的 ImageAsset 数组（与 images 索引一一对应）
 */
export function extractImagesFromMineru(
  markdown: string,
  images: MineruImage[],
): ImageAsset[] {
  if (!markdown || images.length === 0) {
    return [];
  }

  return images.map((img, index) => {
    // 1. 在 markdown 中定位图片引用位置
    // MinerU markdown 中的引用格式：![](images/xxx.jpg) 或 ![](xxx.jpg)
    // 用 path 字段匹配，找不到则用 name 匹配
    const refPattern = buildImageRefPattern(img.path, img.name);
    const matchIdx = markdown.search(refPattern);

    let caption: string | null = null;
    let section: string | null = null;
    let surroundingText = '';

    if (matchIdx >= 0) {
      const before = markdown.slice(0, matchIdx);
      const after = markdown.slice(matchIdx);

      // 2. 提取图注：图片引用前一行，匹配"图N：xxx"或"图N: xxx"
      const linesBefore = before.split('\n').filter((l) => l.trim().length > 0);
      const lastLine = linesBefore[linesBefore.length - 1] || '';
      const captionMatch = lastLine.match(/^图\s*\d+\s*[:：]\s*(.+)$/);
      if (captionMatch) {
        caption = `图${captionMatch[1] ? '' : ''}${lastLine}`.trim();
        // 实际上直接用原文行更准确
        caption = lastLine.trim();
      }

      // 3. 提取章节：向上查找最近的标题行（# / ## / ###）
      for (let i = linesBefore.length - 1; i >= 0; i--) {
        const headerMatch = linesBefore[i].match(/^#{1,6}\s+(.+)$/);
        if (headerMatch) {
          section = headerMatch[1].trim();
          break;
        }
      }

      // 4. 提取前后文：图片位置前后各 250 字符
      const beforeText = before.slice(-250);
      const afterText = after.slice(0, 250);
      surroundingText = `${beforeText}\n[图片位置]\n${afterText}`.slice(0, 500);
    } else {
      // markdown 中找不到引用，使用文件名作为 fallback
      surroundingText = `（图片：${img.name}，未在 markdown 中找到引用位置）`;
    }

    // Uint8Array -> Buffer（共享底层 buffer，零拷贝）
    const buffer = Buffer.from(
      img.data.buffer,
      img.data.byteOffset,
      img.data.byteLength,
    );

    return {
      buffer,
      sourceIndex: index,
      caption,
      page: null, // MinerU 不直接返回页码，需要时从 markdown 的 page 标记提取
      section,
      surroundingText,
      originalPath: img.path,
      sourceType: 'embedded' as const,
    };
  });
}

/**
 * 构造匹配 MinerU markdown 图片引用的正则
 *
 * MinerU 返回的 path 形如 "images/abc.jpg" 或 "abc.jpg"，
 * markdown 中的引用形如 `![](images/abc.jpg)`。
 * 对 path 中的特殊正则字符做转义。
 */
function buildImageRefPattern(path: string, name: string): RegExp {
  // 优先用 path 匹配（更精确）
  // 转义 path 中的正则特殊字符
  const escapedPath = escapeRegExp(path);
  const escapedName = escapeRegExp(name);

  // 尝试匹配 ![xxx](path) 或 ![xxx](name)
  // 路径中可能包含或不包含目录前缀，用 alternation 兼容
  const pattern = `!\\[[^\\]]*\\]\\((?:.*${escapedPath}|.*${escapedName})\\)`;
  return new RegExp(pattern);
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
