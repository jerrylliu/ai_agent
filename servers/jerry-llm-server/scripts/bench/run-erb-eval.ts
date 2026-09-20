/**
 * EnterpriseRAG-Bench (ERB) 评测 runner（benchmark-only，方案 §5 / S3.3）
 *
 * 🔴 与线上完全一致（§5 章首 / §5.5 契约）：
 *   headless 直接调用 src/fundamentals/prompt.ts 的 promptTemplate——
 *   res=undefined 自动走非流式分支（全部 res 依赖在 if(res) 守卫内，§5.5 B），
 *   检索走线上同一条链路（FC 模式强制首轮 search_knowledge_base，
 *   或 RAG 注入模式 retrieveFromKnowledgeBase 的 0.45 阈值 + topK=3 口径），
 *   不做任何评测专属的检索参数覆盖（禁止 --topK 之类的「比线上更强」配置）。
 *
 * 🔴 三重启动守卫（fail-fast，顺序即 3/12/4 号红线）：
 *   ① 生产隔离：CHROMA_PERSIST_DIR 必须设置、CHROMA_URL ≠ 生产 8000（与 import 同款）；
 *   ② 引擎硬约束：BM25_ENGINE=tantivy（T1 库按 tantivy 落盘，minisearch 会静默
 *      新建空内存索引 → hybrid 退化纯向量 → Document Recall 虚低，§5.4）；
 *   ③ 语义缓存必须关闭：SEMANTIC_CACHE_ENABLED=false（否则 Conflicting Info 等
 *      同话题成对题第二次检索命中缓存，document_ids/contexts 失真，§5.2 坑 4）。
 *
 * 🔴 模型与 Key（模型选择是 model-provider 模块态，不持久化，见 model-provider.ts）：
 *   - 启动时 await loadApiKeysFromStorage() 从 Redis 恢复 API Key（只读，零写入）；
 *   - --model <modelId> 显式指定评测模型并经 switchModel() 校验（缺省用当前
 *     currentModelId——注意进程默认是 ollama:minicpm，评测时务必显式指定）；
 *   - Redis 无 Key 时可用 --deepseek-key / --zhipu-key 直传（不落日志）。
 *
 * 输出（方案 §5.1）：answers.jsonl，每行
 *   {"question_id","answer","document_ids","contexts","bench_meta"}
 *   - answer：非流式返回值 AIMessage.content（已剥离 think/DSML 工具块）；
 *   - document_ids：检索命中 dsid 去重集（S3.2 扩展的 UsageData.retrievedDocumentIds，
 *     FC 模式跨全部工具轮次聚合 / RAG 模式取 retrievalResults）；
 *   - contexts：实际送入生成的上下文文本（ragas 用，官方 schema 外自有扩展）；
 *   - bench_meta：自有扩展（model_id / duration_ms / used_knowledge_base），
 *     官方 harness 忽略未知字段。
 *
 * S3.5 执行模型（方案 §5.3）：
 *   - `--concurrency <n>`（默认 5，上限 10）：题目级 worker pool，抢占式领取
 *     （claim-by-index）；appendFileSync 为同步写，事件循环内不会交错，无需文件锁。
 *     落盘顺序 = 完成顺序（非题目顺序），官方 harness 按 question_id 消费，顺序无关。
 *   - `--resume`：读取已落盘 answers.jsonl，跳过已有成功行的题目（error 行不算
 *     完成，会重跑）；顺带清洗 malformed 行（进程崩溃可能留下半行，官方 harness
 *     消费不了脏行）；跨模型混跑时打警告（mixed model 会失真评分）。
 *
 * S3.4 聚合口径（红线 #6：不改 metrics.ts，过滤在 runner 侧）：
 *   - 空 gold 题（expected_doc_ids 为空，实测 = high_level 10 + info_not_found 20
 *     共 30 题）在聚合前剔除出 Document Recall 分母——metrics.ts 对空 gold 一律
 *     返回 0，aggregateResults 只滤 error 不过滤空 gold，不剔除会被 0 分样本拉低
 *     均值约 6%（30/500）；
 *   - 另出独立桶：info_not_found 拒答启发式（词面匹配，LLM judge 属阶段 3 §6.2）、
 *     high_level 计数（质量由官方 harness 判定）；
 *   - 评测结束与 --aggregate-only 模式均产出 eval-summary.json，内含对照口径
 *     （空 gold 若计入的均值）与 dragByMetric（被拉低量），用于核对 ≈6% 判据。
 *
 * 用法示例：
 *   # 单题冒烟（S3.3 判据）
 *   pnpm bench:eval -- --question-id qst_xxxx --model deepseek:deepseek-v4-flash
 *   # 前 20 题试跑
 *   pnpm bench:eval -- --limit 20 --model deepseek:deepseek-v4-flash
 *   # 500 题全量（并发 5，中断后原命令重跑即自动续传）
 *   pnpm bench:eval -- --model deepseek:deepseek-v4-flash --concurrency 5 --resume
 *   # 只聚合已落盘的 answers.jsonl（S3.4，不执行题目、不连向量库）
 *   pnpm bench:eval -- --aggregate-only
 *
 * 运行前提（与 bench:import 相同）：
 *   CHROMA_URL=http://localhost:8001
 *   CHROMA_PERSIST_DIR=E:\ragbench\bm25
 *   BM25_ENGINE=tantivy
 *   SEMANTIC_CACHE_ENABLED=false
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量，模式与 bench:import 一致）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../src/fundamentals/config.js';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { getRuntimeConfig } from '../../src/fundamentals/runtime-config.js';
import { initializeVectorStore } from '../../src/fundamentals/vector-store/store-state.js';
import { getSearchInfraFailureCount, resetSearchInfraFailureCount } from '../../src/fundamentals/vector-store/vector-search.js';
import { promptTemplate, type UsageData } from '../../src/fundamentals/prompt.js';
import { getRedis, waitForRedisReady } from '../../src/fundamentals/redis-client.js';
import {
  loadApiKeysFromStorage,
  setDeepseekApiKey,
  setZhipuApiKey,
  switchModel,
  getCurrentModelId,
} from '../../src/fundamentals/model-provider.js';
import { llmRateLimiter } from '../../src/fundamentals/llm-rate-limiter.js';
import { loadQuestions, type ErbQuestion } from './lib/erb-loader.js';
import {
  aggregateResults,
  evaluateQuery,
  type SingleQueryEval,
} from '../../src/fundamentals/eval/metrics.js';

// ==================== 常量 ====================

const MODULE = 'BenchEval';

/** 生产 ChromaDB 默认地址（红线 #3：脚本禁止指向它，与 bench:import 同款守卫） */
const PROD_CHROMA_URL = 'http://localhost:8000';

/** 题目并发默认值（方案 §5.4：并发 5–10，取下沿保守起步，防 DeepSeek 限流） */
const DEFAULT_CONCURRENCY = 5;

/** 题目并发上限（DeepSeek API 侧并发余量考虑，超出需人工确认） */
const MAX_CONCURRENCY = 10;

/**
 * 检索基础设施失败熔断阈值：Chroma/BM25 失败在检索层被 catch 吞掉（生产弹性设计），
 * 评测场景下静默退化会污染数据（向量路 0 命中 → 纯 BM25 单路）。健康跑失败数恒为 0，
 * 累计超过此值即中止评测——已有成功行保留，--resume 续传。
 */
const MAX_SEARCH_INFRA_FAILURES = 3;

// ==================== CLI 参数 ====================

interface EvalCliOptions {
  /** 只跑指定 question_id 的单题（S3.3 冒烟判据入口） */
  questionId?: string;
  /** 无 --question-id 时最多跑前 N 题（缺省全部 500 题） */
  limit?: number;
  /** 覆盖 answers.jsonl 输出路径（缺省 <CHROMA_PERSIST_DIR>/answers.jsonl） */
  output?: string;
  /** 评测模型 id（经 switchModel 校验；缺省用当前 currentModelId） */
  model?: string;
  /** DeepSeek API Key 直传（Redis 未恢复 Key 时的兜底，不落日志） */
  deepseekKey?: string;
  /** 智谱 API Key 直传（同上） */
  zhipuKey?: string;
  /** S3.4：只聚合已落盘 answers.jsonl（纯文件计算，不执行题目、不连向量库/Redis） */
  aggregateOnly?: boolean;
  /** S3.5：把 append-only 运行日志清洗为官方 harness 可直接消费的规范 answers.jsonl */
  compactOnly?: boolean;
  /** S3.5：断点续传——跳过已有成功行的题目，追加落盘（缺省全新开始，截断文件） */
  resume?: boolean;
  /** S3.5：题目并发数（缺省 5，上限 10） */
  concurrency?: number;
  /** 限定题型（逗号分隔，如 --type semantic,basic；缺省不过滤）。
   *  快速评测用：ERB 前 175 题全是 basic，semantic 集中在 176-201 行，
   *  --limit 前缀切片永远碰不到 semantic 块，必须按题型选题 */
  types?: string[];
}

function parseArgs(argv: string[]): EvalCliOptions {
  const opts: EvalCliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      if (i + 1 >= argv.length) {
        console.error(`缺少参数值：${arg}`);
        process.exit(1);
      }
      return argv[++i];
    };
    switch (arg) {
      case '--question-id':
        opts.questionId = next();
        break;
      case '--limit': {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) {
          console.error('--limit 必须是正整数');
          process.exit(1);
        }
        opts.limit = n;
        break;
      }
      case '--output':
        opts.output = next();
        break;
      case '--model':
        opts.model = next();
        break;
      case '--deepseek-key':
        opts.deepseekKey = next();
        break;
      case '--zhipu-key':
        opts.zhipuKey = next();
        break;
      case '--aggregate-only':
        opts.aggregateOnly = true;
        break;
      case '--compact-only':
        opts.compactOnly = true;
        break;
      case '--resume':
        opts.resume = true;
        break;
      case '--concurrency': {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) {
          console.error('--concurrency 必须是正整数');
          process.exit(1);
        }
        if (n > MAX_CONCURRENCY) {
          console.error(`--concurrency 上限为 ${MAX_CONCURRENCY}（线上 API 限流余量考虑）`);
          process.exit(1);
        }
        opts.concurrency = n;
        break;
      }
      case '--type':
        opts.types = (opts.types ?? []).concat(
          next().split(',').map((t) => t.trim()).filter((t) => t.length > 0),
        );
        break;
      case '--help':
      case '-h':
        console.log(
          [
            '用法：pnpm bench:eval -- [options]',
            '  --question-id <id>    只跑单题（冒烟判据）',
            '  --limit <n>           无 --question-id 时跑前 n 题',
            '  --output <path>       覆盖 answers.jsonl 输出路径',
            '  --model <modelId>     评测模型（如 deepseek:deepseek-v4-flash）',
            '  --deepseek-key <key>  DeepSeek API Key 直传（Redis 未恢复时兜底）',
            '  --zhipu-key <key>     智谱 API Key 直传',
            '  --concurrency <n>     题目并发数（默认 5，上限 10）',
            '  --type <t1,t2>        限定题型（逗号分隔，如 --type semantic,basic）',
            '  --resume              断点续传：跳过已有成功行的题目，追加落盘',
            '  --aggregate-only      只聚合已落盘 answers.jsonl（S3.4 口径），不执行题目',
            '  --compact-only        清洗 answers.jsonl 为官方 harness 可消费的规范文件（去重/剔除失败行）',
          ].join('\n'),
        );
        process.exit(0);
      default:
        console.error(`未知参数：${arg}（--help 查看用法）`);
        process.exit(1);
    }
  }
  // 离线模式（聚合/清洗）是纯文件计算，执行类参数全部无意义，直接拒绝避免「以为跑了题」的误解
  const execOnlyArgs = opts.questionId || opts.limit || opts.model || opts.deepseekKey || opts.zhipuKey ||
    opts.resume || opts.concurrency !== undefined || opts.types !== undefined;
  if ((opts.aggregateOnly || opts.compactOnly) && execOnlyArgs) {
    const mode = opts.aggregateOnly ? '--aggregate-only' : '--compact-only';
    console.error(
      `${mode} 是纯离线模式，不接受 --question-id/--limit/--model/--deepseek-key/--zhipu-key/--resume/--concurrency`,
    );
    process.exit(1);
  }
  if (opts.aggregateOnly && opts.compactOnly) {
    console.error('--aggregate-only 与 --compact-only 不能同用（后者已包含聚合收尾）');
    process.exit(1);
  }
  return opts;
}

// ==================== 启动守卫 ====================

/**
 * 生产隔离守卫（红线 #3）：评测模式与 S3.4 聚合模式共用。
 * 返回问题清单，空数组 = 通过。
 */
function collectIsolationProblems(): string[] {
  const problems: string[] = [];

  if (!config.chromaPersistDir) {
    problems.push(
      'CHROMA_PERSIST_DIR 未设置 —— 检索会连到生产数据目录。' +
        '请设置 benchmark 专用目录，如 CHROMA_PERSIST_DIR=E:\\ragbench\\bm25',
    );
  }
  const chromaUrl = config.chromaUrl.replace(/\/+$/, '');
  if (chromaUrl === PROD_CHROMA_URL) {
    problems.push(
      `CHROMA_URL 仍指向生产实例 ${PROD_CHROMA_URL}。` +
        '请设置 benchmark 专用实例 CHROMA_URL=http://localhost:8001',
    );
  }

  return problems;
}

/**
 * 三重启动守卫（fail-fast，评测模式专用）：
 * ① 生产隔离（红线 #3）② 引擎硬约束（红线 #12）③ 语义缓存关闭（红线 #4）
 * 任何一条不满足都拒绝运行——评测数字宁可跑不出来，不可静默失真。
 * （S3.4 聚合模式只做文件计算、不发生检索，②③不适用，仅复用 ①。）
 */
function assertEvalGuards(): void {
  const problems: string[] = collectIsolationProblems();

  // ② 引擎硬约束：T1 库按 tantivy 落盘，bench 目录不存在 bm25_index.json
  if (config.bm25Engine !== 'tantivy') {
    problems.push(
      `BM25_ENGINE 必须为 tantivy（当前=${config.bm25Engine}）。` +
        'minisearch 下 bench 目录无 bm25_index.json 会新建空内存索引，' +
        'hybrid 检索静默退化为纯向量，Document Recall 虚低且无报错（红线 #12 / §5.4）',
    );
  }

  // ③ 语义缓存必须显式关闭（config zod 默认 true）
  if (config.semanticCacheEnabled !== false) {
    problems.push(
      'SEMANTIC_CACHE_ENABLED 必须为 false（当前未关闭）。' +
        '语义缓存会让同话题成对题第二次检索命中缓存，document_ids/contexts 失真（红线 #4 / §5.2 坑 4）',
    );
  }

  if (problems.length > 0) {
    console.error('🔴 评测启动守卫拦截（红线 #3/#4/#12），拒绝运行：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  logger.info('评测启动守卫通过', {
    module: MODULE,
    chromaUrl: config.chromaUrl,
    persistDir: config.chromaPersistDir,
    bm25Engine: config.bm25Engine,
    semanticCacheEnabled: config.semanticCacheEnabled,
  });
}

// ==================== 单题执行 ====================

/** answers.jsonl 单行记录（官方三字段 + 自有 bench_meta 扩展） */
interface AnswerRecord {
  question_id: string;
  answer: string;
  document_ids: string[];
  contexts: string[];
  bench_meta: {
    model_id: string;
    duration_ms: number;
    used_knowledge_base: boolean;
    question_type: string;
  };
}

/** 单题失败记录（error 行与成功行同写 answers.jsonl，S3.5 的 --resume 依赖此区分） */
interface ErrorRecord {
  question_id: string;
  error: string;
}

/**
 * headless 执行单题：promptTemplate（res=undefined → 非流式分支，§5.5 契约）。
 * 不传 sessionId —— 会话摘要/资产缓存/记忆注入全部短路（§5.5 E，生产零污染）。
 */
async function runQuestion(q: ErbQuestion): Promise<AnswerRecord> {
  const startedAt = Date.now();
  let usage: UsageData | null = null;

  const aiMessage = await promptTemplate(
    q.question,
    undefined, // images：评测无图片输入
    [], // history：500 题互相独立，无对话上下文
    undefined, // res：headless → 自动走非流式分支（§5.5 B）
    undefined, // sessionSummary：无 sessionId 即无摘要
    [], // userMemories：不注入记忆
    () => false, // isCancelled：评测不取消
    undefined, // abortController
    'bench', // userId：仅进日志与 usage
    undefined, // sessionId：全部会话副作用短路（§5.5 E）
    (u: UsageData) => {
      usage = u;
    }, // onUsageComplete：S3.2 扩展字段采集点
    undefined, // imageModel
  );

  // TS 控制流看不到回调内的赋值（onUsageComplete 同步触发于 promptTemplate 内部），
  // 此处 usage 被窄化为 null，需显式断言还原真实类型
  const u = usage as UsageData | null;
  const rawContent: unknown = (aiMessage as { content?: unknown } | null)?.content;
  const answer = typeof rawContent === 'string' ? rawContent : rawContent == null ? '' : JSON.stringify(rawContent);

  return {
    question_id: q.question_id,
    answer,
    document_ids: u?.retrievedDocumentIds ?? [],
    contexts: u?.retrievedContexts ?? [],
    bench_meta: {
      model_id: getCurrentModelId(),
      duration_ms: Date.now() - startedAt,
      used_knowledge_base: u?.usedKnowledgeBase ?? false,
      question_type: q.question_type,
    },
  };
}

// ==================== S3.4 聚合口径（空 gold 剔除 + 拒答/高层独立桶） ====================

/**
 * Document Recall 的 K 值清单。
 * 检索链路实际产出量级：FC 单轮工具 top_k=3（多轮聚合后全集可到 6+）、RAG topK=3；
 * K 大于该题实际检索长度时 Recall@K 饱和（等于 Recall@实际长度），属预期现象。
 */
const K_VALUES = [3, 5, 10];

/**
 * info_not_found 拒答启发式（S3.4 独立口径）。
 * 命中任一模式视为「正确拒答」。纯词面匹配必有误判（答案转述文档原文可能含
 * "not specified" 等），仅作本阶段低成本口径；LLM judge 精判属阶段 3（§6.2）。
 * ERB 语料与题目均为英文，模式以英文为主、中文兜底。
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /\b(no information|no such|no matching|no relevant|no corresponding|no evidence|no record|no details|no mention|not found|not available|not specified|not documented|not mentioned|not provided|not present|not included|not covered|not defined|cannot|can't|couldn't|could not|unable to|doesn't exist|do not exist)\b/i,
  /信息不足|未找到|没有找到|不存在|未提及|无相关/,
];

/** answers.jsonl 单行解析结果（成功记录 / 错误记录） */
type ParsedAnswerLine = { kind: 'ok'; record: AnswerRecord } | { kind: 'error'; record: ErrorRecord };

/** S3.4 聚合摘要（写入 eval-summary.json 的完整结构） */
interface ErbAggregateSummary {
  generatedAt: string;
  kValues: number[];
  /** 收集完整性（missing / malformed 由 S3.5 --resume 补齐后归零） */
  collection: {
    totalQuestions: number;
    answeredOk: number;
    answeredError: number;
    missing: number;
    malformedLines: number;
    orphanLines: number;
    duplicateLines: number;
  };
  /** Document Recall（官方口径：空 gold 已剔除出分母；metrics.ts 本体零改动，红线 #6） */
  documentRecall: {
    evaluableCount: number;
    excludedEmptyGoldCount: number;
    aggregate: Record<string, number>;
    byQuestionType: Record<string, Record<string, number>>;
    /** 对照口径：空 gold 若计入将以全 0 参与均值（复现 metrics.ts 对空 gold 返回 0 的现状） */
    counterfactualAggregateIfIncluded: Record<string, number>;
    /** 官方口径 − 对照口径（正值 = 被空 gold 0 分样本拉低的量；500 题全量后核对 ≈6%，判据） */
    dragByMetric: Record<string, number>;
  };
  /** 空 gold 独立桶（不进 Document Recall 分母） */
  emptyGoldBuckets: {
    byQuestionType: Record<string, number>;
    infoNotFoundRefusalHeuristic: {
      total: number;
      refused: number;
      refusalRate: number;
      note: string;
    };
    highLevel: { total: number; meanAnswerChars: number; note: string };
  };
  /** 口径交叉校验警告：空 gold 类型异常 / 有 gold 却属免检索题型（数据异常时人工介入） */
  typeMismatchWarnings: string[];
}

/** 行结构守卫：error 行 */
function isErrorRecord(obj: unknown): obj is ErrorRecord {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'error' in obj &&
    typeof (obj as { error: unknown }).error === 'string'
  );
}

/** 行结构守卫：成功行（字段/类型不齐视同 malformed，不进聚合） */
function isAnswerRecord(obj: unknown): obj is AnswerRecord {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.question_id === 'string' &&
    typeof r.answer === 'string' &&
    Array.isArray(r.document_ids) &&
    r.document_ids.every((x) => typeof x === 'string') &&
    Array.isArray(r.contexts) &&
    r.contexts.every((x) => typeof x === 'string') &&
    typeof r.bench_meta === 'object' &&
    r.bench_meta !== null
  );
}

/** 读取 answers.jsonl 全部行（JSON 解析失败或结构不齐的行计入 malformedLines） */
function readAnswerLines(answersPath: string): { lines: ParsedAnswerLine[]; malformedLines: number } {
  const raw = fs.readFileSync(answersPath, 'utf-8');
  const lines: ParsedAnswerLine[] = [];
  let malformedLines = 0;
  for (const lineText of raw.split('\n')) {
    const trimmed = lineText.trim();
    if (!trimmed) continue;
    try {
      const obj: unknown = JSON.parse(trimmed);
      if (isErrorRecord(obj)) {
        lines.push({ kind: 'error', record: obj });
      } else if (isAnswerRecord(obj)) {
        lines.push({ kind: 'ok', record: obj });
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }
  return { lines, malformedLines };
}

/** 保留 4 位小数（与 metrics.ts 的 round 精度一致） */
function roundN(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 单题评估条目构造（question_type 作 category，复用 aggregateResults 的分组能力） */
function toSingleQueryEval(q: ErbQuestion, r: AnswerRecord): SingleQueryEval {
  return {
    sampleId: q.question_id,
    query: q.question,
    retrievedDocIds: r.document_ids,
    expectedDocIds: q.expected_doc_ids,
    metrics: evaluateQuery(r.document_ids, q.expected_doc_ids, K_VALUES),
    category: q.question_type,
    durationMs: r.bench_meta.duration_ms,
  };
}

/**
 * S3.4 聚合（纯函数）：空 gold 剔除 + 独立桶 + 对照口径。
 *
 * 分桶规则：以 expected_doc_ids.length === 0 为主判据（Document Recall 分母问题的
 * 根源即空 gold），question_type（high_level / info_not_found）做交叉校验——两者在
 * 实测数据上完全重合（30 题，方案 §2.2）；若出现不一致说明数据异常，记录警告而非
 * 静默归类，避免口径漂移。
 */
function aggregateAnswers(
  questions: ErbQuestion[],
  lines: ParsedAnswerLine[],
  malformedLines: number,
): ErbAggregateSummary {
  const questionById = new Map(questions.map((q) => [q.question_id, q]));

  // 行侧收集：重复行 last-wins（S3.5 --resume 重跑覆盖旧结果的语义）；孤儿行计数
  const okById = new Map<string, AnswerRecord>();
  const errorIds = new Set<string>();
  let orphanLines = 0;
  let duplicateLines = 0;
  for (const line of lines) {
    if (line.kind === 'error') {
      if (questionById.has(line.record.question_id)) {
        errorIds.add(line.record.question_id);
      } else {
        orphanLines++;
      }
      continue;
    }
    if (!questionById.has(line.record.question_id)) {
      orphanLines++;
      continue;
    }
    if (okById.has(line.record.question_id)) {
      duplicateLines++;
    }
    okById.set(line.record.question_id, line.record);
  }

  // 题侧分桶：非空 gold → 官方口径；空 gold → 剔除出分母并进独立桶
  const recallable: SingleQueryEval[] = [];
  const counterfactual: SingleQueryEval[] = [];
  const emptyGoldTypes: Record<string, number> = {};
  let excludedEmptyGold = 0;
  let infoNotFoundTotal = 0;
  let infoNotFoundRefused = 0;
  let highLevelTotal = 0;
  let highLevelAnswerChars = 0;
  let answeredError = 0;
  let missing = 0;
  const typeMismatchWarnings: string[] = [];

  for (const q of questions) {
    const ok = okById.get(q.question_id);
    if (!ok) {
      // 有 error 行无成功行 = 该题失败；两者皆无 = 未跑（S3.5 --resume 补齐）
      if (errorIds.has(q.question_id)) answeredError++;
      else missing++;
      continue;
    }

    if (q.expected_doc_ids.length === 0) {
      excludedEmptyGold++;
      emptyGoldTypes[q.question_type] = (emptyGoldTypes[q.question_type] ?? 0) + 1;
      if (q.question_type !== 'high_level' && q.question_type !== 'info_not_found') {
        typeMismatchWarnings.push(
          `${q.question_id} 空 gold 但 question_type=${q.question_type}（预期仅 high_level/info_not_found）`,
        );
      }
      // 对照口径：metrics.ts 对空 gold 一律返回 0 → 复现「不剔除即被拉低」的现状
      counterfactual.push(toSingleQueryEval(q, ok));
      if (q.question_type === 'info_not_found') {
        infoNotFoundTotal++;
        if (REFUSAL_PATTERNS.some((re) => re.test(ok.answer))) infoNotFoundRefused++;
      } else if (q.question_type === 'high_level') {
        highLevelTotal++;
        highLevelAnswerChars += ok.answer.length;
      }
      continue;
    }

    if (q.question_type === 'high_level' || q.question_type === 'info_not_found') {
      typeMismatchWarnings.push(
        `${q.question_id} 有 gold（${q.expected_doc_ids.length} 个）但 question_type=${q.question_type}（预期免检索题型无 gold）`,
      );
    }
    const entry = toSingleQueryEval(q, ok);
    recallable.push(entry);
    counterfactual.push(entry);
  }

  const params = {
    topK: K_VALUES[K_VALUES.length - 1],
    kValues: K_VALUES,
    searchType: 'hybrid(fc线上链路)',
  };
  const official = aggregateResults(recallable, params);
  const counterfactualReport = aggregateResults(counterfactual, params);

  const dragByMetric: Record<string, number> = {};
  for (const [key, value] of Object.entries(official.aggregate)) {
    dragByMetric[key] = roundN(value - (counterfactualReport.aggregate[key] ?? 0));
  }

  return {
    generatedAt: new Date().toISOString(),
    kValues: K_VALUES,
    collection: {
      totalQuestions: questions.length,
      answeredOk: okById.size,
      answeredError,
      missing,
      malformedLines,
      orphanLines,
      duplicateLines,
    },
    documentRecall: {
      evaluableCount: recallable.length,
      excludedEmptyGoldCount: excludedEmptyGold,
      aggregate: official.aggregate,
      byQuestionType: official.byCategory,
      counterfactualAggregateIfIncluded: counterfactualReport.aggregate,
      dragByMetric,
    },
    emptyGoldBuckets: {
      byQuestionType: emptyGoldTypes,
      infoNotFoundRefusalHeuristic: {
        total: infoNotFoundTotal,
        refused: infoNotFoundRefused,
        refusalRate: infoNotFoundTotal === 0 ? 0 : roundN(infoNotFoundRefused / infoNotFoundTotal),
        note: '启发式词面匹配口径（S3.4）；LLM judge 精判属阶段 3（§6.2 refusalAccuracy）',
      },
      highLevel: {
        total: highLevelTotal,
        meanAnswerChars: highLevelTotal === 0 ? 0 : Math.round(highLevelAnswerChars / highLevelTotal),
        note: '无文档级 gold；质量由官方 harness correctness/completeness 判定，不进 Document Recall',
      },
    },
    typeMismatchWarnings,
  };
}

/** 聚合摘要落盘：eval-summary.json（与 answers.jsonl 同目录） */
function writeAggregateSummary(summary: ErbAggregateSummary, answersPath: string): string {
  const summaryPath = path.join(path.dirname(answersPath), 'eval-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  return summaryPath;
}

/** 聚合摘要日志（分块输出，关键字段直接可读） */
function logAggregateSummary(summary: ErbAggregateSummary): void {
  const { collection, documentRecall, emptyGoldBuckets } = summary;
  logger.info('S3.4 聚合：Document Recall（官方口径，空 gold 已剔除）', {
    module: MODULE,
    evaluableCount: documentRecall.evaluableCount,
    excludedEmptyGoldCount: documentRecall.excludedEmptyGoldCount,
    aggregate: documentRecall.aggregate,
    byQuestionType: documentRecall.byQuestionType,
  });
  logger.info('S3.4 聚合：对照口径（空 gold 若计入将全 0 拉低均值）', {
    module: MODULE,
    counterfactualAggregateIfIncluded: documentRecall.counterfactualAggregateIfIncluded,
    dragByMetric: documentRecall.dragByMetric,
  });
  logger.info('S3.4 聚合：空 gold 独立桶', {
    module: MODULE,
    byQuestionType: emptyGoldBuckets.byQuestionType,
    infoNotFoundRefusal: emptyGoldBuckets.infoNotFoundRefusalHeuristic,
    highLevel: emptyGoldBuckets.highLevel,
  });
  logger.info('S3.4 聚合：收集完整性', { module: MODULE, ...collection });
  for (const w of summary.typeMismatchWarnings) {
    logger.warn('S3.4 聚合：口径交叉校验警告', { module: MODULE, warning: w });
  }
}

// ==================== S3.5 结果清洗（官方 harness 消费口径） ====================

/** 清洗前的原始运行日志留档名（与 answers.jsonl 同目录） */
const RUN_LOG_FILENAME = 'answers.runlog.jsonl';

interface CompactResult {
  /** 清洗后的规范行数（= 成功落盘题目数） */
  kept: number;
  /** 被折叠的重复行数（同题多次落盘，取最后一行） */
  duplicatesCollapsed: number;
  /** 被剔除的失败行数（{question_id, error}） */
  errorRowsDropped: number;
  /** 被剔除的 malformed 行数 */
  malformedDropped: number;
  /** 被剔除的孤儿行数（question_id 不在题目集中） */
  orphanDropped: number;
  /** 始终无成功结果的题目 ID（= 未被评测，必须人工介入补跑） */
  unresolved: string[];
  /** 原始日志留档路径 */
  rawLogPath: string;
  /** 本次是否新建留档（false = 已存在，未覆盖） */
  rawLogCreated: boolean;
}

/**
 * 清洗 append-only 运行日志为官方 harness 可直接消费的规范 answers.jsonl（S3.5 / Gate P2）。
 *
 * 为什么必须清洗：
 *   - 评测期间是 append 追加（--resume 友好），失败题重跑后同一 question_id 会留下多行
 *     （历史 error 行 + 新成功行），官方 metrics_based_eval 消费不了重复行；
 *   - 失败题落盘为 `{question_id, error}`，缺 answer/document_ids/contexts 字段，
 *     不满足 §5.1 的字段契约（Gate P2 判据「字段齐全」）。
 * 清洗口径（与 aggregateAnswers 的统计口径严格一致）：
 *   - 按 question_id last-wins 取最后一行（resume 重跑覆盖旧结果的语义）；
 *   - 最终仍为 error 的题剔除出文件并在日志中报错——文件里没有它即「该题未被评测」，
 *     不得静默当作已完成（红线：不允许静默降级）；
 *   - malformed 行（半行/结构不齐）与孤儿行（question_id 不在题目集中）剔除。
 * 非破坏性：清洗前原始日志留档到 answers.runlog.jsonl；已存在则不覆盖，
 *   避免多次清洗把留档覆盖成清洗后的内容（丢证据）。
 * 幂等：对已清洗文件重复执行结果不变（无重复行、无 error 行）。
 */
function compactAnswersFile(answersPath: string, questions: ErbQuestion[]): CompactResult {
  const { lines, malformedLines } = readAnswerLines(answersPath);
  const questionIds = new Set(questions.map((q) => q.question_id));

  const okById = new Map<string, AnswerRecord>();
  const errorIds = new Set<string>();
  let duplicatesCollapsed = 0;
  let errorRowsDropped = 0;
  let orphanDropped = 0;

  for (const line of lines) {
    if (!questionIds.has(line.record.question_id)) {
      orphanDropped++;
      continue;
    }
    if (line.kind === 'error') {
      errorIds.add(line.record.question_id);
      errorRowsDropped++;
      continue;
    }
    if (okById.has(line.record.question_id)) {
      duplicatesCollapsed++;
    }
    okById.set(line.record.question_id, line.record);
  }

  const unresolved = [...errorIds].filter((id) => !okById.has(id)).sort();
  // 按题目集原序输出：便于人工与 questions.jsonl 逐行比对，也让 harness 输入稳定可复现
  const keptRecords = questions
    .map((q) => okById.get(q.question_id))
    .filter((r): r is AnswerRecord => r !== undefined);

  const rawLogPath = path.join(path.dirname(answersPath), RUN_LOG_FILENAME);
  let rawLogCreated = false;
  if (!fs.existsSync(rawLogPath)) {
    fs.copyFileSync(answersPath, rawLogPath);
    rawLogCreated = true;
  }
  fs.writeFileSync(
    answersPath,
    keptRecords.length > 0 ? `${keptRecords.map((r) => JSON.stringify(r)).join('\n')}\n` : '',
    'utf-8',
  );

  return {
    kept: keptRecords.length,
    duplicatesCollapsed,
    errorRowsDropped,
    malformedDropped: malformedLines,
    orphanDropped,
    unresolved,
    rawLogPath,
    rawLogCreated,
  };
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // ---- S3.4 聚合模式：纯文件计算，不初始化向量库/Redis/模型 ----
  // 引擎/缓存守卫（②③）不适用——不发生任何检索；仅保留生产隔离守卫 ①，
  // 因为输出路径缺省取自 CHROMA_PERSIST_DIR，需防误指生产目录
  if (opts.aggregateOnly) {
    const isolationProblems = collectIsolationProblems();
    if (isolationProblems.length > 0) {
      console.error('🔴 生产隔离守卫拦截（红线 #3），拒绝运行：');
      for (const p of isolationProblems) console.error(`  - ${p}`);
      await closeLogger();
      process.exit(1);
    }

    const answersPath = opts.output ?? path.join(config.chromaPersistDir!, 'answers.jsonl');
    if (!fs.existsSync(answersPath)) {
      console.error(`🔴 answers.jsonl 不存在：${answersPath}（先运行评测，或用 --output 指定已有结果文件）`);
      await closeLogger();
      process.exit(1);
    }

    const { lines, malformedLines } = readAnswerLines(answersPath);
    const summary = aggregateAnswers(loadQuestions(), lines, malformedLines);
    logAggregateSummary(summary);
    const summaryPath = writeAggregateSummary(summary, answersPath);
    logger.info('聚合摘要已写入（--aggregate-only）', { module: MODULE, answersPath, summaryPath });
    await closeLogger();
    return;
  }

  // ---- S3.5 清洗模式：把 append-only 运行日志压实为官方 harness 消费的规范文件 ----
  // 同 --aggregate-only：纯文件计算，不发生检索，故只保留生产隔离守卫 ①
  if (opts.compactOnly) {
    const isolationProblems = collectIsolationProblems();
    if (isolationProblems.length > 0) {
      console.error('🔴 生产隔离守卫拦截（红线 #3），拒绝运行：');
      for (const p of isolationProblems) console.error(`  - ${p}`);
      await closeLogger();
      process.exit(1);
    }

    const answersPath = opts.output ?? path.join(config.chromaPersistDir!, 'answers.jsonl');
    if (!fs.existsSync(answersPath)) {
      console.error(`🔴 answers.jsonl 不存在：${answersPath}（先运行评测，或用 --output 指定已有结果文件）`);
      await closeLogger();
      process.exit(1);
    }

    const questions = loadQuestions();
    const result = compactAnswersFile(answersPath, questions);
    // 清洗改变了文件内容，需重算聚合并刷新 eval-summary.json，保证两者同步
    const { lines, malformedLines } = readAnswerLines(answersPath);
    const summary = aggregateAnswers(questions, lines, malformedLines);
    logAggregateSummary(summary);
    const summaryPath = writeAggregateSummary(summary, answersPath);
    logger.info('结果清洗完成（--compact-only）', {
      module: MODULE,
      answersPath,
      summaryPath,
      kept: result.kept,
      duplicatesCollapsed: result.duplicatesCollapsed,
      errorRowsDropped: result.errorRowsDropped,
      malformedDropped: result.malformedDropped,
      orphanDropped: result.orphanDropped,
      rawLogPath: result.rawLogPath,
      rawLogCreated: result.rawLogCreated,
    });

    if (result.unresolved.length > 0) {
      // 非 0 退出：文件里没有这些题 = 它们未被评测，必须补跑（不得静默当作完成）
      logger.error('清洗后仍有题目无成功结果，需补跑后重新清洗', {
        module: MODULE,
        unresolvedCount: result.unresolved.length,
        unresolvedSample: result.unresolved.slice(0, 20).join(', '),
      });
      process.exitCode = 1;
    }
    await closeLogger();
    return;
  }

  // ---- 评测模式 ----
  assertEvalGuards();

  // runtime-config.json 必须先于 initializeVectorStore 加载（嵌入/模型配置来源，与 bench:import 同序）
  const runtimeConfig = getRuntimeConfig();
  logger.info('runtime-config 已加载', { module: MODULE, runtimePath: runtimeConfig ? '(loaded)' : '(empty)' });

  // ==================== 评测专用：抬升本地令牌桶（干净基线的前提） ====================
  // llm-rate-limiter 对 deepseek 硬编码 providerRPM=30（本地自我限流，为交互式单用户场景保守设置）。
  // ERB 每题约 8-9 次 LLM 调用，30 RPM 只能支撑 ~3.3 题/分：主跑实测 3.4 题/分贴桶运行，
  // 排队时间计入改写 5s 预算 → 改写降级率 38.5%、追问 782 次跳过、34 题整题超限失败。
  // 生产交互是单用户逐题，永远到不了这个密度；评测批量跑反而被自限扭曲成「降级基线」。
  // 此处抬到 600（= 10 calls/s，仍是 fast 池 12 并发信号量兜底，真实 API 零 429 实证可承载），
  // 让 5s 超时预算回归「纯执行时间」本义。仅本进程内存生效（updateConfig 不落盘），生产服务零影响。
  llmRateLimiter.updateConfig({ providerRPM: { deepseek: 600, zhipu: 600 } });
  logger.info('评测模式：本地令牌桶已抬升（deepseek/zhipu → 600 RPM），排除自限排队干扰', { module: MODULE });

  // API Key 恢复：镜像 main.ts 启动序列（getRedis 预热 → 等就绪 → 恢复）。
  // 对 Redis 只读（api-key:*），零写入；REDIS_ENABLED=false 或连不上时跳过（改用 CLI 直传 Key）
  getRedis();
  await waitForRedisReady(5000);
  await loadApiKeysFromStorage();

  // CLI 直传 Key 优先于 Redis 恢复（bench 专机场景兜底；不落日志）
  if (opts.deepseekKey) setDeepseekApiKey(opts.deepseekKey);
  if (opts.zhipuKey) setZhipuApiKey(opts.zhipuKey);

  // 显式指定评测模型（switchModel 内部校验模型存在性与 Key 需求）
  if (opts.model) {
    try {
      switchModel(opts.model);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `🔴 模型切换失败：${message}\n` +
          '提示：Redis 未恢复 Key 时用 --deepseek-key / --zhipu-key 直传，或更换无需 Key 的模型',
      );
      await closeLogger();
      process.exit(1);
    }
  }

  // 向量库初始化（Chroma 客户端 + 嵌入实例）；BM25 由检索路径首调自动 init（幂等）
  await initializeVectorStore();

  // 选定题目：--question-id 精确匹配优先，否则按题型过滤后取前 --limit 题
  const questions = loadQuestions();
  let selected: ErbQuestion[];
  if (opts.questionId) {
    const hit = questions.find((q) => q.question_id === opts.questionId);
    if (!hit) {
      console.error(`🔴 未找到 question_id=${opts.questionId}（questions.jsonl 共 ${questions.length} 题）`);
      await closeLogger();
      process.exit(1);
    }
    selected = [hit];
  } else {
    // 先按题型过滤（定义候选池），再 --limit 截取——顺序不能反：ERB 前 175 题全是
    // basic，若先切前缀再过滤，--type semantic --limit 26 会得到 0 题
    if (opts.types && opts.types.length > 0) {
      const typeSet = new Set(opts.types);
      selected = questions.filter((q) => typeSet.has(q.question_type));
      logger.info('题型过滤已应用', {
        module: MODULE,
        types: opts.types,
        matched: selected.length,
      });
      if (selected.length === 0) {
        const available = [...new Set(questions.map((q) => q.question_type))].join(', ');
        console.error(`🔴 题型过滤后无题可选（--type=${opts.types.join(',')}），可用题型：${available}`);
        await closeLogger();
        process.exit(1);
      }
    } else {
      selected = questions;
    }
    if (opts.limit) {
      selected = selected.slice(0, opts.limit);
    }
  }

  // 输出文件：缺省放 bench 持久化目录（与 Chroma/BM25 产物同区，守卫通过后必然已设置）
  const outputPath = opts.output ?? path.join(config.chromaPersistDir!, 'answers.jsonl');
  // 防误写主跑数据（2026-09-17 事故：快速评测漏传 --output 截断了 500 题主跑文件，
  // 靠 runlog 重建恢复）：缺省路径与主跑规范文件同路径，必须显著提示
  if (!opts.output) {
    console.error(
      `🟡 [安全提示] 未显式指定 --output：将写入缺省路径 ${outputPath}。\n` +
        '   该路径同时是 500 题主跑的规范文件，非 --resume 启动会截断重写它！\n' +
        '   快速评测/子集实验请显式传 --output <path>。',
    );
    logger.warn('未显式指定 --output，使用缺省路径（与主跑规范文件共用，有截断重写风险）', {
      module: MODULE,
      outputPath,
    });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const modelId = getCurrentModelId();

  // ---- S3.5 断点续传：--resume 读取已有成功行，跳过重复执行 ----
  // error 行不算完成（resume 时重跑）；malformed 行顺带清洗（进程崩溃可能留下
  // 半行，官方 harness 消费不了脏行）；非 resume 保持原语义：全新开始，避免旧结果混入
  const doneIds = new Set<string>();
  if (opts.resume && fs.existsSync(outputPath)) {
    const { lines, malformedLines } = readAnswerLines(outputPath);
    if (malformedLines > 0) {
      const cleanText = lines.map((l) => JSON.stringify(l.record)).join('\n');
      fs.writeFileSync(outputPath, cleanText ? `${cleanText}\n` : '', 'utf-8');
      logger.warn('resume 清洗：已剔除 malformed 行', { module: MODULE, malformedLines, outputPath });
    }
    const existingModelCount: Record<string, number> = {};
    for (const line of lines) {
      if (line.kind !== 'ok') continue;
      doneIds.add(line.record.question_id);
      existingModelCount[line.record.bench_meta.model_id] =
        (existingModelCount[line.record.bench_meta.model_id] ?? 0) + 1;
    }
    // 跨模型混跑警告：评分会被多模型混合失真，提示而非阻止（人工决策是否清盘重跑）
    const otherModels = Object.entries(existingModelCount)
      .filter(([m]) => m !== modelId)
      .map(([m, c]) => `${m}×${c}`);
    if (otherModels.length > 0) {
      logger.warn('resume 检测到跨模型已有结果，混合模型会失真评分', {
        module: MODULE,
        currentModel: modelId,
        otherModels,
      });
    }
    logger.info('resume：已有成功结果将跳过', {
      module: MODULE,
      doneCount: doneIds.size,
      existingModels: Object.entries(existingModelCount).map(([m, c]) => `${m}×${c}`).join(', ') || '(none)',
      currentModel: modelId,
    });
  } else if (!opts.resume) {
    fs.writeFileSync(outputPath, '', 'utf-8');
  }

  // 应用 resume 过滤（error 行题目保留在执行列表里重跑）
  const skippedByResume = opts.resume
    ? selected.filter((q) => doneIds.has(q.question_id)).length
    : 0;
  if (opts.resume && skippedByResume > 0) {
    selected = selected.filter((q) => !doneIds.has(q.question_id));
  }

  logger.info('评测开始', {
    module: MODULE,
    modelId,
    questionCount: selected.length,
    skippedByResume,
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    outputPath,
  });

  // 全部已完成的边界（--resume 重入）：无题可跑，直接进入聚合收尾
  if (selected.length === 0) {
    logger.info('所有选中题目均已完成（--resume 跳过），无需执行', { module: MODULE });
  }

  // ---- S3.5 并发 worker pool：抢占式领取（claim-by-index）----
  // appendFileSync 为同步写，单事件循环内不会交错，无需文件锁。
  // 落盘顺序 = 完成顺序（非题目顺序）；官方 harness 按 question_id 消费，顺序无关。
  let nextIndex = 0;
  let completedCount = 0;
  let okCount = 0;
  let errCount = 0;
  // 熔断基线归零：只统计本轮评测期间的基础设施失败（进程内其他初始化尝试不计入）
  resetSearchInfraFailureCount();
  let infraAborted = false;
  const workerCount = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, selected.length || 1));
  const worker = async (): Promise<void> => {
    for (;;) {
      // 熔断检查（每题开始前）：并发窗口内最多多跑 workerCount 题后全体停止。
      // 检索失败在 vector-search 层被吞掉返回空结果，只能靠此轮询感知
      if (infraAborted) return;
      const failures = getSearchInfraFailureCount();
      if (failures > MAX_SEARCH_INFRA_FAILURES) {
        infraAborted = true;
        logger.error('检索基础设施持续失败，评测熔断中止（已有成功行保留，可 --resume 续传）', {
          module: MODULE,
          infraFailures: failures,
          threshold: MAX_SEARCH_INFRA_FAILURES,
        });
        return;
      }
      const i = nextIndex++;
      if (i >= selected.length) return;
      const q = selected[i];
      try {
        const record = await runQuestion(q);
        fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf-8');
        okCount++;
        logger.info('单题完成', {
          module: MODULE,
          progress: `${completedCount + 1}/${selected.length}`,
          questionId: q.question_id,
          questionType: q.question_type,
          answerLength: record.answer.length,
          docIdCount: record.document_ids.length,
          contextCount: record.contexts.length,
          durationMs: record.bench_meta.duration_ms,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const errRecord: ErrorRecord = { question_id: q.question_id, error: message };
        fs.appendFileSync(outputPath, `${JSON.stringify(errRecord)}\n`, 'utf-8');
        errCount++;
        logger.error('单题失败（已记录并继续）', {
          module: MODULE,
          questionId: q.question_id,
          error: message,
        });
      }
      completedCount++;
      if (completedCount % 25 === 0 || completedCount === selected.length) {
        logger.info('评测进度', { module: MODULE, completed: `${completedCount}/${selected.length}`, okCount, errCount });
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // 熔断中止：跳过聚合收尾（数据不完整无评分意义），非零退出码提示人工介入。
  // 已落盘成功行不受影响，修复基础设施后 --resume 续传即可
  if (infraAborted) {
    logger.warn('评测因基础设施故障中止', {
      module: MODULE,
      infraFailures: getSearchInfraFailureCount(),
      completed: `${completedCount}/${selected.length}`,
      okCount,
      errCount,
      outputPath,
    });
    process.exitCode = 2;
    return;
  }

  logger.info('评测结束', { module: MODULE, okCount, errCount, outputPath });

  // 单题冒烟模式：失败即非零退出（S3.3 判据要求单题跑通产出三字段）。
  // --resume 重入（该题已完成被跳过，selected.length===0）不算失败
  if (opts.questionId && selected.length > 0 && (errCount > 0 || okCount === 0)) {
    await gracefulExit(1);
    return;
  }

  // S3.4：对本轮落盘的 answers.jsonl 就地聚合（读回文件而非内存——顺便校验磁盘内容），
  // 产出 eval-summary.json；S3.5 全量跑完后亦可用 --aggregate-only 独立复盘
  const { lines: finalLines, malformedLines: finalMalformedLines } = readAnswerLines(outputPath);
  const summary = aggregateAnswers(questions, finalLines, finalMalformedLines);
  logAggregateSummary(summary);
  const summaryPath = writeAggregateSummary(summary, outputPath);
  logger.info('聚合摘要已写入', { module: MODULE, answersPath: outputPath, summaryPath });
}

// ==================== 优雅退出（同 bench:import 的 gracefulExit 模式） ====================

/** keep-alive 排空等待（ms）：Chroma undici 连接与 ioredis socket 的释放窗口 */
const KEEPALIVE_DRAIN_MS = 6000;

/**
 * 优雅退出：closeLogger → 等 HTTP keep-alive 排空 → 事件循环自然清空退出。
 *
 * 🔴 刻意不调用 closeRedis()：quit() 与 winston 关闭存在竞态（quit 后 ioredis
 *   仍可能 emit error → logger.warn → 命中正在关闭的 transport），Windows 上触发
 *   libuv 断言崩溃（UV_HANDLE_CLOSING，S3.5 实测）；残留的 ioredis socket 与
 *   undici 连接由下方 unref 兜底 timer 的 process.exit 统一回收。
 *
 * 🔴 顺序不可调换：closeLogger 关闭 winston File/Loki transport 句柄（否则驻留
 *   事件循环导致进程挂起不退出）；排空等待规避 Windows libuv 退出断言崩溃。
 */
async function gracefulExit(code: number): Promise<void> {
  process.exitCode = code;
  await closeLogger();
  console.log(`[BenchEval] 等待 HTTP keep-alive 连接释放（${KEEPALIVE_DRAIN_MS / 1000}s）后退出…`);
  await new Promise<void>((resolve) => setTimeout(resolve, KEEPALIVE_DRAIN_MS));
  const killer = setTimeout(() => process.exit(code), 3000);
  killer.unref();
  // 返回后控制流交还事件循环：句柄已排空，进程将自然退出
}

main()
  .then(async () => {
    await gracefulExit(Number(process.exitCode ?? 0));
  })
  .catch(async (e: unknown) => {
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error('评测 runner 异常退出：', message);
    try {
      logger.error('评测 runner 异常退出', { module: MODULE, error: message });
    } catch {
      // logger 自身失败时不再兜底打日志
    }
    await gracefulExit(1);
  });
