/**
 * ERB 运行时压测（阶段 0 / S1.4b / 表 3.1 #1 #3 #4 #5）
 *
 * 运行：pnpm --filter jerry-llm-server bench:measure-runtime
 * 或：  node --import ./scripts/ts-loader.mjs --experimental-transform-types scripts/bench/measure-runtime.ts
 *
 * 测 4 个数（补齐 measure-expansion.ts 未覆盖的运行时指标）：
 *   #1 嵌入 QPS      —— 云端硅基流动 bge-m3 批量嵌入吞吐，外推总耗时
 *   #3 BM25 内存/体积 —— MiniSearch 在 10万/50万/100万 chunk 下常驻内存 + 序列化 json 体积
 *   #4 Chroma 写入   —— 直连 :8000 独立集合，批量 upsert 写速率 + 纯向量磁盘估算
 *   #5 query 延迟    —— 英文 query 走「嵌入 + Chroma 向量检索」的端到端延迟（仅 smoke）
 *
 * 🔴 解耦原则（与 measure-expansion.ts 一致，不碰主链路重型依赖）：
 *   - 不 import config.ts / runtime-config.ts / crypto.ts / store-state.ts / bm25-index.ts
 *     （它们会触发 zod fail-fast 或拉入 logger→config 耦合链）
 *   - 云端嵌入 key：直接读 runtime-config.json 的 apiKeyEncrypted + .env 的 ENCRYPTION_KEY，
 *     内联复刻 AES-256-GCM 解密（与 crypto.ts 同算法，密钥不落明文、不硬编码）
 *   - 嵌入：@langchain/openai OpenAIEmbeddings 直连，参数镜像 embedding-provider.ts 云端分支
 *   - Chroma：chromadb ChromaClient 直连，参数镜像 store-state.ts（host/port + cosine）
 *   - BM25：minisearch 直接复刻 bm25-index.ts#createBM25Index 的配置
 *
 * CLI：
 *   --only LIST        只跑指定项，逗号分隔：embed,bm25,chroma,query（缺省全跑）
 *   --per-type N       每个 source_type 抽样篇数（默认 15 → 分层 135 篇构建语料）
 *   --type NAME        只抽单一 source_type（缺省则分层全 9 类）
 *   --seed N           抽样种子（默认 42）
 *   --bm25-checkpoints BM25 堆量检查点，逗号分隔（默认 100000,500000）
 *   --bm25-compare     S1.5：BM25「写/不写 parent_content」两轮对照，输出膨胀倍数
 *   --chroma-host H    Chroma 主机（默认 localhost）
 *   --chroma-port P    Chroma 端口（默认 8000，与 .env CHROMA_URL / jerry-chroma-dev 容器一致）
 *   --collection NAME  Chroma 集合名（默认 erb_bench_measure，独立于生产集合，deleteCollection 只删此集合）
 *   --query-n N        query 延迟 smoke 的问题数（默认 5）
 *   --total-vectors N  外推用的总向量数（默认 10660000，来自 S1.4a 实测）
 *   --ollama           额外测本地 Ollama bge-m3 嵌入 QPS（默认关闭；直连 /api/embed）
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createDecipheriv } from 'crypto';
import { OpenAIEmbeddings } from '@langchain/openai';
import { ChromaClient } from 'chromadb';
import MiniSearch from 'minisearch';

import {
  ERB_SOURCE_TYPES,
  loadQuestions,
  readDocContent,
  sampleSingleType,
  stratifiedSample,
  type ErbDoc,
  type ErbSourceType,
} from './lib/erb-loader.js';
import {
  getAdaptiveChunkingProfile,
  parentChildSplit,
} from '../../src/fundamentals/vector-store/text-splitter.js';
import {
  buildChildChunkMeta,
  makeParentId,
  type ErbChunkMetadata,
} from './lib/erb-metadata.js';

// ==================== CLI 解析 ====================

type MeasureKey = 'embed' | 'bm25' | 'chroma' | 'query';
const ALL_KEYS: MeasureKey[] = ['embed', 'bm25', 'chroma', 'query'];

interface CliOptions {
  only: MeasureKey[];
  perType: number;
  type?: ErbSourceType;
  seed: number;
  bm25Checkpoints: number[];
  bm25Compare: boolean;
  chromaHost: string;
  chromaPort: number;
  collection: string;
  queryN: number;
  totalVectors: number;
  ollama: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    only: [...ALL_KEYS],
    perType: 15,
    seed: 42,
    bm25Checkpoints: [100_000, 500_000],
    bm25Compare: false,
    chromaHost: 'localhost',
    chromaPort: 8000,
    collection: 'erb_bench_measure',
    queryN: 5,
    totalVectors: 10_660_000,
    ollama: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') {
      const list = String(argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as MeasureKey[];
      const bad = list.filter((k) => !ALL_KEYS.includes(k));
      if (bad.length) throw new Error(`--only 非法项：${bad.join(',')}（可选 ${ALL_KEYS.join(',')}）`);
      if (list.length) opts.only = list;
    } else if (a === '--per-type') opts.perType = Number(argv[++i]) || 15;
    else if (a === '--type') {
      const t = argv[++i] as ErbSourceType;
      if (!ERB_SOURCE_TYPES.includes(t)) {
        throw new Error(`--type 非法：${t}，可选 ${ERB_SOURCE_TYPES.join('/')}`);
      }
      opts.type = t;
    } else if (a === '--seed') opts.seed = Number(argv[++i]) ?? 42;
    else if (a === '--bm25-checkpoints') {
      opts.bm25Checkpoints = String(argv[++i] ?? '')
        .split(/[,\s]+/) // 兼容逗号或空白分隔（Windows/pnpm 透传可能把逗号转成空格）
        .map((s) => Number(s.trim()))
        .filter((n) => n > 0)
        .sort((x, y) => x - y);
    } else if (a === '--chroma-host') opts.chromaHost = String(argv[++i]);
    else if (a === '--chroma-port') opts.chromaPort = Number(argv[++i]) || 8000;
    else if (a === '--collection') opts.collection = String(argv[++i]);
    else if (a === '--query-n') opts.queryN = Number(argv[++i]) || 5;
    else if (a === '--total-vectors') opts.totalVectors = Number(argv[++i]) || 10_660_000;
    else if (a === '--bm25-compare') opts.bm25Compare = true;
    else if (a === '--ollama') opts.ollama = true;
  }
  return opts;
}

// ==================== 工具 ====================

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 从 process.env 或 .env 文件读取一个键（.env 简单行解析，不引入 dotenv） */
function readEnvKey(key: string): string | undefined {
  const fromProc = process.env[key];
  if (fromProc) return fromProc;
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

// ==================== 云端嵌入 key 解析（内联复刻 crypto.ts） ====================

/** AES-256-GCM 解密，密文格式 `iv:authTag:ciphertext`（hex），与 crypto.ts#decrypt 同算法 */
function aesGcmDecrypt(ciphertext: string, keyHex: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('密文格式错误（应为 iv:authTag:ciphertext）');
  const [ivHex, tagHex, dataHex] = parts;
  const key = Buffer.from(keyHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

interface CloudEmbedCfg {
  baseUrl: string;
  model: string;
  apiKey: string;
  batchSize: number;
}

/**
 * 解析云端嵌入生效配置：读 runtime-config.json 的 embedding.cloud，
 * 空字段回退硅基流动预设（镜像 embedding-provider.ts#resolveCloudConfig）。
 */
function resolveCloudEmbed(): CloudEmbedCfg {
  const rcPath = join(process.cwd(), 'runtime-config.json');
  if (!existsSync(rcPath)) {
    throw new Error('runtime-config.json 不存在，无法取得云端嵌入配置');
  }
  const rc = JSON.parse(readFileSync(rcPath, 'utf-8')) as {
    embedding?: { cloud?: { provider?: string; baseUrl?: string; model?: string; apiKeyEncrypted?: string } };
  };
  const cloud = rc?.embedding?.cloud;
  if (!cloud?.apiKeyEncrypted) {
    throw new Error('runtime-config.json 缺少 embedding.cloud.apiKeyEncrypted');
  }
  const keyHex = readEnvKey('ENCRYPTION_KEY');
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY 缺失或长度非 64（应在 .env 中，hex 编码 32 字节）');
  }
  const apiKey = aesGcmDecrypt(cloud.apiKeyEncrypted, keyHex);
  if (!apiKey) throw new Error('解密得到空 apiKey（ENCRYPTION_KEY 可能与写入时不一致）');

  const provider = cloud.provider ?? 'siliconflow';
  const preset =
    provider === 'siliconflow'
      ? { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', batchSize: 32 }
      : { baseUrl: '', model: '', batchSize: 10 };

  const baseUrl = (cloud.baseUrl ?? '').trim() || preset.baseUrl;
  const model = (cloud.model ?? '').trim() || preset.model;
  if (!baseUrl) throw new Error('云端嵌入未配置 baseUrl');
  if (!model) throw new Error('云端嵌入未配置 model');
  return { baseUrl, model, apiKey, batchSize: preset.batchSize };
}

/** 构建 OpenAIEmbeddings（镜像 embedding-provider.ts 云端分支参数） */
function buildCloudEmbeddings(cfg: CloudEmbedCfg): OpenAIEmbeddings {
  return new OpenAIEmbeddings({
    model: cfg.model,
    apiKey: cfg.apiKey,
    configuration: { baseURL: cfg.baseUrl },
    timeout: 30000,
    maxRetries: 3,
    batchSize: cfg.batchSize,
  });
}

// ==================== 语料构建（镜像生产切分） ====================

interface BenchChunk {
  id: string;
  text: string;
  metadata: ErbChunkMetadata;
  documentId: string;
  /** 所属父块全文，仅 S1.5 BM25 parent_content 对照用（metadata.parent_content 已含同值） */
  parentText: string;
}

/** 对抽样文档跑生产同款切分链路，产出 child chunk 语料（父块不入库） */
async function buildCorpus(docs: ErbDoc[]): Promise<BenchChunk[]> {
  const out: BenchChunk[] = [];
  for (const doc of docs) {
    const text = readDocContent(doc);
    if (!text.trim()) continue;
    const profile = getAdaptiveChunkingProfile({ fileType: '.txt', content: text });
    const parents = await parentChildSplit(text, { ...profile, fileType: '.txt' });
    let childIdx = 0;
    for (let pIdx = 0; pIdx < parents.length; pIdx++) {
      const parentId = makeParentId(doc.documentId, pIdx);
      const parentText = parents[pIdx].parent.text;
      for (const ch of parents[pIdx].children) {
        out.push({
          id: `${doc.documentId}__c${childIdx}`,
          text: ch.text,
          metadata: buildChildChunkMeta(doc, ch.text, childIdx, parentId, parentText),
          documentId: doc.documentId,
          parentText,
        });
        childIdx++;
      }
    }
  }
  return out;
}

// ==================== #1 嵌入 QPS ====================

interface EmbedResult {
  vectors: number[][];
  dim: number;
  count: number;
  seconds: number;
  qps: number;
}

async function measureEmbedCloud(corpus: BenchChunk[], cfg: CloudEmbedCfg): Promise<EmbedResult> {
  const emb = buildCloudEmbeddings(cfg);
  const texts = corpus.map((c) => c.text);
  const t0 = performance.now();
  const vectors = await emb.embedDocuments(texts); // 内部按 batchSize=32 分批
  const seconds = (performance.now() - t0) / 1000;
  return {
    vectors,
    dim: vectors[0]?.length ?? 0,
    count: texts.length,
    seconds,
    qps: texts.length / seconds,
  };
}

/** 可选：本地 Ollama bge-m3 嵌入 QPS（直连 /api/embed，不引入新依赖） */
async function measureEmbedOllama(corpus: BenchChunk[]): Promise<EmbedResult | null> {
  const baseUrl = (readEnvKey('OLLAMA_BASE_URL') ?? 'http://localhost:11434').replace(/\/$/, '');
  const rcPath = join(process.cwd(), 'runtime-config.json');
  let model = 'bge-m3';
  if (existsSync(rcPath)) {
    const rc = JSON.parse(readFileSync(rcPath, 'utf-8')) as {
      embedding?: { ollama?: { model?: string } };
    };
    model = rc?.embedding?.ollama?.model || model;
  }
  const texts = corpus.map((c) => c.text);
  const BATCH = 32;
  const vectors: number[][] = [];
  const t0 = performance.now();
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const resp = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts.slice(i, i + BATCH) }),
      });
      if (!resp.ok) throw new Error(`Ollama ${resp.status} ${resp.statusText}`);
      const data = (await resp.json()) as { embeddings: number[][] };
      vectors.push(...data.embeddings);
    }
  } catch (e) {
    console.log(`  ⚠️  Ollama 不可用，跳过本地对照：${(e as Error).message}`);
    return null;
  }
  const seconds = (performance.now() - t0) / 1000;
  return { vectors, dim: vectors[0]?.length ?? 0, count: texts.length, seconds, qps: texts.length / seconds };
}

// ==================== #4 Chroma 写入 ====================

interface ChromaResult {
  count: number;
  seconds: number;
  writesPerSec: number;
  dim: number;
  pureVectorBytes: number;
}

async function measureChroma(
  corpus: BenchChunk[],
  vectors: number[][],
  opts: CliOptions,
): Promise<ChromaResult> {
  const client = new ChromaClient({ host: opts.chromaHost, port: opts.chromaPort });
  // 独立集合，先删后建，绝不碰生产集合
  try {
    await client.deleteCollection({ name: opts.collection });
  } catch {
    /* 不存在则忽略 */
  }
  const coll = await client.getOrCreateCollection({
    name: opts.collection,
    metadata: { 'hnsw:space': 'cosine' },
    embeddingFunction: null, // 全程传预计算向量，不用集合内嵌 EF
  });

  const ids = corpus.map((c) => c.id);
  const documents = corpus.map((c) => c.text);
  const metadatas = corpus.map((c) => c.metadata as unknown as Record<string, string | number | boolean>);

  const BATCH = 500;
  const t0 = performance.now();
  for (let i = 0; i < ids.length; i += BATCH) {
    await coll.upsert({
      ids: ids.slice(i, i + BATCH),
      embeddings: vectors.slice(i, i + BATCH),
      documents: documents.slice(i, i + BATCH),
      metadatas: metadatas.slice(i, i + BATCH),
    });
  }
  const seconds = (performance.now() - t0) / 1000;
  const count = await coll.count();
  const dim = vectors[0]?.length ?? 1024;
  return {
    count,
    seconds,
    writesPerSec: count / seconds,
    dim,
    pureVectorBytes: count * dim * 4, // float32
  };
}

// ==================== #3 BM25 内存 + json 体积 ====================

interface Bm25Point {
  count: number;
  heapUsedMB: number;
  rssMB: number;
  jsonBytes: number;
}

/**
 * 增量堆量至各检查点，快照常驻内存与序列化体积。
 * 语料不够时循环复用真实 child 文本（不同 id）——内存/体积只取决于条数与文本大小，
 * 复用不影响量级结论。配置复刻 bm25-index.ts#createBM25Index。
 *
 * @param injectParentContent true 时保留 metadata 里的 `parent_content`（父块全文，生产写法），
 *        false 时剥掉该字段，用于 S1.5 写/不写对照（metadata 默认已含该字段）。
 */
function measureBM25(
  corpus: BenchChunk[],
  checkpoints: number[],
  injectParentContent = false,
): Bm25Point[] {
  const ms = new MiniSearch<{ id: string; content: string; metadata: Record<string, unknown> }>({
    fields: ['content'],
    storeFields: ['content', 'metadata'],
    searchOptions: { boost: { content: 1 }, fuzzy: 0.2, prefix: true },
  });
  const results: Bm25Point[] = [];
  let added = 0;
  let cursor = 0;
  for (const target of checkpoints) {
    while (added < target) {
      const src = corpus[cursor % corpus.length];
      cursor++;
      let metadata = src.metadata as unknown as Record<string, unknown>;
      if (!injectParentContent) {
        const { parent_content: _omit, ...rest } = metadata;
        metadata = rest;
      }
      ms.add({ id: `bm25_${added}`, content: src.text, metadata });
      added++;
    }
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const mem = process.memoryUsage();
    let jsonBytes = 0;
    try {
      jsonBytes = Buffer.byteLength(JSON.stringify(ms.toJSON()), 'utf-8');
    } catch (e) {
      console.log(`  ⚠️  ${fmt(target)} chunk 序列化失败（可能内存不足）：${(e as Error).message}`);
    }
    results.push({
      count: added,
      heapUsedMB: mem.heapUsed / 1024 / 1024,
      rssMB: mem.rss / 1024 / 1024,
      jsonBytes,
    });
    console.log(
      `  · ${fmt(added)} chunk → heapUsed ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB, ` +
        `rss ${(mem.rss / 1024 / 1024).toFixed(0)} MB, json ${mb(jsonBytes)}`,
    );
  }
  return results;
}

/**
 * S1.5：BM25「写 / 不写 parent_content」对照压测。
 * 两轮独立跑（第一轮结束后显式 gc 释放，避免内存叠加污染第二轮读数），
 * 逐检查点输出 heapUsed / rss / json 的膨胀倍数，验证方案 3.2「砍约 2/3」是否成立。
 */
function measureBM25Compare(corpus: BenchChunk[], checkpoints: number[]): void {
  console.log('  [A] 剥掉 parent_content（旧 bench 口径，已废弃）：');
  const without = measureBM25(corpus, checkpoints, false);
  // 释放上一轮 MiniSearch，尽量让第二轮从干净基线开始
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
  console.log('  [B] 保留 parent_content（现行 bench = 生产口径）：');
  const withPc = measureBM25(corpus, checkpoints, true);

  console.log('  —— 对照（B/A 膨胀倍数）——');
  for (let i = 0; i < without.length; i++) {
    const a = without[i];
    const b = withPc[i];
    if (!a || !b) continue;
    const ratio = (x: number, y: number) => (x > 0 ? (y / x).toFixed(2) + '×' : 'N/A');
    console.log(
      `  · ${fmt(a.count)} chunk：heapUsed ${a.heapUsedMB.toFixed(0)}→${b.heapUsedMB.toFixed(0)}MB (${ratio(a.heapUsedMB, b.heapUsedMB)}), ` +
        `rss ${a.rssMB.toFixed(0)}→${b.rssMB.toFixed(0)}MB (${ratio(a.rssMB, b.rssMB)}), ` +
        `json ${mb(a.jsonBytes)}→${mb(b.jsonBytes)} (${ratio(a.jsonBytes, b.jsonBytes)})`,
    );
  }
  console.log('  · 判据：json 体积膨胀越接近 3× 越印证「不写 parent_content 砍约 2/3」');
}

// ==================== #5 英文 query 延迟 smoke ====================

interface QueryPoint {
  qid: string;
  embedMs: number;
  searchMs: number;
  totalMs: number;
  hits: number;
  goldInLib: boolean;
}

async function measureQuery(
  corpus: BenchChunk[],
  cfg: CloudEmbedCfg,
  opts: CliOptions,
): Promise<QueryPoint[]> {
  const questions = loadQuestions();
  const picks = questions.slice(0, opts.queryN);
  const sampledDocIds = new Set(corpus.map((c) => c.documentId));
  const emb = buildCloudEmbeddings(cfg);
  const client = new ChromaClient({ host: opts.chromaHost, port: opts.chromaPort });
  const coll = await client.getOrCreateCollection({
    name: opts.collection,
    metadata: { 'hnsw:space': 'cosine' },
    embeddingFunction: null,
  });

  const points: QueryPoint[] = [];
  for (const q of picks) {
    const t0 = performance.now();
    const qv = await emb.embedQuery(q.question);
    const t1 = performance.now();
    const res = await coll.query({
      queryEmbeddings: [qv],
      nResults: 10,
      include: ['distances'],
    });
    const t2 = performance.now();
    points.push({
      qid: q.question_id,
      embedMs: t1 - t0,
      searchMs: t2 - t1,
      totalMs: t2 - t0,
      hits: res.ids[0]?.length ?? 0,
      goldInLib: q.expected_doc_ids.some((id) => sampledDocIds.has(id)),
    });
  }
  return points;
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const only = new Set(opts.only);
  const needEmbed = only.has('embed') || only.has('chroma') || only.has('query');

  console.log('=== ERB 运行时压测（S1.4b / 表 3.1 #1 #3 #4 #5）===');
  console.log(`项目：${[...only].join(', ')}  抽样：${opts.type ? `单类 ${opts.type}` : '分层全 9 类'} 每类 ${opts.perType} 篇 seed=${opts.seed}`);

  // 1) 抽样 + 构建语料
  const docs: ErbDoc[] = opts.type
    ? sampleSingleType(opts.type, opts.perType, opts.seed)
    : [...stratifiedSample(opts.perType, opts.seed).values()].flat();
  console.log(`\n[corpus] 抽样 ${docs.length} 篇，切分中…`);
  const corpus = await buildCorpus(docs);
  console.log(`[corpus] 产出 ${fmt(corpus.length)} 个 child chunk（向量）`);
  if (corpus.length === 0) throw new Error('语料为空，无法压测');

  // 容错原则：四项测量彼此独立，单项失败（尤其网络项）只打印 ⚠️，绝不阻断其余。
  // BM25 是 R1 最关键、纯本地，务必跑完；embed 失败则 chroma/query 因缺向量/配置优雅跳过。
  const failures: string[] = [];

  // 2) #1 嵌入 QPS（网络项）
  let embed: EmbedResult | null = null;
  let cfg: CloudEmbedCfg | null = null;
  if (needEmbed) {
    try {
      cfg = resolveCloudEmbed();
      console.log(`\n[#1 嵌入 QPS] 云端 ${cfg.model} @ ${cfg.baseUrl}（batchSize=${cfg.batchSize}）`);
      embed = await measureEmbedCloud(corpus, cfg);
      console.log(`  · ${fmt(embed.count)} chunk / ${embed.seconds.toFixed(1)}s = ${fmt(embed.qps)} chunk/s，维度 ${embed.dim}`);
      const totalSec = opts.totalVectors / embed.qps;
      console.log(
        `  · 外推 ${fmt(opts.totalVectors)} 向量 ≈ ${(totalSec / 3600).toFixed(1)} 小时（单并发；不含限流退避）`,
      );
      if (opts.ollama) {
        const ol = await measureEmbedOllama(corpus);
        if (ol) console.log(`  · [本地对照] Ollama bge-m3：${fmt(ol.qps)} chunk/s（维度 ${ol.dim}）`);
      }
    } catch (e) {
      cfg = null;
      failures.push(`#1 嵌入：${(e as Error).message}`);
      console.log(`  ⚠️  #1 嵌入 QPS 失败（chroma/query 将跳过）：${(e as Error).message}`);
    }
  }

  // 3) #4 Chroma 写入（网络项，依赖 embed 向量）
  if (only.has('chroma')) {
    console.log(`\n[#4 Chroma 写入] ${opts.chromaHost}:${opts.chromaPort} 集合 ${opts.collection}`);
    if (!embed) {
      failures.push('#4 Chroma：缺嵌入向量（#1 未成功）');
      console.log('  ⚠️  跳过：需要 #1 嵌入产出的向量');
    } else {
      try {
        const ch = await measureChroma(corpus, embed.vectors, opts);
        console.log(
          `  · 写入 ${fmt(ch.count)} 向量 / ${ch.seconds.toFixed(1)}s = ${fmt(ch.writesPerSec)} 向量/s（batch=500）`,
        );
        console.log(`  · 纯向量磁盘估算：${mb(ch.pureVectorBytes)}（dim=${ch.dim}×4B），HNSW 索引实际约 1.5–2×`);
        console.log(
          `  · 外推 ${fmt(opts.totalVectors)} 向量纯磁盘 ≈ ${(opts.totalVectors * ch.dim * 4 / 1e9).toFixed(1)} GB`,
        );
        console.log(`  · 真实磁盘请查容器卷：docker system df -v 或 du -sh <chroma-volume>`);
      } catch (e) {
        failures.push(`#4 Chroma：${(e as Error).message}`);
        console.log(`  ⚠️  #4 Chroma 写入失败：${(e as Error).message}`);
      }
    }
  }

  // 4) #3 BM25 内存 + json 体积（纯本地，R1 关键，务必跑完）
  if (only.has('bm25')) {
    const mode = opts.bm25Compare ? '写/不写 parent_content 对照（S1.5）' : '不含 parent_content';
    console.log(`\n[#3 BM25 内存/体积] 检查点 ${opts.bm25Checkpoints.map(fmt).join(' / ')}（复刻 createBM25Index，${mode}）`);
    try {
      if (opts.bm25Compare) {
        measureBM25Compare(corpus, opts.bm25Checkpoints);
      } else {
        measureBM25(corpus, opts.bm25Checkpoints);
        console.log('  · 注：写/不写 parent_content 的对照见 S1.5（加 --bm25-compare）');
      }
    } catch (e) {
      failures.push(`#3 BM25：${(e as Error).message}`);
      console.log(`  ⚠️  #3 BM25 失败：${(e as Error).message}`);
    }
  }

  // 5) #5 query 延迟 smoke（网络项，依赖 embed 配置）
  if (only.has('query')) {
    console.log(`\n[#5 query 延迟 smoke] 前 ${opts.queryN} 题（英文），嵌入 + Chroma 向量检索`);
    if (!cfg) {
      failures.push('#5 query：缺云端嵌入配置（#1 未成功）');
      console.log('  ⚠️  跳过：需要 #1 的云端嵌入配置');
    } else {
      try {
        const pts = await measureQuery(corpus, cfg, opts);
        for (const p of pts) {
          console.log(
            `  · ${p.qid}：嵌入 ${p.embedMs.toFixed(0)}ms + 检索 ${p.searchMs.toFixed(0)}ms = ${p.totalMs.toFixed(0)}ms（命中 ${p.hits}${p.goldInLib ? '，gold 在库' : '，gold 不在子集'}）`,
          );
        }
        const totals = pts.map((p) => p.totalMs).sort((a, b) => a - b);
        const avg = totals.reduce((s, x) => s + x, 0) / (totals.length || 1);
        const p50 = totals[Math.floor(totals.length / 2)] ?? 0;
        console.log(`  · 端到端延迟 avg ${avg.toFixed(0)}ms / p50 ${p50.toFixed(0)}ms（仅 smoke，不判召回）`);
      } catch (e) {
        failures.push(`#5 query：${(e as Error).message}`);
        console.log(`  ⚠️  #5 query 延迟失败：${(e as Error).message}`);
      }
    }
  }

  console.log('\n=== S1.4b 压测完成 ===');
  if (failures.length) {
    console.log(`⚠️  ${failures.length} 项未取到实测值：`);
    for (const f of failures) console.log(`   - ${f}`);
  }
}

main().catch((err) => {
  console.error('压测失败：', err);
  process.exitCode = 1;
});
