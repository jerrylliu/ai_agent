/**
 * 向量存储 — 版本管理与维护
 *
 * 提供文档版本化的向量管理操作：
 * - removeDocumentVersion：按版本 ID 删除向量 + BM25 数据
 * - updateVersionVectorStatus：更新版本状态（回滚时用）
 * - reindexVersion：重新向量化版本（幂等）
 *
 * 以及维护和调试工具：
 * - getDocumentTypes / getAllDocuments / getKnowledgeBaseStats
 * - clearKnowledgeBase
 * - previewChunking / previewEmbedding / debugSearch
 * - cleanOrphanVectors / fixDraftVectors
 */

import { ChromaClient } from 'chromadb';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { eventBus } from '../event-bus.js';
import {
  COLLECTION_NAME,
  embeddings,
  initializeVectorStore,
  resetVectorStore,
  getBM25Index,
  getBM25DocumentStore,
} from './store-state.js';
import {
  initializeBM25Index,
  addToBM25Index,
  saveBM25Index,
  clearBM25Index,
} from './bm25-index.js';
import {
  addDocuments,
  getAllDocuments,
} from './vector-crud.js';
import {
  searchKnowledgeBase,
} from './vector-search.js';
import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './text-splitter.js';

// ==================== 统计与查询 ====================

/**
 * 获取知识库中所有文档类型
 */
export async function getDocumentTypes(): Promise<string[]> {
  try {
    const docs = await getAllDocuments();
    const types = new Set<string>();
    docs.forEach(doc => {
      if (doc.metadata?.doc_type) {
        types.add(doc.metadata.doc_type);
      }
    });
    return Array.from(types);
  } catch (error) {
    logger.error('获取文档类型失败', { module: 'VectorStore', error: String(error) });
    return [];
  }
}

/**
 * 获取知识库统计信息
 */
export async function getKnowledgeBaseStats(): Promise<{
  documentCount: number;
  collectionName: string;
}> {
  try {
    const client = new ChromaClient({ host: config.chromaHost, port: config.chromaPort });
    const collection = await client.getCollection({ name: COLLECTION_NAME });
    const results = await collection.get();
    const documentCount = results.documents?.length || 0;

    return {
      documentCount,
      collectionName: COLLECTION_NAME,
    };
  } catch (error) {
    return {
      documentCount: 0,
      collectionName: COLLECTION_NAME,
    };
  }
}

/**
 * 清空知识库（谨慎使用）
 *
 * 处理流程：
 * 1. 删除 ChromaDB 集合
 * 2. 重新创建空集合（指定 cosine 距离）
 * 3. 清空 BM25 索引
 */
export async function clearKnowledgeBase(): Promise<void> {
  logger.warn('即将清空整个知识库', { module: 'VectorStore' });

  try {
    const client = new ChromaClient({ host: config.chromaHost, port: config.chromaPort });

    // 检查集合是否存在并删除
    try {
      await client.deleteCollection({ name: COLLECTION_NAME });
      logger.info('知识库集合已删除', { module: 'VectorStore' });
    } catch (error: any) {
      if (error.message && error.message.includes('not found')) {
        logger.info('知识库集合不存在，无需删除', { module: 'VectorStore' });
      } else {
        throw error;
      }
    }

    // 重新创建空集合（指定嵌入函数）
    await client.createCollection({
      name: COLLECTION_NAME,
      metadata: { "hnsw:space": "cosine" },
      embeddingFunction: embeddings as any,
    });
    logger.info('已创建新的空知识库集合', { module: 'VectorStore' });

    // 清空 BM25 索引
    await clearBM25Index();
    logger.info('BM25 索引已清空', { module: 'VectorStore' });

    // 重置内存中的向量存储实例，下次操作时会重新加载新集合
    resetVectorStore();
    logger.info('向量存储实例已重置', { module: 'VectorStore' });

    // 通知缓存：知识库已清空
    eventBus.emit('knowledge-base-updated', '知识库清空');
  } catch (error) {
    logger.error('清空知识库失败', { module: 'VectorStore', error: String(error) });
  }
}

// ==================== 预览与调试 ====================

/**
 * 预览文本切片效果（不实际存储）
 * @param text 要切分的文本
 * @returns 切分后的块列表
 */
export async function previewChunking(text: string): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  });
  return splitter.splitText(text);
}

/**
 * 预览 Embedding 向量（不实际存储）
 * @param text 要生成嵌入的文本
 * @returns 嵌入向量的前 10 维（完整向量太长）
 */
export async function previewEmbedding(text: string): Promise<{
  text: string;
  dimensions: number;
  sample: number[];
  fullLength: number;
}> {
  const fullEmbedding = await embeddings.embedQuery(text);
  return {
    text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
    dimensions: fullEmbedding.length,
    sample: fullEmbedding.slice(0, 10),
    fullLength: fullEmbedding.length,
  };
}

/**
 * 调试搜索（详细显示每一步）
 * @param query 查询文本
 * @param topK 返回数量
 */
export async function debugSearch(
  query: string,
  topK: number = 3,
  // 与 searchKnowledgeBase / hybridSearchKnowledgeBase 保持一致
  minSimilarity: number = 0.55
): Promise<{
  originalQuery: string;
  rawResults: Array<{
    content: string;
    score: number;
    metadata: any;
  }>;
  filteredResults: Array<{
    content: string;
    score: number;
    metadata: any;
  }>;
}> {
  const store = await initializeVectorStore();

  logger.debug('调试搜索流程', { module: 'VectorStore' });
  logger.debug('原始查询', { module: 'VectorStore', query });

  const results = await store.similaritySearchWithScore(query, topK * 3);

  logger.debug('原始搜索结果', { module: 'VectorStore', resultCount: results.length });
  results.forEach(([doc, score], i) => {
    logger.debug('调试搜索结果', { module: 'VectorStore', index: i + 1, score: score.toFixed(4), content: doc.pageContent.substring(0, 100), metadata: doc.metadata });
  });
  const filtered = results
    .filter(([_, score]) => score <= minSimilarity)
    .slice(0, topK);

  logger.debug('过滤后搜索结果', { module: 'VectorStore', minSimilarity, filteredCount: filtered.length });

  const rawResults = results.map(([doc, score]) => ({
    content: doc.pageContent,
    score,
    metadata: doc.metadata,
  }));

  const filteredResults = filtered.map(([doc, score]) => ({
    content: doc.pageContent,
    score,
    metadata: doc.metadata,
  }));

  return {
    originalQuery: query,
    rawResults,
    filteredResults,
  };
}

/**
 * 获取知识库中存储的所有文档（带分数调试信息）
 */
export async function getAllDocumentsWithDebug(): Promise<{
  totalCount: number;
  documents: Array<{
    content: string;
    metadata: any;
    contentPreview: string;
    contentLength: number;
  }>;
}> {
  const documents = await getAllDocuments();
  return {
    totalCount: documents.length,
    documents: documents.map(d => ({
      content: d.content,
      metadata: d.metadata,
      contentPreview: d.content.substring(0, 100) + (d.content.length > 100 ? '...' : ''),
      contentLength: d.content.length,
    })),
  };
}

// ==================== 版本化向量管理 ====================

/**
 * 按 versionId 从 ChromaDB + BM25 索引中批量删除
 */
export async function removeDocumentVersion(versionId: number): Promise<void> {
  logger.info('开始删除版本向量数据', { module: 'VectorStore', versionId });

  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    throw new Error('向量存储集合未初始化');
  }

  try {
    const versionFilter = { versionId: String(versionId) };

    let existing: { ids: string[] };
    try {
      existing = await collection.get({ where: versionFilter });
    } catch (getError: any) {
      if (getError.name === 'ChromaNotFoundError' || getError.message?.includes('could not be found')) {
        logger.info('ChromaDB 集合或资源不存在，视为已清理', { module: 'VectorStore', versionId });
        existing = { ids: [] };
      } else {
        throw getError;
      }
    }

    logger.info('查询到版本向量数据', { module: 'VectorStore', versionId, vectorCount: existing.ids.length });

    if (existing.ids.length > 0) {
      try {
        await collection.delete({ where: versionFilter });
        logger.info('已从 ChromaDB 删除版本向量', { module: 'VectorStore', versionId, vectorCount: existing.ids.length });
      } catch (delError: any) {
        if (delError.name === 'ChromaNotFoundError' || delError.message?.includes('could not be found')) {
          logger.info('ChromaDB 删除时资源不存在，视为已清理', { module: 'VectorStore', versionId });
        } else {
          throw delError;
        }
      }
    } else {
      logger.info('ChromaDB 中无该版本向量数据', { module: 'VectorStore', versionId });
    }

    // 同步清理 BM25 索引中该版本的数据
    await initializeBM25Index();
    const bm25Index = getBM25Index();
    const bm25DocumentStore = getBM25DocumentStore();

    if (bm25Index) {
      const idsToRemove: string[] = [];
      for (const [id, doc] of bm25DocumentStore.entries()) {
        if (doc.metadata?.versionId === String(versionId)) {
          idsToRemove.push(id);
        }
      }
      logger.info('BM25 索引中该版本文档数量', { module: 'VectorStore', versionId, docCount: idsToRemove.length });

      if (idsToRemove.length > 0) {
        for (const id of idsToRemove) {
          try {
            bm25Index.remove(id);
          } catch {
            logger.warn('BM25 删除文档失败（可能已不存在）', { module: 'VectorStore', id });
          }
          bm25DocumentStore.delete(id);
        }
        saveBM25Index().catch(err => logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(err) }));
        logger.info('已从 BM25 索引删除版本文档', { module: 'VectorStore', versionId, docCount: idsToRemove.length });
      }
    } else {
      logger.info('BM25 索引未初始化，跳过', { module: 'VectorStore', versionId });
    }

    logger.info('版本向量数据删除完成', { module: 'VectorStore', versionId });

    // 通知缓存：知识库已更新
    eventBus.emit('knowledge-base-updated', '版本删除');
  } catch (error: any) {
    logger.error('删除版本向量数据失败', { module: 'VectorStore', versionId, error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * 按 versionId 批量更新向量的 versionStatus（回滚时用，不删除向量）
 */
export async function updateVersionVectorStatus(versionId: number, newStatus: string): Promise<void> {
  logger.info('开始更新版本向量状态', { module: 'VectorStore', versionId, newStatus });

  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    throw new Error('向量存储集合未初始化');
  }

  try {
    const versionFilter = { versionId: String(versionId) };

    let existing: { ids: string[]; metadatas: any[] };
    try {
      existing = await collection.get({ where: versionFilter });
    } catch (getError: any) {
      if (getError.name === 'ChromaNotFoundError' || getError.message?.includes('could not be found')) {
        logger.info('ChromaDB 集合或资源不存在，无需更新状态', { module: 'VectorStore', versionId });
        existing = { ids: [], metadatas: [] };
      } else {
        throw getError;
      }
    }

    logger.info('查询到版本向量数据', { module: 'VectorStore', versionId, vectorCount: existing.ids.length });

    if (existing.ids.length > 0) {
      const updatedMetadata = existing.metadatas.map((meta: any) => ({
        ...meta,
        versionStatus: newStatus,
      }));

      await collection.update({
        ids: existing.ids,
        metadatas: updatedMetadata,
      });

      logger.info('已更新 ChromaDB 版本向量状态', { module: 'VectorStore', versionId, newStatus, vectorCount: existing.ids.length });
    } else {
      logger.info('ChromaDB 中无该版本向量数据，跳过状态更新', { module: 'VectorStore', versionId });
    }

    // 同步更新 BM25 索引
    await initializeBM25Index();
    const bm25Index = getBM25Index();
    const bm25DocumentStore = getBM25DocumentStore();

    if (bm25Index) {
      let updatedCount = 0;
      for (const [id, doc] of bm25DocumentStore.entries()) {
        if (doc.metadata?.versionId === String(versionId)) {
          doc.metadata.versionStatus = newStatus;
          updatedCount++;
        }
      }
      if (updatedCount > 0) {
        logger.info('已更新 BM25 索引中版本文档状态', { module: 'VectorStore', versionId, newStatus, updatedCount });
        saveBM25Index().catch(err => logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(err) }));
      }
    }

    logger.info('版本向量状态更新完成', { module: 'VectorStore', versionId, newStatus });

    // 通知缓存：知识库已更新（版本状态变更影响检索结果的 versionStatus 过滤）
    eventBus.emit('knowledge-base-updated', '版本状态变更');
  } catch (error: any) {
    logger.error('更新版本向量状态失败', { module: 'VectorStore', versionId, newStatus, error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * 重新向量化版本（先清理旧向量，再重新入库，保证幂等）
 */
export async function reindexVersion(
  versionId: number,
  documentId: number,
  textContent: string,
  versionStatus: string,
  fileInfo: { source: string; fileType: string; mimeType?: string },
): Promise<number> {
  logger.info('开始重新向量化版本', { module: 'VectorStore', versionId, documentId, versionStatus, textLength: textContent.length });

  // 1. 先清理旧向量
  await removeDocumentVersion(versionId);

  // 2. 重新向量化入库
  const metadata = {
    documentId: String(documentId),
    versionId: String(versionId),
    versionStatus,
    source: fileInfo.source,
    fileType: fileInfo.fileType,
    // 传给自适应 Chunking，避免扩展名格式不一致时降级为 default
    mimeType: fileInfo.mimeType || '',
  };

  logger.info('开始重新添加向量', { module: 'VectorStore', versionId, documentId });
  const chunkCount = await addDocuments([textContent], [metadata], {
    chunkingStrategy: 'parent-child',
  });
  logger.info('版本重新向量化完成', { module: 'VectorStore', versionId, documentId, chunkCount });
  return chunkCount;
}

/**
 * 清理孤岛向量（ChromaDB 中存在但数据库无对应记录的向量）
 * @param validVersionIds 数据库中存在的 versionId 列表
 * @returns 清理的向量数量
 */
export async function cleanOrphanVectors(validVersionIds: string[]): Promise<number> {
  logger.info('开始清理孤岛向量', { module: 'VectorStore', validVersionCount: validVersionIds.length });

  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    throw new Error('向量存储集合未初始化');
  }

  try {
    const allDocs = await collection.get();
    const validSet = new Set(validVersionIds);
    const orphanIds: string[] = [];
    const orphanVersionIds = new Set<string>();

    logger.info('ChromaDB 中总向量数', { module: 'VectorStore', totalVectors: allDocs.ids.length });

    for (let i = 0; i < allDocs.ids.length; i++) {
      const meta = allDocs.metadatas[i] as any;
      const versionId = meta?.versionId;
      // 如果有 versionId 但不在有效列表中，则为孤岛向量
      if (versionId && !validSet.has(versionId)) {
        orphanIds.push(allDocs.ids[i]);
        orphanVersionIds.add(versionId);
      }
    }

    if (orphanIds.length > 0) {
      logger.info('发现孤岛向量', { module: 'VectorStore', orphanCount: orphanIds.length, orphanVersionIds: [...orphanVersionIds] });
      await collection.delete({ ids: orphanIds });
      logger.info('已清理孤岛向量', { module: 'VectorStore', count: orphanIds.length });

      // 同步清理 BM25 索引中对应的孤岛数据
      await initializeBM25Index();
      const bm25Index = getBM25Index();
      const bm25DocumentStore = getBM25DocumentStore();

      if (bm25Index) {
        let bm25CleanedCount = 0;
        for (const [id, doc] of bm25DocumentStore.entries()) {
          const docVersionId = doc.metadata?.versionId;
          if (docVersionId && orphanVersionIds.has(docVersionId)) {
            try {
              bm25Index.remove(id);
              bm25DocumentStore.delete(id);
              bm25CleanedCount++;
            } catch {
              // 忽略删除失败
            }
          }
        }
        if (bm25CleanedCount > 0) {
          await saveBM25Index();
          logger.info('已从 BM25 索引清理孤岛数据', { module: 'VectorStore', count: bm25CleanedCount });
        }
      }
    } else {
      logger.info('未发现孤岛向量', { module: 'VectorStore' });
    }

    return orphanIds.length;
  } catch (error: any) {
    logger.error('清理孤岛向量失败', { module: 'VectorStore', error: error.message });
    throw error;
  }
}

/**
 * 修复 draft 状态的向量
 * 将所有 draft 状态的向量更新为 active（用于修复历史数据问题）
 * @returns 修复的 ChromaDB 和 BM25 向量数量
 */
export async function fixDraftVectors(): Promise<{ fixedChromaCount: number; fixedBM25Count: number }> {
  logger.info('开始修复 draft 状态向量', { module: 'VectorStore' });

  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    throw new Error('向量存储集合未初始化');
  }

  try {
    const allDocs = await collection.get();
    const draftIds: string[] = [];
    const draftMetadatas: any[] = [];

    for (let i = 0; i < allDocs.ids.length; i++) {
      const meta = allDocs.metadatas[i] as any;
      if (meta?.versionStatus === 'draft') {
        draftIds.push(allDocs.ids[i]);
        draftMetadatas.push({
          ...meta,
          versionStatus: 'active',
        });
      }
    }

    let bm25FixedCount = 0;

    if (draftIds.length > 0) {
      await collection.update({
        ids: draftIds,
        metadatas: draftMetadatas,
      });
      logger.info('已修复 draft 状态向量', { module: 'VectorStore', count: draftIds.length });

      // 同步更新 BM25 索引
      await initializeBM25Index();
      const bm25DocumentStore = getBM25DocumentStore();

      for (const [id, doc] of bm25DocumentStore.entries()) {
        if (doc.metadata?.versionStatus === 'draft') {
          doc.metadata.versionStatus = 'active';
          bm25FixedCount++;
        }
      }
      if (bm25FixedCount > 0) {
        await saveBM25Index();
        logger.info('已修复 BM25 索引中 draft 状态', { module: 'VectorStore', count: bm25FixedCount });
      }
    } else {
      logger.info('未发现 draft 状态向量', { module: 'VectorStore' });
    }

    return { fixedChromaCount: draftIds.length, fixedBM25Count: bm25FixedCount };
  } catch (error: any) {
    logger.error('修复 draft 状态向量失败', { module: 'VectorStore', error: error.message });
    throw error;
  }
}
