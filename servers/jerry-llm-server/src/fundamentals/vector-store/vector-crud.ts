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
import crypto from 'crypto';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { eventBus } from '../event-bus.js';
import {
  BATCH_SIZE,
  COLLECTION_NAME,
  embeddings,
  initializeVectorStore,
  getBM25Index,
  getBM25DocumentStore,
  getEmbeddingSemaphore,
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
  getAdaptiveChunkingProfile,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  parentChildSplit,
  type ParentChildChunk,
  DEFAULT_PARENT_CHUNK_SIZE,
  DEFAULT_PARENT_CHUNK_OVERLAP,
  DEFAULT_CHILD_CHUNK_SIZE,
  DEFAULT_CHILD_CHUNK_OVERLAP,
} from './text-splitter.js';

// ==================== 文档添加 ====================

/**
 * 计算文本块内容 SHA-256（内容级幂等去重键）
 *
 * 用途：同一文件重复入库时（legacy 上传路径无版本管理，重复上传同名文件
 * 不会触发 ChromaDB 清理），按内容 hash 识别并删除旧块，实现入库幂等。
 * hash 基于 chunk 原文（切分器确定性：同一文本切出相同块），不做归一化 --
 * 跨格式的内容比对是 documents.contentHash（文件级去重）的职责
 */
export function computeChunkHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * 文本块内容级幂等去重：删除与本次待入库块内容相同的旧块
 *
 * 作用域（关键设计决策）：versionId + source + chunk_hash
 *   - 必须包含 versionId：发布新版本时旧版本向量仅被标记为 archived 并保留
 *     （供回滚），若按 documentId 作用域去重会删掉旧版本的归档块，
 *     回滚时 updateVersionVectorStatus 匹配不到向量，导致内容从检索中消失
 *   - legacy 路径 versionId 恒为 'legacy'，实际靠 source（文件名）区分不同文件
 *   - 知识源路径无 versionId，退化为 source（页面 URL）+ chunk_hash
 *
 * 失败容忍：任何去重异常只打日志，不阻塞入库主流程（与图片块去重一致）
 */
export async function deduplicateTextChunks(
  store: Awaited<ReturnType<typeof initializeVectorStore>>,
  chunks: Array<{ text: string; metaIndex: number }>,
  metadata: Record<string, any>[],
): Promise<void> {
  const collection = store.collection;
  if (!collection || chunks.length === 0) return;

  // 按 (versionId, source) 分组收集 hash，减少 ChromaDB 查询次数
  const groups = new Map<string, { versionId?: string; source: string; hashes: Set<string> }>();
  for (const chunk of chunks) {
    const meta = metadata[chunk.metaIndex] || {};
    const versionId = meta.versionId !== undefined ? String(meta.versionId) : undefined;
    const source = meta.source || 'unknown';
    const key = `${versionId ?? ''}__${source}`;
    let group = groups.get(key);
    if (!group) {
      group = { versionId, source, hashes: new Set<string>() };
      groups.set(key, group);
    }
    group.hashes.add(computeChunkHash(chunk.text));
  }

  // 1. 清理 ChromaDB 中的同内容旧块
  let chromaDeletedCount = 0;
  for (const group of groups.values()) {
    try {
      // 元素类型与 chromadb 的 Where 子句结构兼容（字段等值 / $in 操作符）
      const whereClauses: Array<Record<string, string | { $in: string[] }>> = [
        { source: group.source },
        { chunk_hash: { $in: Array.from(group.hashes) } },
      ];
      // versionId 存在时纳入过滤（版本管理路径）；知识源路径无 versionId，
      // 按 source（页面 URL）+ hash 去重即可
      if (group.versionId !== undefined) {
        whereClauses.push({ versionId: group.versionId });
      }
      const existing = await collection.get({
        where: { $and: whereClauses },
      });
      if (existing.ids.length > 0) {
        await collection.delete({ ids: existing.ids });
        chromaDeletedCount += existing.ids.length;
      }
    } catch (err: any) {
      logger.warn('ChromaDB 文本块去重失败（不影响入库）', {
        module: 'VectorStore',
        source: group.source,
        versionId: group.versionId,
        error: err.message,
      });
    }
  }

  // 2. 清理 BM25 索引中的同内容旧块（与 ChromaDB 保持一致，防止双端数据漂移）
  let bm25DeletedCount = 0;
  try {
    await initializeBM25Index();
    const bm25Index = getBM25Index();
    const bm25DocumentStore = getBM25DocumentStore();

    if (bm25Index) {
      const idsToRemove: string[] = [];
      for (const [id, doc] of bm25DocumentStore.entries()) {
        const meta = doc.metadata;
        if (!meta?.chunk_hash) continue;
        const versionId =
          meta.versionId !== undefined ? String(meta.versionId) : undefined;
        const source = meta.source || 'unknown';
        const group = groups.get(`${versionId ?? ''}__${source}`);
        if (group && group.hashes.has(meta.chunk_hash)) {
          idsToRemove.push(id);
        }
      }

      for (const id of idsToRemove) {
        try {
          bm25Index.remove(id);
          bm25DocumentStore.delete(id);
          bm25DeletedCount++;
        } catch {
          /* 旧条目可能已不存在 */
        }
      }

      if (idsToRemove.length > 0) {
        await saveBM25Index();
      }
    }
  } catch (err: any) {
    logger.warn('BM25 文本块去重失败（不影响入库）', {
      module: 'VectorStore',
      error: err.message,
    });
  }

  if (chromaDeletedCount > 0 || bm25DeletedCount > 0) {
    logger.info('文本块内容级去重清理', {
      module: 'VectorStore',
      chromaDeletedCount,
      bm25DeletedCount,
      groupCount: groups.size,
    });
  }
}

/**
 * 添加文档到知识库
 *
 * 支持两种切分策略：
 * - flat（默认）：传统单一粒度切分
 * - parent-child：小粒度检索 + 大粒度上下文
 *   子块（child）用于精准匹配，命中后返回父块（parent）的完整内容
 *
 * @param texts 文档文本内容数组
 * @param metadata 每个文档对应的元数据数组
 * @param options 切分选项
 * @returns 成功添加的文本块数量
 */
export async function addDocuments(
  texts: string[],
  metadata: Record<string, any>[],
  options?: {
    /** 切分策略：flat（默认）或 parent-child */
    chunkingStrategy?: 'flat' | 'parent-child';
    /** Parent-Child 参数 */
    parentChild?: {
      parentChunkSize?: number;
      parentChunkOverlap?: number;
      childChunkSize?: number;
      childChunkOverlap?: number;
    };
  },
): Promise<number> {
  const store = await initializeVectorStore();
  const chunkingStrategy = options?.chunkingStrategy ?? 'flat';

  // 1. 切分文档
  const allChunks: Array<{
    text: string;
    metaIndex: number;
    chunkIndexInDoc: number;
    /** Parent-Child 模式下的额外元数据 */
    parentContent?: string;
    parentId?: string;
    chunkRole?: 'parent' | 'child';
  }> = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const meta = metadata[i] || {};

    const fileType = meta.fileType || '';
    const mimeType = meta.mimeType || '';
    const adaptiveProfile = getAdaptiveChunkingProfile({
      fileType,
      mimeType,
      content: text,
    });

    if (chunkingStrategy === 'parent-child') {
      // Parent-Child 切分
      const pcOptions = options?.parentChild;
      const pcResult = await parentChildSplit(text, {
        parentChunkSize:
          pcOptions?.parentChunkSize ?? adaptiveProfile.parentChunkSize,
        parentChunkOverlap:
          pcOptions?.parentChunkOverlap ?? adaptiveProfile.parentChunkOverlap,
        childChunkSize:
          pcOptions?.childChunkSize ?? adaptiveProfile.childChunkSize,
        childChunkOverlap:
          pcOptions?.childChunkOverlap ?? adaptiveProfile.childChunkOverlap,
        // 传入文档类型和扩展名，让父块切分器按 Markdown 标题 / 代码结构切分
        documentType: adaptiveProfile.documentType,
        fileType,
      });

      logger.info('Parent-Child 切分文档', {
        module: 'VectorStore',
        docIndex: i,
        textLength: text.length,
        documentType: adaptiveProfile.documentType,
        parentChunkSize: adaptiveProfile.parentChunkSize,
        parentChunkOverlap: adaptiveProfile.parentChunkOverlap,
        childChunkSize: adaptiveProfile.childChunkSize,
        childChunkOverlap: adaptiveProfile.childChunkOverlap,
        parentCount: pcResult.length,
        totalChildren: pcResult.reduce(
          (sum, pc) => sum + pc.children.length,
          0,
        ),
        parentSizes: pcResult.map((pc) => pc.parent.text.length),
        childSizes: pcResult.flatMap((pc) =>
          pc.children.map((c) => c.text.length),
        ),
      });

      for (const pc of pcResult) {
        const parentId = `parent_${i}_${pc.parent.index}`;

        // 注意：不将父块写入 ChromaDB，原因：
        // 1. 父块（默认 1500 字符）超过 bge-large 嵌入模型的上下文长度（512 tokens）
        // 2. 检索靠子块精准匹配，父块内容已存储在子块的 parent_content 元数据中
        // 3. 命中子块后自动展开返回父块内容，无需单独检索父块

        // 只添加子块（用于精准检索，携带 parentId 和 parent_content 关联到父块）
        for (const child of pc.children) {
          allChunks.push({
            text: child.text,
            metaIndex: i,
            chunkIndexInDoc: child.index,
            parentContent: pc.parent.text,
            parentId,
            chunkRole: 'child',
          });
        }
      }
    } else {
      // 传统 flat 切分
      // isMD 只在 flat 模式下使用，用于让 getSplitterByFileType 优先走 Markdown 切分器
      const isMD = isMarkdownContent(text);
      const splitter = getSplitterByFileType(fileType, isMD, adaptiveProfile);

      logger.info('切分文档', {
        module: 'VectorStore',
        docIndex: i,
        textLength: text.length,
        fileType: fileType || '(无)',
        mimeType: mimeType || '(无)',
        documentType: adaptiveProfile.documentType,
        chunkSize: adaptiveProfile.chunkSize,
        chunkOverlap: adaptiveProfile.chunkOverlap,
        isMarkdown: isMD,
        splitterType: splitter.constructor.name,
      });

      const chunks = await splitter.splitText(text);

      logger.info('文档切分结果', {
        module: 'VectorStore',
        docIndex: i,
        chunkCount: chunks.length,
        chunkSizes: chunks.map((c) => c.length),
      });

      for (let j = 0; j < chunks.length; j++) {
        allChunks.push({
          text: chunks[j],
          metaIndex: i,
          chunkIndexInDoc: j,
        });
      }
    }
  }

  logger.info('文档切分完成', {
    module: 'VectorStore',
    totalChunks: allChunks.length,
    chunkingStrategy,
    parentChildStats:
      chunkingStrategy === 'parent-child'
        ? {
            children: allChunks.filter((c) => c.chunkRole === 'child').length,
            note: '父块不写入向量库，内容通过子块 parent_content 元数据关联',
          }
        : undefined,
  });

  // 1.5 内容级幂等去重：删除与本次待入库块内容相同的旧块
  // （legacy 路径重复上传的历史遗留 + 任何重试场景的兜底；作用域含 versionId，
  //   不会触碰其他版本的归档向量，回滚功能不受影响，详见函数注释）
  await deduplicateTextChunks(store, allChunks, metadata);

  // 2. 批量写入 ChromaDB（通过信号量控制并发，避免 Ollama 嵌入请求堆积）
  let addedCount = 0;
  const semaphore = getEmbeddingSemaphore();

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE).map((chunk) => {
      const baseMeta: Record<string, any> = {
        ...metadata[chunk.metaIndex],
        chunk_index: chunk.chunkIndexInDoc,
        source: metadata[chunk.metaIndex]?.source || 'unknown',
        doc_type: metadata[chunk.metaIndex]?.docType || 'general',
        // 内容级去重键（见 computeChunkHash 注释）
        chunk_hash: computeChunkHash(chunk.text),
      };

      // Parent-Child 模式：添加关联元数据
      if (chunk.chunkRole) {
        baseMeta.chunk_role = chunk.chunkRole;
        baseMeta.parent_id = chunk.parentId || '';
        if (chunk.chunkRole === 'child' && chunk.parentContent) {
          baseMeta.parent_content = chunk.parentContent;
        }
      }

      return new Document({
        pageContent: chunk.text,
        metadata: baseMeta,
      });
    });

    const callerId = await semaphore.acquire(`addDoc_batch${i}`);
    try {
      await store.addDocuments(batch);
      addedCount += batch.length;
      logger.debug('批量添加成功', {
        module: 'VectorStore',
        callerId,
        batchStart: i,
        batchSize: batch.length,
        totalAdded: addedCount,
      });
    } catch (error: any) {
      logger.error('批量添加文档失败，尝试逐条添加', {
        module: 'VectorStore',
        callerId,
        batchStart: i,
        batchSize: batch.length,
        error: error.message,
        errorStack: error.stack?.substring(0, 300),
      });

      // 降级为逐条添加
      for (let j = 0; j < batch.length; j++) {
        try {
          await store.addDocuments([batch[j]]);
          addedCount++;
        } catch (singleError: any) {
          logger.error('文档添加失败', {
            module: 'VectorStore',
            callerId,
            index: i + j + 1,
            chunkPreview: batch[j].pageContent.substring(0, 80),
            error: singleError.message,
          });
        }
      }
    } finally {
      semaphore.release(callerId);
    }
  }

  logger.info('成功添加文本块到知识库', { module: 'VectorStore', addedCount });

  // 通知缓存：知识库已更新
  eventBus.emit('knowledge-base-updated', '文档添加');

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
      const chunkMetadata: Record<string, any> = {
        ...metadata[chunk.metaIndex],
        chunk_index: chunk.chunkIndexInDoc,
        source: metadata[chunk.metaIndex]?.source || 'unknown',
        doc_type: metadata[chunk.metaIndex]?.docType || 'general',
        // 内容级去重键：与 ChromaDB 侧 baseMeta 保持一致，双端用同一把幂等键
        chunk_hash: computeChunkHash(chunk.text),
      };

      // Parent-Child 模式：BM25 索引也需要 chunk_role/parent_id/parent_content
      // 否则 BM25 检索命中子块时无法展开为父块内容
      if (chunk.chunkRole) {
        chunkMetadata.chunk_role = chunk.chunkRole;
        chunkMetadata.parent_id = chunk.parentId || '';
        if (chunk.chunkRole === 'child' && chunk.parentContent) {
          chunkMetadata.parent_content = chunk.parentContent;
        }
      }

      // 去重：删除 BM25 中同 source + chunk_index 的旧条目，避免重复入库导致索引膨胀
      // 场景：reindex 或知识源增量更新时，同一文档可能被多次入库
      const bm25Index = getBM25Index();
      const bm25DocumentStore = getBM25DocumentStore();
      const sourceValue = chunkMetadata.source;
      const chunkIndexValue = chunkMetadata.chunk_index;
      if (
        sourceValue !== undefined &&
        chunkIndexValue !== undefined &&
        bm25Index
      ) {
        const idsToRemove: string[] = [];
        for (const [existingId, existingDoc] of bm25DocumentStore.entries()) {
          if (
            existingDoc.metadata?.source === sourceValue &&
            existingDoc.metadata?.chunk_index === chunkIndexValue
          ) {
            idsToRemove.push(existingId);
          }
        }
        if (idsToRemove.length > 0) {
          logger.debug('BM25 去重：发现同 source+chunk_index 旧条目', {
            module: 'VectorStore',
            source: sourceValue,
            chunkIndex: chunkIndexValue,
            duplicateCount: idsToRemove.length,
          });
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
      logger.info('BM25 索引去重清理', {
        module: 'VectorStore',
        dedupedCount: bm25DedupedCount,
      });
    }
    logger.info('已添加文档到 BM25 索引', {
      module: 'VectorStore',
      documentCount: bm25AddedCount,
    });
  } catch (bm25Error: any) {
    logger.warn('BM25 索引添加失败，不影响文档存储', {
      module: 'VectorStore',
      error: bm25Error.message,
    });
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
export async function deleteDocuments(
  filter: Record<string, any>,
): Promise<void> {
  const store = await initializeVectorStore();

  logger.info('开始删除文档', { module: 'VectorStore', filter });

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
      const totalBM25Docs = bm25DocumentStore.size;

      logger.debug('BM25 增量删除：扫描文档', {
        module: 'VectorStore',
        totalBM25Docs,
        filter,
      });

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
          logger.warn('BM25 删除文档失败（可能已不存在）', {
            module: 'VectorStore',
            id,
          });
        }
      }

      if (bm25DeletedCount > 0) {
        await saveBM25Index();
        logger.info('已从 BM25 索引增量删除文档', {
          module: 'VectorStore',
          deletedCount: bm25DeletedCount,
          remainingCount: bm25DocumentStore.size,
        });
      } else {
        logger.info('BM25 索引中未找到匹配文档', {
          module: 'VectorStore',
          filter,
        });
      }
    }
  } catch (bm25Error: any) {
    // BM25 增量删除失败时降级为全量重建
    logger.warn('BM25 增量删除失败，降级为全量重建', {
      module: 'VectorStore',
      error: bm25Error.message,
    });
    await rebuildBM25Index(getAllDocuments);
  }

  // 从 ChromaDB 删除文档
  await store.delete({ filter });
  logger.info('已从知识库删除文档', { module: 'VectorStore' });

  // 通知缓存：知识库已更新
  eventBus.emit('knowledge-base-updated', '文档删除');
}

/**
 * 获取知识库中的所有文档
 * 供 BM25 重建索引使用（也供 vector-version 模块调用）
 *
 * @returns 所有文档的列表
 */
export async function getAllDocuments(): Promise<
  Array<{ content: string; metadata: any }>
> {
  logger.info('获取知识库所有文档', { module: 'VectorStore' });

  try {
    const client = new ChromaClient({
      host: config.chromaHost,
      port: config.chromaPort,
    });
    const collection = await client.getCollection({ name: COLLECTION_NAME });
    const results = await collection.get();

    const documents = results.documents.map((doc, i) => ({
      content: doc || '',
      metadata: results.metadatas?.[i] || {},
    }));

    logger.info('知识库文档统计', {
      module: 'VectorStore',
      documentCount: documents.length,
    });
    return documents;
  } catch (error) {
    logger.error('获取文档列表失败', {
      module: 'VectorStore',
      error: String(error),
    });
    return [];
  }
}

// ==================== 图片描述块入库 ====================

/**
 * 图片描述块入库输入
 *
 * 每个图片描述块对应一张图片的 VLM 翻译结果，
 * 通过 chunkType='image' 元数据与普通文本块区分。
 */
export interface ImageChunkInput {
  /** 图片描述文本（VLM 生成或元数据兜底） */
  description: string;
  /** 元数据：documentId / versionId / source 等基础字段 */
  baseMetadata: Record<string, any>;
  /** 图片专属元数据 */
  imageMetadata: {
    /** 原图相对路径（相对 IMAGE_STORAGE_DIR） */
    imagePath: string;
    /** 图片内容 hash */
    imageHash: string;
    /** 图注 */
    caption: string | null;
    /** 页码 */
    page: number | null;
    /** 章节 */
    section: string | null;
    /** 文档内索引 */
    imageSourceIndex: number;
    /** 来源类型：embedded / scanned_page */
    sourceType: 'embedded' | 'scanned_page';
  };
}

/**
 * 添加图片描述块到知识库
 *
 * 与 addDocuments 不同：
 * - 不走文本切分器（图片描述已是完整语义单元，无需再切）
 * - 直接作为单个 chunk 入库，chunkType='image'
 * - 同时写入 ChromaDB 和 BM25 索引
 *
 * @param chunks 图片描述块数组
 * @returns 成功添加的数量
 */
export async function addImageChunks(
  chunks: ImageChunkInput[],
): Promise<number> {
  if (chunks.length === 0) return 0;

  const store = await initializeVectorStore();
  const semaphore = getEmbeddingSemaphore();

  // 去重：删除同 documentId + image_hash 的旧图片描述块
  // 场景：
  // 1. 重新发布：removeDocumentVersion 已按 versionId 删除，但跨版本重发时可能残留
  // 2. 异步重试成功：首次 Layer 4 兜底块已入库，重试成功后需删除旧块避免重复
  await deduplicateImageChunks(store, chunks);

  let addedCount = 0;

  // 构造 LangChain Document 数组
  const documents = chunks.map((chunk) => {
    const metadata: Record<string, any> = {
      ...chunk.baseMetadata,
      chunk_index: chunk.imageMetadata.imageSourceIndex,
      source: chunk.baseMetadata.source || 'unknown',
      doc_type: 'image',
      // 图片专属元数据
      chunk_type: 'image',
      image_path: chunk.imageMetadata.imagePath,
      image_hash: chunk.imageMetadata.imageHash,
      caption: chunk.imageMetadata.caption ?? '',
      page: chunk.imageMetadata.page ?? -1,
      section: chunk.imageMetadata.section ?? '',
      image_source_index: chunk.imageMetadata.imageSourceIndex,
      image_source_type: chunk.imageMetadata.sourceType,
    };

    return new Document({
      pageContent: chunk.description,
      metadata,
    });
  });

  // 批量入库（受信号量保护，与 addDocuments 一致）
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    const callerId = await semaphore.acquire(`addImage_batch${i}`);

    try {
      await store.addDocuments(batch);
      addedCount += batch.length;
      logger.debug('图片描述块批量入库成功', {
        module: 'VectorStore',
        callerId,
        batchStart: i,
        batchSize: batch.length,
        totalAdded: addedCount,
      });
    } catch (error: any) {
      logger.error('图片描述块批量入库失败，尝试逐条添加', {
        module: 'VectorStore',
        callerId,
        batchStart: i,
        batchSize: batch.length,
        error: error.message,
      });

      // 降级为逐条添加
      for (let j = 0; j < batch.length; j++) {
        try {
          await store.addDocuments([batch[j]]);
          addedCount++;
        } catch (singleError: any) {
          logger.error('图片描述块单条入库失败', {
            module: 'VectorStore',
            callerId,
            index: i + j + 1,
            imageHash: batch[j].metadata.image_hash,
            error: singleError.message,
          });
        }
      }
    } finally {
      semaphore.release(callerId);
    }
  }

  logger.info('图片描述块入库完成', {
    module: 'VectorStore',
    addedCount,
    totalCount: chunks.length,
  });

  // 同步写入 BM25 索引（失败不影响主流程）
  try {
    await initializeBM25Index();

    for (const doc of documents) {
      const id = `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${doc.metadata.image_source_index}`;
      await addToBM25Index(id, doc.pageContent, doc.metadata, true);
    }
    await saveBM25Index();

    logger.info('图片描述块已加入 BM25 索引', {
      module: 'VectorStore',
      bm25AddedCount: documents.length,
    });
  } catch (bm25Error: any) {
    logger.warn('图片描述块 BM25 索引添加失败，不影响主流程', {
      module: 'VectorStore',
      error: bm25Error.message,
    });
  }

  // 通知缓存更新
  eventBus.emit('knowledge-base-updated', '图片描述块添加');

  return addedCount;
}

// ==================== 图片描述块去重 ====================

/**
 * 删除同 documentId + image_hash 的旧图片描述块
 *
 * 在 addImageChunks 入库前调用，确保同一图片不会在向量库中产生重复块。
 * 同时清理 ChromaDB 和 BM25 索引中的旧条目。
 *
 * 去重维度：documentId + image_hash + chunk_type='image'
 * 不用 versionId 做去重，因为重试成功后 versionId 相同但描述不同。
 */
async function deduplicateImageChunks(
  store: Awaited<ReturnType<typeof initializeVectorStore>>,
  chunks: ImageChunkInput[],
): Promise<void> {
  const collection = store.collection;
  if (!collection) return;

  // 收集需要去重的 (documentId, image_hash) 对
  const dedupKeys = new Set<string>();
  for (const chunk of chunks) {
    const docId = chunk.baseMetadata.documentId;
    const hash = chunk.imageMetadata.imageHash;
    if (docId && hash) {
      dedupKeys.add(`${docId}__${hash}`);
    }
  }

  if (dedupKeys.size === 0) return;

  // 1. 清理 ChromaDB 中的旧图片块
  let chromaDeletedCount = 0;
  for (const key of dedupKeys) {
    const [docId, hash] = key.split('__');
    try {
      // ChromaDB where 条件只支持单字段等值，用 $and 组合
      const existing = await collection.get({
        where: {
          $and: [
            { documentId: docId },
            { image_hash: hash },
            { chunk_type: 'image' },
          ],
        },
      });
      if (existing.ids.length > 0) {
        await collection.delete({ ids: existing.ids });
        chromaDeletedCount += existing.ids.length;
      }
    } catch (err: any) {
      logger.warn('ChromaDB 图片块去重失败（不影响入库）', {
        module: 'VectorStore',
        documentId: docId,
        imageHash: hash,
        error: err.message,
      });
    }
  }

  // 2. 清理 BM25 索引中的旧图片块
  let bm25DeletedCount = 0;
  try {
    await initializeBM25Index();
    const bm25Index = getBM25Index();
    const bm25DocumentStore = getBM25DocumentStore();

    if (bm25Index) {
      const idsToRemove: string[] = [];
      for (const [id, doc] of bm25DocumentStore.entries()) {
        const meta = doc.metadata;
        if (
          meta?.chunk_type === 'image' &&
          meta?.documentId &&
          dedupKeys.has(`${meta.documentId}__${meta.image_hash}`)
        ) {
          idsToRemove.push(id);
        }
      }

      for (const id of idsToRemove) {
        try {
          bm25Index.remove(id);
          bm25DocumentStore.delete(id);
          bm25DeletedCount++;
        } catch {
          /* 旧条目可能已不存在 */
        }
      }

      if (idsToRemove.length > 0) {
        await saveBM25Index();
      }
    }
  } catch (err: any) {
    logger.warn('BM25 图片块去重失败（不影响入库）', {
      module: 'VectorStore',
      error: err.message,
    });
  }

  if (chromaDeletedCount > 0 || bm25DeletedCount > 0) {
    logger.info('图片描述块去重清理', {
      module: 'VectorStore',
      chromaDeletedCount,
      bm25DeletedCount,
      dedupKeyCount: dedupKeys.size,
    });
  }
}
