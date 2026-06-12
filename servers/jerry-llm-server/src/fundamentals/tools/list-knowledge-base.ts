/**
 * 知识库概览工具
 *
 * 解决"知识库含有什么内容"类元查询问题。
 * 语义搜索不适合列举所有文档，本工具直接从向量库元数据聚合文档列表，
 * 让 LLM 能准确回答知识库内容概览类问题。
 */

import { logger } from '../logger';
import { getAllDocuments } from '../vector-store/index.js';

export const listKnowledgeBaseSchema = {
  type: 'function' as const,
  function: {
    name: 'list_knowledge_base',
    description: '列出知识库中的所有文档概览。当用户询问知识库有什么内容、包含哪些文档、有哪些资料时使用此工具，而不是用搜索工具。搜索工具用于查找具体内容，本工具用于列出文档清单。',
    parameters: {
      type: 'object',
      properties: {
        detail_level: {
          type: 'string',
          enum: ['brief', 'detailed'],
          description: '概览详细程度：brief=仅文档名和类型，detailed=包含内容摘要',
        },
      },
      required: [],
    },
  },
};

export interface ListKnowledgeBaseParams {
  detail_level?: 'brief' | 'detailed';
}

export interface ListKnowledgeBaseResult {
  documents: Array<{
    source: string;
    docType: string;
    chunkCount: number;
    /** detailed 模式下包含内容摘要 */
    contentPreview?: string;
  }>;
  totalDocuments: number;
  totalChunks: number;
}

/**
 * 执行知识库概览查询
 *
 * 从 ChromaDB 元数据聚合文档列表，不走语义搜索。
 * 按 source 字段分组，统计每个文档的块数。
 */
export async function executeListKnowledgeBase(
  params: ListKnowledgeBaseParams,
): Promise<ListKnowledgeBaseResult> {
  const detailLevel = params.detail_level ?? 'brief';

  logger.info('FC工具 [list_knowledge_base] 开始执行', {
    module: 'Tool:ListKnowledgeBase',
    detailLevel,
  });

  try {
    const allDocs = await getAllDocuments();

    // 按 source 分组聚合
    const sourceMap = new Map<string, { docType: string; chunkCount: number; preview?: string }>();

    for (const doc of allDocs) {
      const source = doc.metadata?.source || 'unknown';
      const docType = doc.metadata?.doc_type || doc.metadata?.docType || 'unknown';
      const existing = sourceMap.get(source);

      if (existing) {
        existing.chunkCount++;
      } else {
        sourceMap.set(source, {
          docType,
          chunkCount: 1,
          preview: detailLevel === 'detailed' ? doc.content.substring(0, 200) : undefined,
        });
      }
    }

    const documents: ListKnowledgeBaseResult['documents'] = [];
    for (const [source, info] of sourceMap) {
      const entry: ListKnowledgeBaseResult['documents'][number] = {
        source,
        docType: info.docType,
        chunkCount: info.chunkCount,
      };
      if (detailLevel === 'detailed' && info.preview) {
        entry.contentPreview = info.preview + '...';
      }
      documents.push(entry);
    }

    const result: ListKnowledgeBaseResult = {
      documents,
      totalDocuments: documents.length,
      totalChunks: allDocs.length,
    };

    logger.info('FC工具 [list_knowledge_base] 执行完成', {
      module: 'Tool:ListKnowledgeBase',
      documentCount: documents.length,
      totalChunks: allDocs.length,
    });

    return result;
  } catch (error: any) {
    logger.error('FC工具 [list_knowledge_base] 执行失败', {
      module: 'Tool:ListKnowledgeBase',
      error: error.message,
    });

    return {
      documents: [],
      totalDocuments: 0,
      totalChunks: 0,
    };
  }
}
