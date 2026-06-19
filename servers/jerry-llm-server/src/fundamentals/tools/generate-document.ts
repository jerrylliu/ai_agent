/**
 * generate_document 工具 —— AI 生成 PDF / Word / HTML 文档
 *
 * 设计目标：
 *   让 Agent 把 Markdown 内容转为 PDF / DOCX / HTML 文件，
 *   返回内部协议引用 fc://document/{key}，可直接传给 send_notification.attachments 发送邮件。
 *
 * 存储策略：
 *   不再使用内存 Map 缓存。文件落盘到 DOCUMENT_STORAGE_DIR，元数据写入 generated_document 表。
 *   重启不丢、按 userId 鉴权下载、定时清理过期文件，由 GeneratedDocumentService 负责。
 *
 * 与 send_notification 协作：
 *   1. Agent 调用 generate_document 生成文档，得到 fileUrl + downloadUrl
 *   2. Agent 调用 send_notification，把 fileUrl 填入 attachments[].url
 *   3. send-notification.ts 识别 fc://document/{key}，调 service.read 拿 buffer 作附件
 */

import { z } from 'zod';
import { logger } from '../logger';
import {
  markdownToHtml,
  markdownToPdf,
  markdownToDocx,
  getDocumentMimeType,
  ensureExtension,
} from '../document-generator';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== Service 注入 ====================

let documentStorageService: {
  save: (params: {
    buffer: Buffer;
    filename: string;
    format: 'pdf' | 'docx' | 'html';
    mimeType: string;
    userId?: string;
    sessionId?: string;
  }) => Promise<{ key: string; expiresAt: Date }>;
  read: (
    key: string,
    userId: string | null,
  ) => Promise<{ entity: { mimeType: string; filename: string }; buffer: Buffer } | null>;
} | null = null;

/**
 * 注入持久化服务实例（由 AppModule.onModuleInit 调用）
 */
export function initGenerateDocumentTool(service: typeof documentStorageService): void {
  documentStorageService = service;
  logger.info('generate_document：DocumentStorageService 已注入', { module: 'Tool:GenerateDocument' });
}

// ==================== 内部协议 ====================

const DOCUMENT_URL_PREFIX = 'fc://document/';

/** 判断 URL 是否为生成文档内部协议 */
export function isDocumentUrl(url: string): boolean {
  return url.startsWith(DOCUMENT_URL_PREFIX);
}

/** 从内部 URL 中提取 key */
export function parseDocumentKey(url: string): string | null {
  if (!isDocumentUrl(url)) return null;
  return url.slice(DOCUMENT_URL_PREFIX.length);
}

/**
 * 邮件通道附件解码用：从持久化服务读取文件
 * 邮件场景不限制 userId（系统级访问）
 */
export async function getCachedDocument(
  url: string,
): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  const key = parseDocumentKey(url);
  if (!key || !documentStorageService) return null;
  const result = await documentStorageService.read(key, null);
  if (!result) return null;
  return { buffer: result.buffer, filename: result.entity.filename, mimeType: result.entity.mimeType };
}

// ==================== 工具 Schema ====================

export const generateDocumentParamsSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe('文档标题（也用于文件名，会自动追加扩展名）'),
  content: z
    .string()
    .min(1)
    .describe(
      '文档正文内容，必须是 Markdown 格式。支持标题(#)、列表、粗体(**xx**)、代码块(```)、引用(>)、表格等。',
    ),
  format: z
    .enum(['pdf', 'docx', 'html'])
    .describe(
      '输出格式：pdf（适合打印分发）、docx（Word，适合二次编辑）、html（适合网页查看）',
    ),
});

export type GenerateDocumentParams = z.infer<typeof generateDocumentParamsSchema>;

export const generateDocumentSchema = buildToolJsonSchema(
  'generate_document',
  '把 Markdown 内容生成为 PDF / Word(docx) / HTML 文件，返回 fileUrl 字段（内部协议引用）。当用户要求"生成 PDF/Word/HTML 文档/报告/手册"等场景时使用。返回的 fileUrl 可直接填入 send_notification.attachments[].url 作为邮件附件发送。',
  generateDocumentParamsSchema,
);

// ==================== 类型定义 ====================

// ==================== Result Schema ====================

export const generateDocumentResultSchema = z.looseObject({
  success: z.boolean(),
  /** 类型标记：前端识别为文件卡片 */
  type: z.literal('document').optional(),
  /** 内部协议 URL：fc://document/{key}，可传给 send_notification.attachments[].url */
  fileUrl: z.string().optional(),
  /** HTTP 下载链接：前端 FileCard 用 */
  downloadUrl: z.string().optional(),
  /** HTTP 预览链接：前端 FilePreview 用 */
  previewUrl: z.string().optional(),
  /** 文档 key（前端透传给后续操作时用） */
  key: z.string().optional(),
  filename: z.string().optional(),
  format: z.string().optional(),
  sizeBytes: z.number().optional(),
  /** 过期时间戳（毫秒） */
  expiresAt: z.number().optional(),
  message: z.string(),
});

export type GenerateDocumentResult = z.infer<typeof generateDocumentResultSchema>;

interface ToolContext {
  userId?: string;
  sessionId?: string;
}

// ==================== 执行器 ====================

export async function executeGenerateDocument(
  rawParams: unknown,
  context?: ToolContext,
): Promise<GenerateDocumentResult> {
  if (!documentStorageService) {
    return { success: false, message: '文档服务未初始化' };
  }

  // zod 校验：title / content 非空、format 限定 pdf|docx|html
  const parsed = safeParseToolParams(generateDocumentParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [generate_document] 参数校验失败', {
      module: 'Tool:GenerateDocument',
      error: parsed.error,
    });
    return {
      success: false,
      message: `参数校验失败：${parsed.error}`,
    };
  }

  const { title, content, format } = parsed.data;

  const startedAt = Date.now();
  try {
    let buffer: Buffer;
    if (format === 'pdf') {
      buffer = await markdownToPdf(content, { title });
    } else if (format === 'docx') {
      buffer = await markdownToDocx(content, { title });
    } else {
      const html = markdownToHtml(content, { title });
      buffer = Buffer.from(html, 'utf-8');
    }

    const filename = ensureExtension(title.trim(), format);
    const mimeType = getDocumentMimeType(format);

    const saved = await documentStorageService.save({
      buffer,
      filename,
      format,
      mimeType,
      userId: context?.userId,
      sessionId: context?.sessionId,
    });

    const fileUrl = `${DOCUMENT_URL_PREFIX}${saved.key}`;
    // 注意：downloadUrl/previewUrl 用相对路径，前端拼接 baseUrl，避免跨环境配置错误
    const downloadUrl = `/chat/documents/download/${saved.key}`;
    const previewUrl = `/chat/documents/preview/${saved.key}`;

    logger.info('FC工具 [generate_document] 生成成功', {
      module: 'Tool:GenerateDocument',
      title,
      format,
      sizeBytes: buffer.length,
      durationMs: Date.now() - startedAt,
      key: saved.key,
    });

    return {
      success: true,
      type: 'document',
      fileUrl,
      downloadUrl,
      previewUrl,
      key: saved.key,
      filename,
      format,
      sizeBytes: buffer.length,
      expiresAt: saved.expiresAt.getTime(),
      message: `${format.toUpperCase()} 文档"${filename}"已生成，可下载或通过 send_notification 发送邮件（attachments[].url 填 ${fileUrl}）`,
    };
  } catch (error: any) {
    logger.error('FC工具 [generate_document] 生成失败', {
      module: 'Tool:GenerateDocument',
      title,
      format,
      error: error?.message || String(error),
    });
    return {
      success: false,
      message: `生成${format}文档失败：${error?.message || String(error)}`,
    };
  }
}
