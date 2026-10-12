/**
 * 用户记忆专用向量 collection 封装（memory-vector-retrieval-plan.md §4）
 *
 * 设计要点：
 * - 独立 collection `user_memories`：与知识库（knowledge_base_*）物理隔离，
 *   杜绝"知识库片段被当作用户记忆注入"的串抽屉事故
 * - 一条记忆 = 一个 chunk（记忆是短文本，不切分）
 * - 确定性 ID `mem_{memoryId}`：MySQL 主键直拼，增删改按 ID 精确操作
 *   （搜索式删除是模糊的，ID 删除是精确的）
 * - metadata 记 userId（检索强制过滤，多用户安全底线）+ memoryId 回指 + 类别/重要性
 * - MySQL 是唯一真相源：本模块所有操作的失败都不阻塞主流程，由上层记
 *   "待同步"标记 + 全量重建兜底（真相可随时重抄目录）
 * - 嵌入实例复用 store-state 的 getEmbeddings()（与知识库同一运行时配置）：
 *   换嵌入模型后指纹不同模型产生的向量不可比，全量重建是唯一正确迁移方式
 *
 * 与知识库的关键差异：知识库走 LangChain Chroma 封装（text-splitter 切分 +
 * BM25 双引擎），记忆库直接用 ChromaClient 原生 upsert/query——记忆不切分、
 * 不建 BM25，原生 API 足够且避免不必要的封装层
 */

import { ChromaClient } from 'chromadb';
import { logger } from '../logger';
import { config } from '../config';
import { getEmbeddings } from './store-state';

// ==================== 常量 ====================

/** 用户记忆专用 collection 名（与知识库 knowledge_base_* 前缀物理隔离） */
export const MEMORY_COLLECTION_NAME = 'user_memories';

/** 向量文档 ID 前缀：mem_{memoryId}，MySQL 主键直拼 */
const MEMORY_DOC_ID_PREFIX = 'mem_';

/** 知识库集合使用 cosine 空间（见 store-state doInitialize），记忆集合保持一致 */
const HNSW_METADATA = { 'hnsw:space': 'cosine' } as const;

// ==================== 内部状态 ====================

interface MemoryCollectionBundle {
  client: ChromaClient;
  collection: Awaited<ReturnType<ChromaClient['getCollection']>>;
}

/** 懒加载单例：模块加载时不连 ChromaDB，首次使用才建立连接 */
let bundlePromise: Promise<MemoryCollectionBundle> | null = null;

/**
 * 获取（或初始化）用户记忆 collection
 *
 * collection 不存在时自动创建（cosine 空间）。连接失败向上抛错，
 * 由调用方决定降级行为（写路径记待同步 / 读路径落兜底层）
 */
async function getMemoryCollection(): Promise<MemoryCollectionBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const client = new ChromaClient({
        host: config.chromaHost,
        port: config.chromaPort,
      });
      try {
        const collection = await client.getCollection({
          name: MEMORY_COLLECTION_NAME,
          embeddingFunction: getEmbeddings() as any,
        });
        logger.debug('用户记忆集合已连接', {
          module: 'MemoryVector',
          collection: MEMORY_COLLECTION_NAME,
        });
        return { client, collection };
      } catch {
        // 集合不存在 → 创建；创建也失败（如 ChromaDB 不可用）→ 向上抛
        const collection = await client.createCollection({
          name: MEMORY_COLLECTION_NAME,
          metadata: HNSW_METADATA,
          embeddingFunction: getEmbeddings() as any,
        });
        logger.info('用户记忆集合不存在，已创建新集合', {
          module: 'MemoryVector',
          collection: MEMORY_COLLECTION_NAME,
        });
        return { client, collection };
      }
    })().catch((e: Error) => {
      // 失败时清空 promise，下次调用重试连接（而不是永远缓存失败）
      bundlePromise = null;
      throw e;
    });
  }
  return bundlePromise;
}

/** 拼向量文档 ID：memoryId → mem_{memoryId} */
function memoryDocId(memoryId: number): string {
  return `${MEMORY_DOC_ID_PREFIX}${memoryId}`;
}

// ==================== 写操作（写穿同步） ====================

/** 记忆向量的 metadata 结构（Chroma metadata 仅支持标量值） */
export interface MemoryVectorMetadata {
  userId: string;
  memoryId: number;
  importance: number;
  category: string;
  updatedAt: string;
}

/** Chroma SDK 的 Metadata 类型要求 string 索引签名，接口直接赋值会报 TS2322 */
type ChromaMetadata = Record<string, string | number | boolean>;

/**
 * 写入/覆盖一条记忆向量（内容变更 → 重新 embed；属性变更 → 仅 metadata）
 *
 * - 内容与属性一起传：重新 embed 内容，覆盖写（upsert 语义，同 ID 幂等）
 * - 仅属性（content 传 null）：只更新 metadata，不重新 embed（零成本毫秒级）
 *
 * @throws ChromaDB 不可用 / 嵌入失败时向上抛，调用方负责记"待同步"
 */
export async function upsertMemoryVector(params: {
  memoryId: number;
  userId: string;
  content: string | null;
  category: string;
  importance: number;
  updatedAt: Date;
}): Promise<void> {
  const { collection } = await getMemoryCollection();
  const metadata: ChromaMetadata = {
    userId: params.userId,
    memoryId: params.memoryId,
    category: params.category,
    importance: params.importance,
    updatedAt: params.updatedAt.toISOString(),
  };

  if (params.content === null) {
    // 仅属性变更：按 ID get 后原向量 + 新 metadata 覆盖写，不触发嵌入
    const existing = await collection.get({ ids: [memoryDocId(params.memoryId)] });
    if (!existing.documents || existing.documents.length === 0 || !existing.documents[0]) {
      // 向量还不存在（如历史上同步失败）：降级为全量写（需要 content）
      throw new Error('向量不存在，无法仅更新 metadata，需要全量同步');
    }
    await collection.upsert({
      ids: [memoryDocId(params.memoryId)],
      documents: [existing.documents[0]],
      // Chroma get 返回的 embeddings 可能未包含，带上已存向量避免 upsert 重新嵌入；
      // SDK 类型要求 number[][]，这里永远传"包含一个向量"的数组
      ...(existing.embeddings?.[0]
        ? { embeddings: [existing.embeddings[0]] }
        : {}),
      metadatas: [metadata],
    });
    return;
  }

  // 全量写：embed 内容（记忆是短文本，单条嵌入）
  const [embedding] = await getEmbeddings().embedDocuments([params.content]);
  await collection.upsert({
    ids: [memoryDocId(params.memoryId)],
    documents: [params.content],
    embeddings: [embedding],
    metadatas: [metadata],
  });
}

/**
 * 删除一条记忆向量（按确定性 ID 精确删除，不做搜索式删除）
 *
 * 向量本就不存在时静默成功（幂等：删真相后目录同步失败重试也安全）
 */
export async function deleteMemoryVector(memoryId: number): Promise<void> {
  const { collection } = await getMemoryCollection();
  await collection.delete({ ids: [memoryDocId(memoryId)] });
}

/**
 * 删除某用户的全部记忆向量（清空记忆场景，按 metadata 过滤批量删除）
 */
export async function deleteAllMemoryVectorsForUser(userId: string): Promise<void> {
  const { collection } = await getMemoryCollection();
  await collection.delete({ where: { userId } });
}

// ==================== 读操作 ====================

/** 向量检索命中的记忆引用 */
export interface MemoryVectorHit {
  memoryId: number;
  content: string;
  similarity: number;
}

/**
 * 语义检索某用户的记忆（②检索层）
 *
 * @param query 检索查询（当前消息 + 最近 1~2 轮）
 * @param userId 强制过滤（多用户隔离底线）
 * @param topK 召回条数
 * @returns 按 similarity 降序的命中列表
 * @throws ChromaDB 不可用 / 超时由调用方控制（上层包 AbortSignal），失败落兜底层
 */
export async function searchMemoryVectors(params: {
  query: string;
  userId: string;
  topK: number;
}): Promise<MemoryVectorHit[]> {
  const { collection } = await getMemoryCollection();
  const queryEmbedding = await getEmbeddings().embedQuery(params.query);
  const result = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: params.topK,
    where: { userId: params.userId },
    include: ['documents', 'metadatas', 'distances'],
  });

  const docs = result.documents?.[0] ?? [];
  const metas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];

  const hits: MemoryVectorHit[] = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const meta = metas[i] as unknown as MemoryVectorMetadata | undefined;
    if (!doc || !meta?.memoryId) continue;
    // cosine 距离 → 相似度（cosine distance ∈ [0,2]，相似度 = 1 - 距离，可为负 = 完全不相关）
    const distance = distances[i] ?? 2;
    hits.push({
      memoryId: meta.memoryId,
      content: doc,
      similarity: 1 - distance,
    });
  }
  return hits;
}

/**
 * 统计某用户在向量库中的记忆条数（真假空判定用）
 *
 * MySQL 有记忆但此数为 0 → "假空"异常信号（collection 被删/重建失败/同步全挂）
 */
export async function countMemoryVectorsForUser(userId: string): Promise<number> {
  const { collection } = await getMemoryCollection();
  const result = await collection.get({ where: { userId }, include: [] });
  return result.ids?.length ?? 0;
}

// ==================== 全量重建（迁移 / 对账 / 自愈三合一） ====================

/**
 * 全量重建某用户的记忆向量
 *
 * 先清该用户旧向量再逐条写入（幂等：重复执行结果一致）。
 * 三种用途：存量迁移（上线首次灌入）/ 手动对账（前端"全部同步"）/ 自动自愈（假空触发）
 *
 * @param memories 该用户 MySQL 全部记忆（真相源快照）
 * @returns 成功写入条数
 */
export async function rebuildMemoryVectorsForUser(params: {
  userId: string;
  memories: Array<{
    id: number;
    content: string;
    category: string;
    importance: number;
    updatedAt: Date;
  }>;
}): Promise<number> {
  const { collection } = await getMemoryCollection();

  // 1. 清该用户全部旧向量（幂等重建的"清"半步）
  await collection.delete({ where: { userId: params.userId } });

  // 2. 逐条 embed 写入（记忆库几百条规模，批量 20 条控并发）
  let written = 0;
  const batchSize = 20;
  for (let i = 0; i < params.memories.length; i += batchSize) {
    const batch = params.memories.slice(i, i + batchSize);
    const embeddings = await getEmbeddings().embedDocuments(
      batch.map((m) => m.content),
    );
    await collection.upsert({
      ids: batch.map((m) => memoryDocId(m.id)),
      documents: batch.map((m) => m.content),
      embeddings,
      metadatas: batch.map((m) => ({
        userId: params.userId,
        memoryId: m.id,
        category: m.category,
        importance: m.importance,
        updatedAt: m.updatedAt.toISOString(),
      })),
    });
    written += batch.length;
  }

  logger.info('用户记忆向量全量重建完成', {
    module: 'MemoryVector',
    userId: params.userId,
    total: params.memories.length,
    written,
  });
  return written;
}
