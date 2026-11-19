/**
 * ERB 评测语料摘要块重建脚本（benchmark-only，Doc Tree v1 配套）
 *
 * 背景：bench:import 刻意不复用生产入库链路（直写 collection.add），
 *       而摘要块挂在生产 publishToVectorStore / reindexVersion 两条链路上，
 *       评测库语料因此**没有摘要块** —— 本脚本补齐这一环。
 *
 * 工作方式：
 *   遍历 ERB 语料（gold-first 顺序，与 import --tier 口径一致）→ 逐篇调用
 *   addDocSummaryChunk（生产 Doc Tree 入库函数本体，保证评测与生产行为一致）：
 *   LLM 生成摘要 → 幂等去重旧摘要块 → 写 ChromaDB + BM25。
 *
 * 关键约束（与 import-erb-corpus 同款红线）：
 *   - 生产隔离：CHROMA_PERSIST_DIR 必须显式设置、CHROMA_URL 不得指向生产 8000；
 *   - 开关门卫：DOC_TREE_ENABLED 未开启时拒绝运行（否则静默空跑，误导后续评测）；
 *   - 幂等：addDocSummaryChunk 内部按 documentId+chunk_role=summary 去重，
 *     重跑安全（先删旧摘要再写新摘要）；--skip 提供 crude 续传。
 *
 * 用法示例：
 *   pnpm bench:rebuild-summaries -- --tier T1                    # 全量（≈1.1 万篇）
 *   pnpm bench:rebuild-summaries -- --tier T1 --limit 722        # 仅 gold 722 篇（快速冒烟）
 *   pnpm bench:rebuild-summaries -- --tier T1 --skip 722         # 续传：跳过 gold 段
 */

// ==================== Imports ====================

// 必须最先加载 .env：config.ts 启动即 zod fail-fast（缺 JWT_SECRET 拒绝启动），
// 且不覆盖已有 shell 环境变量（终端里 $env: 设置的 bench 隔离变量优先级更高）
import 'dotenv/config';
import { config } from '../../src/fundamentals/config.js';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import {
  addDocSummaryChunk,
  MIN_DOC_CHARS_FOR_SUMMARY,
} from '../../src/fundamentals/vector-store/doc-summary.js';
import {
  walkDocs,
  readDocContent,
  ERB_SOURCE_TYPES,
  GOLD_FIRST_TIERS,
  goldFirstSample,
  type ErbDoc,
  type ErbSourceType,
  type GoldFirstTier,
} from './lib/erb-loader.js';
import { buildDocMeta } from './lib/erb-metadata.js';

// ==================== 常量 ====================

const MODULE = 'RebuildErbSummaries';

/** 生产 ChromaDB 默认地址（bench 红线 #3：禁止指向） */
const PROD_CHROMA_URL = 'http://localhost:8000';

/** 进度日志节奏（每处理 N 篇打印一行） */
const PROGRESS_EVERY = 25;

// ==================== 类型定义 ====================

interface RebuildOptions {
  tier?: GoldFirstTier;
  sourceType?: ErbSourceType;
  limit?: number;
  skip: number;
  concurrency: number;
}

interface RebuildStats {
  processed: number;
  summariesAdded: number;
  skippedShort: number;
  failed: number;
}

// ==================== 并发控制 ====================

/** 最小信号量（与 import-erb-corpus 内部实现同款，worker 池共用） */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ==================== 参数解析 ====================

function printUsageAndExit(code: number): never {
  console.log(`用法：pnpm bench:rebuild-summaries -- [选项]

选项：
  --tier <T0|T1|T2>      gold-first 档位（须与 bench:import 的档位一致）：
                           T0 = 仅 722 gold
                           T1 = gold + 9,978 干扰（seed=42）
                           T2 = gold + 49,278 干扰（seed=43）
  --source-type <type>   仅处理单类（slack/gmail/...），不能与 --tier 同用
  --limit <n>            本次最多处理 n 篇（迭代顺序 = 语料顺序）
  --skip <n>             跳过前 n 篇（crude 续传：上次跑到哪里就从哪里继续）
  --concurrency <n>      并发数 1~32（默认 8）
  --help                 显示本帮助`);
  process.exit(code);
}

function parseArgs(argv: string[]): RebuildOptions {
  const opts: RebuildOptions = { skip: 0, concurrency: 8 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        printUsageAndExit(0);
        break;
      case '--tier': {
        const value = argv[++i];
        if (!value || !(value in GOLD_FIRST_TIERS)) {
          console.error(
            `无效的 --tier: ${value ?? '(缺失)'}，可选: ${Object.keys(GOLD_FIRST_TIERS).join(' | ')}`,
          );
          process.exit(1);
        }
        opts.tier = value as GoldFirstTier;
        break;
      }
      case '--source-type': {
        const value = argv[++i] as ErbSourceType;
        if (!value || !ERB_SOURCE_TYPES.includes(value)) {
          console.error(
            `无效的 --source-type: ${value ?? '(缺失)'}，可选: ${ERB_SOURCE_TYPES.join(' / ')}`,
          );
          process.exit(1);
        }
        opts.sourceType = value;
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
      case '--skip': {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n < 0) {
          console.error('--skip 必须是非负整数');
          process.exit(1);
        }
        opts.skip = n;
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
      default:
        console.error(`未知参数: ${arg}`);
        printUsageAndExit(1);
    }
  }
  if (opts.tier && opts.sourceType) {
    console.error('--tier 不能与 --source-type 同用');
    process.exit(1);
  }
  return opts;
}

// ==================== 生产隔离 + 开关门卫 ====================

/**
 * 启动守卫：bench 隔离红线 + DOC_TREE_ENABLED 门卫。
 *
 * 1. CHROMA_PERSIST_DIR 必须显式设置（否则 BM25 会写进生产默认目录）；
 * 2. CHROMA_URL 不得指向生产 8000；
 * 3. DOC_TREE_ENABLED 必须开启 —— addDocSummaryChunk 开关关闭时静默返回 false，
 *    全量空跑会让人误以为摘要已重建，必须在门口拦截。
 */
function assertGuards(): void {
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
        '请设置 CHROMA_URL=http://localhost:8001（benchmark 专用实例）',
    );
  }

  if (!config.docTreeEnabled) {
    problems.push(
      'DOC_TREE_ENABLED 未开启 —— addDocSummaryChunk 会静默跳过，本次运行将是全量空跑。' +
        '请设置 DOC_TREE_ENABLED=true',
    );
  }

  if (problems.length > 0) {
    console.error('🔴 启动守卫拦截，拒绝运行：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

// ==================== 主流程 ====================

/**
 * 处理单篇文档：读正文 → 调用生产 addDocSummaryChunk（内部含 LLM 摘要 /
 * 幂等去重 / ChromaDB + BM25 写入，永不抛出）。
 *
 * @returns 'added' 摘要入库 / 'short' 文档过短跳过 / 'failed' 入库失败
 */
async function processDoc(
  doc: ErbDoc,
  stats: RebuildStats,
): Promise<'added' | 'short' | 'failed'> {
  let content: string;
  try {
    content = readDocContent(doc);
  } catch (err) {
    stats.failed++;
    logger.warn('读取文档失败', {
      module: MODULE,
      documentId: doc.documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }

  if (!content || content.trim().length < MIN_DOC_CHARS_FOR_SUMMARY) {
    stats.skippedShort++;
    return 'short';
  }

  // 与 bench:import 同源的 baseMeta（documentId/source/source_type），
  // 无 versionId/versionStatus —— 检索侧版本过滤对缺失字段按 active 处理，
  // 与正文块口径一致
  const baseMeta: Record<string, unknown> = { ...buildDocMeta(doc) };
  const ok = await addDocSummaryChunk(baseMeta, doc.slug, content);
  if (ok) {
    stats.summariesAdded++;
    return 'added';
  }
  // 开关开启且文本足够长时返回 false 只剩「写入失败」一种解释
  stats.failed++;
  logger.warn('摘要块入库失败', { module: MODULE, documentId: doc.documentId });
  return 'failed';
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  assertGuards();

  const tierDef = opts.tier ? GOLD_FIRST_TIERS[opts.tier] : null;
  const tierTotal =
    tierDef !== null && tierDef !== undefined
      ? 722 + tierDef.interference
      : null;

  console.log('=== ERB 摘要块重建（Doc Tree v1，benchmark-only） ===');
  console.log(`CHROMA_URL         : ${config.chromaUrl}`);
  console.log(`CHROMA_PERSIST_DIR : ${config.chromaPersistDir}`);
  console.log(`BM25 引擎          : ${config.bm25Engine}`);
  console.log(
    `摘要模型           : deepseek:deepseek-v4-flash（超时 8s，降级抽取式兜底）`,
  );
  if (opts.tier) {
    console.log(
      `档位               : ${opts.tier}（gold-first 顺序，共 ${tierTotal} 篇，与 import --tier 口径一致）`,
    );
  }
  if (opts.sourceType) console.log(`source_type        : ${opts.sourceType}`);
  if (opts.limit !== undefined)
    console.log(`limit              : ${opts.limit}`);
  if (opts.skip > 0)
    console.log(`skip               : ${opts.skip}（crude 续传）`);
  console.log(`concurrency        : ${opts.concurrency}`);
  console.log(`过短门槛           : < ${MIN_DOC_CHARS_FOR_SUMMARY} 字符跳过`);

  // 文档源迭代器：tier 模式走 gold-first 生成器（与 import 顺序确定一致），
  // 普通模式走 walkDocs 全库遍历
  const tier = opts.tier;
  const docIterator: Iterator<ErbDoc> = tier
    ? (function* (): Generator<ErbDoc> {
        let emitted = 0;
        for (const doc of goldFirstSample(GOLD_FIRST_TIERS[tier])) {
          if (opts.limit !== undefined && emitted >= opts.limit) return;
          yield doc;
          emitted++;
        }
      })()
    : walkDocs({ sourceType: opts.sourceType, limit: opts.limit });

  // crude 续传：跳过前 N 篇（迭代顺序确定，跳过的即视为已完成）
  for (let i = 0; i < opts.skip; i++) {
    if (docIterator.next().done) break;
  }

  const stats: RebuildStats = {
    processed: 0,
    summariesAdded: 0,
    skippedShort: 0,
    failed: 0,
  };
  const semaphore = new Semaphore(opts.concurrency);

  /** 预估总量（用于进度百分比）：tier + limit 可算，纯遍历模式未知 */
  const planned =
    tierTotal !== null
      ? Math.max(0, Math.min(tierTotal, opts.limit ?? tierTotal) - opts.skip)
      : opts.limit;

  const worker = async (): Promise<void> => {
    for (;;) {
      const result = docIterator.next();
      if (result.done) return;
      await semaphore.acquire();
      try {
        const outcome = await processDoc(result.value, stats);
        stats.processed++;
        // 过短跳过不打日志（量可能很大），其余每篇一条轻量进度
        if (outcome !== 'short') {
          logger.info(
            `[${outcome}] ${stats.processed}${planned ? `/${planned}` : ''}`,
            {
              module: MODULE,
              documentId: result.value.documentId,
            },
          );
        }
        if (stats.processed % PROGRESS_EVERY === 0) {
          console.log(
            `[进度] ${stats.processed}${planned ? `/${planned}` : ''} → ` +
              `摘要 ${stats.summariesAdded}，过短 ${stats.skippedShort}，失败 ${stats.failed}`,
          );
        }
      } finally {
        semaphore.release();
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  console.log('=== 摘要块重建完成 ===');
  console.log(`已处理   : ${stats.processed}`);
  console.log(`摘要入库 : ${stats.summariesAdded}`);
  console.log(`过短跳过 : ${stats.skippedShort}`);
  console.log(`失败     : ${stats.failed}`);
  if (stats.failed > 0 && stats.summariesAdded === 0 && stats.processed > 0) {
    console.error(
      '🔴 全部失败：请检查 ChromaDB/DeepSeek 连通性后重跑（幂等，可安全续跑）',
    );
    process.exitCode = 1;
  }
}

run()
  .catch((err: unknown) => {
    console.error(
      '🔴 重建流程异常退出：',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void closeLogger();
  });
