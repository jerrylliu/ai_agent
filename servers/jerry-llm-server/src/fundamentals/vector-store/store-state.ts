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

/**
 * BGE 查询前缀
 *
 * BGE 系列模型（bge-large-zh / bge-large-en）要求查询时加指令前缀，
 * 否则查询嵌入与文档嵌入不在同一语义空间，导致检索准确率极低。
 *
 * 实测：不加前缀 "考勤异常处理细则" vs 考勤文档相似度 0.51（低于无关技术文档 0.56）；
 *       加前缀后相似度提升至 0.66，正确匹配。
 *
 * 文档入库时不加前缀（embedDocuments），仅查询时加（embedQuery）。
 */
const BGE_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

/**
 * 包装 OllamaEmbeddings，为 BGE 模型自动添加查询前缀
 *
 * - embedQuery：加前缀（用于检索时的查询嵌入）
 * - embedDocuments：不加前缀（用于入库时的文档嵌入）
 */
class BgeOllamaEmbeddings extends OllamaEmbeddings {
  async embedQuery(text: string): Promise<number[]> {
    return super.embedQuery(`${BGE_QUERY_PREFIX}${text}`);
  }
}

/** ChromaDB 数据持久化目录 */
export const PERSIST_DIR = path.join(__dirname, '..', '..', '..', 'chromadb_data');

/** 批量添加文档时的批次大小（增大批次减少 Ollama 请求次数，提升入库速度） */
export const BATCH_SIZE = 20;

/** 入库并发控制：同时允许的最大嵌入请求数 */
export const MAX_EMBEDDING_CONCURRENCY = 2;

/** 创建嵌入模型实例（全局单例）—— 使用 BgeOllamaEmbeddings 自动添加查询前缀 */
export const embeddings = new BgeOllamaEmbeddings({
  model: EMBEDDING_MODEL,
  baseUrl: config.ollamaBaseUrl,
});

// ==================== 入库并发信号量 ====================

/**
 * 简易信号量：控制 addDocuments 的并发数
 * 防止多个知识源同步 + 文档上传同时请求 Ollama 嵌入导致排队或 OOM
 */
class Semaphore {
  private queue: Array<{ resolve: () => void; callerId: string; enqueuedAt: number }> = [];
  private running = 0;
  private nextCallerId = 0;

  constructor(private max: number) {}

  async acquire(callerTag?: string): Promise<string> {
    const callerId = callerTag ?? `caller_${this.nextCallerId++}`;

    if (this.running < this.max) {
      this.running++;
      logger.info('嵌入信号量：获取成功，立即执行', {
        module: 'VectorStore',
        callerId,
        running: this.running,
        max: this.max,
        queueLength: this.queue.length,
      });
      return callerId;
    }

    const enqueuedAt = Date.now();
    logger.info('嵌入信号量：并发已满，进入等待队列', {
      module: 'VectorStore',
      callerId,
      running: this.running,
      max: this.max,
      queueLength: this.queue.length + 1,
    });

    return new Promise<string>((resolve) => {
      this.queue.push({ resolve: () => resolve(callerId), callerId, enqueuedAt });
    });
  }

  release(callerId: string): void {
    this.running--;

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const waitMs = Date.now() - next.enqueuedAt;
      this.running++;
      logger.info('嵌入信号量：释放后唤醒等待者', {
        module: 'VectorStore',
        releasedBy: callerId,
        awakened: next.callerId,
        waitMs,
        running: this.running,
        queueLength: this.queue.length,
      });
      next.resolve();
    } else {
      logger.info('嵌入信号量：释放，无等待者', {
        module: 'VectorStore',
        releasedBy: callerId,
        running: this.running,
        queueLength: 0,
      });
    }
  }

  /** 获取当前状态（用于监控） */
  getStatus(): { running: number; max: number; queueLength: number } {
    return { running: this.running, max: this.max, queueLength: this.queue.length };
  }
}

/** 全局入库信号量 */
const embeddingSemaphore = new Semaphore(MAX_EMBEDDING_CONCURRENCY);

/**
 * 获取入库信号量（供 vector-crud 使用）
 */
export function getEmbeddingSemaphore(): Semaphore {
  return embeddingSemaphore;
}

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
