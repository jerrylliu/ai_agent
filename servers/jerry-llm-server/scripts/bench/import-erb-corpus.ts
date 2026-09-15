/**
 * EnterpriseRAG-Bench (ERB) 语料批量入库脚本（benchmark-only，方案 §4.1 / §4.3）
 *
 * 自建入库流程（刻意不复用生产 addDocuments，见方案 §4.3 设计决策表）：
 *   parentChildSplit 切分
 *   → 自建信号量分批 embedDocuments（云端，D7：并发 8 / 批量 32 / 429 指数退避）
 *   → collection.add 写 ChromaDB
 *   → addToBM25Index(..., skipSave=true) 增量追加
 *   → 全部完成后一次 saveBM25Index()
 *
 * 🔴 引擎无关（方案 §3.7 / 红线 #12）：
 *   BM25 只经门面 bm25-index.ts 交互，禁止 import 任何具体引擎实现，
 *   禁止假设落盘格式 —— T2 档切换引擎时本脚本零改动。
 *
 * 🔴 完成判据（方案 S2.3）：
 *   全程未调用生产入库 addDocuments / 整索引重建 rebuildBM25Index；
 *   本文件对具体引擎包名零引用。
 *
 * 🔴 生产隔离守卫（方案 §4.6 D5=方案 A / 红线 #3）：
 *   启动时校验 CHROMA_PERSIST_DIR 已显式覆盖、CHROMA_URL 未指向生产默认
 *   http://localhost:8000，否则 fail-fast 拒绝运行。
 *
 * 🔴 断点续传 + 磁盘熔断（方案 §4.3 / §3.8.5 ⑥ / S2.4）：
 *   - 每 5000 篇一个 checkpoint：saveBM25Index() 与 progress.json 游标锁步推进，
 *     保证游标永不超前于 BM25 已落盘态（否则续传后末尾索引残缺）；
 *   - --resume 从 progress.json 恢复：跳过已消费文档、恢复统计与嵌入预算，
 *     首批做存在性探测修复（Chroma 已有 → 免嵌入只补 BM25，无重复 chunk）；
 *   - 磁盘熔断：启动健康门 + 每批落盘后检查，主熔断盘/健康门盘剩余空间低于
 *     阈值（默认 8GB，--min-free-gb 可覆盖）→ 停写 → 落 BM25 → 写 checkpoint
 *     → logger.error → 非 0 退出（不得静默继续）。
 *
 * 🔴 引擎硬约束（用户指令）：ERB 评测必须 BM25_ENGINE=tantivy，启动即校验；
 *   生产环境保持默认 minisearch，两者互不影响（红线 #10/#11）。
 *
 * 其他与生产链路的刻意差异（方案 §4.3）：
 *   - 不写 parent_content：ERB 评测按 documentId 比对、不做父块展开，
 *     去掉后 BM25 内存与 ChromaDB 磁盘同时砍约 2/3；
 *   - 跳过内容 SHA 去重查询：抽样文档天然无重复，省去每 chunk 一次向量库往返；
 *   - 嵌入调用熔断：MAX_EMBED_CALLS（默认 8600）防止误操作烧穿云端免费额度（D7）。
 *
 * 用法示例：
 *   # T0 档冒烟：只导 722 篇 gold（gold-first 抽样属 S2.6，此处先小批量验证管线）
 *   pnpm bench:import -- --limit 50
 *   # 单一 source_type
 *   pnpm bench:import -- --source-type slack --limit 200
 *   # 干跑（只切分统计，不嵌入不写库）
 *   pnpm bench:import -- --dry-run --limit 100
 *   # 中断后续传（参数必须与上次运行一致）
 *   pnpm bench:import -- --resume
 *
 * 运行前提（红线 #3）：
 *   CHROMA_URL=http://localhost:8001
 *   CHROMA_PERSIST_DIR=E:\ragbench\bm25
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量，模式与 scripts/eval/* 一致）
import 'dotenv/config';
import * as path from 'path';
import { config } from '../../src/fundamentals/config.js';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { getRuntimeConfig } from '../../src/fundamentals/runtime-config.js';
import {
  buildEmbeddings,
  EMBEDDING_PROVIDER_PRESETS,
} from '../../src/fundamentals/vector-store/embedding-provider.js';
import { initializeVectorStore } from '../../src/fundamentals/vector-store/store-state.js';
import {
  getAdaptiveChunkingProfile,
  parentChildSplit,
} from '../../src/fundamentals/vector-store/text-splitter.js';
// 🔴 引擎无关：只 import BM25 门面函数（内部经 getBM25Engine() 选型），
//    禁止直接 import 任何具体引擎实现模块
import {
  initializeBM25Index,
  addToBM25Index,
  deleteFromBM25Index,
  saveBM25Index,
} from '../../src/fundamentals/vector-store/bm25-index.js';
import type { Embeddings } from '@langchain/core/embeddings';
import {
  walkDocs,
  readDocContent,
  ERB_SOURCE_TYPES,
  type ErbDoc,
  type ErbSourceType,
} from './lib/erb-loader.js';
import { buildChildChunkMeta, makeParentId } from './lib/erb-metadata.js';
import {
  readImportProgress,
  writeImportProgress,
  type ImportProgress,
  type RunFingerprint,
} from './lib/import-progress.js';
import {
  checkDiskWater,
  driveFromPath,
  gbToBytes,
  bytesToGb,
  type DiskWaterConfig,
  type DiskWaterResult,
} from './lib/disk-water.js';

// ==================== 常量与默认值 ====================

const MODULE = 'BenchImport';

/** 默认嵌入并发（D7：云端并发 8；生产 store-state 的 2 是给交互式入库保守的，bench 独占带宽可拉高） */
const DEFAULT_CONCURRENCY = 8;

/** 默认嵌入 HTTP 调用次数熔断上限（D7：T1 档 ≈7,156 次，留 20% 余量取 8,600） */
const DEFAULT_MAX_EMBED_CALLS = 8600;

/** 单文档嵌入失败重试次数（429 瞬时限流兜底；OpenAIEmbeddings 内部已有 maxRetries=3） */
const EMBED_RETRY_MAX = 3;

/** 重试退避基数（毫秒），按 2s / 4s 指数递增 */
const EMBED_RETRY_BASE_MS = 2000;

/** 每处理多少篇文档打印一次进度 */
const PROGRESS_EVERY_DOCS = 100;

/** checkpoint 批大小（方案 §4.3：游标与 BM25 落盘在批边界锁步推进） */
const BATCH_SIZE = 5000;

/** checkpoint 文件名（放 CHROMA_PERSIST_DIR 根下，与 BM25/Chroma 持久化产物同区） */
const PROGRESS_FILENAME = 'progress.json';

/** 磁盘熔断默认阈值 GB（方案 §3.8.5 ⑥：< 8GB 触发） */
const DEFAULT_MIN_FREE_GB = 8;

/** 健康门默认盘符（语料源 D:\ragatest 只读、位于 D 盘；env BENCH_HEALTH_DRIVE 可覆盖） */
const DEFAULT_HEALTH_DRIVE = 'D';

/** 生产 ChromaDB 默认地址（红线 #3：脚本禁止指向它） */
const PROD_CHROMA_URL = 'http://localhost:8000';

// ==================== CLI 参数 ====================

interface CliOptions {
  /** 限定单一 source_type；缺省遍历全部 9 类 */
  sourceType?: ErbSourceType;
  /** 最多导入多少篇文档 */
  limit?: number;
  /** 嵌入并发数（默认 8） */
  concurrency: number;
  /** 嵌入 HTTP 调用熔断上限（默认 8600，env MAX_EMBED_CALLS 可覆盖） */
  maxEmbedCalls: number;
  /** 干跑：只切分统计 chunk 数，不嵌入、不写任何存储 */
  dryRun: boolean;
  /** 断点续传：从 progress.json 恢复游标/统计/嵌入预算（方案 §4.3） */
  resume: boolean;
  /** 磁盘熔断阈值 GB（默认 8，env BENCH_MIN_FREE_GB 可覆盖；验收要求可人为调高触发） */
  minFreeGb: number;
}

function printUsageAndExit(code: number): never {
  console.log(`用法: pnpm bench:import -- [选项]

选项:
  --source-type <type>   限定单一 source_type（可选: ${ERB_SOURCE_TYPES.join(' | ')}）
  --limit <n>            最多导入 n 篇文档
  --concurrency <n>      嵌入并发数（默认 ${DEFAULT_CONCURRENCY}）
  --max-embed-calls <n>  嵌入 HTTP 调用熔断上限（默认 ${DEFAULT_MAX_EMBED_CALLS}）
  --dry-run              只切分统计，不嵌入不写库
  --resume               从 progress.json 断点续传（--source-type/--limit 必须与上次一致）
  --min-free-gb <n>      磁盘熔断阈值 GB（默认 ${DEFAULT_MIN_FREE_GB}，env BENCH_MIN_FREE_GB 可覆盖）
  --help                 显示本帮助`);
  process.exit(code);
}

function parseArgs(): CliOptions {
  const argv = process.argv.slice(2);
  const opts: CliOptions = {
    concurrency: DEFAULT_CONCURRENCY,
    maxEmbedCalls: Number(process.env.MAX_EMBED_CALLS) || DEFAULT_MAX_EMBED_CALLS,
    dryRun: false,
    resume: false,
    minFreeGb: Number(process.env.BENCH_MIN_FREE_GB) || DEFAULT_MIN_FREE_GB,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        printUsageAndExit(0);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--resume':
        opts.resume = true;
        break;
      case '--min-free-gb': {
        const n = Number(argv[++i]);
        if (!Number.isFinite(n) || n <= 0) {
          console.error('--min-free-gb 必须是正数');
          process.exit(1);
        }
        opts.minFreeGb = n;
        break;
      }
      case '--source-type': {
        const value = argv[++i];
        if (!value || !(ERB_SOURCE_TYPES as readonly string[]).includes(value)) {
          console.error(`无效的 --source-type: ${value ?? '(缺失)'}，可选: ${ERB_SOURCE_TYPES.join(' | ')}`);
          process.exit(1);
        }
        opts.sourceType = value as ErbSourceType;
        break;
      }
      case '--limit': {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n <= 0) {
          console.error('--limit 必须是正整数');
          process.exit(1);
        }
        opts.limit = n;
        break;
      }
      case '--concurrency': {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n <= 0 || n > 32) {
          console.error('--concurrency 必须是 1~32 的整数');
          process.exit(1);
        }
        opts.concurrency = n;
        break;
      }
      case '--max-embed-calls': {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n <= 0) {
          console.error('--max-embed-calls 必须是正整数');
          process.exit(1);
        }
        opts.maxEmbedCalls = n;
        break;
      }
      default:
        console.error(`未知参数: ${arg}`);
        printUsageAndExit(1);
    }
  }
  if (opts.resume && opts.dryRun) {
    console.error('--resume 不能与 --dry-run 同用（干跑不产生 checkpoint）');
    process.exit(1);
  }
  return opts;
}

// ==================== 生产隔离守卫（红线 #3） ====================

/**
 * 启动守卫：确认当前 env 指向 benchmark 专用 ChromaDB，而非生产实例。
 *
 * 两个条件缺一不可：
 * 1. CHROMA_PERSIST_DIR 已显式设置（BM25 索引与 Chroma 持久化都会落到该目录，
 *    未设置时会写进生产默认的 chromadb_data，污染生产 BM25 索引）；
 * 2. CHROMA_URL 不是生产默认 http://localhost:8000（bench 实例约定 8001）。
 */
function assertBenchIsolation(): void {
  const problems: string[] = [];

  if (!config.chromaPersistDir) {
    problems.push(
      'CHROMA_PERSIST_DIR 未设置 —— BM25 索引会写入生产默认目录 chromadb_data。' +
        '请设置 benchmark 专用目录，如 CHROMA_PERSIST_DIR=E:\\ragbench\\bm25',
    );
  }

  const chromaUrl = config.chromaUrl.replace(/\/+$/, '');
  if (chromaUrl === PROD_CHROMA_URL) {
    problems.push(
      `CHROMA_URL 仍指向生产实例 ${PROD_CHROMA_URL}。` +
        '请启动 benchmark 专用实例（jerry-chroma-bench）并设置 CHROMA_URL=http://localhost:8001',
    );
  }

  if (problems.length > 0) {
    console.error('🔴 生产隔离守卫拦截（方案红线 #3），拒绝运行：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  logger.info('生产隔离守卫通过', {
    module: MODULE,
    chromaUrl: config.chromaUrl,
    persistDir: config.chromaPersistDir,
  });
}

// ==================== 信号量（脚本自建，不复用生产并发=2 的信号量） ====================

/** 简易计数信号量：控制同时进行的嵌入请求数 */
class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // 唤醒即持有槽位（release 侧已完成 running 的移交）
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // 槽位直接移交给等待者，running 不变
      next();
    } else {
      this.running--;
    }
  }
}

// ==================== 统计与全局停止位 ====================

interface Stats {
  docsImported: number;
  docsSkipped: number;
  docsFailed: number;
  /** 续传修复通道：Chroma 已存在 chunk、免嵌入仅补写 BM25 的文档数 */
  docsRepaired: number;
  chunksAdded: number;
  /** 已消耗的嵌入 HTTP 调用次数（估算：ceil(文本数 / 供应商批量)；续传时跨运行累计） */
  embedCalls: number;
}

/** Ctrl+C / 熔断触发后置位，worker 循环据此优雅收尾 */
let stopRequested = false;
/** 熔断触发原因（用于收尾摘要区分「正常完成」与「被熔断截断」） */
let stopReason: string | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 嵌入（带熔断 + 指数退避重试） ====================

/**
 * 带调用预算的批量嵌入。
 *
 * - 熔断（D7 硬性要求）：预估本次 HTTP 调用数（ceil(n / 供应商批量)），
 *   超预算直接返回 null 并置停止位，防止误操作烧穿云端免费额度；
 * - 429 退避：OpenAIEmbeddings 内部 maxRetries=3 之外，脚本层再兜底重试
 *   （2s / 4s 指数退避），跨过更长的限流窗口；重试仍失败则抛给上层按文档跳过。
 *
 * @returns 向量数组；预算不足返回 null
 */
async function embedWithBudget(
  embeddings: Embeddings,
  texts: string[],
  batchHttpSize: number,
  stats: Stats,
  maxEmbedCalls: number,
): Promise<number[][] | null> {
  const cost = Math.max(1, Math.ceil(texts.length / batchHttpSize));
  if (stats.embedCalls + cost > maxEmbedCalls) {
    stopRequested = true;
    stopReason = `嵌入调用熔断触发：已用 ${stats.embedCalls} 次，本次需 ${cost} 次，上限 ${maxEmbedCalls}`;
    logger.warn('嵌入调用熔断触发，停止导入', { module: MODULE, ...{ reason: stopReason } });
    return null;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const vectors = await embeddings.embedDocuments(texts);
      stats.embedCalls += cost;
      return vectors;
    } catch (error: any) {
      if (attempt >= EMBED_RETRY_MAX) throw error;
      const backoffMs = EMBED_RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn('嵌入请求失败，指数退避后重试', {
        module: MODULE,
        attempt,
        backoffMs,
        error: error?.message ?? String(error),
      });
      await sleep(backoffMs);
    }
  }
}

// ==================== 单文档导入 ====================

interface ImportContext {
  collection: NonNullable<Awaited<ReturnType<typeof initializeVectorStore>>['collection']>;
  embeddings: Embeddings;
  /** 供应商单次嵌入请求批量（用于估算 HTTP 调用次数） */
  batchHttpSize: number;
  stats: Stats;
  maxEmbedCalls: number;
  dryRun: boolean;
  /** 续传修复探测：仅 resume 后第一批开启（后续批次由游标锁步保证是全新文档） */
  probeExisting: boolean;
}

/**
 * 导入单篇文档：切分 → 嵌入 → 写 ChromaDB → 增量追加 BM25（skipSave）。
 *
 * chunk id 格式 `${documentId}__c${childIdx}`（与 measure-runtime 口径一致，
 * 文档内全局递增、跨父块连续），评测检索结果按 `split('__')[0]` 还原 dsid。
 */
async function importDoc(doc: ErbDoc, ctx: ImportContext): Promise<void> {
  const { stats } = ctx;

  let content: string;
  try {
    content = readDocContent(doc);
  } catch (error: any) {
    stats.docsFailed++;
    logger.error('读取文档失败，跳过', {
      module: MODULE,
      documentId: doc.documentId,
      error: error?.message ?? String(error),
    });
    return;
  }

  if (!content.trim()) {
    stats.docsSkipped++;
    logger.warn('文档内容为空，跳过', { module: MODULE, documentId: doc.documentId });
    return;
  }

  // ERB 全部为 .txt；仍走自适应 profile：部分文档内容为 Markdown 结构，
  // 与生产入库同口径切分，保证评测结果对生产检索行为有代表性
  const profile = getAdaptiveChunkingProfile({ fileType: '.txt', content });
  const parents = await parentChildSplit(content, {
    parentChunkSize: profile.parentChunkSize,
    parentChunkOverlap: profile.parentChunkOverlap,
    childChunkSize: profile.childChunkSize,
    childChunkOverlap: profile.childChunkOverlap,
    documentType: profile.documentType,
    fileType: '.txt',
  });

  // 展平 child chunks（父块不入库，与生产 vector-crud 行为一致）
  const ids: string[] = [];
  const texts: string[] = [];
  const metas: Array<Record<string, string | number | boolean>> = [];
  let childIdx = 0;
  for (let pIdx = 0; pIdx < parents.length; pIdx++) {
    const parentId = makeParentId(doc.documentId, pIdx);
    for (const child of parents[pIdx].children) {
      ids.push(`${doc.documentId}__c${childIdx}`);
      texts.push(child.text);
      // 🔴 metadata 不含 parent_content（方案 §4.4 最小集，见 erb-metadata.ts 头注释）
      metas.push({ ...buildChildChunkMeta(doc, child.text, childIdx, parentId) });
      childIdx++;
    }
  }

  if (texts.length === 0) {
    stats.docsSkipped++;
    logger.warn('文档切分后无子块，跳过', { module: MODULE, documentId: doc.documentId });
    return;
  }

  if (ctx.dryRun) {
    stats.docsImported++;
    stats.chunksAdded += texts.length;
    return;
  }

  // 🔴 续传修复通道（S2.4，仅 resume 后首批开启）：中断窗口内可能出现
  //    「Chroma 有、BM25 落盘态没有」（硬中断，finally 未执行）或
  //    「两者都有」（优雅中断，finally 落盘了超出游标的 BM25）。
  //    按 id 探测存在性保证幂等：
  //    - 全部已存在 → 免嵌入、免 Chroma 写，仅补写 BM25（先删后加：MiniSearch
  //      重复 id 抛错、Tantivy 静默重复，两者都不能直接重加），且不烧嵌入预算；
  //    - 部分已存在 → 清掉 Chroma + BM25 残留后走正常写入路径。
  if (ctx.probeExisting) {
    const existing = await ctx.collection.get({ ids, include: [] });
    const existingIds = existing.ids ?? [];
    if (existingIds.length === ids.length) {
      for (let i = 0; i < ids.length; i++) {
        deleteFromBM25Index(ids[i]);
        await addToBM25Index(ids[i], texts[i], metas[i], true);
      }
      stats.docsRepaired++;
      stats.docsImported++;
      stats.chunksAdded += texts.length;
      return;
    }
    if (existingIds.length > 0) {
      logger.warn('续传探测到残留 chunk，先删除再重写', {
        module: MODULE,
        documentId: doc.documentId,
        residual: existingIds.length,
        total: ids.length,
      });
      await ctx.collection.delete({ ids: existingIds });
      for (const id of existingIds) deleteFromBM25Index(id);
    }
  }

  const vectors = await embedWithBudget(
    ctx.embeddings,
    texts,
    ctx.batchHttpSize,
    stats,
    ctx.maxEmbedCalls,
  );
  if (!vectors) return; // 熔断已置停止位，由 worker 循环收尾
  if (vectors.length !== texts.length) {
    throw new Error(
      `嵌入返回数量不符：期望 ${texts.length}，实际 ${vectors.length}（documentId=${doc.documentId}）`,
    );
  }

  await ctx.collection.add({
    ids,
    embeddings: vectors,
    metadatas: metas,
    documents: texts,
  });

  // 🔴 BM25 增量追加 + skipSave=true：全程不触碰 rebuildBM25Index（整索引重建），
  //    落盘由 main() 收尾时一次 saveBM25Index() 完成（方案 §4.3）
  for (let i = 0; i < ids.length; i++) {
    await addToBM25Index(ids[i], texts[i], metas[i], true);
  }

  stats.docsImported++;
  stats.chunksAdded += texts.length;
}

// ==================== 磁盘水位日志 ====================

/** 打印一次磁盘水位探测结果（结构化日志 + 控制台摘要） */
function logDiskWater(water: DiskWaterResult, phase: string): void {
  const detail = water.drives
    .map((d) =>
      d.freeBytes === null
        ? `${d.drive}: 探测失败（${d.error}）`
        : `${d.drive}: 剩余 ${bytesToGb(d.freeBytes)}GB`,
    )
    .join(' | ');
  logger.info(`磁盘水位检查（${phase}）`, { module: MODULE, detail, ok: water.ok });
  console.log(`[磁盘水位 ${phase}] ${detail}${water.ok ? '' : ` 🔴 ${water.violations.join('; ')}`}`);
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const opts = parseArgs();

  // 守卫必须先于任何存储初始化：config 加载即校验 env，隔离不达标直接退出
  assertBenchIsolation();

  // 🔴 引擎硬约束（用户指令）：ERB 评测必须 tantivy，生产保持 minisearch。
  //    红线 #11：BM25 分数不可跨引擎对比，评测索引混用引擎会让结果失去意义。
  if (config.bm25Engine !== 'tantivy') {
    console.error(
      `🔴 ERB 评测入库要求 BM25_ENGINE=tantivy（当前为 ${config.bm25Engine}）。` +
        '请在 bench 环境设置 BM25_ENGINE=tantivy；生产环境保持默认 minisearch 不变。',
    );
    process.exit(1);
  }

  // assertBenchIsolation() 已保证非空；取局部变量供 TS 类型窄化（string | undefined → string）
  const persistDir = config.chromaPersistDir;
  if (!persistDir) {
    console.error('🔴 CHROMA_PERSIST_DIR 未设置（生产隔离守卫应已拦截，此处为兜底）');
    process.exit(1);
  }

  const startedAt = Date.now();
  const stats: Stats = {
    docsImported: 0,
    docsSkipped: 0,
    docsFailed: 0,
    docsRepaired: 0,
    chunksAdded: 0,
    embedCalls: 0,
  };

  // ==================== 断点续传加载（方案 §4.3 / S2.4） ====================

  const progressPath = path.join(persistDir, PROGRESS_FILENAME);
  const runFingerprint: RunFingerprint = {
    sourceType: opts.sourceType ?? null,
    limit: opts.limit ?? null,
  };
  let progress: ImportProgress | null = null;
  /** 续传需跳过的文档数（walkDocs 遍历顺序在语料只读前提下确定性稳定） */
  let docsToSkip = 0;
  /** 已完成批次数（续传后接着计） */
  let batchesCompleted = 0;

  if (opts.resume) {
    progress = readImportProgress(progressPath);
    if (!progress) {
      console.error(`🔴 --resume 但 checkpoint 不存在: ${progressPath}（请先正常运行一次）`);
      process.exit(1);
    }
    // 指纹校验：sourceType/limit 不一致会导致游标错位、语料残缺或重复
    if (
      progress.runFingerprint.sourceType !== runFingerprint.sourceType ||
      progress.runFingerprint.limit !== runFingerprint.limit
    ) {
      console.error(
        '🔴 续传指纹不匹配：checkpoint 记录 ' +
          `sourceType=${progress.runFingerprint.sourceType ?? '全部'} / limit=${progress.runFingerprint.limit ?? '不限'}，` +
          `本次为 sourceType=${opts.sourceType ?? '全部'} / limit=${opts.limit ?? '不限'}。` +
          '请使用与上次运行完全一致的参数续传。',
      );
      process.exit(1);
    }
    // 引擎校验：红线 #10/#11，跨引擎续传会产生不可比对的混合索引
    if (progress.bm25Engine !== config.bm25Engine) {
      console.error(
        `🔴 续传引擎不匹配：checkpoint 记录 ${progress.bm25Engine}，` +
          `当前 BM25_ENGINE=${config.bm25Engine}。禁止跨引擎续传（红线 #10/#11）。`,
      );
      process.exit(1);
    }
    // 恢复统计与游标（embedCalls 跨运行累计，嵌入预算不被续传重置）
    Object.assign(stats, progress.stats);
    docsToSkip = progress.docsConsumed;
    batchesCompleted = progress.batchesCompleted;
    logger.info('续传 checkpoint 加载成功', {
      module: MODULE,
      progressPath,
      docsToSkip,
      batchesCompleted,
      lastStatus: progress.status,
      embedCalls: stats.embedCalls,
    });
  }

  // ==================== 磁盘熔断配置（方案 §3.8.5 ⑥） ====================

  const mainDrive = driveFromPath(persistDir);
  if (!mainDrive) {
    console.error(`🔴 无法从 CHROMA_PERSIST_DIR 派生盘符: ${persistDir}`);
    process.exit(1);
  }
  const diskCfg: DiskWaterConfig = {
    mainDrive,
    healthDrive: (process.env.BENCH_HEALTH_DRIVE || DEFAULT_HEALTH_DRIVE).toUpperCase(),
    minFreeBytes: gbToBytes(opts.minFreeGb),
  };

  console.log('=== ERB 语料批量入库（benchmark-only） ===');
  console.log(`CHROMA_URL         : ${config.chromaUrl}`);
  console.log(`CHROMA_PERSIST_DIR : ${config.chromaPersistDir}`);
  console.log(`BM25 引擎          : ${config.bm25Engine}（ERB 强制 tantivy）`);
  console.log(`source_type        : ${opts.sourceType ?? '全部 9 类'}`);
  console.log(`limit              : ${opts.limit ?? '不限'}`);
  console.log(`concurrency        : ${opts.concurrency}`);
  console.log(`maxEmbedCalls      : ${opts.maxEmbedCalls}`);
  console.log(`dryRun             : ${opts.dryRun}`);
  console.log(`resume             : ${opts.resume ? `是（跳过 ${docsToSkip} 篇，续 ${batchesCompleted} 批）` : '否'}`);
  console.log(`磁盘熔断           : 主熔断盘 ${mainDrive}: / 健康门盘 ${diskCfg.healthDrive}: < ${opts.minFreeGb}GB 触发`);
  console.log(`checkpoint         : ${progressPath}（每 ${BATCH_SIZE} 篇）`);

  // 启动健康门：任何写入之前探测磁盘水位，不达标拒绝启动（fail-closed）
  if (!opts.dryRun) {
    const water = await checkDiskWater(diskCfg);
    logDiskWater(water, '启动健康门');
    if (!water.ok) {
      logger.error('磁盘熔断：启动健康门未通过，拒绝导入', {
        module: MODULE,
        violations: water.violations,
      });
      console.error(`🔴 磁盘熔断（启动健康门）：${water.violations.join('; ')}`);
      process.exit(1);
    }
  }

  // D7：显式构建云端嵌入实例（不走 store-state 的懒加载单例，
  // 避免 localEnabled 总开关把 bench 导入意外切到本地 Ollama）
  const embeddingConfig = getRuntimeConfig().embedding;
  const embeddings = buildEmbeddings(embeddingConfig, 'cloud');
  const cloudProvider = embeddingConfig.cloud.provider;
  const batchHttpSize = EMBEDDING_PROVIDER_PRESETS[cloudProvider]?.batchSize ?? 10;

  const store = await initializeVectorStore();
  if (!store.collection) {
    throw new Error(
      '向量存储处于内存降级模式（collection=null），拒绝导入 —— 请确认 benchmark ChromaDB 实例已启动',
    );
  }
  const collection = store.collection;

  // 续传场景无需额外恢复代码：initializeBM25Index() 天然从磁盘加载已落盘索引
  // （minisearch 读 bm25_index.json / tantivy 重开索引目录），与 checkpoint 游标一致
  await initializeBM25Index();

  // Ctrl+C 优雅停止：置位后 worker 完成当前文档即退出，finally 中仍会落盘 BM25
  process.on('SIGINT', () => {
    if (stopRequested) {
      console.error('\n再次收到 SIGINT，强制退出（BM25 索引可能未落盘）');
      process.exit(1);
    }
    stopRequested = true;
    stopReason = '收到 SIGINT，用户中断';
    console.log('\n收到 SIGINT，等待当前文档完成后停止（再次 Ctrl+C 强制退出）...');
  });

  const ctx: ImportContext = {
    collection,
    embeddings,
    batchHttpSize,
    stats,
    maxEmbedCalls: opts.maxEmbedCalls,
    dryRun: opts.dryRun,
    // 仅续传后第一批开启修复探测（硬中断窗口内 Chroma/BM25 可能已有游标后的文档）
    probeExisting: progress !== null,
  };

  const docIterator = walkDocs({ sourceType: opts.sourceType, limit: opts.limit });

  // 续传：跳过已消费文档（游标之后的文档才需要处理）
  for (let i = 0; i < docsToSkip; i++) {
    if (docIterator.next().done) break;
  }

  const semaphore = new Semaphore(opts.concurrency);

  /** 累计已消费文档数（含在飞完成的），checkpoint 游标 */
  let docsConsumed = docsToSkip;
  /** 当前批已拉取篇数（批边界 = BATCH_SIZE） */
  let batchPulled = 0;
  /** 迭代器是否耗尽（正常完成标志） */
  let iteratorDone = false;

  const nextDoc = (): ErbDoc | null => {
    if (stopRequested || batchPulled >= BATCH_SIZE) return null;
    const result = docIterator.next();
    if (result.done) {
      iteratorDone = true;
      return null;
    }
    batchPulled++;
    docsConsumed++;
    return result.value;
  };

  /** worker：从共享迭代器拉文档，信号量控制嵌入并发（每批重建一组） */
  const worker = async (): Promise<void> => {
    for (;;) {
      const doc = nextDoc();
      if (!doc) return;
      await semaphore.acquire();
      try {
        await importDoc(doc, ctx);
      } catch (error: any) {
        stats.docsFailed++;
        logger.error('文档导入失败，跳过', {
          module: MODULE,
          documentId: doc.documentId,
          error: error?.message ?? String(error),
          stack: error?.stack,
        });
      } finally {
        semaphore.release();
      }

      const done = stats.docsImported + stats.docsSkipped + stats.docsFailed;
      if (done % PROGRESS_EVERY_DOCS === 0) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        console.log(
          `[进度] 文档 ${done}（成功 ${stats.docsImported} / 跳过 ${stats.docsSkipped} / 失败 ${stats.docsFailed}）` +
            ` | chunks ${stats.chunksAdded} | 嵌入调用 ~${stats.embedCalls}/${opts.maxEmbedCalls}` +
            ` | ${elapsedSec.toFixed(0)}s`,
        );
      }
    }
  };

  /** 生成当前时刻的 checkpoint 内容 */
  const buildProgress = (status: ImportProgress['status']): ImportProgress => ({
    version: 1,
    runFingerprint,
    bm25Engine: config.bm25Engine,
    docsConsumed,
    batchesCompleted,
    stats: { ...stats },
    status,
    updatedAt: new Date().toISOString(),
  });

  try {
    // 🔴 批次循环（S2.4 核心一致性设计）：每批消费 ≤BATCH_SIZE 篇 →
    //    saveBM25Index() → 写 progress.json（游标与 BM25 落盘锁步推进）→ 磁盘检查。
    //    progress.json 永不超前于 BM25 已落盘态：硬中断后续传最多修复一批，
    //    不会出现"游标已过但 BM25 索引残缺"的窗口（方案 §4.3 警示的陷阱）。
    while (!stopRequested && !iteratorDone) {
      batchPulled = 0;
      await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
      // 修复探测只作用于续传后第一批
      ctx.probeExisting = false;

      if (batchPulled === 0) break; // 迭代器耗尽
      if (batchPulled < BATCH_SIZE) iteratorDone = true;

      if (opts.dryRun) continue; // 干跑无写入：不落盘、不写 checkpoint、不查磁盘

      batchesCompleted++;
      console.log(
        `[批次 ${batchesCompleted}] 本批 ${batchPulled} 篇完成，保存 BM25 索引 + 推进 checkpoint...`,
      );
      await saveBM25Index();
      writeImportProgress(progressPath, buildProgress('in_progress'));

      // 磁盘熔断：每批落盘后检查（即下一批写入前），触发 → 停写。
      // 此时 BM25 与 checkpoint 均已落盘，中止序列满足方案 §4.3：
      // 停写 → 落 BM25 → 写 progress.json → logger.error → 非 0 退出（gracefulExit）
      const water = await checkDiskWater(diskCfg);
      logDiskWater(water, `批次 ${batchesCompleted} 后`);
      if (!water.ok) {
        stopRequested = true;
        stopReason = `磁盘熔断触发：${water.violations.join('; ')}`;
        logger.error('磁盘熔断触发，停止写入（checkpoint 已落盘，可 --resume 续传）', {
          module: MODULE,
          violations: water.violations,
          docsConsumed,
          batchesCompleted,
        });
      }
    }
  } finally {
    // 🔴 收尾落盘 + checkpoint：优雅停止（SIGINT / 嵌入熔断 / 磁盘熔断）时，
    //    所有已拉取文档均已完成写入（Promise.all 等待在飞 importDoc 结束），
    //    BM25 落盘态与游标同步推进到实际消费数，下次 --resume 直接续接。
    //    硬中断（kill -9）不会执行本块：游标停留在上个批边界，
    //    由续传首批修复探测兜底"Chroma 有、BM25 落盘态没有"的窗口。
    if (!opts.dryRun && (stats.chunksAdded > 0 || progress !== null)) {
      console.log('正在保存 BM25 索引（收尾落盘）...');
      await saveBM25Index();
      const finalStatus = iteratorDone && !stopReason ? 'completed' : 'aborted';
      writeImportProgress(progressPath, buildProgress(finalStatus));
      console.log(`checkpoint 已写入: ${progressPath}（游标 ${docsConsumed} 篇，状态 ${finalStatus}）`);
    }
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log('\n=== 入库结束 ===');
  console.log(`状态         : ${stopReason ? `提前停止（${stopReason}）` : '正常完成'}`);
  console.log(`文档成功     : ${stats.docsImported}`);
  console.log(`文档跳过     : ${stats.docsSkipped}`);
  console.log(`文档失败     : ${stats.docsFailed}`);
  console.log(`续传修复     : ${stats.docsRepaired}（免嵌入仅补 BM25）`);
  console.log(`child chunks : ${stats.chunksAdded}`);
  console.log(`嵌入调用(估) : ${stats.embedCalls} / ${opts.maxEmbedCalls}`);
  console.log(`耗时         : ${elapsedSec.toFixed(1)}s`);
  if (!opts.dryRun && stats.docsImported > 0) {
    console.log(
      `吞吐         : ${(stats.chunksAdded / Math.max(elapsedSec, 0.001)).toFixed(1)} chunks/s`,
    );
  }

  // 熔断/中断视为非零退出，便于上层脚本感知
  if (stopReason || stats.docsFailed > 0) {
    process.exitCode = stopReason ? 1 : 0;
  }
}

/**
 * undici（全局 fetch 底层）keep-alive 连接的排空等待时长。
 *
 * 实测（Windows + Node v25）：多个 ChromaClient（store-state 直连 + LangChain
 * 包装器内部各建一个）会保持多条 keep-alive socket，在其存活期间退出进程
 * （自然退出或 process.exit 均触发）会命中 libuv 断言崩溃
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（exit code 0xC0000409）。
 * undici 默认 keepAliveTimeout=4s，等待 6s 后连接已自行关闭，退出安全（实测 EXIT=0）。
 */
const KEEPALIVE_DRAIN_MS = 6000;

/**
 * 优雅退出：关 logger transports → 等 HTTP keep-alive 连接排空 → 事件循环自然清空退出。
 *
 * 🔴 顺序不可调换：closeLogger 关闭 winston File/Loki transport 句柄（否则驻留
 * 事件循环导致进程挂起不退出）；排空等待规避 Windows libuv 退出断言崩溃。
 * 兜底：排空后 3 秒若仍未自然退出（理论上不会发生）再强制 process.exit，
 * 此时已无存活 keep-alive 句柄，exit 是安全的；timer.unref 不阻止自然退出。
 */
async function gracefulExit(code: number): Promise<void> {
  process.exitCode = code;
  await closeLogger();
  console.log(`[BenchImport] 等待 HTTP keep-alive 连接释放（${KEEPALIVE_DRAIN_MS / 1000}s）后退出…`);
  await new Promise<void>((resolve) => setTimeout(resolve, KEEPALIVE_DRAIN_MS));
  const killer = setTimeout(() => process.exit(code), 3000);
  killer.unref();
  // 返回后控制流交还事件循环：句柄已排空，进程将自然退出
}

main()
  .then(async () => {
    await gracefulExit(Number(process.exitCode ?? 0));
  })
  .catch(async (error: any) => {
    logger.error('ERB 语料入库脚本异常终止', {
      module: MODULE,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
    console.error(`\n🔴 脚本异常终止: ${error?.message ?? error}`);
    await gracefulExit(1);
  });
