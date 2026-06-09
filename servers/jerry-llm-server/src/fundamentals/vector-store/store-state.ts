/**
 * 向量存储 — 共享状态与初始化
 *
 * 集中管理向量存储的可变状态（单例实例、初始化锁、BM25 索引），
 * 以及 ChromaDB 初始化和降级逻辑。
 *
 * 其他子模块（vector-crud、vector-search、vector-version、bm25-index）
 * 通过此模块的 getter/setter 访问共享状态，避免循环依赖。
 */

import { Chroma } from '@langchain/community/vectorstores/chroma';
import { ChromaClient } from 'chromadb';
import { OllamaEmbeddings } from '@langchain/ollama';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../logger.js';
import { config } from '../config.js';

// ==================== 常量 ====================

/** 知识库集合名称 */
export const COLLECTION_NAME = 'knowledge_base';

/** 嵌入模型（中文支持好） */
export const EMBEDDING_MODEL = 'bge-large';

/** ChromaDB 数据持久化目录 */
export const PERSIST_DIR = path.join(__dirname, '..', '..', '..', 'chromadb_data');

/** 批量添加文档时的批次大小 */
export const BATCH_SIZE = 1;

/** 创建嵌入模型实例（全局单例） */
export const embeddings = new OllamaEmbeddings({
  model: EMBEDDING_MODEL,
  baseUrl: config.ollamaBaseUrl,
});

// ==================== 可变状态 ====================

/** 向量存储实例（单例） */
let vectorStore: Chroma | null = null;

/** 初始化锁：防止并发双重初始化 */
let initPromise: Promise<Chroma> | null = null;

/** 标记当前是否为内存存储（降级模式） */
let isMemoryStore = false;

/** BM25 索引实例 */
let bm25Index: any = null;

/** BM25 文档存储（id → {content, metadata}） */
let bm25DocumentStore: Map<string, { content: string; metadata: any }> = new Map();

// ==================== 状态访问器 ====================

export function getVectorStore(): Chroma | null { return vectorStore; }
export function setVectorStore(store: Chroma | null): void { vectorStore = store; }

export function getInitPromise(): Promise<Chroma> | null { return initPromise; }
export function setInitPromise(promise: Promise<Chroma> | null): void { initPromise = promise; }

export function getIsMemoryStore(): boolean { return isMemoryStore; }
export function setIsMemoryStore(value: boolean): void { isMemoryStore = value; }

export function getBM25Index(): any { return bm25Index; }
export function setBM25Index(index: any): void { bm25Index = index; }

export function getBM25DocumentStore(): Map<string, { content: string; metadata: any }> { return bm25DocumentStore; }
export function setBM25DocumentStore(store: Map<string, { content: string; metadata: any }>): void { bm25DocumentStore = store; }

// ==================== 初始化与重置 ====================

/**
 * 重置向量存储实例
 * 当 ChromaDB 从不可用恢复为可用时，需要手动调用此函数清除旧的内存存储实例
 * 下次调用 initializeVectorStore() 时会重新连接 ChromaDB
 */
export function resetVectorStore(): void {
  vectorStore = null;
  initPromise = null;
  isMemoryStore = false;
  logger.info('向量存储实例已重置，下次初始化将重新连接 ChromaDB', { module: 'VectorStore' });
}

/**
 * 检查当前向量存储是否为内存存储（降级模式）
 */
export function isVectorStoreMemoryMode(): boolean {
  return isMemoryStore;
}

/**
 * 初始化向量数据库
 * 如果已存在则加载，否则创建新的
 */
export async function initializeVectorStore(): Promise<Chroma> {
  if (vectorStore && !isMemoryStore) {
    return vectorStore;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doInitialize();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * 实际执行初始化的逻辑
 * - 尝试连接 ChromaDB，加载或创建集合
 * - 如果 ChromaDB 不可用，降级为内存存储
 */
async function doInitialize(): Promise<Chroma> {
  logger.info('初始化向量数据库', { module: 'VectorStore' });

  if (!fs.existsSync(PERSIST_DIR)) {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    logger.info('创建 ChromaDB 数据目录', { module: 'VectorStore', path: PERSIST_DIR });
  }

  try {
    const client = new ChromaClient({ host: config.chromaHost, port: config.chromaPort });

    let collectionExists = false;
    try {
      await client.getCollection({ name: COLLECTION_NAME });
      collectionExists = true;
      logger.info('发现已有知识库集合', { module: 'VectorStore' });
    } catch {
      collectionExists = false;
      logger.info('知识库集合不存在，将创建新集合', { module: 'VectorStore' });
    }

    if (collectionExists) {
      vectorStore = await Chroma.fromExistingCollection(embeddings, {
        collectionName: COLLECTION_NAME,
        url: config.chromaUrl,
      });
      const coll = await client.getCollection({ name: COLLECTION_NAME });
      logger.info('当前集合空间', { module: 'VectorStore', space: coll.metadata?.['hnsw:space'] || 'l2(默认)' });
    } else {
      await client.createCollection({
        name: COLLECTION_NAME,
        metadata: { "hnsw:space": "cosine" },
        embeddingFunction: embeddings as any,
      });
      logger.info('新知识库集合已创建', { module: 'VectorStore' });
      vectorStore = await Chroma.fromExistingCollection(embeddings, {
        collectionName: COLLECTION_NAME,
        url: config.chromaUrl,
      });
    }

    isMemoryStore = false;
    logger.info('向量数据库初始化完成', { module: 'VectorStore' });
    return vectorStore;
  } catch (error: any) {
    logger.error('ChromaDB 连接失败，降级为内存存储', { module: 'VectorStore', error: error.message });
    return createMemoryVectorStore();
  }
}

/**
 * 创建内存向量存储（降级方案）
 * 当 ChromaDB 不可用时使用，数据不会持久化
 */
async function createMemoryVectorStore(): Promise<Chroma> {
  logger.warn('使用内存向量存储（数据不会持久化）', { module: 'VectorStore' });

  const { MemoryVectorStore } = await import('@langchain/classic/vectorstores/memory');
  const memoryStore = new MemoryVectorStore(embeddings);
  isMemoryStore = true;

  // 将 MemoryVectorStore 包装为兼容 Chroma 接口的对象
  vectorStore = {
    addDocuments: memoryStore.addDocuments.bind(memoryStore),
    similaritySearchWithScore: memoryStore.similaritySearchWithScore.bind(memoryStore),
    delete: async () => { logger.warn('内存存储不支持删除操作', { module: 'VectorStore' }); },
    collection: null,
  } as unknown as Chroma;

  return vectorStore;
}
