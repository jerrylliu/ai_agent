/**
 * generate_document 工具 —— AI 生成 PDF / Word / HTML / Markdown 文档
 *
 * 设计目标：
 *   让 Agent 把 Markdown 内容转为 PDF / DOCX / HTML / MD 文件，
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
  markdownToMd,
  getDocumentMimeType,
  ensureExtension,
} from '../document-generator';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== Service 注入 ====================

let documentStorageService: {
  save: (params: {
    buffer: Buffer;
    filename: string;
    format: 'pdf' | 'docx' | 'html' | 'md';
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
    .optional()
    .describe(
      '文档正文内容，必须是 Markdown 格式。一般情况下不要传这个参数：请把文档正文直接写在你的回复正文里，系统会在本轮回复结束后自动取用正文生成文件。仅当需要生成的文档内容与你的回复正文不一致时，才在这里显式提供正文。',
    ),
  format: z
    .enum(['pdf', 'docx', 'html', 'md'])
    .describe(
      '输出格式：pdf（适合打印分发）、docx（Word，适合二次编辑）、html（适合网页查看）、md（Markdown 源文件，适合在 GitHub/VSCode/Typora 中查看或二次编辑）',
    ),
});

export type GenerateDocumentParams = z.infer<typeof generateDocumentParamsSchema>;

/**
 * 文档导出意图（P1：正文与格式分离）
 *
 * 模型调用 generate_document 且未提供 content 时，只登记"要导出什么标题、什么格式"，
 * 真正的正文由调用方在流式结束后从本轮回复正文中取，避免把整篇文档塞进工具参数
 * （大 payload 会拖慢首 token、易被中转站截断，也是 DSML 文本泄漏的诱因之一）。
 */
export interface GenerateDocumentIntent {
  title: string;
  format: 'pdf' | 'docx' | 'html' | 'md';
}

export const generateDocumentSchema = buildToolJsonSchema(
  'generate_document',
  '把 Markdown 内容生成为 PDF / Word(docx) / HTML / Markdown(md) 文件，返回 fileUrl 字段（内部协议引用）。当用户要求"生成 PDF/Word/HTML/Markdown 文档/报告/手册"等场景时使用。调用时只需要 title + format：请把文档正文完整写在你的回复正文里，系统会自动取用本轮回复正文生成文件并展示文件卡片。返回的 fileUrl 可直接填入 send_notification.attachments[].url 作为邮件附件发送。',
  generateDocumentParamsSchema,
);

// ==================== 类型定义 ====================

// ==================== Result Schema ====================

export const generateDocumentResultSchema = z.looseObject({
  success: z.boolean(),
  /** 类型标记：前端识别为文件卡片 */
  type: z.literal('document').optional(),
  /** 是否延迟落盘：true 表示只登记了导出意图，正文将由调用方在流式结束后补上 */
  deferred: z.boolean().optional(),
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
  /** SSE Response（或飞书 fakeResponse）：延迟落盘后要往这个通道推文件卡片 */
  res?: any;
  /** 请求级文档导出意图收集器（P1：由 prompt.ts 每次请求创建并注入，实现请求隔离） */
  docIntents?: GenerateDocumentIntent[];
}

// ==================== 执行器 ====================

/**
 * 把 Markdown 正文落盘成指定格式文档（可复用）
 *
 * 同时被两条路径复用，保证行为一致：
 *   1. 模型直接在 content 里给了正文 → executeGenerateDocument 立即调用
 *   2. 模型只登记意图 → prompt.ts 在流式结束后用本轮回复正文调用
 */
export async function persistDocument(params: {
  title: string;
  content: string;
  format: 'pdf' | 'docx' | 'html' | 'md';
  userId?: string;
  sessionId?: string;
}): Promise<GenerateDocumentResult> {
  const { title, content, format, userId, sessionId } = params;

  if (!documentStorageService) {
    return { success: false, message: '文档服务未初始化' };
  }

  const startedAt = Date.now();
  try {
    let buffer: Buffer;
    if (format === 'pdf') {
      buffer = await markdownToPdf(content, { title });
    } else if (format === 'docx') {
      buffer = await markdownToDocx(content, { title });
    } else if (format === 'md') {
      buffer = markdownToMd(content, { title });
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
      userId,
      sessionId,
    });

    const fileUrl = `${DOCUMENT_URL_PREFIX}${saved.key}`;
    // 注意：downloadUrl/previewUrl 用相对路径，前端拼接 baseUrl，避免跨环境配置错误
    const downloadUrl = `/chat/documents/download/${saved.key}`;
    const previewUrl = `/chat/documents/preview/${saved.key}`;

    logger.info('FC工具 [generate_document] 生成成功', {
      module: 'Tool:GenerateDocument',
      title,
      format,
      contentLength: content.length,
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

export async function executeGenerateDocument(
  rawParams: unknown,
  context?: ToolContext,
): Promise<GenerateDocumentResult> {
  if (!documentStorageService) {
    return { success: false, message: '文档服务未初始化' };
  }

  // zod 校验：title 非空、format 限定 pdf|docx|html|md；content 可选
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
  const body = (content ?? '').trim();

  // P1：模型没给正文 → 只登记导出意图，由调用方在流式结束后用本轮回复正文落盘，
  // 避免把整篇文档塞进工具参数（大 payload 拖慢响应、易被截断、也是文本协议泄漏的诱因）。
  // 前置条件：必须有可推送文件卡片的响应通道（SSE res / 飞书 fakeResponse）+ 意图收集器，
  // 否则"登记"永远没人兑现，只会给模型一个假成功，不如直接失败让它把正文写进回复里。
  if (!body) {
    if (!context?.docIntents || !context?.res) {
      logger.warn('FC工具 [generate_document] 未提供正文且上下文不支持延迟生成', {
        module: 'Tool:GenerateDocument',
        title,
        format,
        hasRes: !!context?.res,
        hasDocIntents: !!context?.docIntents,
      });
      return {
        success: false,
        message: '缺少文档正文：请把文档正文写入你的回复正文，或将 Markdown 正文放进 content 参数后再调用本工具',
      };
    }
    context.docIntents.push({ title, format });
    logger.info('FC工具 [generate_document] 已登记文档导出意图（正文走回复正文通道）', {
      module: 'Tool:GenerateDocument',
      title,
      format,
      intentCount: context.docIntents.length,
    });
    return {
      success: true,
      type: 'document',
      deferred: true,
      filename: ensureExtension(title.trim(), format),
      format,
      message: `已登记生成${format.toUpperCase()}文档"${title}"：请把文档正文完整写在你的回复正文里，系统会在本轮回复结束后自动取用正文生成文件并推送给用户。不要在工具参数里重复提供正文。`,
    };
  }

  return persistDocument({
    title,
    content: body,
    format,
    userId: context?.userId,
    sessionId: context?.sessionId,
  });
}
