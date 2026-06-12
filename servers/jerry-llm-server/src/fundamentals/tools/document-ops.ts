/**
 * 文档操作工具
 *
 * 让 Agent 可以主动操作知识库文档：
 * - create_document: 创建新文档
 * - update_document: 更新文档内容
 * - summarize_document: 对指定文档生成摘要
 * - compare_documents: 对比两个文档差异
 */

import { logger } from '../logger';
import { createLLM, buildModelConfig } from '../model-provider';
import { HumanMessage } from '@langchain/core/messages';
import * as Diff from 'diff';

// ==================== DocumentService 注入 ====================

let documentService: any = null;

/**
 * 注入 DocumentService 实例
 * 在 AppModule 初始化时调用
 */
export function initDocumentTools(service: any): void {
  documentService = service;
  logger.info('文档操作工具：DocumentService 已注入', { module: 'Tool:DocumentOps' });
}

// ==================== create_document ====================

export const createDocumentSchema = {
  type: 'function' as const,
  function: {
    name: 'create_document',
    description: '在知识库中创建新文档。当用户需要新建文档、记录笔记、保存信息时使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '文档标题',
        },
        content: {
          type: 'string',
          description: '文档内容（纯文本或 Markdown 格式）',
        },
        description: {
          type: 'string',
          description: '文档描述（可选）',
        },
        tags: {
          type: 'array',
          description: '文档标签列表（可选）',
          items: { type: 'string' },
        },
      },
      required: ['title', 'content'],
    },
  },
};

export interface CreateDocumentParams {
  title: string;
  content: string;
  description?: string;
  tags?: string[];
}

export interface CreateDocumentResult {
  success: boolean;
  documentId?: number;
  title: string;
  message: string;
}

export async function executeCreateDocument(
  params: CreateDocumentParams,
): Promise<CreateDocumentResult> {
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

export const updateDocumentSchema = {
  type: 'function' as const,
  function: {
    name: 'update_document',
    description: '更新知识库中已有文档的内容。通过上传新版本更新文档，保留历史版本。',
    parameters: {
      type: 'object',
      properties: {
        documentId: {
          type: 'number',
          description: '要更新的文档ID',
        },
        content: {
          type: 'string',
          description: '新的文档内容（纯文本或 Markdown 格式）',
        },
        title: {
          type: 'string',
          description: '新标题（可选，不传则保持原标题）',
        },
      },
      required: ['documentId', 'content'],
    },
  },
};

export interface UpdateDocumentParams {
  documentId: number;
  content: string;
  title?: string;
}

export interface UpdateDocumentResult {
  success: boolean;
  documentId: number;
  versionNumber?: number;
  message: string;
}

export async function executeUpdateDocument(
  params: UpdateDocumentParams,
): Promise<UpdateDocumentResult> {
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

    // 如果提供了新标题，额外更新文档元信息
    if (params.title) {
      await documentService.updateDocument(params.documentId, { title: params.title });
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

export const summarizeDocumentSchema = {
  type: 'function' as const,
  function: {
    name: 'summarize_document',
    description: '对指定文档生成摘要。当用户需要快速了解文档核心内容时使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        documentId: {
          type: 'number',
          description: '要生成摘要的文档ID',
        },
        maxLength: {
          type: 'number',
          description: '摘要最大长度（字数），默认200',
          default: 200,
        },
      },
      required: ['documentId'],
    },
  },
};

export interface SummarizeDocumentParams {
  documentId: number;
  maxLength?: number;
}

export interface SummarizeDocumentResult {
  success: boolean;
  documentId: number;
  title?: string;
  summary?: string;
  message: string;
}

export async function executeSummarizeDocument(
  params: SummarizeDocumentParams,
): Promise<SummarizeDocumentResult> {
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
    const maxLen = params.maxLength || 200;

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
    const summary = typeof result.content === 'string' ? result.content.trim() : '';

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

export const compareDocumentsSchema = {
  type: 'function' as const,
  function: {
    name: 'compare_documents',
    description: '对比两个文档的差异。当用户需要比较两份文档的不同之处时使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        documentId1: {
          type: 'number',
          description: '第一个文档的ID',
        },
        documentId2: {
          type: 'number',
          description: '第二个文档的ID',
        },
      },
      required: ['documentId1', 'documentId2'],
    },
  },
};

export interface CompareDocumentsParams {
  documentId1: number;
  documentId2: number;
}

export interface CompareDocumentsResult {
  success: boolean;
  document1Title?: string;
  document2Title?: string;
  diff?: string;
  similarity?: number;
  message: string;
}

export async function executeCompareDocuments(
  params: CompareDocumentsParams,
): Promise<CompareDocumentsResult> {
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
    const similarity = totalLines > 0
      ? Math.round((unchangedLines / totalLines) * 100)
      : 100;

    const diffSummary = diffParts.length > 0
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
