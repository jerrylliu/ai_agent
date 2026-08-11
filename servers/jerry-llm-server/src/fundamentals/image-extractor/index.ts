/**
 * 图片提取器统一出口与类型定义
 *
 * 各文档类型的图片提取器放在同目录下：
 * - pdf-mineru.ts: MinerU 路径（直接从 SDK 返回的 images 数组提取）
 * - pdf-pdfjs.ts: pdfjs 降级路径（Slice 4 引入）
 * - word.ts: Word 文档（Slice 4 引入）
 * - excel.ts: Excel 文档（暂未实现，后续按需引入）
 *
 * 每个提取器返回统一的 ImageAsset 数组，供 vision-translator 消费。
 */

/**
 * 从文档中提取的图片资源
 *
 * 设计原则：
 * - buffer 携带二进制内容，用于 VLM 调用和落盘
 * - surroundingText 由调用方在解析阶段填充（从原文上下文提取）
 * - caption / page / section 尽量提取，缺失则为 null
 */
export interface ImageAsset {
  /** 图片二进制内容 */
  buffer: Buffer;

  /** 图片在文档中的索引（0-based，用于落盘文件名和元数据） */
  sourceIndex: number;

  /** 原文图注（如"图1：系统架构图"），缺失则为 null */
  caption: string | null;

  /** 所在页码（PDF 才有意义），缺失则为 null */
  page: number | null;

  /** 所在章节（如"3.2 系统设计"），缺失则为 null */
  section: string | null;

  /** 前后文摘要（最多 500 字，用于 VLM Prompt 和反查） */
  surroundingText: string;

  /** 原始图片在 ZIP/markdown 中的路径（MinerU 返回的 path 字段） */
  originalPath: string;

  /** 图片来源类型：内嵌图片 or 扫描件渲染页 */
  sourceType: 'embedded' | 'scanned_page';
}

/**
 * 解析后的文档
 *
 * parseDocument 的返回值，包含纯文本和图片资源列表。
 * 各解析器（PDF/Word/Excel）都返回此结构，无图片的文档 images 为空数组。
 */
export interface ParsedDocument {
  /** 提取的纯文本内容（含 Markdown 标记，供切分器使用） */
  text: string;

  /** 提取的图片资源列表（可能为空） */
  images: ImageAsset[];
}
