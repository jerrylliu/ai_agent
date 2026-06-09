/**
 * 向量存储 — 文档 CRUD 操作
 *
 * 提供向量存储的核心写操作：
 * - addDocuments：将文档切分后批量写入 ChromaDB + BM25 索引
 * - deleteDocuments：按元数据过滤条件删除文档
 *
 * 读取/检索操作在 vector-search.ts 中定义。
 */

import { Document } from '@langchain/core/documents';
import { ChromaClient } from 'chromadb';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  BATCH_SIZE,
  COLLECTION_NAME,
  embeddings,
  initializeVectorStore,
  getBM25Index,
  getBM25DocumentStore,
} from './store-state.js';
import {
  initializeBM25Index,
  addToBM25Index,
  saveBM25Index,
  rebuildBM25Index,
} from './bm25-index.js';
import {
  getSplitterByFileType,
  isMarkdownContent,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
} from './text-splitter.js';

// ==================== 文档添加 ====================

/**
 * 添加文档到知识库
 *
 * 处理流程：
 * 1. 根据文件类型选择切分器，将文档切分为文本块
 * 2. 批量写入 ChromaDB（向量存储）
 * 3. 同步写入 BM25 索引（关键词检索）
 *
 * @param texts 文档文本内容数组
 * @param metadata 每个文档对应的元数据数组
 * @returns 成功添加的文本块数量
 */
export async function addDocuments(
  texts: string[],
  metadata: Record<string, any>[],
): Promise<number> {
  const store = await initializeVectorStore();

  // 1. 切分文档
  const allChunks: Array<{
    text: string;
    metaIndex: number;
    chunkIndexInDoc: number;
  }> = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const meta = metadata[i] || {};

    // 根据文件类型选择切分器
    const fileType = meta.fileType || '';
    const isMD = isMarkdownContent(text);
    const splitter = getSplitterByFileType(fileType, isMD);

    const chunks = await splitter.splitText(text);

    for (let j = 0; j < chunks.length; j++) {
      allChunks.push({
        text: chunks[j],
        metaIndex: i,
        chunkIndexInDoc: j,
      });
    }
  }

  logger.info('文档切分完成', { module: 'VectorStore', totalChunks: allChunks.length });

  // 2. 批量写入 ChromaDB
  let addedCount = 0;

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE).map((chunk) => {
      return new Document({
        pageContent: chunk.text,
        metadata: {
          ...metadata[chunk.metaIndex],
          // chunk_index 使用文档内序号，与 ChromaDB 中的 chunk_index 保持一致
          chunk_index: chunk.chunkIndexInDoc,
          source: metadata[chunk.metaIndex]?.source || 'unknown',
          doc_type: metadata[chunk.metaIndex]?.docType || 'general',
        },
      });
    });

    try {
      await store.addDocuments(batch);
      addedCount += batch.length;
    } catch (error: any) {
      logger.error('批量添加文档失败，尝试逐条添加', { module: 'VectorStore', error: error.message });

      // 降级为逐条添加
      for (let j = 0; j < batch.length; j++) {
        try {
          await store.addDocuments([batch[j]]);
          addedCount++;
        } catch (singleError: any) {
          logger.error('文档添加失败', { module: 'VectorStore', index: i + j + 1, error: singleError.message });
        }
      }
    }
  }

  logger.info('成功添加文本块到知识库', { module: 'VectorStore', addedCount });

  if (addedCount === 0) {
    throw new Error('所有文本块添加失败，ChromaDB 可能未启动或不可用');
  }

  // 3. 同步写入 BM25 索引（失败不影响主流程）
  try {
    await initializeBM25Index();
    let bm25AddedCount = 0;
    let bm25DedupedCount = 0;

    for (const [i, chunk] of allChunks.entries()) {
      const id = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${i}`;
      const chunkMetadata = {
        ...metadata[chunk.metaIndex],
        chunk_index: chunk.chunkIndexInDoc,
        source: metadata[chunk.metaIndex]?.source || 'unknown',
        doc_type: metadata[chunk.metaIndex]?.docType || 'general',
      };

      // 去重：删除 BM25 中同 source + chunk_index 的旧条目，避免重复入库导致索引膨胀
      // 场景：reindex 或知识源增量更新时，同一文档可能被多次入库
      const bm25Index = getBM25Index();
      const bm25DocumentStore = getBM25DocumentStore();
      const sourceValue = chunkMetadata.source;
      const chunkIndexValue = chunkMetadata.chunk_index;
      if (sourceValue !== undefined && chunkIndexValue !== undefined && bm25Index) {
        const idsToRemove: string[] = [];
        for (const [existingId, existingDoc] of bm25DocumentStore.entries()) {
          if (existingDoc.metadata?.source === sourceValue &&
              existingDoc.metadata?.chunk_index === chunkIndexValue) {
            idsToRemove.push(existingId);
          }
        }
        for (const removeId of idsToRemove) {
          try {
            bm25Index.remove(removeId);
            bm25DocumentStore.delete(removeId);
            bm25DedupedCount++;
          } catch {
            // 旧条目可能已不存在，忽略
          }
        }
      }

      await addToBM25Index(id, chunk.text, chunkMetadata, true); // 批量操作，跳过单次保存
      bm25AddedCount++;
    }
    await saveBM25Index(); // 批量操作完成后统一保存

    if (bm25DedupedCount > 0) {
      logger.info('BM25 索引去重清理', { module: 'VectorStore', dedupedCount: bm25DedupedCount });
    }
    logger.info('已添加文档到 BM25 索引', { module: 'VectorStore', documentCount: bm25AddedCount });
  } catch (bm25Error: any) {
    logger.warn('BM25 索引添加失败，不影响文档存储', { module: 'VectorStore', error: bm25Error.message });
  }

  return addedCount;
}

// ==================== 文档删除 ====================

/**
 * 从知识库删除文档
 *
 * 处理流程：
 * 1. 从 BM25 索引中按 filter 增量删除匹配的文档
 * 2. 从 ChromaDB 中删除匹配的文档
 *
 * BM25 增量删除失败时降级为全量重建。
 *
 * @param filter 删除文档的过滤条件（基于元数据字段匹配）
 */
export async function deleteDocuments(filter: Record<string, any>): Promise<void> {
  const store = await initializeVectorStore();

  // 先从 BM25 索引中按 filter 增量删除匹配的文档，避免全量重建
  // BM25 删除直接按 filter 匹配 bm25DocumentStore，无需依赖 ChromaDB 查询
  try {
    // 确保 BM25 索引已初始化（服务重启后 bm25Index 可能为 null，需要从磁盘加载）
    await initializeBM25Index();
    const bm25Index = getBM25Index();
    const bm25DocumentStore = getBM25DocumentStore();

    if (bm25Index) {
      // 从 BM25 索引中按 filter 匹配删除文档
      let bm25DeletedCount = 0;
      const idsToRemove: string[] = [];
      for (const [id, doc] of bm25DocumentStore.entries()) {
        const docMeta = doc.metadata;
        let matches = true;

        // 检查 filter 中的每个条件是否匹配
        for (const [key, value] of Object.entries(filter)) {
          if (docMeta?.[key] !== value) {
            matches = false;
            break;
          }
        }

        if (matches) {
          idsToRemove.push(id);
        }
      }

      for (const id of idsToRemove) {
        try {
          bm25Index.remove(id);
          bm25DocumentStore.delete(id);
          bm25DeletedCount++;
        } catch {
          logger.warn('BM25 删除文档失败（可能已不存在）', { module: 'VectorStore', id });
        }
      }

      if (bm25DeletedCount > 0) {
        await saveBM25Index();
        logger.info('已从 BM25 索引增量删除文档', { module: 'VectorStore', deletedCount: bm25DeletedCount });
      }
    }
  } catch (bm25Error: any) {
    // BM25 增量删除失败时降级为全量重建
    logger.warn('BM25 增量删除失败，降级为全量重建', { module: 'VectorStore', error: bm25Error.message });
    await rebuildBM25Index(getAllDocuments);
  }

  // 从 ChromaDB 删除文档
  await store.delete({ filter });
  logger.info('已从知识库删除文档', { module: 'VectorStore' });
}

/**
 * 获取知识库中的所有文档
 * 供 BM25 重建索引使用（也供 vector-version 模块调用）
 *
 * @returns 所有文档的列表
 */
export async function getAllDocuments(): Promise<Array<{ content: string; metadata: any }>> {
  logger.info('获取知识库所有文档', { module: 'VectorStore' });

  try {
    const client = new ChromaClient({ host: config.chromaHost, port: config.chromaPort });
    const collection = await client.getCollection({ name: COLLECTION_NAME });
    const results = await collection.get();

    const documents = results.documents.map((doc, i) => ({
      content: doc || '',
      metadata: results.metadatas?.[i] || {},
    }));

    logger.info('知识库文档统计', { module: 'VectorStore', documentCount: documents.length });
    return documents;
  } catch (error) {
    logger.error('获取文档列表失败', { module: 'VectorStore', error: String(error) });
    return [];
  }
}
