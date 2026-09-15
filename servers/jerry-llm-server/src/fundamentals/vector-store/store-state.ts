/**
 * 向量存储 — 共享状态与初始化
 *
 * 集中管理向量存储的可变状态（单例实例、初始化锁、BM25 索引），
 * 以及 ChromaDB 初始化和降级逻辑。
 *
 * 嵌入支持「本地 Ollama / 云端」双模式（见 embedding-provider.ts），
 * 但持久化配置里只有一个总开关 localEnabled：
 * - localEnabled=true ：优先本地 Ollama；探测到本地不可用（未安装 / 未启动 /
 *   未拉取模型）时自动降级云端，降级原因见 getLocalFallbackReason()
 * - localEnabled=false：只使用云端
 * 实际生效模式是运行时解析结果（resolveEffectiveMode），不写回配置文件。
 *
 * Chroma 集合按「嵌入模型指纹」隔离：knowledge_base_<fingerprint>。
 * 本地 bge-m3 与硅基流动 BAAI/bge-m3 是同一模型权重、同一向量空间，指纹相同 →
 * 共用同一集合，本地/云端切换与自动降级都不需要重建索引。
 * 换成不同模型（如 Qwen3-Embedding-8B）时指纹变化 → 自动切到新集合，避免不同
 * 向量空间的数据混写在一起导致检索静默劣化（维度相同 Chroma 也不会报错）。
 *
 * 其他子模块（vector-crud、vector-search、vector-version、bm25-index）
 * 通过此模块的 getter/setter 访问共享状态，避免循环依赖。
 */

import { Chroma } from '@langchain/community/vectorstores/chroma';
import { ChromaClient } from 'chromadb';
import type { Embeddings } from '@langchain/core/embeddings';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getRuntimeConfig, type EmbeddingMode } from '../runtime-config.js';
import {
  buildEmbeddings,
  describeEmbeddingConfig,
  resolveCloudModel,
} from './embedding-provider.js';

// ==================== 常量 ====================

/** 知识库集合名前缀（完整集合名 = 前缀 + '_' + 嵌入模型指纹） */
export const COLLECTION_NAME_PREFIX = 'knowledge_base';

/** ChromaDB 数据持久化目录 */
export const PERSIST_DIR = path.join(__dirname, '..', '..', '..', 'chromadb_data');

/** 批量添加文档时的批次大小（增大批次减少嵌入请求次数，提升入库速度） */
export const BATCH_SIZE = 20;

/** 入库并发控制：同时允许的最大嵌入请求数 */
export const MAX_EMBEDDING_CONCURRENCY = 2;

// ==================== 集合名（按嵌入模型指纹隔离） ====================

/**
 * 计算嵌入模型指纹（作为集合名后缀）
 *
 * 去供应商前缀（BAAI/bge-m3 → bge-m3）、转小写、去非字母数字（bge-m3 → bgem3），
 * 使「同一模型权重的不同供应商写法」映射到同一个 Chroma 集合。
 */
export function collectionFingerprint(model: string): string {
  const bare = model.split('/').pop()?.trim() ?? '';
  return bare.toLowerCase().replace(/[^a-z0-9]/g, '') || 'default';
}

// ==================== 生效模式（总开关 + 本地探测） ====================

/**
 * 当前生效的嵌入模式
 *
 * 由 resolveEffectiveMode() 在初始化 / 配置变更时解析写入。
 * 初值按总开关推导，保证解析前被同步读取时也不会给出与开关矛盾的答案。
 */
let effectiveMode: EmbeddingMode = getRuntimeConfig().embedding.localEnabled
  ? 'ollama'
  : 'cloud';

/** 本地不可用导致降级云端时的原因（未降级为 null） */
let localFallbackReason: string | null = null;

/** 探测超时：本地服务不可达时必须快速失败，避免拖慢启动 */
const OLLAMA_PROBE_TIMEOUT_MS = 2000;

/** 探测结果缓存有效期：避免每次向量操作都发一次 HTTP 探测请求 */
const OLLAMA_PROBE_CACHE_TTL_MS = 30_000;

export interface OllamaProbeResult {
  /** 本地 Ollama 是否可用于嵌入 */
  ok: boolean;
  /** 不可用原因（可用时为 null） */
  reason: string | null;
}

let ollamaProbeCache: { at: number; result: OllamaProbeResult } | null = null;

/** 清除本地探测缓存（配置变更后强制下次重新探测） */
export function clearOllamaProbeCache(): void {
  ollamaProbeCache = null;
}

/**
 * Ollama /api/tags 返回 "bge-m3:latest" 这类带 tag 的名字，
 * 需去掉 tag 并容忍供应商前缀差异后再比对
 */
function matchesOllamaModel(tagName: string, wanted: string): boolean {
  const normalize = (s: string): string => s.split(':')[0].trim().toLowerCase();
  const have = normalize(tagName);
  const want = normalize(wanted);
  if (!have || !want) return false;
  return have === want || have.endsWith(`/${want}`) || want.endsWith(`/${have}`);
}

/**
 * 探测本地 Ollama 是否可用于嵌入
 *
 * 两个条件都要满足：
 * 1. 服务可达（GET /api/tags 在超时内返回 200）
 * 2. 配置的嵌入模型已拉取到本地
 *
 * 结果缓存 30 秒，force=true 可跳过缓存强制重探。
 */
export async function probeOllamaAvailability(
  force = false,
): Promise<OllamaProbeResult> {
  if (!force && ollamaProbeCache && Date.now() - ollamaProbeCache.at < OLLAMA_PROBE_CACHE_TTL_MS) {
    return ollamaProbeCache.result;
  }

  const { baseUrl, model } = getRuntimeConfig().embedding.ollama;
  let result: OllamaProbeResult;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      result = { ok: false, reason: `Ollama 返回异常状态码 ${response.status}` };
    } else {
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      const names = (data.models ?? []).map((m) => m.name ?? '');
      result = names.some((name) => matchesOllamaModel(name, model))
        ? { ok: true, reason: null }
        : {
            ok: false,
            reason: `本地未拉取嵌入模型 ${model}（请执行 ollama pull ${model}）`,
          };
    }
  } catch (error: any) {
    result = {
      ok: false,
      reason:
        error?.name === 'AbortError'
          ? `Ollama 服务无响应（${baseUrl}，超过 ${OLLAMA_PROBE_TIMEOUT_MS}ms）`
          : `Ollama 服务不可达（${baseUrl}）：${error?.message ?? '未知错误'}`,
    };
  }

  ollamaProbeCache = { at: Date.now(), result };
  if (!result.ok) {
    logger.warn('本地 Ollama 嵌入不可用', {
      module: 'VectorStore',
      reason: result.reason,
    });
  }
  return result;
}

/**
 * 解析当前生效的嵌入模式（总开关语义）
 *
 * - localEnabled=false → 直接云端，不探测本地
 * - localEnabled=true  → 探测本地；可用则本地，不可用则降级云端并记录原因
 *
 * @param force 是否跳过探测缓存强制重探（配置变更后应传 true）
 */
export async function resolveEffectiveMode(force = false): Promise<EmbeddingMode> {
  const embeddingConfig = getRuntimeConfig().embedding;

  if (!embeddingConfig.localEnabled) {
    effectiveMode = 'cloud';
    localFallbackReason = null;
    return effectiveMode;
  }

  const probe = await probeOllamaAvailability(force);
  effectiveMode = probe.ok ? 'ollama' : 'cloud';
  localFallbackReason = probe.ok ? null : probe.reason;

  if (!probe.ok) {
    logger.warn('本地 Ollama 不可用，嵌入自动降级为云端', {
      module: 'VectorStore',
      reason: localFallbackReason,
    });
  }
  return effectiveMode;
}

/** 获取当前生效的嵌入模式（同步读取缓存值，解析由 resolveEffectiveMode 完成） */
export function getEmbeddingMode(): EmbeddingMode {
  return effectiveMode;
}

/** 获取本地降级原因（未降级返回 null） */
export function getLocalFallbackReason(): string | null {
  return localFallbackReason;
}

/** 获取当前生效模式所使用的嵌入模型名 */
export function getActiveModelName(): string {
  const embeddingConfig = getRuntimeConfig().embedding;
  return effectiveMode === 'cloud'
    ? resolveCloudModel(embeddingConfig.cloud)
    : embeddingConfig.ollama.model;
}

/**
 * 获取当前生效的 Chroma 集合名称（按嵌入模型指纹隔离）
 *
 * 同一模型（如本地 bge-m3 与云端 BAAI/bge-m3）→ 同一集合，切换无需重建；
 * 不同模型 → 不同集合，避免向量空间不兼容导致的检索静默劣化。
 */
export function getActiveCollectionName(): string {
  return `${COLLECTION_NAME_PREFIX}_${collectionFingerprint(getActiveModelName())}`;
}

// ==================== 嵌入模型实例（懒加载单例） ====================

/** 嵌入模型实例（首次使用时按当前运行时配置 + 生效模式构建） */
let embeddingsInstance: Embeddings | null = null;

/**
 * 获取当前嵌入模型实例（懒加载单例）
 *
 * 首次调用时按 runtime-config 中的嵌入配置 + 当前生效模式构建；
 * 配置变更（保存设置 / 切换总开关）后通过 applyEmbeddingConfigChange() 失效重建。
 */
export function getEmbeddings(): Embeddings {
  if (!embeddingsInstance) {
    const embeddingConfig = getRuntimeConfig().embedding;
    embeddingsInstance = buildEmbeddings(embeddingConfig, effectiveMode);
    logger.info('嵌入模型实例已创建', {
      module: 'VectorStore',
      mode: effectiveMode,
      description: describeEmbeddingConfig(embeddingConfig, effectiveMode),
    });
  }
  return embeddingsInstance;
}

/**
 * 应用嵌入配置变更：失效嵌入单例 + 清除探测缓存 + 重置向量存储
 *
 * 保存嵌入设置或切换本地总开关后调用，
 * 下次 initializeVectorStore() 时会重新解析生效模式、构建嵌入实例并连接对应集合。
 */
export function applyEmbeddingConfigChange(): void {
  embeddingsInstance = null;
  clearOllamaProbeCache();
  localFallbackReason = null;
  // 总开关关闭时立刻按云端语义生效，避免重置到下次初始化之间误用本地模型算集合名
  if (!getRuntimeConfig().embedding.localEnabled) {
    effectiveMode = 'cloud';
  }
  resetVectorStore();
  logger.info('嵌入配置已变更，嵌入实例与向量存储已重置', {
    module: 'VectorStore',
    localEnabled: getRuntimeConfig().embedding.localEnabled,
    mode: effectiveMode,
    collection: getActiveCollectionName(),
  });
}

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

/**
 * 初始化代际标记：每次重置时递增。
 * 用于让"进行中"的初始化在完成后识别自己已被重置（如中途切换了嵌入模式），
 * 从而丢弃旧配置下的初始化结果，防止旧集合的 store 污染单例。
 */
let initGeneration = 0;

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
  // 递增代际标记：让进行中的初始化完成后识别已被重置，丢弃旧结果
  initGeneration++;
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

  initPromise = doInitialize(initGeneration);

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
 *
 * @param generation 启动时的初始化代际，完成赋值前校验是否已被重置
 */
async function doInitialize(generation: number): Promise<Chroma> {
  // 先解析生效模式（总开关 + 本地探测）：集合名与嵌入实例都依赖 effectiveMode，
  // 必须在读取它们之前完成解析，否则会用初值（可能与本地实际可用性矛盾）连错集合
  await resolveEffectiveMode();
  const collectionName = getActiveCollectionName();
  logger.info('初始化向量数据库', {
    module: 'VectorStore',
    mode: getEmbeddingMode(),
    fallbackReason: getLocalFallbackReason(),
    collection: collectionName,
  });

  if (!fs.existsSync(PERSIST_DIR)) {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    logger.info('创建 ChromaDB 数据目录', { module: 'VectorStore', path: PERSIST_DIR });
  }

  let store: Chroma;
  let memoryMode = false;

  // 先构建嵌入实例：失败（如云端缺少 API Key）必须直接抛出，
  // 不能被下面的降级逻辑掩盖——否则数据会被静默写入不持久化的内存存储
  const embeddings = getEmbeddings();

  try {
    const client = new ChromaClient({ host: config.chromaHost, port: config.chromaPort });

    let collectionExists = false;
    try {
      await client.getCollection({ name: collectionName });
      collectionExists = true;
      logger.info('发现已有知识库集合', { module: 'VectorStore', collection: collectionName });
    } catch {
      collectionExists = false;
      logger.info('知识库集合不存在，将创建新集合', { module: 'VectorStore', collection: collectionName });
    }

    if (collectionExists) {
      store = await Chroma.fromExistingCollection(embeddings, {
        collectionName,
        url: config.chromaUrl,
      });
      const coll = await client.getCollection({ name: collectionName });
      logger.info('当前集合空间', { module: 'VectorStore', space: coll.metadata?.['hnsw:space'] || 'l2(默认)' });
    } else {
      await client.createCollection({
        name: collectionName,
        metadata: { "hnsw:space": "cosine" },
        embeddingFunction: embeddings as any,
      });
      logger.info('新知识库集合已创建', { module: 'VectorStore', collection: collectionName });
      store = await Chroma.fromExistingCollection(embeddings, {
        collectionName,
        url: config.chromaUrl,
      });
    }
  } catch (error: any) {
    logger.error('ChromaDB 连接失败，降级为内存存储', { module: 'VectorStore', error: error.message });
    store = await createMemoryVectorStore();
    memoryMode = true;
  }

  // 防竞态：初始化进行中若发生过重置（如用户中途切换嵌入模式），
  // 本次结果是按旧配置/旧集合构建的，写入单例会导致后续读写命中错误集合。
  // 丢弃本次结果，用最新配置重新初始化。
  if (generation !== initGeneration) {
    logger.warn('向量存储初始化已被配置变更取代，丢弃本次结果并按最新配置重新初始化', {
      module: 'VectorStore',
      staleCollection: collectionName,
    });
    return initializeVectorStore();
  }

  vectorStore = store;
  isMemoryStore = memoryMode;
  logger.info('向量数据库初始化完成', { module: 'VectorStore', collection: collectionName, memoryMode });
  return vectorStore;
}

/**
 * 创建内存向量存储（降级方案）
 * 当 ChromaDB 不可用时使用，数据不会持久化。
 * 注意：只构建并返回包装对象，不写入模块级单例（赋值统一由 doInitialize 出口完成）
 */
async function createMemoryVectorStore(): Promise<Chroma> {
  logger.warn('使用内存向量存储（数据不会持久化）', { module: 'VectorStore' });

  const { MemoryVectorStore } = await import('@langchain/classic/vectorstores/memory');
  const memoryStore = new MemoryVectorStore(getEmbeddings());

  // 将 MemoryVectorStore 包装为兼容 Chroma 接口的对象
  return {
    addDocuments: memoryStore.addDocuments.bind(memoryStore),
    similaritySearchWithScore: memoryStore.similaritySearchWithScore.bind(memoryStore),
    delete: async () => { logger.warn('内存存储不支持删除操作', { module: 'VectorStore' }); },
    collection: null,
  } as unknown as Chroma;
}
