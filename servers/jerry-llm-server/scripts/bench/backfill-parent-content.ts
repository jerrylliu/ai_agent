/**
 * ERB bench 语料「原地回填 parent_content」（S4.0 修复的落地步骤，benchmark-only）
 *
 * 【为什么需要本脚本】
 *   早期 bench 入库刻意不写 `parent_content`（当时的错误前提：ERB 只按 documentId 比对、
 *   不做父块展开）。但评测跑的是真实 RAG 链路，vector-search 命中 child 后
 *   `if (meta.chunk_role === 'child' && meta.parent_content)` 会**静默降级**为
 *   340 字符子块碎片，而生产同路径注入的是 1600 字符父块 —— 评测因此系统性低估产品表现。
 *   修复分两步：① 入库脚本改为写 parent_content（已完成，见 erb-metadata.ts 头注释）；
 *   ② 本脚本对**已入库的存量数据**原地回填（重跑全量入库要重烧 1.2 万次嵌入调用，不值当）。
 *
 * 【两步回填，均不重嵌入、不改 documents】
 *   阶段 A（chroma）：遍历档位语料 → 用与入库**完全同参**的 profile 重切分 →
 *     逐文档校验「Chroma 现有 chunk 集合 === 重切分 chunk 集合（id 与文本逐一对齐）」→
 *     `collection.update({ ids, metadatas })` 只更新 metadata（向量与正文一律不动）。
 *     🔴 对齐校验是 fail-safe 关键：切分参数若与入库时不一致，直接跳过该文档并计入
 *     mismatch（绝不写入错位的父块），收尾非 0 退出，避免「修一半、静默劣化」。
 *   阶段 B（bm25）：Tantivy 的 metadata 是 stored field，**无原位更新能力**，
 *     只能 delete-by-term + 重新 add；逐条 delete 会触发 22 万次 commit（不可接受），
 *     故采用「clear + 从 Chroma 全量重建 + 单次 commit」路径。
 *     🔴 重建数据源是 Chroma（唯一真相源），因此 BM25 与 Chroma 天然一致；
 *     BM25 阶段无断点，重跑即全量重建（幂等）。
 *
 * 【与生产的关系】零影响：PERSIST_DIR 由 CHROMA_PERSIST_DIR 隔离（红线 #3），
 *   生产 `chromadb_data/bm25_index.json` 不被触碰；本脚本不改 src/ 下任何生产代码。
 *
 * 用法示例：
 *   # 试跑（只切分+对齐校验，不写任何存储；用于确认耗时与对齐率）
 *   pnpm bench:backfill -- --dry-run --limit 50
 *   # 全量回填（A + B 两阶段）
 *   pnpm bench:backfill -- --tier T1
 *   # 中断后续传（A 阶段从 checkpoint 游标续；B 阶段全量重建）
 *   pnpm bench:backfill -- --tier T1 --resume
 *
 * 运行前提（与 bench:import 相同）：
 *   CHROMA_URL=http://localhost:8001
 *   CHROMA_PERSIST_DIR=E:\ragbench\bm25
 *   BM25_ENGINE=tantivy
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量，模式与 bench:import 一致）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../src/fundamentals/config.js';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { initializeVectorStore } from '../../src/fundamentals/vector-store/store-state.js';
import {
  initializeBM25Index,
  addToBM25Index,
  clearBM25Index,
  saveBM25Index,
} from '../../src/fundamentals/vector-store/bm25-index.js';
import {
  getAdaptiveChunkingProfile,
  parentChildSplit,
} from '../../src/fundamentals/vector-store/text-splitter.js';
import {
  readDocContent,
  GOLD_FIRST_TIERS,
  goldFirstSample,
  type ErbDoc,
  type GoldFirstTier,
} from './lib/erb-loader.js';
import { buildChildChunkMeta, makeParentId } from './lib/erb-metadata.js';

// ==================== 常量与默认值 ====================

const MODULE = 'BenchBackfill';

/** 默认并发（Chroma 逐文档 1 次 get + 1 次 update，HTTP 往返为主，可适度并发） */
const DEFAULT_CONCURRENCY = 8;

/** 默认 checkpoint 间隔（每处理 N 篇文档落一次游标，可 --resume 续传） */
const DEFAULT_CHECKPOINT_DOCS = 500;

/** BM25 重建时每累计 N 个 chunk commit 一次（Tantivy 单次 commit 过大易长时间阻塞） */
const DEFAULT_BM25_COMMIT_CHUNKS = 20_000;

/** BM25 重建时 Chroma 分页大小 */
const BM25_PAGE_SIZE = 500;

/** checkpoint 文件名（放 CHROMA_PERSIST_DIR 根下，与 bench 其他持久化产物同区） */
const PROGRESS_FILENAME = 'backfill-parent-content.progress.json';

/** 生产 ChromaDB 默认地址（红线 #3：脚本禁止指向它，与 bench:import 同款守卫） */
const PROD_CHROMA_URL = 'http://localhost:8000';

// ==================== CLI 参数 ====================

type Phase = 'chroma' | 'bm25' | 'all';

interface CliOptions {
  /** gold-first 档位（语料定义必须与 bench:import 一致，否则 chunk 集合对不上） */
  tier: GoldFirstTier;
  /** 本次最多处理多少篇（试跑用；缺省不限） */
  limit?: number;
  concurrency: number;
  checkpointDocs: number;
  bm25CommitChunks: number;
  phase: Phase;
  /** 干跑：只重切分 + 对齐校验，不写 Chroma、不重建 BM25 */
  dryRun: boolean;
  /** 断点续传：从 checkpoint 游标继续阶段 A */
  resume: boolean;
}

function printUsageAndExit(code: number): never {
  console.log(`用法: pnpm bench:backfill -- [选项]

选项:
  --tier <T0|T1|T2>        gold-first 档位，必须与入库时一致（默认 T1）
  --limit <n>              本次最多处理 n 篇（试跑用；缺省不限）
  --concurrency <n>        Chroma 阶段并发（默认 ${DEFAULT_CONCURRENCY}）
  --checkpoint-docs <n>    checkpoint 间隔篇数（默认 ${DEFAULT_CHECKPOINT_DOCS}）
  --bm25-commit-chunks <n> BM25 重建每累计 n 个 chunk commit 一次（默认 ${DEFAULT_BM25_COMMIT_CHUNKS}）
  --phase <chroma|bm25|all> 只跑指定阶段（默认 all；bm25 阶段为全量重建）
  --dry-run                只切分 + 对齐校验，不写任何存储
  --resume                 从 checkpoint 游标续传（阶段 A；阶段 B 本就全量重建）
  --help                  显示本帮助`);
  process.exit(code);
}

function parseArgs(): CliOptions {
  const argv = process.argv.slice(2);
  const opts: CliOptions = {
    tier: 'T1',
    concurrency: DEFAULT_CONCURRENCY,
    checkpointDocs: DEFAULT_CHECKPOINT_DOCS,
    bm25CommitChunks: DEFAULT_BM25_COMMIT_CHUNKS,
    phase: 'all',
    dryRun: false,
    resume: false,
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
      case '--tier': {
        const value = argv[++i];
        if (!value || !(value in GOLD_FIRST_TIERS)) {
          console.error(`无效的 --tier: ${value ?? '(缺失)'}，可选: ${Object.keys(GOLD_FIRST_TIERS).join(' | ')}`);
          process.exit(1);
        }
        opts.tier = value as GoldFirstTier;
        break;
      }
      case '--phase': {
        const value = argv[++i];
        if (value !== 'chroma' && value !== 'bm25' && value !== 'all') {
          console.error(`无效的 --phase: ${value ?? '(缺失)'}，可选: chroma | bm25 | all`);
          process.exit(1);
        }
        opts.phase = value;
        break;
      }
      case '--limit':
      case '--concurrency':
      case '--checkpoint-docs':
      case '--bm25-commit-chunks': {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n <= 0) {
          console.error(`${arg} 必须是正整数`);
          process.exit(1);
        }
        if (arg === '--limit') opts.limit = n;
        else if (arg === '--concurrency') opts.concurrency = n;
        else if (arg === '--checkpoint-docs') opts.checkpointDocs = n;
        else opts.bm25CommitChunks = n;
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

// ==================== 生产隔离守卫（红线 #3，与 bench:import 同款） ====================

/**
 * 启动守卫：确认当前 env 指向 benchmark 专用 ChromaDB，而非生产实例。
 * 与 import-erb-corpus.ts#assertBenchIsolation 同款（脚本间不共享代码，
 * 保持 scripts/bench 各自独立、可单独复制运行）。
 */
function assertBenchIsolation(): void {
  const problems: string[] = [];

  if (!config.chromaPersistDir) {
    problems.push(
      'CHROMA_PERSIST_DIR 未设置 —— BM25 索引会写入生产默认目录 chromadb_data。' +
        '请设置 CHROMA_PERSIST_DIR=E:\\ragbench\\bm25',
    );
  }

  const chromaUrl = config.chromaUrl.replace(/\/+$/, '');
  if (chromaUrl === PROD_CHROMA_URL) {
    problems.push(
      `CHROMA_URL 仍指向生产实例 ${PROD_CHROMA_URL}。` +
        '请设置 CHROMA_URL=http://localhost:8001（jerry-chroma-bench 容器）',
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

// ==================== 统计与 checkpoint ====================

interface Stats {
  /** 阶段 A：已扫描文档数（= 游标推进量，含跳过/失败） */
  docsScanned: number;
  /** 阶段 A：metadata 已更新（或干跑下「待更新」）文档数 */
  docsUpdated: number;
  /** 阶段 A：已含正确 parent_content、无需写入的文档数（幂等快路径） */
  docsAlreadyOk: number;
  /** 阶段 A：Chroma 中不存在该文档（入库时失败/内容为空），跳过 */
  docsAbsent: number;
  /** 阶段 A：重切分后无子块，跳过 */
  docsEmpty: number;
  /** 阶段 A：读取源文件失败，跳过 */
  docsReadFailed: number;
  /** 阶段 A：重切分结果与 Chroma 不一致，拒写（fail-safe） */
  docsMismatch: number;
  /** 阶段 A：累计更新的 chunk 数 */
  chunksUpdated: number;
  /** 阶段 B：BM25 重建写入的 chunk 数 */
  bm25ChunksAdded: number;
}

interface BackfillProgress {
  version: 1;
  tier: GoldFirstTier;
  bm25Engine: string;
  /** 阶段 A 已完成文档数（续传游标） */
  docsDone: number;
  chromaPhaseDone: boolean;
  bm25PhaseDone: boolean;
  stats: Stats;
  updatedAt: string;
}

function emptyStats(): Stats {
  return {
    docsScanned: 0,
    docsUpdated: 0,
    docsAlreadyOk: 0,
    docsAbsent: 0,
    docsEmpty: 0,
    docsReadFailed: 0,
    docsMismatch: 0,
    chunksUpdated: 0,
    bm25ChunksAdded: 0,
  };
}

function readProgress(progressPath: string): BackfillProgress | null {
  if (!fs.existsSync(progressPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(progressPath, 'utf-8')) as BackfillProgress;
  } catch (error: any) {
    console.error(`🔴 checkpoint 解析失败: ${progressPath}（${error?.message ?? error}）`);
    process.exit(1);
  }
}

function writeProgress(progressPath: string, progress: BackfillProgress): void {
  try {
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf-8');
  } catch (error: any) {
    // checkpoint 只是断点续传辅助，回填本身幂等（重复处理安全）：
    // 写失败不应打断长跑，告警后继续，仅丢失「从中断处续传」能力
    logger.warn('checkpoint 写入失败（不影响回填本身，仅影响断点续传）', {
      module: MODULE,
      path: progressPath,
      error: error?.message ?? String(error),
    });
  }
}

// ==================== 信号量（逐文档并发控制） ====================

/** 简易计数信号量：控制同时在飞的 Chroma 请求数 */
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
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.running--;
  }
}

// ==================== 重切分（与入库同参，逐 chunk 对齐） ====================

/** 期望的 child chunk（id / 正文 / 新 metadata） */
interface ExpectedChunk {
  id: string;
  text: string;
  meta: Record<string, string | number | boolean>;
}

/**
 * 用与 bench:import **完全同参**的切分流程重建某篇文档的 child chunk 列表。
 *
 * 🔴 参数必须与 import-erb-corpus.ts#importDoc 逐字一致（同一 profile + 同一
 *    parentChildSplit 入参），否则 chunk id 与正文无法对齐，回填会整体失效。
 *    childIdx 跨父块全局递增（与入库一致），故 id 序列天然确定。
 *
 * @param doc 待处理的 ERB 文档
 */
async function buildExpectedChunks(doc: ErbDoc): Promise<ExpectedChunk[]> {
  const content = readDocContent(doc);
  if (!content.trim()) return [];

  const profile = getAdaptiveChunkingProfile({ fileType: '.txt', content });
  const parents = await parentChildSplit(content, {
    parentChunkSize: profile.parentChunkSize,
    parentChunkOverlap: profile.parentChunkOverlap,
    childChunkSize: profile.childChunkSize,
    childChunkOverlap: profile.childChunkOverlap,
    documentType: profile.documentType,
    fileType: '.txt',
  });

  const chunks: ExpectedChunk[] = [];
  let childIdx = 0;
  for (let pIdx = 0; pIdx < parents.length; pIdx++) {
    const parentId = makeParentId(doc.documentId, pIdx);
    const parentText = parents[pIdx].parent.text;
    for (const child of parents[pIdx].children) {
      chunks.push({
        id: `${doc.documentId}__c${childIdx}`,
        text: child.text,
        // 展开为对象字面量：interface 无隐式索引签名（与 import 同因）
        meta: { ...buildChildChunkMeta(doc, child.text, childIdx, parentId, parentText) },
      });
      childIdx++;
    }
  }
  return chunks;
}

// ==================== 阶段 A：Chroma metadata 原地回填 ====================

/** Chroma collection 的类型（从 initializeVectorStore 推导，避免直接依赖 chromadb 类型） */
type BenchCollection = NonNullable<
  Awaited<ReturnType<typeof initializeVectorStore>>['collection']
>;

interface ChromaCtx {
  collection: BenchCollection;
  opts: CliOptions;
  stats: Stats;
  /** 不一致样本（最多保留 10 条，用于收尾报告） */
  mismatchSamples: string[];
}

/**
 * 处理单篇文档：重切分 → 与 Chroma 现有 chunk 逐一对齐校验 → 只更新 metadata。
 *
 * 幂等：重复执行结果一致（对齐校验通过后写入的是同一份 parent_content）。
 * fail-safe：任一对齐异常（缺 chunk / 文本不一致 / chunk 数不一致）一律拒写并计数，
 * 绝不写入可能错位的父块（错位父块会让检索上下文串文档，比不修更糟）。
 */
async function backfillDoc(doc: ErbDoc, ctx: ChromaCtx): Promise<void> {
  const { stats, opts } = ctx;

  let expected: ExpectedChunk[];
  try {
    expected = await buildExpectedChunks(doc);
  } catch (error: any) {
    stats.docsReadFailed++;
    logger.error('重切分失败，跳过该文档', {
      module: MODULE,
      documentId: doc.documentId,
      error: error?.message ?? String(error),
    });
    return;
  }

  if (expected.length === 0) {
    stats.docsEmpty++;
    logger.warn('文档重切分后无子块，跳过', { module: MODULE, documentId: doc.documentId });
    return;
  }

  // 按 documentId 精确取回该文档现有 chunk（含正文与 metadata）：
  // 用 where 而非 ids，是为了同时检出「缺失 chunk」与「多余残留 chunk」两种情况
  const existing = await ctx.collection.get({
    where: { documentId: doc.documentId },
    include: ['documents', 'metadatas'],
  });
  const ids = existing.ids ?? [];
  if (ids.length === 0) {
    stats.docsAbsent++;
    logger.warn('Chroma 中不存在该文档的 chunk，跳过（入库时失败或内容为空）', {
      module: MODULE,
      documentId: doc.documentId,
    });
    return;
  }

  const storedTexts = existing.documents ?? [];
  const storedMetas = (existing.metadatas ?? []) as Array<Record<string, unknown>>;
  const textById = new Map<string, string>();
  const metaById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i++) {
    textById.set(ids[i], storedTexts[i] ?? '');
    metaById.set(ids[i], storedMetas[i] ?? {});
  }

  // ==================== 对齐校验 ====================
  let mismatch: string | null = null;
  if (ids.length !== expected.length) {
    mismatch = `chunk 数不一致（Chroma ${ids.length} / 重切分 ${expected.length}）`;
  } else {
    for (const chunk of expected) {
      const storedText = textById.get(chunk.id);
      if (storedText === undefined) {
        mismatch = `Chroma 缺少 chunk ${chunk.id}`;
        break;
      }
      if (storedText !== chunk.text) {
        mismatch = `chunk ${chunk.id} 正文不一致（Chroma ${storedText.length} 字符 / 重切分 ${chunk.text.length} 字符）`;
        break;
      }
    }
  }
  if (mismatch) {
    stats.docsMismatch++;
    if (ctx.mismatchSamples.length < 10) {
      ctx.mismatchSamples.push(`${doc.documentId}: ${mismatch}`);
    }
    logger.error('重切分结果与 Chroma 不一致，拒写该文档（fail-safe）', {
      module: MODULE,
      documentId: doc.documentId,
      reason: mismatch,
    });
    return;
  }

  // ==================== 幂等快路径 ====================
  // 全部 chunk 的 parent_content 已正确 → 无需写入（续传/重跑时大幅省去 update 往返）
  const allOk = expected.every(
    (chunk) => metaById.get(chunk.id)?.parent_content === chunk.meta.parent_content,
  );
  if (allOk) {
    stats.docsAlreadyOk++;
    return;
  }

  if (opts.dryRun) {
    stats.docsUpdated++;
    stats.chunksUpdated += expected.length;
    return;
  }

  await ctx.collection.update({
    ids: expected.map((chunk) => chunk.id),
    metadatas: expected.map((chunk) => chunk.meta),
  });
  stats.docsUpdated++;
  stats.chunksUpdated += expected.length;
}

/** 阶段 A 主循环：并发 worker 抢占式领取文档，按间隔落 checkpoint */
async function backfillChroma(
  collection: BenchCollection,
  opts: CliOptions,
  stats: Stats,
  docsToSkip: number,
  progressPath: string,
): Promise<{ mismatchSamples: string[]; chromaDone: boolean }> {
  let docsConsumed = docsToSkip;
  let pulled = 0;
  let lastCheckpoint = 0;
  let stopRequested = false;

  const mismatchSamples: string[] = [];

  const writeCheckpoint = (chromaDone: boolean, _bm25Done: boolean): void => {
    writeProgress(progressPath, {
      version: 1,
      tier: opts.tier,
      bm25Engine: config.bm25Engine,
      docsDone: docsConsumed,
      chromaPhaseDone: chromaDone,
      bm25PhaseDone: false,
      stats: { ...stats },
      updatedAt: new Date().toISOString(),
    });
  };

  const ctx: ChromaCtx = {
    collection,
    opts,
    stats,
    mismatchSamples,
  };

  // 文档源：与 bench:import 同款 tier 生成器（gold 在前、顺序确定）
  const docIterator: Iterator<ErbDoc> = goldFirstSample(GOLD_FIRST_TIERS[opts.tier]);
  for (let i = 0; i < docsToSkip; i++) {
    if (docIterator.next().done) break;
  }

  const nextDoc = (): ErbDoc | null => {
    if (stopRequested) return null;
    if (opts.limit !== undefined && pulled >= opts.limit) return null;
    const result = docIterator.next();
    if (result.done) return null;
    pulled++;
    docsConsumed++;
    return result.value;
  };

  process.on('SIGINT', () => {
    if (stopRequested) {
      console.error('\n再次收到 SIGINT，强制退出');
      process.exit(1);
    }
    stopRequested = true;
    console.log('\n收到 SIGINT，等待在飞文档完成后停止（checkpoint 会在收尾时落盘）...');
  });

  const semaphore = new Semaphore(opts.concurrency);
  const worker = async (): Promise<void> => {
    for (;;) {
      const doc = nextDoc();
      if (!doc) return;
      await semaphore.acquire();
      try {
        await backfillDoc(doc, ctx);
      } catch (error: any) {
        stats.docsReadFailed++;
        logger.error('文档回填失败，跳过', {
          module: MODULE,
          documentId: doc.documentId,
          error: error?.message ?? String(error),
          stack: error?.stack,
        });
      } finally {
        semaphore.release();
      }

      stats.docsScanned++;
      if (stats.docsScanned % 100 === 0) {
        console.log(
          `[进度] 已扫描 ${stats.docsScanned} | 更新 ${stats.docsUpdated} | 已正确 ${stats.docsAlreadyOk}` +
            ` | 缺失 ${stats.docsAbsent} | 不一致 ${stats.docsMismatch} | 失败 ${stats.docsReadFailed}`,
        );
      }
      // checkpoint：写在飞文档数可能略超前，但重复处理是幂等的，安全
      if (!opts.dryRun && stats.docsScanned - lastCheckpoint >= opts.checkpointDocs) {
        lastCheckpoint = stats.docsScanned;
        writeCheckpoint(false, false);
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  const chromaDone = !stopRequested && (opts.limit === undefined || pulled < opts.limit);
  return { mismatchSamples, chromaDone };
}

// ==================== 阶段 B：BM25 索引全量重建 ====================

/**
 * 从 Chroma 全量重建 BM25 索引（clear → 逐条 add(skipSave) → 分段 commit → 收尾 commit）。
 *
 * 🔴 为什么必须重建而非增量：Tantivy 的 metadata 是 stored field，无法原位更新，
 *    逐条 delete + add 会触发 22 万次 commit（每次 commit 都要落盘 + reload）。
 *    clear + 单轮重建只产生「分段 commit + 一次收尾 commit」，是唯一可行路径。
 * 🔴 数据源是 Chroma（唯一真相源）→ 重建后 BM25 与 Chroma 天然一致，
 *    因此本阶段无断点、重跑即全量重建（幂等）。
 */
async function rebuildBM25(
  collection: BenchCollection,
  opts: CliOptions,
  stats: Stats,
): Promise<void> {
  await initializeBM25Index();

  console.log('阶段 B：清空 BM25 索引（Tantivy deleteAll）...');
  await clearBM25Index();

  let offset = 0;
  let added = 0;
  let lastCommit = 0;

  for (;;) {
    const page = await collection.get({
      limit: BM25_PAGE_SIZE,
      offset,
      include: ['documents', 'metadatas'],
    });
    const ids = page.ids ?? [];
    if (ids.length === 0) break;

    const docs = page.documents ?? [];
    const metas = page.metadatas ?? [];
    if (docs.length !== ids.length || metas.length !== ids.length) {
      throw new Error(
        `Chroma 分页返回字段长度不一致：ids=${ids.length} documents=${docs.length} metadatas=${metas.length}` +
          `（offset=${offset}）—— 拒绝以残缺数据重建 BM25`,
      );
    }

    for (let i = 0; i < ids.length; i++) {
      await addToBM25Index(ids[i], docs[i] ?? '', metas[i] ?? {}, true);
    }
    added += ids.length;
    offset += ids.length;

    if (added - lastCommit >= opts.bm25CommitChunks) {
      await saveBM25Index();
      lastCommit = added;
      console.log(`[BM25 重建] 已写入 ${added} 个 chunk（已 commit）`);
    } else if (added % 20_000 === 0) {
      console.log(`[BM25 重建] 已写入 ${added} 个 chunk`);
    }
  }

  console.log(`阶段 B：收尾 commit（共 ${added} 个 chunk）...`);
  await saveBM25Index();
  stats.bm25ChunksAdded = added;
  console.log(`阶段 B 完成：BM25 索引已从 Chroma 全量重建，共 ${added} 个 chunk`);
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const opts = parseArgs();

  // 守卫必须先于任何存储初始化（config 加载即校验 env，隔离不达标直接退出）
  assertBenchIsolation();

  // 引擎硬约束：ERB 评测必须 tantivy（红线 #10/#11），重建索引必须与评测口径一致
  if (config.bm25Engine !== 'tantivy') {
    console.error(
      `🔴 回填要求 BM25_ENGINE=tantivy（当前为 ${config.bm25Engine}）。` +
        '请在 bench 环境设置 BM25_ENGINE=tantivy；生产环境保持默认 minisearch 不变。',
    );
    process.exit(1);
  }

  const persistDir = config.chromaPersistDir;
  if (!persistDir) {
    console.error('🔴 CHROMA_PERSIST_DIR 未设置（生产隔离守卫应已拦截，此处为兜底）');
    process.exit(1);
  }

  const progressPath = path.join(persistDir, PROGRESS_FILENAME);
  const stats = emptyStats();
  let docsToSkip = 0;
  let priorProgress: BackfillProgress | null = null;

  if (opts.resume) {
    priorProgress = readProgress(progressPath);
    if (!priorProgress) {
      console.error(`🔴 --resume 但 checkpoint 不存在: ${progressPath}（请先正常运行一次）`);
      process.exit(1);
    }
    if (priorProgress.tier !== opts.tier) {
      console.error(
        `🔴 续传档位不匹配：checkpoint 记录 ${priorProgress.tier}，本次 ${opts.tier}。` +
          '档位不同则语料集合不同，续传会产生错位。',
      );
      process.exit(1);
    }
    if (priorProgress.bm25Engine !== config.bm25Engine) {
      console.error(
        `🔴 续传引擎不匹配：checkpoint 记录 ${priorProgress.bm25Engine}，` +
          `当前 BM25_ENGINE=${config.bm25Engine}。禁止跨引擎续传（红线 #10/#11）。`,
      );
      process.exit(1);
    }
    Object.assign(stats, priorProgress.stats);
    docsToSkip = priorProgress.docsDone;
    // 续传后若已进入过阶段 B，则阶段 A 必然已完成
    if (priorProgress.bm25PhaseDone) {
      console.log('checkpoint 显示上一轮已完成全量回填；本次将重新校验并对齐（幂等）。');
    }
  }

  console.log('=== ERB bench 语料 parent_content 原地回填 ===');
  console.log(`CHROMA_URL         : ${config.chromaUrl}`);
  console.log(`CHROMA_PERSIST_DIR : ${persistDir}`);
  console.log(`BM25 引擎          : ${config.bm25Engine}（回填强制 tantivy）`);
  console.log(`档位               : ${opts.tier}（与 bench:import 同款 gold-first 语料定义）`);
  console.log(`阶段               : ${opts.phase}`);
  console.log(`limit              : ${opts.limit ?? '不限'}`);
  console.log(`concurrency        : ${opts.concurrency}`);
  console.log(`dryRun             : ${opts.dryRun}`);
  console.log(`resume             : ${opts.resume ? `是（跳过 ${docsToSkip} 篇）` : '否'}`);
  console.log(`checkpoint         : ${progressPath}`);

  const store = await initializeVectorStore();
  if (!store.collection) {
    throw new Error(
      '向量存储处于内存降级模式（collection=null），拒绝回填 —— 请确认 benchmark ChromaDB 实例已启动',
    );
  }
  const collection = store.collection;
  console.log('已连接 ChromaDB benchmark 实例');

  // 上一轮是否已完成阶段 A（用于判断「只跑 bm25」是否安全）
  const priorChromaDone = priorProgress?.chromaPhaseDone ?? false;

  const startedAt = Date.now();

  // ==================== 阶段 A ====================
  if (opts.phase !== 'bm25') {
    console.log('\n阶段 A：Chroma metadata 原地回填（不重嵌入、不改 documents）...');
    const { mismatchSamples, chromaDone } = await backfillChroma(
      collection,
      opts,
      stats,
      docsToSkip,
      progressPath,
    );

    if (!opts.dryRun) {
      writeProgress(progressPath, {
        version: 1,
        tier: opts.tier,
        bm25Engine: config.bm25Engine,
        docsDone: docsToSkip + stats.docsScanned,
        chromaPhaseDone: chromaDone && stats.docsMismatch === 0,
        bm25PhaseDone: false,
        stats: { ...stats },
        updatedAt: new Date().toISOString(),
      });
    }

    console.log(`\n阶段 A 结束：扫描 ${stats.docsScanned} 篇`);
    console.log(`  已更新     : ${stats.docsUpdated}（chunk ${stats.chunksUpdated}）`);
    console.log(`  已正确跳过 : ${stats.docsAlreadyOk}`);
    console.log(`  不在库中   : ${stats.docsAbsent}`);
    console.log(`  空内容     : ${stats.docsEmpty}`);
    console.log(`  读取失败   : ${stats.docsReadFailed}`);
    console.log(`  对齐不一致 : ${stats.docsMismatch}${stats.docsMismatch > 0 ? '  🔴 已拒写，需排查' : ''}`);
    if (mismatchSamples.length > 0) {
      console.log('  不一致样本（最多 10 条）:');
      for (const s of mismatchSamples) console.log(`    - ${s}`);
    }
    if (stats.docsMismatch > 0) {
      logger.error('阶段 A 存在对齐不一致文档，请排查后再进入阶段 B', {
        module: MODULE,
        docsMismatch: stats.docsMismatch,
        samples: mismatchSamples,
      });
      // 不一致意味着这些文档的切分口径与入库时不同，继续重建 BM25 会把「半修复」状态固化
      console.error('\n🔴 存在对齐不一致文档，中止（不进入阶段 B），请先排查根因');
      return;
    }
  } else if (!priorChromaDone && !opts.dryRun) {
    console.warn(
      '⚠️ 未检测到「阶段 A 已完成」的 checkpoint —— BM25 将从 Chroma 现状重建，' +
        '若阶段 A 未跑完，未回填文档在 BM25 路径上仍会静默降级（不会损坏数据）。',
    );
  }

  // ==================== 阶段 B ====================
  if (opts.phase !== 'chroma' && !opts.dryRun) {
    console.log('\n阶段 B：BM25 索引全量重建（Tantivy metadata 无法原位更新，只能重建）...');
    await rebuildBM25(collection, opts, stats);
    writeProgress(progressPath, {
      version: 1,
      tier: opts.tier,
      bm25Engine: config.bm25Engine,
      docsDone: docsToSkip + stats.docsScanned,
      chromaPhaseDone: priorChromaDone || opts.phase === 'all',
      bm25PhaseDone: true,
      stats: { ...stats },
      updatedAt: new Date().toISOString(),
    });
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log('\n=== 回填结束 ===');
  console.log(`耗时         : ${elapsedSec.toFixed(1)}s`);
  console.log(`chunk 更新   : ${stats.chunksUpdated}（Chroma metadata）`);
  console.log(`BM25 重建    : ${stats.bm25ChunksAdded}（chunk）`);
  console.log('下一步验证   : pnpm bench:verify-import -- --docs 10700');

  if (stats.docsMismatch > 0 || stats.docsReadFailed > 0) {
    process.exitCode = 1;
  }
}

/**
 * undici（全局 fetch 底层）keep-alive 连接的排空等待时长。
 *
 * 与 bench:import 同因：多个 ChromaClient keep-alive socket 存活期间退出进程
 * 会命中 libuv 断言崩溃（exit code 0xC0000409）。等待 6s 让连接自行关闭后退出。
 */
const KEEPALIVE_DRAIN_MS = 6000;

/** 优雅退出：关 logger transports → 等 HTTP keep-alive 排空 → 事件循环自然清空 */
async function gracefulExit(code: number): Promise<void> {
  process.exitCode = code;
  await closeLogger();
  console.log(`[BenchBackfill] 等待 HTTP keep-alive 连接释放（${KEEPALIVE_DRAIN_MS / 1000}s）后退出…`);
  await new Promise<void>((resolve) => setTimeout(resolve, KEEPALIVE_DRAIN_MS));
  const killer = setTimeout(() => process.exit(code), 3000);
  killer.unref();
}

main()
  .then(async () => {
    await gracefulExit(Number(process.exitCode ?? 0));
  })
  .catch(async (error: any) => {
    logger.error('parent_content 回填脚本异常终止', {
      module: MODULE,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
    console.error(`\n🔴 脚本异常终止: ${error?.message ?? error}`);
    await gracefulExit(1);
  });
