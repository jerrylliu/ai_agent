import { hybridSearchKnowledgeBase } from '../vector-store';
import { logger } from '../logger';

export const searchKnowledgeBaseSchema = {
  type: 'function' as const,
  function: {
    name: 'search_knowledge_base',
    description: '搜索知识库中与查询相关的文档内容。当用户的问题可能涉及已上传的文档、知识库中的信息时，使用此工具进行精确搜索。不要对与知识库无关的通用问题使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询语句，应该是一个精确的、能匹配知识库内容的问题或关键词',
        },
        top_k: {
          type: 'number',
          description: '返回的最相关文档数量，默认3',
          default: 3,
        },
        document_id: {
          type: 'number',
          description: '限定搜索的文档ID，不传则搜索所有文档',
        },
      },
      required: ['query'],
    },
  },
};

export interface SearchKnowledgeBaseParams {
  query: string;
  top_k?: number;
  document_id?: number;
}

export interface SearchKnowledgeBaseResult {
  results: Array<{
    content: string;
    source: string;
    score: number;
    documentId: string;
    versionId: string;
  }>;
  total: number;
  query: string;
}

export async function executeSearchKnowledgeBase(
  params: SearchKnowledgeBaseParams,
): Promise<SearchKnowledgeBaseResult> {
  const startTime = Date.now();

  logger.info('FC工具 [search_knowledge_base] 开始执行', {
    module: 'Tool:SearchKnowledgeBase',
    rawParams: JSON.stringify(params),
    query: params.query,
    top_k: params.top_k,
    document_id: params.document_id,
  });

  if (!params.query || !params.query.trim()) {
    logger.warn('FC工具 [search_knowledge_base] 参数校验失败：query 为空', {
      module: 'Tool:SearchKnowledgeBase',
      params: JSON.stringify(params),
    });
    return {
      results: [],
      total: 0,
      query: params.query || '',
    };
  }

  const topK = params.top_k || 3;
  const filter: Record<string, string> = { versionStatus: 'active' };

  if (params.document_id) {
    filter.documentId = String(params.document_id);
  }

  logger.info('FC工具 [search_knowledge_base] 调用 hybridSearchKnowledgeBase', {
    module: 'Tool:SearchKnowledgeBase',
    query: params.query,
    topK,
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    filter: JSON.stringify(filter),
  });

  let results: Array<{ content: string; metadata: any; score: number; vectorScore: number; sources: string[] }>;
  try {
    results = await hybridSearchKnowledgeBase(
      params.query,
      topK,
      0.7,
      0.3,
      Object.keys(filter).length > 0 ? filter : undefined,
    );
  } catch (searchError: any) {
    const duration = Date.now() - startTime;
    logger.error('FC工具 [search_knowledge_base] hybridSearchKnowledgeBase 调用失败', {
      module: 'Tool:SearchKnowledgeBase',
      query: params.query,
      duration,
      error: searchError.message,
      errorStack: searchError.stack?.substring(0, 500),
    });
    throw searchError;
  }

  const duration = Date.now() - startTime;

  logger.info('FC工具 [search_knowledge_base] hybridSearchKnowledgeBase 返回结果', {
    module: 'Tool:SearchKnowledgeBase',
    query: params.query,
    resultCount: results.length,
    duration,
  });

  const mappedResults = results.map((r, idx) => {
    const contentPreview = r.content.length > 100 ? r.content.substring(0, 100) + '...' : r.content;
    logger.debug(`FC工具 [search_knowledge_base] 结果 #${idx + 1}`, {
      module: 'Tool:SearchKnowledgeBase',
      index: idx + 1,
      score: r.score,
      vectorScore: r.vectorScore,
      source: r.metadata?.source || '未知来源',
      documentId: r.metadata?.documentId || '',
      versionId: r.metadata?.versionId || '',
      contentPreview,
      contentLength: r.content.length,
    });

    return {
      content: r.content,
      source: r.metadata?.source || '未知来源',
      score: r.score,
      documentId: r.metadata?.documentId || '',
      versionId: r.metadata?.versionId || '',
    };
  });

  const finalResult: SearchKnowledgeBaseResult = {
    results: mappedResults,
    total: mappedResults.length,
    query: params.query,
  };

  logger.info('FC工具 [search_knowledge_base] 执行完成，返回结果摘要', {
    module: 'Tool:SearchKnowledgeBase',
    query: params.query,
    totalResults: finalResult.total,
    duration,
    resultScores: mappedResults.map(r => r.score),
    resultSources: mappedResults.map(r => r.source),
  });

  return finalResult;
}
