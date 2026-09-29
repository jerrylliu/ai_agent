/**
 * 文档操作工具
 *
 * 让 Agent 可以主动操作知识库文档：
 * - create_document: 创建新文档
 * - update_document: 更新文档内容
 * - summarize_document: 对指定文档生成摘要
 * - compare_documents: 对比两个文档差异
 */

import { z } from 'zod';
import { logger } from '../logger';
import { createLLM, buildModelConfig } from '../model-provider';
import { HumanMessage } from '@langchain/core/messages';
import * as Diff from 'diff';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== DocumentService 注入 ====================

let documentService: any = null;

/**
 * 注入 DocumentService 实例
 * 在 AppModule 初始化时调用
 */
export function initDocumentTools(service: any): void {
  documentService = service;
  logger.info('文档操作工具：DocumentService 已注入', {
    module: 'Tool:DocumentOps',
  });
}

// ==================== create_document ====================

export const createDocumentParamsSchema = z.object({
  title: z.string().min(1).describe('文档标题'),
  content: z.string().min(1).describe('文档内容（纯文本或 Markdown 格式）'),
  description: z.string().optional().describe('文档描述（可选）'),
  tags: z.array(z.string()).optional().describe('文档标签列表（可选）'),
});

export type CreateDocumentParams = z.infer<typeof createDocumentParamsSchema>;

export const createDocumentSchema = buildToolJsonSchema(
  'create_document',
  '在知识库中创建新文档。当用户需要新建文档、记录笔记、保存信息时使用此工具。',
  createDocumentParamsSchema,
);

export interface CreateDocumentResult {
  success: boolean;
  documentId?: number;
  title: string;
  message: string;
}

export async function executeCreateDocument(
  rawParams: unknown,
): Promise<CreateDocumentResult> {
  const parsed = safeParseToolParams(createDocumentParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [create_document] 参数校验失败', {
      module: 'Tool:DocumentOps',
      error: parsed.error,
    });
    return {
      success: false,
      title: (rawParams as { title?: string })?.title || '',
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!documentService) {
    return {
      success: false,
      title: params.title,
      message: '文档服务未初始化',
    };
  }

  try {
    // 将文本内容转为 Buffer 模拟文件上传
    const contentBuffer = Buffer.from(params.content, 'utf-8');
    const fileName = `${params.title}.md`;

    const result = await documentService.uploadDocument(
      {
        buffer: contentBuffer,
        originalname: fileName,
        size: contentBuffer.length,
        mimetype: 'text/markdown',
      },
      {
        title: params.title,
        description: params.description,
        tags: params.tags || [],
        operator: 'agent',
      },
    );

    logger.info('FC工具 [create_document] 创建文档成功', {
      module: 'Tool:DocumentOps',
      title: params.title,
      documentId: result.document.id,
    });

    return {
      success: true,
      documentId: result.document.id,
      title: params.title,
      message: `文档"${params.title}"已创建成功，文档ID: ${result.document.id}`,
    };
  } catch (error: any) {
    logger.error('FC工具 [create_document] 创建文档失败', {
      module: 'Tool:DocumentOps',
      title: params.title,
      error: error.message,
    });
    return {
      success: false,
      title: params.title,
      message: `创建文档失败: ${error.message}`,
    };
  }
}

// ==================== update_document ====================

export const updateDocumentParamsSchema = z.object({
  documentId: z.number().int().positive().describe('要更新的文档ID'),
  content: z.string().min(1).describe('新的文档内容（纯文本或 Markdown 格式）'),
  title: z.string().optional().describe('新标题（可选，不传则保持原标题）'),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      '文档标签列表（可选）。传入时整体替换现有标签，空数组表示清空全部标签；不传则保持不变',
    ),
});

export type UpdateDocumentParams = z.infer<typeof updateDocumentParamsSchema>;

export const updateDocumentSchema = buildToolJsonSchema(
  'update_document',
  '更新知识库中已有文档的内容。通过上传新版本更新文档，保留历史版本。可同时更新标题与标签（仅改标签时正文也需原样传入）。',
  updateDocumentParamsSchema,
);

export interface UpdateDocumentResult {
  success: boolean;
  documentId: number;
  versionNumber?: number;
  message: string;
}

export async function executeUpdateDocument(
  rawParams: unknown,
): Promise<UpdateDocumentResult> {
  const parsed = safeParseToolParams(updateDocumentParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [update_document] 参数校验失败', {
      module: 'Tool:DocumentOps',
      error: parsed.error,
    });
    return {
      success: false,
      documentId: (rawParams as { documentId?: number })?.documentId ?? 0,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!documentService) {
    return {
      success: false,
      documentId: params.documentId,
      message: '文档服务未初始化',
    };
  }

  try {
    const contentBuffer = Buffer.from(params.content, 'utf-8');
    const fileName = `${params.title || 'update'}.md`;

    const result = await documentService.uploadDocument(
      {
        buffer: contentBuffer,
        originalname: fileName,
        size: contentBuffer.length,
        mimetype: 'text/markdown',
      },
      {
        documentId: params.documentId,
        title: params.title,
        operator: 'agent',
      },
    );

    // 标题/标签为元信息修改（不产生新版本）：仅在提供时额外调用 updateDocument。
    // 注意 tags 与 title 判断方式不同——空数组是有效值（清空全部标签），
    // 必须用 !== undefined 判断，用 truthy 判断会漏掉空数组
    const metaPatch: { title?: string; tags?: string[] } = {};
    if (params.title) metaPatch.title = params.title;
    if (params.tags !== undefined) metaPatch.tags = params.tags;
    if (Object.keys(metaPatch).length > 0) {
      await documentService.updateDocument(params.documentId, metaPatch);
    }

    logger.info('FC工具 [update_document] 更新文档成功', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      versionNumber: result.version.versionNumber,
    });

    return {
      success: true,
      documentId: params.documentId,
      versionNumber: result.version.versionNumber,
      message: `文档已更新为新版本 v${result.version.versionNumber}`,
    };
  } catch (error: any) {
    logger.error('FC工具 [update_document] 更新文档失败', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      error: error.message,
    });
    return {
      success: false,
      documentId: params.documentId,
      message: `更新文档失败: ${error.message}`,
    };
  }
}

// ==================== summarize_document ====================

export const summarizeDocumentParamsSchema = z.object({
  documentId: z.number().int().positive().describe('要生成摘要的文档ID'),
  maxLength: z
    .number()
    .int()
    .positive()
    .default(200)
    .describe('摘要最大长度（字数），默认200'),
});

export type SummarizeDocumentParams = z.infer<
  typeof summarizeDocumentParamsSchema
>;

export const summarizeDocumentSchema = buildToolJsonSchema(
  'summarize_document',
  '对指定文档生成摘要。当用户需要快速了解文档核心内容时使用此工具。',
  summarizeDocumentParamsSchema,
);

export interface SummarizeDocumentResult {
  success: boolean;
  documentId: number;
  title?: string;
  summary?: string;
  message: string;
}

export async function executeSummarizeDocument(
  rawParams: unknown,
): Promise<SummarizeDocumentResult> {
  const parsed = safeParseToolParams(summarizeDocumentParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [summarize_document] 参数校验失败', {
      module: 'Tool:DocumentOps',
      error: parsed.error,
    });
    return {
      success: false,
      documentId: (rawParams as { documentId?: number })?.documentId ?? 0,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!documentService) {
    return {
      success: false,
      documentId: params.documentId,
      message: '文档服务未初始化',
    };
  }

  try {
    const doc = await documentService.getDocument(params.documentId);
    if (!doc) {
      return {
        success: false,
        documentId: params.documentId,
        message: `文档 ${params.documentId} 不存在`,
      };
    }

    // 获取文档内容（从最新活跃版本）
    const versions = await documentService.listVersions(params.documentId);
    const activeVersion = versions?.find((v: any) => v.status === 'active');
    if (!activeVersion) {
      return {
        success: false,
        documentId: params.documentId,
        title: doc.title,
        message: '文档没有可用的活跃版本',
      };
    }

    // 读取文件内容
    const { readVersionFile } = await import('../file-storage.js');
    const fileBuffer = readVersionFile(activeVersion.fileUrl);
    if (!fileBuffer) {
      return {
        success: false,
        documentId: params.documentId,
        title: doc.title,
        message: '无法读取文档文件内容',
      };
    }

    const content = fileBuffer.toString('utf-8');
    const maxLen = params.maxLength;

    // 使用 LLM 生成摘要
    const llm = createLLM(buildModelConfig('deepseek:deepseek-v4-flash'));
    const prompt = `请对以下文档内容生成摘要，要求：
1. 不超过${maxLen}字
2. 提炼核心观点和关键信息
3. 保持客观，不添加原文没有的信息

文档标题：${doc.title}

文档内容：
${content.substring(0, 6000)}

摘要：`;

    const result = await llm.invoke([new HumanMessage(prompt)]);
    const summary =
      typeof result.content === 'string' ? result.content.trim() : '';

    logger.info('FC工具 [summarize_document] 生成摘要成功', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      summaryLength: summary.length,
    });

    return {
      success: true,
      documentId: params.documentId,
      title: doc.title,
      summary,
      message: `文档"${doc.title}"的摘要已生成`,
    };
  } catch (error: any) {
    logger.error('FC工具 [summarize_document] 生成摘要失败', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      error: error.message,
    });
    return {
      success: false,
      documentId: params.documentId,
      message: `生成摘要失败: ${error.message}`,
    };
  }
}

// ==================== compare_documents ====================

export const compareDocumentsParamsSchema = z.object({
  documentId1: z.number().int().positive().describe('第一个文档的ID'),
  documentId2: z.number().int().positive().describe('第二个文档的ID'),
});

export type CompareDocumentsParams = z.infer<
  typeof compareDocumentsParamsSchema
>;

export const compareDocumentsSchema = buildToolJsonSchema(
  'compare_documents',
  '对比两个文档的差异。当用户需要比较两份文档的不同之处时使用此工具。',
  compareDocumentsParamsSchema,
);

export interface CompareDocumentsResult {
  success: boolean;
  document1Title?: string;
  document2Title?: string;
  diff?: string;
  similarity?: number;
  message: string;
}

export async function executeCompareDocuments(
  rawParams: unknown,
): Promise<CompareDocumentsResult> {
  const parsed = safeParseToolParams(compareDocumentsParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [compare_documents] 参数校验失败', {
      module: 'Tool:DocumentOps',
      error: parsed.error,
    });
    return {
      success: false,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!documentService) {
    return {
      success: false,
      message: '文档服务未初始化',
    };
  }

  try {
    const [doc1, doc2] = await Promise.all([
      documentService.getDocument(params.documentId1),
      documentService.getDocument(params.documentId2),
    ]);

    if (!doc1) {
      return { success: false, message: `文档 ${params.documentId1} 不存在` };
    }
    if (!doc2) {
      return { success: false, message: `文档 ${params.documentId2} 不存在` };
    }

    // 获取活跃版本内容
    const { readVersionFile } = await import('../file-storage.js');
    const getContent = async (doc: any) => {
      const versions = await documentService.listVersions(doc.id);
      const active = versions?.find((v: any) => v.status === 'active');
      if (!active) return '';
      const buf = readVersionFile(active.fileUrl);
      return buf ? buf.toString('utf-8') : '';
    };

    const [content1, content2] = await Promise.all([
      getContent(doc1),
      getContent(doc2),
    ]);

    if (!content1 || !content2) {
      return {
        success: false,
        document1Title: doc1.title,
        document2Title: doc2.title,
        message: '无法读取文档内容进行比较',
      };
    }

    // 计算差异
    const changes = Diff.diffLines(content1, content2);
    let addedLines = 0;
    let removedLines = 0;
    let unchangedLines = 0;

    const diffParts: string[] = [];
    for (const change of changes) {
      if (change.added) {
        addedLines += change.count || 0;
        diffParts.push(`+ ${change.value.trim()}`);
      } else if (change.removed) {
        removedLines += change.count || 0;
        diffParts.push(`- ${change.value.trim()}`);
      } else {
        unchangedLines += change.count || 0;
      }
    }

    const totalLines = addedLines + removedLines + unchangedLines;
    const similarity =
      totalLines > 0 ? Math.round((unchangedLines / totalLines) * 100) : 100;

    const diffSummary =
      diffParts.length > 0
        ? diffParts.slice(0, 50).join('\n')
        : '两份文档内容完全相同';

    logger.info('FC工具 [compare_documents] 对比完成', {
      module: 'Tool:DocumentOps',
      documentId1: params.documentId1,
      documentId2: params.documentId2,
      similarity,
      addedLines,
      removedLines,
    });

    return {
      success: true,
      document1Title: doc1.title,
      document2Title: doc2.title,
      diff: diffSummary,
      similarity,
      message: `文档对比完成：相似度 ${similarity}%，新增 ${addedLines} 行，删除 ${removedLines} 行`,
    };
  } catch (error: any) {
    logger.error('FC工具 [compare_documents] 对比失败', {
      module: 'Tool:DocumentOps',
      error: error.message,
    });
    return {
      success: false,
      message: `文档对比失败: ${error.message}`,
    };
  }
}

// ==================== list_documents（AI 操作界面·文档管理域） ====================

export const listDocumentsParamsSchema = z.object({
  filter: z
    .enum(['all', 'untagged', 'keyword'])
    .optional()
    .describe(
      '筛选方式：all=全部文档（默认）；untagged=只看没有标签的文档；keyword=按标题关键词筛选',
    ),
  keyword: z
    .string()
    .optional()
    .describe('标题关键词（filter=keyword 时必填，大小写不敏感）'),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('最多返回条数（默认 50，最大 200）'),
});

export type ListDocumentsParams = z.infer<typeof listDocumentsParamsSchema>;

export const listDocumentsSchema = buildToolJsonSchema(
  'list_documents',
  '列出知识库文档清单（含ID/标题/标签/描述）。用户要整理文档、找无标签文档、按名字找文档ID时使用。查具体内容用 search_knowledge_base。',
  listDocumentsParamsSchema,
);

export interface DocumentListItem {
  documentId: number;
  title: string;
  tags: string[];
  description?: string;
  updatedAt?: string;
}

export interface ListDocumentsResult {
  success: boolean;
  total: number;
  returned: number;
  documents: DocumentListItem[];
  message: string;
}

export async function executeListDocuments(
  rawParams: unknown,
): Promise<ListDocumentsResult> {
  const parsed = safeParseToolParams(listDocumentsParamsSchema, rawParams);
  if (!parsed.success) {
    return {
      success: false,
      total: 0,
      returned: 0,
      documents: [],
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;
  const filter = params.filter ?? 'all';

  if (filter === 'keyword' && !params.keyword?.trim()) {
    return {
      success: false,
      total: 0,
      returned: 0,
      documents: [],
      message: 'filter=keyword 时必须提供 keyword 参数',
    };
  }

  if (!documentService) {
    return {
      success: false,
      total: 0,
      returned: 0,
      documents: [],
      message: '文档服务未初始化',
    };
  }

  try {
    const allDocs: any[] = await documentService.listDocuments();

    const kw = params.keyword?.trim().toLowerCase();
    const filtered = allDocs.filter((doc) => {
      if (filter === 'untagged') {
        // 标签列可能是 JSON 字符串或已解析数组，两种形态都兼容
        const tags = Array.isArray(doc.tags)
          ? doc.tags
          : (() => {
              try {
                const v =
                  typeof doc.tags === 'string' ? JSON.parse(doc.tags) : null;
                return Array.isArray(v) ? v : [];
              } catch {
                return [];
              }
            })();
        return tags.length === 0;
      }
      if (filter === 'keyword')
        return doc.title?.toLowerCase().includes(kw || '');
      return true;
    });

    const limit = params.limit ?? 50;
    const documents: DocumentListItem[] = filtered
      .slice(0, limit)
      .map((doc) => ({
        documentId: doc.id,
        title: doc.title,
        tags: Array.isArray(doc.tags)
          ? doc.tags
          : (() => {
              try {
                const v =
                  typeof doc.tags === 'string' ? JSON.parse(doc.tags) : null;
                return Array.isArray(v) ? v : [];
              } catch {
                return [];
              }
            })(),
        description: doc.description || undefined,
        updatedAt: doc.updatedAt
          ? new Date(doc.updatedAt).toISOString()
          : undefined,
      }));

    logger.info('FC工具 [list_documents] 查询完成', {
      module: 'Tool:DocumentOps',
      filter,
      total: filtered.length,
      returned: documents.length,
    });

    return {
      success: true,
      total: filtered.length,
      returned: documents.length,
      documents,
      message:
        filtered.length > limit
          ? `共 ${filtered.length} 篇符合条件，已返回前 ${limit} 篇（可用 limit 调大或加关键词缩小范围）`
          : `共 ${filtered.length} 篇符合条件`,
    };
  } catch (error: any) {
    logger.error('FC工具 [list_documents] 查询失败', {
      module: 'Tool:DocumentOps',
      error: error.message,
    });
    return {
      success: false,
      total: 0,
      returned: 0,
      documents: [],
      message: `查询文档清单失败: ${error.message}`,
    };
  }
}

// ==================== update_document_meta（仅改元信息，不产生新版本） ====================

export const updateDocumentMetaParamsSchema = z.object({
  documentId: z.number().int().positive().describe('要修改的文档ID'),
  title: z.string().min(1).optional().describe('新标题（可选）'),
  description: z.string().optional().describe('新描述（可选）'),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      '文档标签列表。传入时整体替换现有标签，空数组表示清空全部标签；不传则保持不变。只需调整标签/标题/描述时优先用本工具而非 update_document',
    ),
});

export type UpdateDocumentMetaParams = z.infer<
  typeof updateDocumentMetaParamsSchema
>;

export const updateDocumentMetaSchema = buildToolJsonSchema(
  'update_document_meta',
  '轻量修改文档元信息（标签/标题/描述），不改动正文、不产生新版本。给文档打标签、改标题时使用。',
  updateDocumentMetaParamsSchema,
);

export interface UpdateDocumentMetaResult {
  success: boolean;
  documentId: number;
  title?: string;
  tags?: string[];
  message: string;
}

export async function executeUpdateDocumentMeta(
  rawParams: unknown,
): Promise<UpdateDocumentMetaResult> {
  const parsed = safeParseToolParams(updateDocumentMetaParamsSchema, rawParams);
  if (!parsed.success) {
    return {
      success: false,
      documentId: (rawParams as { documentId?: number })?.documentId ?? 0,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  // 三个字段都未传 = 无事可做：直接拒绝，避免产生一次无意义的写库
  if (
    params.title === undefined &&
    params.description === undefined &&
    params.tags === undefined
  ) {
    return {
      success: false,
      documentId: params.documentId,
      message: 'title / description / tags 至少提供一个，否则无需调用本工具',
    };
  }

  if (!documentService) {
    return {
      success: false,
      documentId: params.documentId,
      message: '文档服务未初始化',
    };
  }

  try {
    // 仅透传用户显式提供的字段（undefined 字段在 updateDocument 中保持不变）
    const updated = await documentService.updateDocument(params.documentId, {
      title: params.title,
      description: params.description,
      tags: params.tags,
    });

    const changed: string[] = [];
    if (params.title !== undefined) changed.push('标题');
    if (params.description !== undefined) changed.push('描述');
    if (params.tags !== undefined)
      changed.push(`标签[${params.tags.join('、') || '（已清空）'}]`);

    logger.info('FC工具 [update_document_meta] 修改成功', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      changed: changed.join('，'),
    });

    return {
      success: true,
      documentId: updated.id,
      title: updated.title,
      tags: Array.isArray(updated.tags) ? updated.tags : undefined,
      message: `文档《${updated.title}》已更新：${changed.join('，')}`,
    };
  } catch (error: any) {
    logger.error('FC工具 [update_document_meta] 修改失败', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      error: error.message,
    });
    return {
      success: false,
      documentId: params.documentId,
      message: `修改文档元信息失败: ${error.message}`,
    };
  }
}

// ==================== delete_document（高危：需人工确认） ====================

export const deleteDocumentParamsSchema = z.object({
  documentId: z.number().int().positive().describe('要删除的文档ID'),
  title: z
    .string()
    .optional()
    .describe(
      '文档标题（建议填写，用于删除前核对目标：与实际标题不符将拒绝执行，防止误删）',
    ),
});

export type DeleteDocumentParams = z.infer<typeof deleteDocumentParamsSchema>;

export const deleteDocumentSchema = buildToolJsonSchema(
  'delete_document',
  '删除知识库中的文档（含全部版本与向量数据，不可恢复）。必须先用 list_documents 确认目标文档ID后再调用。',
  deleteDocumentParamsSchema,
);

export interface DeleteDocumentResult {
  success: boolean;
  documentId: number;
  title?: string;
  message: string;
}

export async function executeDeleteDocument(
  rawParams: unknown,
): Promise<DeleteDocumentResult> {
  const parsed = safeParseToolParams(deleteDocumentParamsSchema, rawParams);
  if (!parsed.success) {
    return {
      success: false,
      documentId: (rawParams as { documentId?: number })?.documentId ?? 0,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!documentService) {
    return {
      success: false,
      documentId: params.documentId,
      message: '文档服务未初始化',
    };
  }

  try {
    // 删除前核对标题：LLM 传参张冠李戴是误删的主要来源，标题不符直接拒绝
    const doc = await documentService.getDocument(params.documentId);
    if (
      params.title?.trim() &&
      doc.title?.trim() &&
      params.title.trim() !== doc.title.trim()
    ) {
      return {
        success: false,
        documentId: params.documentId,
        title: doc.title,
        message: `标题核对失败：文档ID ${params.documentId} 的实际标题是《${doc.title}》，与传入的《${params.title}》不符。请先用 list_documents 核实后再重试`,
      };
    }

    await documentService.deleteDocument(params.documentId, 'agent');

    logger.info('FC工具 [delete_document] 删除成功', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      title: doc.title,
    });

    return {
      success: true,
      documentId: params.documentId,
      title: doc.title,
      message: `文档《${doc.title}》已删除（含全部版本与向量数据）`,
    };
  } catch (error: any) {
    logger.error('FC工具 [delete_document] 删除失败', {
      module: 'Tool:DocumentOps',
      documentId: params.documentId,
      error: error.message,
    });
    return {
      success: false,
      documentId: params.documentId,
      message: `删除文档失败: ${error.message}`,
    };
  }
}

// ==================== list_document_versions（只读） ====================

export const listDocumentVersionsParamsSchema = z.object({
  documentId: z.number().int().positive().describe('文档ID'),
});

export type ListDocumentVersionsParams = z.infer<
  typeof listDocumentVersionsParamsSchema
>;

export const listDocumentVersionsSchema = buildToolJsonSchema(
  'list_document_versions',
  '列出文档的历史版本（版本号/状态/时间）。用户要查看文档版本历史或准备恢复版本时使用。',
  listDocumentVersionsParamsSchema,
);

export interface DocumentVersionListItem {
  versionId: number;
  versionNumber: number;
  status: string;
  parsingStatus: string;
  createdAt?: string;
}

export interface ListDocumentVersionsResult {
  success: boolean;
  documentId: number;
  documentTitle?: string;
  versions: DocumentVersionListItem[];
  message: string;
}

export async function executeListDocumentVersions(
  rawParams: unknown,
): Promise<ListDocumentVersionsResult> {
  const parsed = safeParseToolParams(
    listDocumentVersionsParamsSchema,
    rawParams,
  );
  if (!parsed.success) {
    return {
      success: false,
      documentId: (rawParams as { documentId?: number })?.documentId ?? 0,
      versions: [],
      message: `参数校验失败: ${parsed.error}`,
    };
  }

  if (!documentService) {
    return {
      success: false,
      documentId: parsed.data.documentId,
      versions: [],
      message: '文档服务未初始化',
    };
  }

  try {
    const doc = await documentService.getDocument(parsed.data.documentId);
    const versions: any[] = await documentService.listVersions(
      parsed.data.documentId,
    );

    return {
      success: true,
      documentId: parsed.data.documentId,
      documentTitle: doc.title,
      versions: versions.map((v) => ({
        versionId: v.id,
        versionNumber: v.versionNumber,
        status: String(v.status),
        parsingStatus: String(v.parsingStatus),
        createdAt: v.createdAt
          ? new Date(v.createdAt).toISOString()
          : undefined,
      })),
      message: `《${doc.title}》共 ${versions.length} 个版本（版本号越大越新）`,
    };
  } catch (error: any) {
    logger.error('FC工具 [list_document_versions] 查询失败', {
      module: 'Tool:DocumentOps',
      documentId: parsed.data.documentId,
      error: error.message,
    });
    return {
      success: false,
      documentId: parsed.data.documentId,
      versions: [],
      message: `查询版本列表失败: ${error.message}`,
    };
  }
}

// ==================== restore_document_version（高危：需人工确认） ====================

export const restoreDocumentVersionParamsSchema = z.object({
  versionId: z
    .number()
    .int()
    .positive()
    .describe('要恢复的版本ID（来自 list_document_versions 的 versionId）'),
  documentTitle: z
    .string()
    .optional()
    .describe(
      '文档标题（建议填写，用于恢复前核对目标：与实际标题不符将拒绝执行）',
    ),
});

export type RestoreDocumentVersionParams = z.infer<
  typeof restoreDocumentVersionParamsSchema
>;

export const restoreDocumentVersionSchema = buildToolJsonSchema(
  'restore_document_version',
  '把文档恢复到某个历史版本：以旧版本内容生成一个新版本（历史保留、可再回退）。需先用 list_document_versions 获取版本ID。',
  restoreDocumentVersionParamsSchema,
);

export interface RestoreDocumentVersionResult {
  success: boolean;
  documentId: number;
  restoredFromVersionNumber?: number;
  newVersionNumber?: number;
  message: string;
}

export async function executeRestoreDocumentVersion(
  rawParams: unknown,
): Promise<RestoreDocumentVersionResult> {
  const parsed = safeParseToolParams(
    restoreDocumentVersionParamsSchema,
    rawParams,
  );
  if (!parsed.success) {
    return {
      success: false,
      documentId: 0,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!documentService) {
    return { success: false, documentId: 0, message: '文档服务未初始化' };
  }

  try {
    // 恢复前核对：versionId 必须真实存在且属于调用方认定的文档（标题不符拒绝）
    const targetVersion = await documentService.getVersion(params.versionId);
    const doc = await documentService.getDocument(targetVersion.documentId);
    if (
      params.documentTitle?.trim() &&
      doc.title?.trim() &&
      params.documentTitle.trim() !== doc.title.trim()
    ) {
      return {
        success: false,
        documentId: doc.id,
        message: `标题核对失败：版本ID ${params.versionId} 属于文档《${doc.title}》，与传入的《${params.documentTitle}》不符。请先用 list_document_versions 核实后再重试`,
      };
    }

    const result = await documentService.restoreVersion(
      params.versionId,
      'agent',
    );

    logger.info('FC工具 [restore_document_version] 恢复成功', {
      module: 'Tool:DocumentOps',
      documentId: result.document.id,
      restoredFrom: params.versionId,
    });

    return {
      success: true,
      documentId: result.document.id,
      restoredFromVersionNumber: targetVersion.versionNumber,
      newVersionNumber: result.version.versionNumber,
      message: `《${doc.title}》已恢复到版本 ${targetVersion.versionNumber} 的内容，生成新版本 ${result.version.versionNumber}（历史版本保留）`,
    };
  } catch (error: any) {
    logger.error('FC工具 [restore_document_version] 恢复失败', {
      module: 'Tool:DocumentOps',
      versionId: params.versionId,
      error: error.message,
    });
    return {
      success: false,
      documentId: 0,
      message: `恢复版本失败: ${error.message}`,
    };
  }
}
