/**
 * KG A 档「实体链接命中率」spike（benchmark-only）
 *
 * 背景：KG A 档方案 = 离线 LLM 抽实体 → MySQL 三元组表 → 在线查询抽实体 + 图上 1~2 跳
 *       → 关联 chunk 补进候选池与 RRF 融合。方案的**可达性命门**是实体链接
 *       （问题词 → 图节点）：链接不上，图再大也补不进正确的 chunk。
 *       因此在投入 30 题门闩之前，先用 10 题做低成本 spike 验证链接命中率。
 *
 * 🔴 预注册判定线（跑实验前定死，禁止事后调整口径 —— wiki 门闩的教训）：
 *      令 linkRate = 全部问题 mention 中被成功链接到图节点的比例（micro）
 *      - PASS  ：linkRate ≥ 0.60 且 mergedR@3 提升题数 ≥ 2 且 回退题数 ≤ 提升题数
 *      - REJECT：linkRate < 0.30
 *      - REVIEW：其余（人工看失败样例归因后再决定）
 *    「R@3 提升」口径：merged = 基线 top2 + 图补充 1 位（补充位最多顶 1 个，
 *    最多翻 1 题，不夸大 KG 的贡献）。
 *
 * 防泄题纪律：
 *   - 离线抽取阶段**只看文档正文**，不接触任何题目文本；
 *   - 抽取范围 = 10 题 gold 文档并集（闭包全量），不针对某道题定制；
 *   - 题目文本仅在「问题实体链接」阶段使用（这是在线流程的真实位置）。
 *
 * 数据实况导致的实现修正（重要）：
 *   ERB semantic 题是**改写式**提问（如 "top end 80GB accelerator" 对应文档里的
 *   "NVIDIA H200 80GB"），纯字符串归一化匹配会系统性假阴性，把方案否在错误的原因上
 *   （与 wiki 实验「综述体 vs 细节题语义鸿沟」同类陷阱）。因此链接阶段做三段式：
 *     ① LLM 抽问题 mention + 生成 surface 变体（全称/缩写/型号/项目名）
 *     ② 确定性候选召回（归一化精确 + 子串包含 + token 重叠，通用 token 剪枝）
 *     ③ LLM 严格确认（同一真实实体才链接）
 *   同时把「纯精确归一化匹配率」作为诊断项一并报告，用于区分
 *   「链接能力不足」与「必须依赖 LLM 语义链接」两种结论。
 *
 * 🟠 v2 链接层升级（2026-09-22，首轮 REVIEW 后按归因定向修复）：
 *   首轮 39 条未链接 mention 的归因：无候选召回 10（25.6%）/ 候选存在但表述不在 gold
 *   中（LLM 正确拒绝）18（46.2%）/ 候选存在且表述在 gold 中却被拒 11（28.2%）。
 *   即「召回盲区」与「确认过严」各占一半可修空间，据此改三点：
 *     A. 候选召回加**语义向量通道**（bge-m3 余弦，Ollama 本地），与词汇通道取并集：
 *        词汇路仍取 top8（与 v1 严格同口径），语义路额外补最多 4 个，候选带 source 标记。
 *        目的是消除 "EU Central"→eu-central-1 这类无字面重叠的召回空白。
 *     B. LLM 确认从**二元拒绝**改为**带 confidence + matchType 的阈值判定**：
 *        confidence ≥ LINK_CONF_THRESHOLD（默认 0.6）才计入链接；同时按
 *        STRICT_CONF_THRESHOLD（0.85）另算「严格口径 linkRate」，与 v1 可比。
 *     C. 抽取阶段**强化 alias 要求**（区域码↔人类可读名、代号↔市场名、指标名↔口语说法
 *        互列别名），并在图中记录 alias→主名的 canonical 映射：链接命中别名时按主名
 *        权重扩展，不再因走 1 跳边而降权。
 *   变量控制：v2 复用 v1 的 question-mentions.json（mention 集合与分母完全一致），
 *   差异只来自「抽取 alias 强化 + 召回语义通道 + 确认阈值」三处。
 *   ⚠️ 依赖本地 Ollama（默认 http://127.0.0.1:11434，模型 bge-m3）；不可用时自动
 *      降级为纯词汇通道并打警告，不影响主流程（`--no-embed` 可显式关闭做消融对比）。
 *
 * 输出（默认 E:\ragbench\kg-spike\，可用 --out-dir 覆盖）：
 *   entities.jsonl        逐篇实体/三元组抽取缓存（断点续传，重跑同命令自动补齐）
 *   entity-embeddings.json 实体键向量缓存（bge-m3，跨轮复用，避免重复嵌入）
 *   question-mentions.json 问题 mention 缓存（仅依赖题目文本，可跨轮复用）
 *   spike-data.json       全部量化结果
 *   spike-report.md       人读报告（含判定结论、失败样例归因与局限）
 *   entities.jsonl.cost.json  token 成本
 *
 * ⚠️ 沙箱注意：Trae 沙箱只允许写工作区（E:\miaoma-ai-app）内的路径。
 *   在沙箱内跑本脚本时，默认输出目录 E:\ragbench\ 的写入会被拦截
 *   （append 报 EBADF、overwrite 报 EPERM），导致缓存与报告无法落盘。
 *   两种解法：① 加 `--out-dir .tmp/kg-spike`（已 gitignore）；
 *             ② 在 Settings → Permission & Approval 中把 E:\ragbench 加入允许写入的路径。
 *
 * 用法：
 *   node --import ./scripts/ts-loader.mjs --experimental-transform-types \
 *     scripts/bench/kg-link-spike.ts [--limit 10] [--concurrency 2] [--link-only] \
 *     [--out-dir .tmp/kg-spike] [--no-embed] [--embed-model bge-m3] \
 *     [--ollama-url http://127.0.0.1:11434] [--link-conf 0.6] [--compare-with path] [--seed 20260923]
 *   # --link-only：跳过抽取阶段，直接用 entities.jsonl 缓存重算链接与归因
 *   # --no-embed ：关闭语义向量通道（消融对比，只跑词汇召回）
 *   # --compare-with：指定 v1 的 spike-data.json，报告末尾自动输出跨轮对比表
 *   # --seed     ：给 LLM 调用指定采样 seed（换 seed 复跑用；缓存全命中时只有链接确认会重新采样）
 */

// 报告正文用全角空格（U+3000）做中文排版分隔，是刻意行为，关掉该规则的字面量误报
/* eslint-disable no-irregular-whitespace */

// 必须最先加载 .env（model-provider / config 依赖完整环境变量）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { OllamaEmbeddings } from '@langchain/ollama';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { evaluateQuery } from '../../src/fundamentals/eval/metrics.js';
import {
  createRateLimitedLLM,
  setDeepseekApiKey,
  switchModel,
} from '../../src/fundamentals/model-provider.js';
import {
  walkDocs,
  readDocContent,
  loadQuestions,
  type ErbDoc,
  type ErbQuestion,
} from './lib/erb-loader.js';

// ==================== 常量 ====================

const MODULE = 'BenchKgSpike';

/** spike 独立输出目录（与 wiki-gate 物理隔离） */
const KG_DIR = 'E:\\ragbench\\kg-spike';
/** 复用门闩轮的选题与基线（同口径 → 结果可与 30 题基线配对） */
const GATE_DIR = 'E:\\ragbench\\bm25\\wiki-gate';

/** spike 题数（取 selected-qids.json 前 N 题，与 gate 选题顺序一致） */
const DEFAULT_LIMIT = 10;

/** 与 gate 轮一致的最低单价模型 */
const DEFAULT_MODEL = 'deepseek:deepseek-v4-flash';
const DEFAULT_CONCURRENCY = 2;

/** 单次抽取送入 LLM 的正文字符上限（与 wiki 合成同约定） */
const EXTRACT_DOC_CHARS = 8000;
/** 每篇实体/三元组上限（写进 prompt，同时作为 zod 硬顶的 2 倍冗余） */
const MAX_ENTITIES_PER_DOC = 20;

/** 单篇抽取 / 单次链接的重试次数 */
const RETRY_MAX = 2;

/** 图上 1 跳邻居实体所带文档的得分权重（链接实体本身为 1.0） */
const HOP_NEIGHBOR_WEIGHT = 0.5;
/** merged 列表中留给图补充的槽位数（=1，见头部预注册口径） */
const GRAPH_SUPPLEMENT_SLOTS = 1;

/** 每个 mention 的候选召回上限与最低分（词汇通道，v1 同口径不动） */
const CANDIDATE_TOP_K = 8;
const CANDIDATE_MIN_SCORE = 0.3;
/** token 倒排剪枝：单个 token 命中实体键超过此值视为通用词，不参与召回 */
const TOKEN_POSTING_CAP = 200;

// ---- 🟠 v2 语义向量召回通道（bge-m3 / Ollama 本地） ----
/** 嵌入模型：与项目知识库默认嵌入模型一致（bge-m3 不需要 BGE 查询前缀） */
const DEFAULT_EMBED_MODEL = 'bge-m3';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
/**
 * 语义候选的最低余弦相似度。
 * 取得宽松（0.5）是刻意的：语义通道只负责把候选**送进池子**，
 * 是否链接由后续 LLM 确认把关，此处宁可多召回也不留盲区。
 */
const EMBED_MIN_SIM = 0.5;
/** 语义通道在词汇 top8 之外额外补充的候选数（控制 prompt 长度与噪声） */
const EMBED_SUPPLEMENT_SLOTS = 4;
/** 单次批量嵌入条数（Ollama /api/embed 批量上限保守值） */
const EMBED_BATCH_SIZE = 32;

// ---- 🟠 v2 确认阈值（二元拒绝 → 置信度分级） ----
/** 计入链接的最低置信度（主口径） */
const LINK_CONF_THRESHOLD = 0.6;
/** 严格口径置信度（用于与 v1 的二元严格确认可比对照） */
const STRICT_CONF_THRESHOLD = 0.85;

/** 图扩展候选池保留数量（用于 newGoldReach 诊断） */
const GRAPH_POOL_CAP = 20;

// ---- 🔴 预注册判定线 ----
/**
 * v1 原始判定线（**已作废，仅作留痕**）：linkRate ≥ 0.6 且 提升 ≥ 2 且 回退 ≤ 提升。
 * 作废时间点：10 题两轮 linkRate 数据（55.9% / 50.8%，均值 53.4%）出来**之后**。
 * 作废原因：linkRate 的分母混入了「表述根本没在 gold 正文出现」的不可链接 mention
 * （两轮实测占分母 34% / 41%），这类 mention 的正确行为就是**不链接**，
 * 于是 linkRate 的数学天花板只有约 0.66，0.60 的 PASS 线在该口径下几乎不可达。
 * ⚠️ 这属于「看到数据后改判据」，有 p-hacking 嫌疑，必须在报告中留痕（见
 * `## 预注册修正声明` 小节），且原始 linkRate 数据全程保留、不删不改。
 */
const PASS_LINK_RATE = 0.6;
const REJECT_LINK_RATE = 0.3;
const PASS_MIN_IMPROVED = 2;

/**
 * 🟡 v3 修正判定线（**当前生效**，用户已批准）。
 * 设计原则：主判据只认「检索端是否真的多召回 gold」，链接层指标降为诊断 + 兜底，
 * 因为 spike 的目的是判断 KG A 档能不能提升检索，不是判断实体链接本身好不好看。
 */
/** 主判据：提升题数 / headroom（基线 R@3 未满的题）≥ 50%。headroom 是提升空间的数学上限 */
const PASS_IMPROVED_OF_HEADROOM = 0.5;
/** 安全判据：回退题数硬上限（按 30 题口径取 5% ≈ 1 题），超出即 REVIEW */
const MAX_REGRESSED_ABS = 1;
/** 兜底判据：可链接子集命中率 ≥ 50%。低于则说明链接层本身崩坏，判 REVIEW */
const PASS_LINKABLE_RATE = 0.5;

// ==================== CLI ====================

interface CliOptions {
  limit: number;
  model: string;
  concurrency: number;
  outDir: string;
  /** 跳过抽取阶段，直接用缓存重算链接与归因 */
  linkOnly: boolean;
  /** 🟠 v2：关闭语义向量通道（消融对比，只跑词汇召回） */
  noEmbed: boolean;
  /** 🟠 v2：嵌入模型名 */
  embedModel: string;
  /** 🟠 v2：Ollama 服务地址 */
  ollamaUrl: string;
  /** 🟠 v2：计入链接的最低置信度（主口径） */
  linkConf: number;
  /** 🟠 v2：上一轮 spike-data.json 路径，用于输出跨轮对比表 */
  compareWith: string | null;
  /** 🟠 v2：LLM 采样 seed（换 seed 复跑用，null = 不指定，由服务端随机） */
  seed: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    limit: DEFAULT_LIMIT,
    model: DEFAULT_MODEL,
    concurrency: DEFAULT_CONCURRENCY,
    outDir: KG_DIR,
    linkOnly: false,
    noEmbed: false,
    embedModel: DEFAULT_EMBED_MODEL,
    ollamaUrl: DEFAULT_OLLAMA_URL,
    linkConf: LINK_CONF_THRESHOLD,
    compareWith: null,
    seed: null,
  };
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
      case '--limit': {
        // 必须校验：NaN 会让 qids.slice(0, NaN) 变成 0 题，
        // 最终报「未定位到任何 gold 文档」，错误信息与真实原因完全无关
        const raw = next();
        const v = Number(raw);
        if (!Number.isInteger(v) || v < 1) {
          console.error(`--limit 需为正整数，收到：${raw}`);
          process.exit(1);
        }
        opts.limit = v;
        break;
      }
      case '--model':
        opts.model = next();
        break;
      case '--concurrency': {
        // 必须校验：NaN 会让抽取并发池的 worker 数为 0，抽取阶段静默全跳过
        const raw = next();
        const v = Number(raw);
        if (!Number.isInteger(v) || v < 1) {
          console.error(`--concurrency 需为正整数，收到：${raw}`);
          process.exit(1);
        }
        opts.concurrency = v;
        break;
      }
      case '--out-dir':
        opts.outDir = next();
        break;
      case '--link-only':
        opts.linkOnly = true;
        break;
      case '--no-embed':
        opts.noEmbed = true;
        break;
      case '--embed-model':
        opts.embedModel = next();
        break;
      case '--ollama-url':
        opts.ollamaUrl = next();
        break;
      case '--link-conf': {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          console.error(`--link-conf 需为 0~1 的数字，收到：${v}`);
          process.exit(1);
        }
        opts.linkConf = v;
        break;
      }
      case '--compare-with':
        opts.compareWith = next();
        break;
      case '--seed': {
        const v = Number(next());
        if (!Number.isInteger(v)) {
          console.error(`--seed 需为整数，收到：${v}`);
          process.exit(1);
        }
        opts.seed = v;
        break;
      }
      default:
        console.error(`未知参数：${arg}`);
        process.exit(1);
    }
  }
  return opts;
}

// ==================== Zod Schema（LLM 结构化输出，禁止裸 JSON.parse 直用） ====================

const EntitySchema = z.object({
  name: z.string().min(1).max(120).describe('实体在文档中的原始表述'),
  type: z
    .string()
    .min(1)
    .max(30)
    .describe(
      '实体类型：person/team/org/product/model/project/location/event/plan/metric',
    ),
  aliases: z
    .array(z.string().max(120))
    .default([])
    .describe('同一实体在文档中出现的其他表述（缩写、全称、代号）'),
});

const TripleSchema = z.object({
  head: z.string().min(1).max(120).describe('头实体（须为文中原始表述）'),
  relation: z.string().min(1).max(60).describe('小写下划线关系短语'),
  tail: z.string().min(1).max(120).describe('尾实体（须为文中原始表述）'),
});

const DocExtractSchema = z.object({
  entities: z.array(EntitySchema).max(MAX_ENTITIES_PER_DOC * 2),
  triples: z.array(TripleSchema).max(MAX_ENTITIES_PER_DOC * 2),
});
type DocExtract = z.infer<typeof DocExtractSchema>;

const MentionSchema = z.object({
  surface: z
    .string()
    .min(1)
    .max(160)
    .describe('问题中指向某实体的词组（原文照抄）'),
  variants: z
    .array(z.string().max(160))
    .max(6)
    .describe('该实体在文档中可能出现的其他表述（全称/缩写/型号/项目名）'),
});
const QuestionMentionsSchema = z.object({
  mentions: z.array(MentionSchema).max(8),
});
type QuestionMentions = z.infer<typeof QuestionMentionsSchema>;

/**
 * 🟠 v2：LLM 确认从「二元拒绝」改为「带 confidence + matchType 的分级判定」。
 * 首轮归因发现 11 条未链接 mention 的表述**确实出现在 gold 文档**中却被拒
 * （如 "rollout system"→Canary rollout、"dry run"→rehearse_run_*），
 * 二元口径下这些一律记 0；分级后可用阈值把「同一实体的不同表述」纳入链接。
 */
const LinkMatchTypeSchema = z.enum([
  'exact', // 同一实体的完全等价表述（全称/缩写/大小写/区域码↔名称）
  'variant', // 同一实体的不同说法（口语↔术语、代号↔市场名）
  'related', // 相关但非同一实体（父项目/子模块/上位概念）—— 不计入链接
]);

const LinkDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      mention: z.string().min(1).describe('mention 编号，如 M1'),
      links: z
        .array(
          z.object({
            candidate: z.string().min(1).describe('候选编号，如 C1'),
            confidence: z
              .number()
              .min(0)
              .max(1)
              .describe('该候选与 mention 指向同一真实实体的置信度'),
            matchType: LinkMatchTypeSchema.describe('匹配类型'),
          }),
        )
        .max(CANDIDATE_TOP_K + EMBED_SUPPLEMENT_SLOTS)
        .describe('认为指向同一实体的候选（可多个，按置信度从高到低）'),
    }),
  ),
});
type LinkMatchType = z.infer<typeof LinkMatchTypeSchema>;

// ==================== 通用工具 ====================

function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function scheduleForceExit(code: number): void {
  const t = setTimeout(() => process.exit(code), 6000);
  t.unref();
}

/** 禁止裸 process.exit：先关 logger，再用 unref 定时器兜底防事件循环挂起 */
async function gracefulExit(code: number): Promise<never> {
  scheduleForceExit(code);
  try {
    await closeLogger();
  } catch {
    // 关日志失败不阻塞退出
  }
  process.exit(code);
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}
const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0, calls: 0 };

interface LlmResponseShape {
  content: unknown;
  usage_metadata?: { input_tokens?: number; output_tokens?: number } | null;
  response_metadata?: {
    tokenUsage?: { promptTokens?: number; completionTokens?: number };
  };
}

/** 从 LangChain 响应中提取 token 用量（兼容两种字段命名） */
function accumulateUsage(resp: LlmResponseShape): void {
  usage.calls++;
  const um = resp.usage_metadata;
  if (
    um &&
    typeof um.input_tokens === 'number' &&
    typeof um.output_tokens === 'number'
  ) {
    usage.inputTokens += um.input_tokens;
    usage.outputTokens += um.output_tokens;
    return;
  }
  const tm = resp.response_metadata?.tokenUsage;
  if (
    tm &&
    typeof tm.promptTokens === 'number' &&
    typeof tm.completionTokens === 'number'
  ) {
    usage.inputTokens += tm.promptTokens;
    usage.outputTokens += tm.completionTokens;
  }
}

/** 写成本账单；失败不抛——评测已完成，不应因产物落盘失败而中断流程 */
async function writeCostFile(
  costPath: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await safeWriteFile(
    costPath,
    JSON.stringify({ ...usage, ...extra }, null, 2),
    'overwrite',
  );
}

/**
 * 弹性文件写入：失败后退避重试，仍失败则返回 false 交由调用方降级，
 * 不抛异常、不丢弃已付费的 LLM 结果。
 *
 * 已知失败根因（2026-09-22 定位）：**Trae 沙箱路径限制**。本脚本输出目录 `E:\ragbench\`
 * 位于工作区 `E:\miaoma-ai-app` 之外，沙箱内启动的进程对该路径的写操作被拦截，
 * 表现为 append 报 `EBADF: bad file descriptor`、overwrite 报 `EPERM: operation not permitted`
 * （同一路径由沙箱外进程写入完全正常，且与并发数、LLM 活动均无关）。
 *
 * 因此：**跑本脚本必须走沙箱外执行**；此处的重试与降级只是兜底，
 * 保证拦截发生时数据不随进程退出丢失（调用方负责把内容转储到 stdout 供外部回收）。
 */
async function safeWriteFile(
  filePath: string,
  content: string,
  mode: 'append' | 'overwrite',
): Promise<boolean> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (mode === 'append') fs.appendFileSync(filePath, content, 'utf8');
      else fs.writeFileSync(filePath, content, 'utf8');
      return true;
    } catch (error: unknown) {
      const msg = errMsg(error);
      const transient = /EBADF|EPERM|EBUSY|EMFILE|ENFILE/.test(msg);
      if (!transient || attempt === maxAttempts) {
        logger.error('文件写入失败（数据保留在内存，阶段末兜底重写）', {
          module: MODULE,
          filePath,
          mode,
          attempt,
          error: msg,
        });
        return false;
      }
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
  return false;
}

/** 容忍 ```json 围栏与前后噪声文本的 JSON 提取 + zod 校验 */
interface SafeParser<T> {
  safeParse: (v: unknown) => {
    success: boolean;
    data?: T;
    error?: { issues: Array<{ message: string }> };
  };
}

function extractJson<T>(text: string, schema: SafeParser<T>, label: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`${label}：返回文本中未找到 JSON 对象`);
  }
  const parsed = schema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
  if (!parsed.success) {
    throw new Error(
      `${label}：zod 校验失败: ${parsed.error?.issues.map((i) => i.message).join('; ') ?? 'unknown'}`,
    );
  }
  return parsed.data as T;
}

/**
 * 🟠 v2：LLM 采样 seed（换 seed 复跑用）。模块级而非层层透传，因为 invokeJson 的三个
 * 调用方（抽取 / mention / 链接确认）都拿不到 CliOptions，为一次复跑改四处签名不值得。
 */
let LLM_SEED: number | null = null;

/**
 * invoke 的窄化视图：BaseChatModel 的 CallOptions 未声明 seed，但底层 ChatOpenAI
 * 会把 options.seed 透传到 OpenAI 兼容接口的请求体，createRateLimitedLLM 的包装
 * 也是 (...args) 透明转发，因此这里只做一次类型窄化，不改变运行时行为。
 */
type SeedInvokable = {
  invoke(input: unknown, options?: { seed?: number }): Promise<unknown>;
};

/**
 * LLM 结构化调用（重试时把上一次错误回灌 prompt，提高二次成功率）。
 * DeepSeek V4 全系 Thinking 模式，思考块长度不可控 → 必须 zod 校验 + 重试兜底。
 */
async function invokeJson<T>(
  llm: BaseChatModel,
  prompt: string,
  schema: SafeParser<T>,
  label: string,
): Promise<T> {
  let lastError = '';
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const full =
        prompt +
        (lastError
          ? `\n\nYour previous output failed: ${lastError}. Fix it and try again.`
          : '');
      const resp = (await (llm as unknown as SeedInvokable).invoke(
        full,
        LLM_SEED != null ? { seed: LLM_SEED } : undefined,
      )) as LlmResponseShape;
      accumulateUsage(resp);
      return extractJson<T>(String(resp.content), schema, label);
    } catch (error: unknown) {
      lastError = errMsg(error);
      logger.warn('LLM 结构化调用失败', {
        module: MODULE,
        label,
        attempt,
        error: lastError,
      });
      if (attempt < RETRY_MAX)
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(
    `${label}：${RETRY_MAX} 次尝试均失败，最后错误：${lastError}`,
  );
}

// ==================== 归一化与 token 化 ====================

/** 跨语言免对齐的归一化：小写 + 空白折叠（实体键统一口径） */
function normEntity(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 英文语料的通用词（不参与 token 召回，避免候选爆炸） */
const STOPWORDS = new Set([
  'the',
  'of',
  'for',
  'and',
  'with',
  'from',
  'into',
  'onto',
  'about',
  'after',
  'before',
  'when',
  'what',
  'which',
  'who',
  'how',
  'are',
  'was',
  'were',
  'is',
  'new',
  'first',
  'last',
  'current',
  'major',
  'top',
  'end',
  'year',
  'month',
  'week',
  'day',
  'time',
  'plan',
  'plans',
  'team',
  'teams',
  'project',
  'projects',
  'company',
  'companies',
  'provider',
  'providers',
  'partner',
  'partners',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ==================== 🟠 v2 语义向量通道（bge-m3 / Ollama 本地） ====================

/** 余弦相似度；任一为零向量时返回 0（避免 NaN 污染排序） */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 嵌入服务：探测可用性 → 批量嵌入实体键 → 磁盘缓存跨轮复用。
 *
 * 设计原则：**任何失败都降级为「通道关闭」**（等价于 v1 的纯词汇召回），
 * 不抛异常中断主流程——spike 的主产出是链接命中率，语义通道只是召回增强项。
 */
class EmbeddingService {
  /** 归一化实体键 → 向量 */
  private readonly cache = new Map<string, number[]>();
  private embeddings: OllamaEmbeddings | null = null;
  /** 通道是否可用（probe 成功且未被关闭） */
  available = false;
  /** 不可用原因（写进报告局限小节） */
  unavailableReason = '';
  /** 本轮实际发生的嵌入调用条数（成本披露用） */
  embeddedCount = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly cachePath: string,
  ) {}

  get cacheSize(): number {
    return this.cache.size;
  }

  /** 探测 Ollama 服务与目标模型；失败仅记录原因并置 available=false */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (body.models ?? []).map((m) => m.name);
      const hit = names.some(
        (n) => n === this.model || n.startsWith(`${this.model}:`),
      );
      if (!hit) {
        this.unavailableReason = `本地无模型 ${this.model}（已有：${names.join(', ') || '空'}）`;
        return false;
      }
      this.embeddings = new OllamaEmbeddings({
        model: this.model,
        baseUrl: this.baseUrl,
      });
      this.available = true;
      return true;
    } catch (error: unknown) {
      this.unavailableReason = `Ollama 探测失败：${errMsg(error)}`;
      this.available = false;
      return false;
    }
  }

  /** 读取磁盘向量缓存；模型不一致时整份作废（向量空间不可比） */
  loadCache(): void {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as {
        model?: string;
        vectors?: Record<string, number[]>;
      };
      if (raw.model && raw.model !== this.model) {
        logger.warn('嵌入缓存模型与当前不一致，忽略缓存', {
          module: MODULE,
          cached: raw.model,
          current: this.model,
        });
        return;
      }
      for (const [k, v] of Object.entries(raw.vectors ?? {})) {
        if (Array.isArray(v) && v.length > 0) this.cache.set(k, v);
      }
      logger.info('嵌入缓存已载入', { module: MODULE, size: this.cache.size });
    } catch (error: unknown) {
      logger.warn('嵌入缓存读取失败，忽略', {
        module: MODULE,
        error: errMsg(error),
      });
    }
  }

  /** 落盘向量缓存；失败不抛（嵌入可重算，不阻塞主流程） */
  async saveCache(): Promise<void> {
    const payload = JSON.stringify({
      model: this.model,
      vectors: Object.fromEntries(this.cache),
    });
    await safeWriteFile(this.cachePath, payload, 'overwrite');
  }

  get(key: string): number[] | undefined {
    return this.cache.get(key);
  }

  /**
   * 批量嵌入实体键文本（命中缓存的跳过）。
   * 批量失败时降级为逐条嵌入，避免单个坏文本拖垮整批。
   */
  async embedKeys(
    entries: Array<{ key: string; text: string }>,
  ): Promise<void> {
    if (!this.available || !this.embeddings) return;
    const pending = entries.filter((e) => e.key && !this.cache.has(e.key));
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const vectors = await this.embeddings.embedDocuments(
          batch.map((b) => b.text),
        );
        batch.forEach((b, idx) => {
          const v = vectors[idx];
          if (Array.isArray(v) && v.length > 0) {
            this.cache.set(b.key, v);
            this.embeddedCount++;
          }
        });
      } catch (error: unknown) {
        logger.warn('批量嵌入失败，降级逐条', {
          module: MODULE,
          batchSize: batch.length,
          error: errMsg(error),
        });
        for (const b of batch) {
          try {
            const v = await this.embeddings.embedQuery(b.text);
            if (Array.isArray(v) && v.length > 0) {
              this.cache.set(b.key, v);
              this.embeddedCount++;
            }
          } catch (inner: unknown) {
            logger.warn('单条嵌入失败', {
              module: MODULE,
              key: b.key,
              error: errMsg(inner),
            });
          }
        }
      }
    }
  }

  /** 嵌入查询文本；失败返回 null，调用方降级为纯词汇召回 */
  async embedQuery(text: string): Promise<number[] | null> {
    if (!this.available || !this.embeddings || !text.trim()) return null;
    try {
      const v = await this.embeddings.embedQuery(text);
      if (Array.isArray(v) && v.length > 0) {
        this.embeddedCount++;
        return v;
      }
      return null;
    } catch (error: unknown) {
      logger.warn('查询嵌入失败，该 mention 降级为纯词汇召回', {
        module: MODULE,
        error: errMsg(error),
      });
      return null;
    }
  }
}

// ==================== 图索引 ====================

interface EntityIndex {
  /** 归一化键 → 展示用原始 label（首次出现的表述） */
  keyToLabel: Map<string, string>;
  keyToType: Map<string, string>;
  /** 归一化键 → 出现该实体的文档 id 集合 */
  keyToDocs: Map<string, Set<string>>;
  /** 归一化键 → 三元组邻居键（无向） */
  adjacency: Map<string, Set<string>>;
  /** token → 实体键集合（候选召回用倒排） */
  tokenToKeys: Map<string, Set<string>>;
  /**
   * 🟠 v2：别名键 → 主名键（canonical 映射）。
   * 链接命中别名时按主名权重 1.0 扩展，不再因走 1 跳边而降权到 0.5。
   */
  keyToCanonical: Map<string, string>;
  /** 三元组总数（含跨文档重复计数，仅报告用） */
  tripleCount: number;
}

function buildIndex(rows: DocEntityRow[]): EntityIndex {
  const index: EntityIndex = {
    keyToLabel: new Map(),
    keyToType: new Map(),
    keyToDocs: new Map(),
    adjacency: new Map(),
    tokenToKeys: new Map(),
    keyToCanonical: new Map(),
    tripleCount: 0,
  };

  /** 作为主名（实体名 / 三元组端点）注册过的键，别名映射不得覆盖它 */
  const primaryKeys = new Set<string>();

  const registerKey = (
    raw: string,
    type?: string,
    isPrimary = true,
  ): string => {
    const key = normEntity(raw);
    if (!key) return key;
    if (isPrimary) primaryKeys.add(key);
    if (!index.keyToLabel.has(key)) {
      index.keyToLabel.set(key, raw.trim());
      index.keyToType.set(key, type ?? 'unknown');
      for (const token of tokenize(raw)) {
        const posting = index.tokenToKeys.get(token);
        if (posting) posting.add(key);
        else index.tokenToKeys.set(token, new Set([key]));
      }
    }
    return key;
  };

  const addDoc = (key: string, documentId: string): void => {
    if (!key) return;
    const docs = index.keyToDocs.get(key);
    if (docs) docs.add(documentId);
    else index.keyToDocs.set(key, new Set([documentId]));
  };

  const addEdge = (a: string, b: string): void => {
    if (!a || !b || a === b) return;
    const na = index.adjacency.get(a);
    if (na) na.add(b);
    else index.adjacency.set(a, new Set([b]));
    const nb = index.adjacency.get(b);
    if (nb) nb.add(a);
    else index.adjacency.set(b, new Set([a]));
  };

  for (const row of rows) {
    for (const entity of row.entities) {
      const key = registerKey(entity.name, entity.type);
      addDoc(key, row.documentId);
      for (const alias of entity.aliases) {
        // 别名与主名归一到同一节点（别名作为该节点的另一种表述）
        const aliasKey = registerKey(alias, entity.type, false);
        if (!aliasKey) continue;
        addDoc(aliasKey, row.documentId);
        addEdge(key, aliasKey);
        // 🟠 v2：登记 alias→主名 canonical 映射（首次出现优先；不覆盖已是主名的键）
        if (aliasKey !== key && !index.keyToCanonical.has(aliasKey)) {
          index.keyToCanonical.set(aliasKey, key);
        }
      }
    }
    for (const triple of row.triples) {
      index.tripleCount++;
      const head = registerKey(triple.head);
      const tail = registerKey(triple.tail);
      addDoc(head, row.documentId);
      addDoc(tail, row.documentId);
      addEdge(head, tail);
    }
  }

  // 二次修正：某键若在后续文档中被当作主名注册（抽取顺序造成的先后偏差），
  // 撤销其别名身份，避免把独立实体误折叠到别的实体上。
  for (const aliasKey of [...index.keyToCanonical.keys()]) {
    if (primaryKeys.has(aliasKey)) index.keyToCanonical.delete(aliasKey);
  }

  return index;
}

// ==================== 阶段 1：离线实体抽取 ====================

interface DocEntityRow {
  documentId: string;
  entities: DocExtract['entities'];
  triples: DocExtract['triples'];
}

const EXTRACT_PROMPT = `You are building a knowledge-graph index for a retrieval system.

From the document below, extract:
- "entities": the most important NAMED entities (people, teams, organizations, products, hardware models/SKUs, projects, initiatives, locations/regions, events, meetings, plans/policies, programs). Use the EXACT surface form as written in the document. Fill "aliases" with other forms of the SAME entity that appear in the document (abbreviation, full name, code name). At most ${MAX_ENTITIES_PER_DOC} entities, ordered by importance.
- "triples": factual relations between entities, as head/relation/tail. head and tail MUST be exact surface forms from the document. relation is a short lowercase snake_case phrase (e.g. works_on, located_in, depends_on, approved_by, scheduled_for, measured_by). At most ${MAX_ENTITIES_PER_DOC} triples.

Rules:
- Use ONLY information present in the document. No outside knowledge, no guessing.
- Do NOT extract generic common nouns ("performance", "cost", "the team") unless they are proper names.
- Prefer specific identifiers (model numbers, region codes, program names) — they matter most for retrieval.
- "aliases" is CRITICAL for linking. Fill it aggressively with every other in-document form of the SAME entity, in BOTH directions:
  * region code <-> human-readable name ("eu-central-1" <-> "EU Central" / "Frankfurt region")
  * code name / internal name <-> market or product name ("dry run" <-> "rehearse_run_2026q1")
  * abbreviation <-> full name, SKU <-> product family ("H200" <-> "NVIDIA H200 80GB")
  * metric or policy name <-> the colloquial way the document refers to it ("canary rollout" <-> "rollout system")
  Only include forms that actually appear in the document text.
- Output ONLY a JSON object, no markdown fences:
{"entities":[{"name":"...","type":"...","aliases":["..."]}],"triples":[{"head":"...","relation":"...","tail":"..."}]}

Document:
`;

function loadEntityCache(cachePath: string): Map<string, DocEntityRow> {
  const cache = new Map<string, DocEntityRow>();
  if (!fs.existsSync(cachePath)) return cache;
  for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as DocEntityRow;
      if (row.documentId) cache.set(row.documentId, row);
    } catch {
      // 半行/损坏行由重跑覆盖
    }
  }
  return cache;
}

/** 全库遍历定位目标文档（找齐即提前退出） */
function locateDocs(wanted: Set<string>): Map<string, ErbDoc> {
  const found = new Map<string, ErbDoc>();
  for (const doc of walkDocs({})) {
    if (wanted.has(doc.documentId) && !found.has(doc.documentId)) {
      found.set(doc.documentId, doc);
      if (found.size === wanted.size) break;
    }
  }
  return found;
}

/**
 * 逐篇抽取（并发池 + 断点续传：cachePath 已有的 documentId 跳过）
 *
 * 返回的 rows = 缓存已有 + 本轮新抽（内存态）：即使写盘全部失败，
 * 本次运行仍能建图出报告，不浪费已付费的 LLM 调用。
 */
async function extractEntities(
  docs: Map<string, ErbDoc>,
  cachePath: string,
  llm: BaseChatModel,
  concurrency: number,
): Promise<{ ok: number; fail: number; rows: DocEntityRow[] }> {
  const cached = loadEntityCache(cachePath);
  const pending = [...docs.values()].filter((d) => !cached.has(d.documentId));
  console.log(
    `抽取阶段：目标 ${docs.size} 篇，缓存已有 ${cached.size} 篇，本次待抽 ${pending.length} 篇` +
      `（模型并发 ${concurrency}）`,
  );
  if (cached.size > 0) console.log('续传：跳过已缓存文档');

  let cursor = 0;
  let ok = 0;
  let fail = 0;
  let appendFails = 0;
  const newRows: DocEntityRow[] = [];
  const startedAt = Date.now();

  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const doc = pending[cursor++];
      try {
        const content = readDocContent(doc).slice(0, EXTRACT_DOC_CHARS);
        const result = await invokeJson(
          llm,
          EXTRACT_PROMPT + content,
          DocExtractSchema,
          `抽取 ${doc.documentId}`,
        );
        const row: DocEntityRow = {
          documentId: doc.documentId,
          entities: result.entities,
          triples: result.triples,
        };
        // 先入内存再写盘：写盘故障（EBADF 等）不算抽取失败、不丢结果
        newRows.push(row);
        ok++;
        if (
          !(await safeWriteFile(
            cachePath,
            JSON.stringify(row) + '\n',
            'append',
          ))
        ) {
          appendFails++;
        }
      } catch (error: unknown) {
        fail++;
        // stack 必带：EBADF 一类错误无法从 message 判断是网络层还是文件层
        logger.error('文档实体抽取失败（重跑同命令可补齐）', {
          module: MODULE,
          documentId: doc.documentId,
          error: errMsg(error),
          stack: error instanceof Error ? error.stack : String(error),
        });
      }
      const done = ok + fail;
      if (done % 20 === 0 || done === pending.length) {
        const minutes = (Date.now() - startedAt) / 60000;
        console.log(
          `抽取进度 ${done}/${pending.length} ok=${ok} fail=${fail} ` +
            `速率=${minutes > 0 ? (done / minutes).toFixed(1) : '-'} 篇/分钟`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () =>
      worker(),
    ),
  );

  // 阶段末兜底整体重写：LLM 活动停止后句柄竞争消失，即使逐篇 append 全灭也能完整落盘；
  // 顺带清掉缓存文件中的非文档行（如诊断 probe 行）
  const rows = [...cached.values(), ...newRows];
  if (appendFails > 0 || pending.length > 0) {
    const body =
      rows.map((r) => JSON.stringify(r)).join('\n') +
      (rows.length > 0 ? '\n' : '');
    const wrote = await safeWriteFile(cachePath, body, 'overwrite');
    if (appendFails > 0) {
      console.log(
        `⚠️ 逐篇写盘失败 ${appendFails} 次，阶段末整体重写` +
          (wrote
            ? '已成功兜底'
            : '也失败：结果仅存内存（本次报告仍可用，但中断后无法续传）'),
      );
    }
  }
  return { ok, fail, rows };
}

// ==================== 阶段 2：问题实体链接 ====================

interface MentionLink {
  mentionId: string;
  surface: string;
  variants: string[];
  /** 确定性精确归一化命中的实体键（诊断用） */
  exactKeys: string[];
  /** 候选召回（编号 → 实体键），🟠 v2 带 source/sim 便于归因语义通道贡献 */
  candidates: Array<{
    id: string;
    key: string;
    label: string;
    type: string;
    docCount: number;
    source: CandidateSource;
    sim?: number;
  }>;
  /** LLM 确认且 confidence ≥ 主口径阈值的实体键 */
  linkedKeys: string[];
  /**
   * 🟠 v2：LLM 返回的**全部**链接判定（未按阈值过滤）。
   * 保留原始 confidence/matchType，使得主口径（0.6）与严格口径（0.85）
   * 可在同一份数据上复算，无需二次调用 LLM。
   */
  linkDetails: Array<{
    key: string;
    confidence: number;
    matchType: LinkMatchType;
    source: CandidateSource;
  }>;
}

const MENTION_PROMPT = `You are doing entity linking for a retrieval system over an enterprise corpus.

The question below is a PARAPHRASE: it usually avoids the exact proper names used in the documents. List the mentions that point at specific named entities in the corpus (products, hardware models/SKUs, organizations, teams, people, projects, programs, locations/regions, events, plans/policies).

For each mention output:
- "surface": the exact phrase copied from the question
- "variants": up to 6 plausible surface forms the SAME entity could take inside the documents (full name, abbreviation, model/SKU code, product family, formal program or region code). Guess conservatively from the wording; do not invent unrelated entities.

At most 8 mentions, ordered by how central they are to answering the question.
Output ONLY a JSON object, no markdown fences:
{"mentions":[{"surface":"...","variants":["..."]}]}

Question:
`;

/** 🟠 v2：候选召回来源标记（both = 词汇与语义两通道均命中） */
type CandidateSource = 'lexical' | 'semantic' | 'both';

interface RecalledCandidate {
  id: string;
  key: string;
  label: string;
  type: string;
  docCount: number;
  score: number;
  source: CandidateSource;
  /** 语义余弦相似度（source 含 semantic 时有值） */
  sim?: number;
}

/**
 * 词汇通道召回（**v1 同口径，不得改动**：精确 1.0 / 子串 0.8 / token 重叠 ×0.6，
 * MIN_SCORE 过滤后取 top8）。v2 的语义通道只做「额外补充」，保证两轮可比。
 */
function recallLexical(
  mention: { surface: string; variants: string[] },
  index: EntityIndex,
): Array<{ key: string; score: number }> {
  const scores = new Map<string, number>();
  const surfaces = [mention.surface, ...mention.variants].filter(
    (s) => s.trim().length > 0,
  );

  for (const surface of surfaces) {
    const norm = normEntity(surface);
    const tokens = new Set(tokenize(surface));
    if (norm.length === 0) continue;

    // ① 精确归一化命中：直接满分
    if (index.keyToDocs.has(norm)) scores.set(norm, 1);

    // ② token 倒排召回（通用 token 剪枝，避免候选爆炸）
    const candidateKeys = new Set<string>();
    for (const token of tokens) {
      const posting = index.tokenToKeys.get(token);
      if (!posting || posting.size > TOKEN_POSTING_CAP) continue;
      for (const key of posting) candidateKeys.add(key);
    }

    for (const key of candidateKeys) {
      const label = index.keyToLabel.get(key) ?? key;
      const labelNorm = normEntity(label);
      let score = scores.get(key) ?? 0;

      if (labelNorm === norm) score = Math.max(score, 1);
      else if (
        norm.length >= 4 &&
        (labelNorm.includes(norm) ||
          (labelNorm.length >= 4 && norm.includes(labelNorm)))
      ) {
        // ③ 子串包含（型号/代码类实体的常见形态）
        score = Math.max(score, 0.8);
      } else {
        // ④ token 重叠率（以 mention 变体 token 数为分母）
        const keyTokens = new Set(tokenize(label));
        let common = 0;
        for (const t of tokens) if (keyTokens.has(t)) common++;
        const overlap = tokens.size > 0 ? (0.6 * common) / tokens.size : 0;
        score = Math.max(score, overlap);
      }
      if (score > 0) scores.set(key, score);
    }
  }

  return [...scores.entries()]
    .filter(([, score]) => score >= CANDIDATE_MIN_SCORE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, CANDIDATE_TOP_K)
    .map(([key, score]) => ({ key, score }));
}

/**
 * 🟠 v2：语义向量补充通道。
 *
 * 词汇通道对「无字面重叠」的表述是系统性盲区——首轮 39 条未链接 mention 中有 10 条
 * **完全没有候选**（如 "EU Central"→eu-central-1、"India South"→ap-south-1）。
 * 此处用 bge-m3 余弦在词汇 top8 之外额外补最多 EMBED_SUPPLEMENT_SLOTS 个候选。
 * 相似度阈值刻意宽松（EMBED_MIN_SIM=0.5）：召回只负责把候选送进池子，
 * 是否链接由 LLM 确认 + 置信度阈值把关，宁多勿漏。
 *
 * 多个查询向量（surface + variants）取逐键最大相似度，避免单一表述的向量偏差。
 */
function semanticSupplement(
  queryVectors: number[][],
  index: EntityIndex,
  embed: EmbeddingService,
  lexicalKeys: Set<string>,
): Array<{ key: string; sim: number; alreadyLexical: boolean }> {
  if (queryVectors.length === 0) return [];
  const ranked: Array<{ key: string; sim: number }> = [];
  for (const key of index.keyToLabel.keys()) {
    const vec = embed.get(key);
    if (!vec) continue;
    let best = 0;
    for (const qv of queryVectors) {
      const sim = cosine(qv, vec);
      if (sim > best) best = sim;
    }
    if (best >= EMBED_MIN_SIM) ranked.push({ key, sim: best });
  }
  ranked.sort((a, b) => b.sim - a.sim || a.key.localeCompare(b.key));

  const out: Array<{ key: string; sim: number; alreadyLexical: boolean }> = [];
  let slots = EMBED_SUPPLEMENT_SLOTS;
  for (const r of ranked) {
    if (lexicalKeys.has(r.key)) {
      // 已在词汇 top8 中：只打 both 标记，不占补充槽位
      out.push({ ...r, alreadyLexical: true });
      continue;
    }
    if (slots <= 0) break;
    slots--;
    out.push({ ...r, alreadyLexical: false });
  }
  return out;
}

/** 单 mention 的候选召回 = 词汇通道（v1 同口径）∪ 语义补充通道 */
function recallCandidates(
  mention: { surface: string; variants: string[] },
  index: EntityIndex,
  queryVectors: number[][],
  embed: EmbeddingService | null,
): RecalledCandidate[] {
  const lexical = recallLexical(mention, index);
  const picked: RecalledCandidate[] = lexical.map((c, i) => ({
    id: `c${i + 1}`,
    key: c.key,
    label: index.keyToLabel.get(c.key) ?? c.key,
    type: index.keyToType.get(c.key) ?? 'unknown',
    docCount: index.keyToDocs.get(c.key)?.size ?? 0,
    score: c.score,
    source: 'lexical' as CandidateSource,
  }));

  if (!embed?.available || queryVectors.length === 0) return picked;

  const lexicalKeys = new Set(lexical.map((c) => c.key));
  for (const s of semanticSupplement(queryVectors, index, embed, lexicalKeys)) {
    const sim = Number(s.sim.toFixed(4));
    if (s.alreadyLexical) {
      const hit = picked.find((p) => p.key === s.key);
      if (hit) {
        hit.source = 'both';
        hit.sim = sim;
      }
      continue;
    }
    picked.push({
      id: `c${picked.length + 1}`,
      key: s.key,
      label: index.keyToLabel.get(s.key) ?? s.key,
      type: index.keyToType.get(s.key) ?? 'unknown',
      docCount: index.keyToDocs.get(s.key)?.size ?? 0,
      score: sim,
      source: 'semantic',
      sim,
    });
  }
  return picked;
}

/** 纯精确归一化匹配（诊断项：不依赖 LLM 的链接能力下限） */
function exactMatchKeys(
  mention: { surface: string; variants: string[] },
  index: EntityIndex,
): string[] {
  const keys: string[] = [];
  for (const surface of [mention.surface, ...mention.variants]) {
    const norm = normEntity(surface);
    if (norm && index.keyToDocs.has(norm) && !keys.includes(norm))
      keys.push(norm);
  }
  return keys;
}

/**
 * 链接阶段：抽 mention → 候选召回（词汇 ∪ 语义）→ LLM 分级确认（题目文本只在此处使用）
 *
 * 🟠 v2：确认为带 confidence + matchType 的分级判定，
 * `confThreshold` 之上的 exact/variant 才计入 linkedKeys；
 * 原始判定全量留在 linkDetails，供严格口径（0.85）复算与归因。
 */
async function linkQuestion(
  question: ErbQuestion,
  index: EntityIndex,
  llm: BaseChatModel,
  mentionsCache: Map<string, QuestionMentions>,
  cachePath: string,
  embed: EmbeddingService | null,
  confThreshold: number,
): Promise<MentionLink[]> {
  let mentions = mentionsCache.get(question.question_id);
  if (!mentions) {
    mentions = await invokeJson(
      llm,
      MENTION_PROMPT + question.question,
      QuestionMentionsSchema,
      `问题 mention 抽取 ${question.question_id}`,
    );
    mentionsCache.set(question.question_id, mentions);
    // 弹性写：链接阶段同样处于 LLM HTTP 活动期，写盘失败不中断流程（内存缓存仍生效，
    // 链接循环结束后 main 会兜底整体重写一次）
    await safeWriteFile(
      cachePath,
      JSON.stringify(Object.fromEntries(mentionsCache), null, 2),
      'overwrite',
    );
  }

  const links: MentionLink[] = [];
  for (let i = 0; i < mentions.mentions.length; i++) {
    const m = mentions.mentions[i];
    const mentionId = `M${i + 1}`;

    // 🟠 v2：为 surface + variants 逐个求向量（最多 4 个不同表述），取逐键最大相似度。
    // 嵌入是本地 bge-m3，成本远低于 LLM 调用；失败则该 mention 自动退回纯词汇召回。
    const queryVectors: number[][] = [];
    if (embed?.available) {
      const forms = [
        ...new Set([m.surface, ...m.variants].map((s) => normEntity(s))),
      ]
        .filter((s) => s.length > 0)
        .slice(0, 4);
      for (const form of forms) {
        const vec = await embed.embedQuery(form);
        if (vec) queryVectors.push(vec);
      }
    }

    const candidates = recallCandidates(m, index, queryVectors, embed);
    links.push({
      mentionId,
      surface: m.surface,
      variants: m.variants,
      exactKeys: exactMatchKeys(m, index),
      candidates: candidates.map(
        ({ id, key, label, type, docCount, source, sim }) => ({
          id,
          key,
          label,
          type,
          docCount,
          source,
          sim,
        }),
      ),
      linkedKeys: [],
      linkDetails: [],
    });
  }

  const linkable = links.filter((l) => l.candidates.length > 0);
  if (linkable.length === 0) return links;

  // 一次调用批量确认全部 mention（10 题 × 1 次，成本可忽略）
  const promptLines: string[] = [
    'You are doing entity linking: decide which candidate knowledge-graph entities each question mention refers to.',
    '',
    `Question: ${question.question}`,
    '',
    'Candidates were retrieved by string overlap and/or embedding similarity, so they MAY be wrong.',
    'For each mention, output every candidate you believe denotes the SAME real-world entity, with:',
    '- "confidence": 0..1, how sure you are that mention and candidate are the SAME entity',
    '- "matchType": "exact" (equivalent forms: abbreviation, full name, region code vs name, SKU vs family),',
    '                "variant" (same entity described differently: colloquial vs technical term, code name vs market name),',
    '                "related" (associated but NOT the same entity: parent project, sub-module, broader concept)',
    '',
    'Calibration: 0.9+ = clearly the same entity; 0.6-0.85 = same entity expressed differently, wording not identical;',
    '0.3-0.6 = plausible but unverified; below 0.3 or "related" = do not link.',
    'Prefer emitting a low-confidence link over omitting it — a downstream threshold decides.',
    'If no candidate matches, return an empty "links" list for that mention.',
    '',
  ];
  for (const link of linkable) {
    promptLines.push(
      `${link.mentionId} surface: "${link.surface}"` +
        (link.variants.length > 0
          ? ` (variants: ${link.variants.join(', ')})`
          : ''),
    );
    for (const c of link.candidates) {
      const provenance =
        c.source === 'semantic'
          ? `semantic sim=${c.sim?.toFixed(2) ?? '-'}`
          : c.source === 'both'
            ? `lexical+semantic sim=${c.sim?.toFixed(2) ?? '-'}`
            : 'lexical';
      promptLines.push(
        `  ${c.id}: "${c.label}" (type=${c.type}, docs=${c.docCount}, via=${provenance})`,
      );
    }
  }
  promptLines.push(
    '',
    'Output ONLY a JSON object, no markdown fences:',
    '{"decisions":[{"mention":"M1","links":[{"candidate":"c1","confidence":0.95,"matchType":"exact"},' +
      '{"candidate":"c3","confidence":0.7,"matchType":"variant"}]}]}',
  );

  const decisions = await invokeJson(
    llm,
    promptLines.join('\n'),
    LinkDecisionSchema,
    `实体链接确认 ${question.question_id}`,
  );

  const byId = new Map(linkable.map((l) => [l.mentionId, l]));
  for (const decision of decisions.decisions) {
    const link = byId.get(decision.mention);
    if (!link) continue;
    for (const item of decision.links) {
      const candidate = link.candidates.find((c) => c.id === item.candidate);
      if (!candidate) continue;
      if (!link.linkDetails.some((d) => d.key === candidate.key)) {
        link.linkDetails.push({
          key: candidate.key,
          confidence: item.confidence,
          matchType: item.matchType,
          source: candidate.source,
        });
      }
      // 主口径：阈值之上且非 related（related 语义上就不是同一实体，任何阈值都不该计入）
      if (
        item.matchType !== 'related' &&
        item.confidence >= confThreshold &&
        !link.linkedKeys.includes(candidate.key)
      ) {
        link.linkedKeys.push(candidate.key);
      }
    }
  }
  return links;
}

// ==================== 阶段 3：图扩展与归因 ====================

interface GraphDoc {
  documentId: string;
  score: number;
  /** 贡献来源（链接实体 label / 1 跳邻居 label），报告可读性用 */
  via: string[];
}

/** 链接实体 → 其文档（权重 1.0）+ 1 跳邻居实体 → 其文档（权重 0.5） */
function expandFromLinkedKeys(
  linkedKeys: string[],
  index: EntityIndex,
): GraphDoc[] {
  const scores = new Map<string, { score: number; via: Set<string> }>();
  const add = (documentId: string, weight: number, viaLabel: string): void => {
    const entry = scores.get(documentId);
    if (entry) {
      entry.score += weight;
      entry.via.add(viaLabel);
    } else {
      scores.set(documentId, { score: weight, via: new Set([viaLabel]) });
    }
  };

  for (const rawKey of linkedKeys) {
    // 🟠 v2：链接命中**别名**时，别名与其主名是同一实体的两种表述，
    // 必须按同等权重 1.0 扩展；否则要多走 1 跳边而被降权到 0.5，
    // 白白削弱 alias 强化抽取带来的收益。
    const canonical = index.keyToCanonical.get(rawKey) ?? rawKey;
    const core = [rawKey, canonical].filter(
      (k, i, arr) => k && arr.indexOf(k) === i,
    );

    for (const key of core) {
      const label = index.keyToLabel.get(key) ?? key;
      for (const documentId of index.keyToDocs.get(key) ?? [])
        add(documentId, 1, label);
    }
    for (const key of core) {
      for (const neighbor of index.adjacency.get(key) ?? []) {
        // 别名↔主名这条边已按 1.0 计入，不再重复按 1 跳降权
        if (core.includes(neighbor)) continue;
        const neighborLabel = index.keyToLabel.get(neighbor) ?? neighbor;
        for (const documentId of index.keyToDocs.get(neighbor) ?? []) {
          add(documentId, HOP_NEIGHBOR_WEIGHT, `1hop:${neighborLabel}`);
        }
      }
    }
  }

  return [...scores.entries()]
    .map(([documentId, entry]) => ({
      documentId,
      score: entry.score,
      via: [...entry.via],
    }))
    .sort(
      (a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId),
    );
}

// ==================== 主流程 ====================

interface BaselineRow {
  question_id: string;
  document_ids: string[];
}

function readBaseline(filePath: string): Map<string, BaselineRow> {
  const map = new Map<string, BaselineRow>();
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as BaselineRow;
      if (row.question_id && Array.isArray(row.document_ids))
        map.set(row.question_id, row);
    } catch {
      // 半行跳过（与 compare-wiki-gate 同容忍口径）
    }
  }
  return map;
}

interface QuestionResult {
  questionId: string;
  question: string;
  goldDocIds: string[];
  mentions: MentionLink[];
  mentionCount: number;
  linkedMentionCount: number;
  exactMentionCount: number;
  /** 🟠 v2：严格口径（confidence ≥ STRICT_CONF_THRESHOLD）下链接成功的 mention 数，与 v1 二元确认可比 */
  strictLinkedMentionCount: number;
  /** 🟠 v2：靠纯语义补充候选（词汇通道未召回）才链接成功的 mention 数 */
  semanticLinkedMentionCount: number;
  /** 🟠 v2：候选池中出现过纯语义补充候选的 mention 数（语义通道覆盖面） */
  semanticCandidateMentionCount: number;
  /** 🟠 v2：链接命中别名键（经 canonical 映射提权）的 mention 数 */
  aliasLinkedMentionCount: number;
  baselineR3: number;
  mergedR3: number;
  graphOnlyR3: number;
  improved: boolean;
  regressed: boolean;
  /** 图候选池中属于 gold 但基线 top-10 未召回的文档数（真·新增可达） */
  newGoldReach: number;
  graphPoolSize: number;
  /** 未链接 mention 的诊断：其变体是否在 gold 文档正文中原样出现 */
  unlinkedDiag: Array<{
    surface: string;
    textPresentInGold: boolean;
    candidateLabels: string[];
    /** 🟠 v2：候选中纯语义补充的数量（0 = 语义通道也没救回来） */
    semanticCandidateCount: number;
    /** 🟠 v2：LLM 给出的最高置信度（无判定则 null）——区分「差一点过阈值」与「完全不像」 */
    maxConfidence: number | null;
    /** 🟠 v2：最高置信度对应的匹配类型 */
    bestMatchType: LinkMatchType | null;
  }>;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const pct = (v: number): string => (v * 100).toFixed(1) + '%';

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const entitiesPath = path.join(opts.outDir, 'entities.jsonl');
  const mentionsPath = path.join(opts.outDir, 'question-mentions.json');

  // 1. 选题（与 gate 同口径：selected-qids.json 前 N 题 → 结果可与 30 题基线配对）
  const selectedDoc = JSON.parse(
    fs.readFileSync(path.join(GATE_DIR, 'selected-qids.json'), 'utf8'),
  ) as { questionIds: string[] };
  const qids = selectedDoc.questionIds.slice(0, opts.limit);
  const questionsById = new Map(loadQuestions().map((q) => [q.question_id, q]));
  const selected: ErbQuestion[] = [];
  for (const qid of qids) {
    const q = questionsById.get(qid);
    if (!q) {
      console.error(`🔴 questions.jsonl 中缺少 ${qid}`);
      // return 而非 await：让 TS 收窄 q 的非空类型（gracefulExit 返回 Promise<never>）
      return gracefulExit(2);
    }
    selected.push(q);
  }

  const baseline = readBaseline(path.join(GATE_DIR, 'baseline-30.jsonl'));
  const missingBaseline = selected.filter((q) => !baseline.has(q.question_id));
  if (missingBaseline.length > 0) {
    console.error(
      `🔴 基线文件缺少 ${missingBaseline.length} 题: ${missingBaseline
        .map((q) => q.question_id)
        .join(',')}`,
    );
    await gracefulExit(2);
  }

  // 2. 文档域 = N 题 gold 并集（闭包全量抽取，不针对某题定制）
  const goldUnion = new Set<string>();
  for (const q of selected)
    for (const id of q.expected_doc_ids) goldUnion.add(id);
  console.log(
    `spike 题数 ${selected.length}，gold 文档并集 ${goldUnion.size} 篇，开始全库定位...`,
  );
  const docs = locateDocs(goldUnion);
  console.log(`定位成功 ${docs.size}/${goldUnion.size} 篇`);
  if (docs.size === 0) {
    console.error('🔴 未定位到任何 gold 文档，无法建图');
    await gracefulExit(2);
  }
  if (docs.size < goldUnion.size) {
    console.warn(
      `⚠️ ${goldUnion.size - docs.size} 篇 gold 未在语料中定位到（按缺失处理）`,
    );
  }

  // 3. LLM 实例
  if (opts.model.startsWith('deepseek:') && process.env.DEEPSEEK_API_KEY) {
    setDeepseekApiKey(process.env.DEEPSEEK_API_KEY);
  }
  LLM_SEED = opts.seed;
  if (LLM_SEED != null)
    console.log(`LLM 采样 seed = ${LLM_SEED}（换 seed 复跑）`);
  const llm = createRateLimitedLLM(switchModel(opts.model), 'fast');

  // 4. 阶段 1：离线实体抽取（断点续传；rows 为内存态，不依赖写盘成功）
  let rows: DocEntityRow[];
  if (!opts.linkOnly) {
    const extracted = await extractEntities(
      docs,
      entitiesPath,
      llm,
      opts.concurrency,
    );
    console.log(`抽取完成：本轮成功 ${extracted.ok} / 失败 ${extracted.fail}`);
    rows = extracted.rows;
  } else {
    console.log('--link-only：跳过抽取阶段，使用缓存');
    rows = [...loadEntityCache(entitiesPath).values()];
  }
  rows = rows.filter((r) => docs.has(r.documentId));
  if (rows.length === 0) {
    console.error('🔴 抽取缓存为空，无法建图');
    await gracefulExit(2);
  }

  // 5. 建图（应用层内存邻接表，百篇级语料无需 Neo4j）
  const index = buildIndex(rows);
  console.log(
    `建图完成：文档 ${rows.length} 篇 / 唯一实体键 ${index.keyToLabel.size} / ` +
      `三元组 ${index.tripleCount} / 倒排 token ${index.tokenToKeys.size} / ` +
      `别名→主名映射 ${index.keyToCanonical.size}`,
  );

  // 5b. 🟠 v2：语义向量通道准备（不可用则降级为纯词汇召回 = v1 口径）
  const embeddingsPath = path.join(opts.outDir, 'entity-embeddings.json');
  let embed: EmbeddingService | null = null;
  if (opts.noEmbed) {
    console.log('--no-embed：语义向量通道已关闭（消融模式，仅词汇召回）');
  } else {
    embed = new EmbeddingService(
      opts.ollamaUrl,
      opts.embedModel,
      embeddingsPath,
    );
    if (await embed.probe()) {
      embed.loadCache();
      // 实体键文本 = 首次出现的原始表述（label），与查询侧同为「表述级」文本，向量空间可比
      const entries = [...index.keyToLabel.entries()].map(([key, label]) => ({
        key,
        text: label,
      }));
      const before = embed.cacheSize;
      await embed.embedKeys(entries);
      console.log(
        `语义通道就绪：模型 ${opts.embedModel}，向量 ${embed.cacheSize} 条` +
          `（本轮新嵌入 ${embed.cacheSize - before}，缓存命中 ${before}）`,
      );
      await embed.saveCache();
    } else {
      console.warn(
        `⚠️ 语义向量通道不可用，降级为纯词汇召回（等价 v1 口径）：${embed.unavailableReason}`,
      );
      embed = null;
    }
  }

  // 6. 阶段 2+3：逐题链接 → 图扩展 → 归因
  // mention 缓存是整份 JSON.parse：半写损坏或结构漂移不能让整轮崩掉
  // （抽取结果才是付费产物，链接阶段可重跑）。逐条 zod 校验，非法条目剔除后重算。
  const mentionsCache = new Map<string, QuestionMentions>();
  if (fs.existsSync(mentionsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mentionsPath, 'utf8')) as Record<
        string,
        unknown
      >;
      for (const [qid, value] of Object.entries(raw)) {
        const parsed = QuestionMentionsSchema.safeParse(value);
        if (parsed.success) {
          mentionsCache.set(qid, parsed.data);
        } else {
          console.warn(
            `⚠️ mention 缓存条目 ${qid} 校验失败，已剔除并将重算：` +
              `${parsed.error?.issues.map((i) => i.message).join('; ') ?? 'unknown'}`,
          );
        }
      }
    } catch (error: unknown) {
      console.error(
        `🔴 mention 缓存解析失败（${errMsg(error)}），忽略全部缓存并重跑链接阶段：${mentionsPath}`,
      );
      mentionsCache.clear();
    }
  }
  if (mentionsCache.size > 0) {
    console.log(
      `mention 缓存命中 ${mentionsCache.size} 题（变量控制：与上一轮同一 mention 集合，分母一致）`,
    );
  }

  const results: QuestionResult[] = [];
  for (const q of selected) {
    const links = await linkQuestion(
      q,
      index,
      llm,
      mentionsCache,
      mentionsPath,
      embed,
      opts.linkConf,
    );
    const linkedKeys = [...new Set(links.flatMap((l) => l.linkedKeys))];

    const graphDocs = expandFromLinkedKeys(linkedKeys, index);
    const graphPool = graphDocs.slice(0, GRAPH_POOL_CAP);

    const baseRow = baseline.get(q.question_id)!;
    const baseTop = baseRow.document_ids;
    const keepCount = Math.max(0, 3 - GRAPH_SUPPLEMENT_SLOTS);
    const kept = baseTop.slice(0, keepCount);
    const supplements = graphDocs
      .map((g) => g.documentId)
      .filter((id) => !kept.includes(id))
      .slice(0, GRAPH_SUPPLEMENT_SLOTS);
    const merged = [...kept, ...supplements].slice(0, 3);

    const baseMetrics = evaluateQuery(baseTop, q.expected_doc_ids, [3]);
    const mergedMetrics = evaluateQuery(merged, q.expected_doc_ids, [3]);
    const graphMetrics = evaluateQuery(
      graphDocs.map((g) => g.documentId).slice(0, 3),
      q.expected_doc_ids,
      [3],
    );
    const baselineR3 = baseMetrics['Recall@3'] ?? 0;
    const mergedR3 = mergedMetrics['Recall@3'] ?? 0;

    // 真·新增可达：图候选池中的 gold，且基线 top-10 完全没召回
    const newGoldReach = graphPool.filter(
      (g) =>
        q.expected_doc_ids.includes(g.documentId) &&
        !baseTop.includes(g.documentId),
    ).length;

    // 未链接 mention 归因：变体是否在 gold 正文中原样出现（区分「抽取漏」vs「表述鸿沟」）
    const goldText = q.expected_doc_ids
      .map((id) => docs.get(id))
      .filter((d): d is ErbDoc => d !== undefined)
      .map((d) => readDocContent(d).slice(0, EXTRACT_DOC_CHARS).toLowerCase())
      .join('\n');
    const unlinkedDiag = links
      .filter((l) => l.linkedKeys.length === 0)
      .map((l) => {
        const confs = l.linkDetails.filter((d) => d.matchType !== 'related');
        const best = confs.reduce(
          (acc, d) => (acc === null || d.confidence > acc.confidence ? d : acc),
          null as { confidence: number; matchType: LinkMatchType } | null,
        );
        return {
          surface: l.surface,
          textPresentInGold: [l.surface, ...l.variants].some(
            (v) => v.trim().length >= 4 && goldText.includes(normEntity(v)),
          ),
          candidateLabels: l.candidates.slice(0, 3).map((c) => c.label),
          semanticCandidateCount: l.candidates.filter(
            (c) => c.source === 'semantic',
          ).length,
          maxConfidence: best ? best.confidence : null,
          bestMatchType: best ? best.matchType : null,
        };
      });

    // 🟠 v2：严格口径（0.85）复算——与 v1 的二元严格确认同量级，用于判断
    // linkRate 的提升究竟来自「阈值放宽」还是「召回与 alias 真的变好了」
    const strictLinkedMentionCount = links.filter((l) =>
      l.linkDetails.some(
        (d) =>
          d.matchType !== 'related' && d.confidence >= STRICT_CONF_THRESHOLD,
      ),
    ).length;
    // 语义通道的净贡献：链接键中存在「只有语义通道才召回」的候选
    const semanticLinkedMentionCount = links.filter((l) => {
      if (l.linkedKeys.length === 0) return false;
      return l.linkedKeys.some((k) => {
        const c = l.candidates.find((cc) => cc.key === k);
        return c?.source === 'semantic';
      });
    }).length;
    const semanticCandidateMentionCount = links.filter((l) =>
      l.candidates.some((c) => c.source === 'semantic'),
    ).length;
    const aliasLinkedMentionCount = links.filter((l) =>
      l.linkedKeys.some((k) => index.keyToCanonical.has(k)),
    ).length;

    results.push({
      questionId: q.question_id,
      question: q.question,
      goldDocIds: q.expected_doc_ids,
      mentions: links,
      mentionCount: links.length,
      linkedMentionCount: links.filter((l) => l.linkedKeys.length > 0).length,
      exactMentionCount: links.filter((l) => l.exactKeys.length > 0).length,
      strictLinkedMentionCount,
      semanticLinkedMentionCount,
      semanticCandidateMentionCount,
      aliasLinkedMentionCount,
      baselineR3,
      mergedR3,
      graphOnlyR3: graphMetrics['Recall@3'] ?? 0,
      improved: mergedR3 > baselineR3,
      regressed: mergedR3 < baselineR3,
      newGoldReach,
      graphPoolSize: graphPool.length,
      unlinkedDiag,
    });
    console.log(
      `${q.question_id}: mention ${links.length} 链接 ${results[results.length - 1].linkedMentionCount}` +
        ` 精确 ${results[results.length - 1].exactMentionCount} | R@3 ${pct(baselineR3)} → ${pct(mergedR3)}` +
        ` | 图池 ${graphDocs.length} 新增gold ${newGoldReach}`,
    );
  }

  // 链接循环结束（LLM 活动停止）后兜底重写 mention 缓存：
  // 即使逐题写盘全部失败，10 次付费 mention 抽取结果也能完整落盘供续传
  await safeWriteFile(
    mentionsPath,
    JSON.stringify(Object.fromEntries(mentionsCache), null, 2),
    'overwrite',
  );

  // 7. 汇总与预注册判定
  const totalMentions = results.reduce((a, r) => a + r.mentionCount, 0);
  const totalLinked = results.reduce((a, r) => a + r.linkedMentionCount, 0);
  const totalExact = results.reduce((a, r) => a + r.exactMentionCount, 0);
  const totalStrictLinked = results.reduce(
    (a, r) => a + r.strictLinkedMentionCount,
    0,
  );
  const totalSemanticLinked = results.reduce(
    (a, r) => a + r.semanticLinkedMentionCount,
    0,
  );
  const totalSemanticCandidates = results.reduce(
    (a, r) => a + r.semanticCandidateMentionCount,
    0,
  );
  const totalAliasLinked = results.reduce(
    (a, r) => a + r.aliasLinkedMentionCount,
    0,
  );
  const linkRate = totalMentions > 0 ? totalLinked / totalMentions : 0;
  const strictLinkRate =
    totalMentions > 0 ? totalStrictLinked / totalMentions : 0;
  const exactRate = totalMentions > 0 ? totalExact / totalMentions : 0;
  const questionHitRate =
    results.length > 0
      ? results.filter((r) => r.linkedMentionCount > 0).length / results.length
      : 0;
  const improvedCount = results.filter((r) => r.improved).length;
  const regressedCount = results.filter((r) => r.regressed).length;

  // 🟡 v3：headroom = 基线 R@3 未满的题数。merged 只在「基线没把 gold 排进 top3」的题上
  // 才可能提升，故 headroom 是提升题数的数学上限，主判据必须按它归一——
  // 否则不同轮选题的基线难度不同，「提升 ≥ 2 题」这种绝对数根本不可比。
  const headroomQuestions = results.filter((r) => r.baselineR3 < 1).length;
  const improvedOfHeadroom =
    headroomQuestions > 0 ? improvedCount / headroomQuestions : 0;

  // 🟡 v3：可链接子集命中率。unlinkedDiag.textPresentInGold === false 的 mention 是
  // 「表述根本没在 gold 正文出现」（如 "acceptable latency and cost changes"），
  // 对这类 mention 正确行为就是拒绝链接，故从分母剔除后再算命中率。
  const unlinkableMentions = results.reduce(
    (a, r) => a + r.unlinkedDiag.filter((u) => !u.textPresentInGold).length,
    0,
  );
  const linkableMentions = totalMentions - unlinkableMentions;
  const linkableLinkRate =
    linkableMentions > 0 ? totalLinked / linkableMentions : 0;

  // 🟡 v3 修正判定（v1 判定线已作废，作废原因与 p-hacking 风险见常量区注释）
  const verdict: 'PASS' | 'REJECT' | 'REVIEW' =
    improvedCount === 0 || regressedCount > improvedCount
      ? 'REJECT'
      : linkableLinkRate < PASS_LINKABLE_RATE ||
          regressedCount > MAX_REGRESSED_ABS ||
          improvedOfHeadroom < PASS_IMPROVED_OF_HEADROOM
        ? 'REVIEW'
        : 'PASS';

  // 🟠 v2：跨轮对比（--compare-with 指向上一轮 spike-data.json）
  interface PrevSnapshot {
    linkRate: number;
    strictLinkRate?: number;
    exactMatchRate: number;
    questionHitRate: number;
    totalMentions: number;
    linkedMentions: number;
    baselineR3: number;
    mergedR3: number;
    improvedQuestions: number;
    regressedQuestions: number;
    verdict: string;
    uniqueEntityKeys: number;
    triples: number;
  }
  let comparison: {
    prevPath: string;
    prev: PrevSnapshot;
    deltaLinkRate: number;
    deltaStrictLinkRate: number | null;
    deltaQuestionHitRate: number;
    deltaMergedR3: number;
    deltaImproved: number;
    deltaRegressed: number;
    deltaEntityKeys: number;
  } | null = null;
  if (opts.compareWith) {
    try {
      const prevRaw = JSON.parse(fs.readFileSync(opts.compareWith, 'utf8')) as {
        linking?: Record<string, number>;
        attribution?: Record<string, number>;
        domain?: Record<string, number>;
        verdict?: string;
      };
      const prev: PrevSnapshot = {
        linkRate: prevRaw.linking?.linkRate ?? 0,
        strictLinkRate: prevRaw.linking?.strictLinkRate,
        exactMatchRate: prevRaw.linking?.exactMatchRate ?? 0,
        questionHitRate: prevRaw.linking?.questionHitRate ?? 0,
        totalMentions: prevRaw.linking?.totalMentions ?? 0,
        linkedMentions: prevRaw.linking?.linkedMentions ?? 0,
        baselineR3: prevRaw.attribution?.baselineR3 ?? 0,
        mergedR3: prevRaw.attribution?.mergedR3 ?? 0,
        improvedQuestions: prevRaw.attribution?.improvedQuestions ?? 0,
        regressedQuestions: prevRaw.attribution?.regressedQuestions ?? 0,
        verdict: prevRaw.verdict ?? 'UNKNOWN',
        uniqueEntityKeys: prevRaw.domain?.uniqueEntityKeys ?? 0,
        triples: prevRaw.domain?.triples ?? 0,
      };
      comparison = {
        prevPath: opts.compareWith,
        prev,
        deltaLinkRate: linkRate - prev.linkRate,
        deltaStrictLinkRate:
          typeof prev.strictLinkRate === 'number'
            ? strictLinkRate - prev.strictLinkRate
            : null,
        deltaQuestionHitRate: questionHitRate - prev.questionHitRate,
        deltaMergedR3: mean(results.map((r) => r.mergedR3)) - prev.mergedR3,
        deltaImproved: improvedCount - prev.improvedQuestions,
        deltaRegressed: regressedCount - prev.regressedQuestions,
        deltaEntityKeys: index.keyToLabel.size - prev.uniqueEntityKeys,
      };
    } catch (error: unknown) {
      console.warn(`⚠️ --compare-with 读取失败，跳过对比表：${errMsg(error)}`);
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    preregistration: {
      /** v1 原始判定线（已作废，留痕用） */
      passLinkRate: PASS_LINK_RATE,
      rejectLinkRate: REJECT_LINK_RATE,
      passMinImproved: PASS_MIN_IMPROVED,
      /** 🟡 v3 修正判定线（当前生效） */
      revised: {
        passImprovedOfHeadroom: PASS_IMPROVED_OF_HEADROOM,
        maxRegressedAbs: MAX_REGRESSED_ABS,
        passLinkableRate: PASS_LINKABLE_RATE,
        linkRateRole: 'diagnostic（降为诊断指标，不设门）',
        /** 修正发生在看到 10 题两轮 linkRate 数据之后，属事后改判据，必须留痕 */
        amendedAfterSeeingData: true,
        amendmentReason:
          'linkRate 分母混入「表述不在 gold 正文」的不可链接 mention（两轮实测占 34%/41%），' +
          '其数学天花板约 0.66，原 0.60 PASS 线在该口径下几乎不可达；主判据改为 headroom 归一的检索端命中率',
      },
      attribution: `merged = baseline top${3 - GRAPH_SUPPLEMENT_SLOTS} + 图补充 ${GRAPH_SUPPLEMENT_SLOTS} 位`,
    },
    domain: {
      questions: results.length,
      questionIds: results.map((r) => r.questionId),
      goldUnionDocs: goldUnion.size,
      extractedDocs: rows.length,
      uniqueEntityKeys: index.keyToLabel.size,
      triples: index.tripleCount,
      aliasCanonicalMappings: index.keyToCanonical.size,
      model: opts.model,
      /** 🟠 v2：LLM 采样 seed（null = 未指定，由服务端随机） */
      seed: opts.seed,
    },
    linking: {
      totalMentions,
      linkedMentions: totalLinked,
      linkRate,
      /** 🟠 v2：主口径置信度阈值 */
      confThreshold: opts.linkConf,
      /** 🟠 v2：严格口径 linkRate（confidence ≥ 0.85），与 v1 二元确认可比 */
      strictLinkRate,
      strictConfThreshold: STRICT_CONF_THRESHOLD,
      exactMatchRate: exactRate,
      questionHitRate,
      /** 🟡 v3：表述不在 gold 正文的 mention 数（正确行为就是不链接，从分母剔除） */
      unlinkableMentions,
      /** 🟡 v3：可链接子集分母 = totalMentions − unlinkableMentions */
      linkableMentions,
      /** 🟡 v3：可链接子集命中率（兜底判据用，剔除分母污染后的真实链接能力） */
      linkableLinkRate,
    },
    /** 🟠 v2：三项改造各自的贡献量（判断收益来源，避免把「阈值放宽」误读成「能力变强」） */
    v2Channels: {
      semanticEnabled: embed !== null,
      semanticModel: embed ? opts.embedModel : null,
      semanticUnavailableReason: embed
        ? null
        : opts.noEmbed
          ? '--no-embed 显式关闭'
          : 'Ollama 探测失败',
      entityVectors: embed?.cacheSize ?? 0,
      embeddedThisRun: embed?.embeddedCount ?? 0,
      /** 候选池出现过纯语义补充候选的 mention 数（覆盖面） */
      mentionsWithSemanticCandidates: totalSemanticCandidates,
      /** 靠纯语义候选才链接成功的 mention 数（净贡献） */
      mentionsLinkedViaSemantic: totalSemanticLinked,
      /** 链接命中别名键（canonical 提权生效）的 mention 数 */
      mentionsLinkedViaAlias: totalAliasLinked,
      embedMinSim: EMBED_MIN_SIM,
      embedSupplementSlots: EMBED_SUPPLEMENT_SLOTS,
    },
    attribution: {
      baselineR3: mean(results.map((r) => r.baselineR3)),
      mergedR3: mean(results.map((r) => r.mergedR3)),
      deltaR3:
        mean(results.map((r) => r.mergedR3)) -
        mean(results.map((r) => r.baselineR3)),
      graphOnlyR3: mean(results.map((r) => r.graphOnlyR3)),
      improvedQuestions: improvedCount,
      regressedQuestions: regressedCount,
      /** 🟡 v3：基线 R@3 未满的题数 = 提升题数的数学上限（主判据分母） */
      headroomQuestions,
      /** 🟡 v3：主判据值 = 提升题数 / headroom */
      improvedOfHeadroom,
      totalNewGoldReach: results.reduce((a, r) => a + r.newGoldReach, 0),
    },
    verdict,
    /** 🟡 v3：判定依据逐条落盘，便于人工复核「为什么是这个档」 */
    verdictBasis: {
      rule: `PASS ⇔ 提升>0 且 回退≤提升 且 提升/headroom ≥ ${PASS_IMPROVED_OF_HEADROOM} 且 回退 ≤ ${MAX_REGRESSED_ABS} 且 可链接子集命中率 ≥ ${PASS_LINKABLE_RATE}`,
      improvedCount,
      headroomQuestions,
      improvedOfHeadroom,
      passImprovedOfHeadroom: improvedOfHeadroom >= PASS_IMPROVED_OF_HEADROOM,
      regressedCount,
      passRegressed:
        regressedCount <= improvedCount && regressedCount <= MAX_REGRESSED_ABS,
      linkableLinkRate,
      passLinkableRate: linkableLinkRate >= PASS_LINKABLE_RATE,
      /** v1 原判定线下的结果（留痕对照，不参与定档） */
      legacyVerdict:
        linkRate < REJECT_LINK_RATE
          ? 'REJECT'
          : linkRate >= PASS_LINK_RATE &&
              improvedCount >= PASS_MIN_IMPROVED &&
              regressedCount <= improvedCount
            ? 'PASS'
            : 'REVIEW',
    },
    comparison,
    usage,
    perQuestion: results.map((r) => ({
      questionId: r.questionId,
      question: r.question,
      goldDocIds: r.goldDocIds,
      mentionCount: r.mentionCount,
      linkedMentionCount: r.linkedMentionCount,
      exactMentionCount: r.exactMentionCount,
      strictLinkedMentionCount: r.strictLinkedMentionCount,
      semanticLinkedMentionCount: r.semanticLinkedMentionCount,
      aliasLinkedMentionCount: r.aliasLinkedMentionCount,
      baselineR3: r.baselineR3,
      mergedR3: r.mergedR3,
      graphOnlyR3: r.graphOnlyR3,
      improved: r.improved,
      regressed: r.regressed,
      newGoldReach: r.newGoldReach,
      graphPoolSize: r.graphPoolSize,
      mentions: r.mentions.map((m) => ({
        mentionId: m.mentionId,
        surface: m.surface,
        variants: m.variants,
        exactKeys: m.exactKeys,
        linkedKeys: m.linkedKeys,
        linkedLabels: m.linkedKeys.map((k) => index.keyToLabel.get(k) ?? k),
        linkDetails: m.linkDetails.map((d) => ({
          ...d,
          label: index.keyToLabel.get(d.key) ?? d.key,
          canonical: index.keyToCanonical.get(d.key) ?? null,
        })),
        candidates: m.candidates,
      })),
      unlinkedDiag: r.unlinkedDiag,
    })),
  };

  const dataPath = path.join(opts.outDir, 'spike-data.json');
  const dataJson = JSON.stringify(data, null, 2);
  if (!(await safeWriteFile(dataPath, dataJson, 'overwrite'))) {
    // 写盘被拦截（如沙箱路径限制）时把完整数据转储到 stdout，避免已付费的 LLM 结果丢失
    console.log('===SPIKE_DATA_JSON_BEGIN===');
    console.log(dataJson);
    console.log('===SPIKE_DATA_JSON_END===');
  }

  // 🟠 v2：报告辅助段（通道贡献 + 跨轮对比），拼接进下方 lines
  const signedPct = (v: number): string =>
    `${v >= 0 ? '+' : '-'}${pct(Math.abs(v))}`;
  const signedInt = (v: number): string =>
    `${v >= 0 ? '+' : '-'}${Math.abs(v)}`;
  const channelLines: string[] = [
    `## v2 通道贡献（三点改造的收益来源）`,
    '',
    ...(embed
      ? [
          `- 语义通道：✅ 启用（${opts.embedModel} @ ${opts.ollamaUrl}），实体向量 ${embed.cacheSize} 条，本轮新嵌入 ${embed.embeddedCount} 条`,
          `- 语义候选覆盖面：${totalSemanticCandidates} 个 mention 的候选池中出现纯语义补充候选（阈值 sim ≥ ${EMBED_MIN_SIM}，补充槽位 ${EMBED_SUPPLEMENT_SLOTS}）`,
          `- 语义净贡献：${totalSemanticLinked} 个 mention 仅靠纯语义候选才链接成功`,
        ]
      : [
          `- 语义通道：❌ 未启用（${opts.noEmbed ? '--no-embed 显式关闭' : 'Ollama 探测失败'}），本轮退化为纯词汇通道（= v1 口径）`,
        ]),
    `- 别名提权：${totalAliasLinked} 个 mention 链接命中别名键（alias→canonical 映射共 ${index.keyToCanonical.size} 条）`,
    `- 确认阈值：主口径 conf ≥ ${opts.linkConf}（判定用），严格口径 conf ≥ ${STRICT_CONF_THRESHOLD}（对照 v1 二元确认，防止把阈值放宽误读为能力变强）`,
    '',
  ];
  const comparisonLines: string[] = comparison
    ? [
        `## 跨轮对比（vs \`${comparison.prevPath}\`）`,
        '',
        `> ⚠️ **本表仅供链接层口径参考，检索层（R@3）各行不可直接比。**`,
        `> 两轮题集与基线不同（上一轮 ${comparison.prev.totalMentions} mention / 基线 R@3 ${pct(comparison.prev.baselineR3)}，` +
          `本轮 ${totalMentions} mention / 基线 R@3 ${pct(data.attribution.baselineR3)}），` +
          `题集越大越难，基线越低则 headroom 越大。` +
          `故 \`merged R@3\` 与 \`提升/回退题数\` 的 Δ **不是能力变化**，只反映题集难度差异；` +
          `跨轮判定一律以 **提升 / headroom** 归一口径为准（见上方判定结论表），不读本表的绝对 Δ。`,
        '',
        `| 指标 | 上一轮 | 本轮 | Δ | 可比性 |`,
        `|------|--------|------|-----|--------|`,
        `| 基线 R@3（题集难度基准） | ${pct(comparison.prev.baselineR3)} | ${pct(data.attribution.baselineR3)} | ${signedPct(data.attribution.baselineR3 - comparison.prev.baselineR3)} | 基准值，非结论 |`,
        `| linkRate（主口径） | ${pct(comparison.prev.linkRate)} | ${pct(linkRate)} | ${signedPct(comparison.deltaLinkRate)} | 诊断，不设门 |`,
        `| 严格口径 linkRate | ${comparison.prev.strictLinkRate != null ? pct(comparison.prev.strictLinkRate) : '—（v1 为二元确认）'} | ${pct(strictLinkRate)} | ${comparison.deltaStrictLinkRate != null ? signedPct(comparison.deltaStrictLinkRate) : '—'} | 诊断，不设门 |`,
        `| 题目级命中率 | ${pct(comparison.prev.questionHitRate)} | ${pct(questionHitRate)} | ${signedPct(comparison.deltaQuestionHitRate)} | 可比（比例型） |`,
        `| merged R@3 | ${pct(comparison.prev.mergedR3)} | ${pct(data.attribution.mergedR3)} | ${signedPct(comparison.deltaMergedR3)} | ❌ 不可比（题集不同） |`,
        `| 提升 / 回退题数 | ${comparison.prev.improvedQuestions} / ${comparison.prev.regressedQuestions} | ${improvedCount} / ${regressedCount} | ${signedInt(comparison.deltaImproved)} / ${signedInt(comparison.deltaRegressed)} | ❌ 绝对数不可比，须除 headroom |`,
        `| 唯一实体键 | ${comparison.prev.uniqueEntityKeys} | ${index.keyToLabel.size} | ${signedInt(comparison.deltaEntityKeys)} | 规模差，非质量差 |`,
        `| 判定 | ${comparison.prev.verdict} | ${verdict} | — | 判据已修正，两轮不可直接对照 |`,
        '',
      ]
    : [];

  // 8. Markdown 报告
  const lines: string[] = [
    `# KG A 档实体链接命中率 spike 报告（${results.length} 题）`,
    '',
    `生成时间：${data.generatedAt}　模型：${opts.model}` +
      (opts.seed != null
        ? `　LLM 采样 seed：${opts.seed}（换 seed 复跑）`
        : ''),
    '',
    `## 预注册修正声明（⚠️ 必读，防 p-hacking）`,
    '',
    `**本节承认：判定线是在看到 10 题两轮数据之后修改的，属事后改判据，存在 p-hacking 风险。**`,
    '',
    `- 原 v1 判定线（**已作废**）：PASS ⇔ linkRate ≥ ${PASS_LINK_RATE} 且 提升题数 ≥ ${PASS_MIN_IMPROVED} 且 回退 ≤ 提升；REJECT ⇔ linkRate < ${REJECT_LINK_RATE}。`,
    `- 作废时间点：10 题两轮 linkRate（首轮 ${pct(0.559)} / seed2 轮 ${pct(0.508)}，均值 ${pct(0.534)}）出来**之后**、30 题门闩开跑**之前**。`,
    `- 作废原因：linkRate 的分母混入了「表述根本没在 gold 正文出现」的不可链接 mention（两轮实测占分母 34% / 41%）。` +
      `这类 mention 的**正确行为就是不链接**，因此 linkRate 的数学天花板只有约 ${pct(0.66)}，${PASS_LINK_RATE} 的 PASS 线在该口径下几乎不可达——` +
      `瓶颈是**指标分母污染**，不是链接能力不足（剔除污染后的可链接子集命中率两轮合并为 ${pct(0.851)}）。`,
    `- 数据保全：两轮原始 linkRate、逐 mention 链接明细、未链接归因全部保留在各自 \`spike-data.json\` 中，未删未改；` +
      `本报告同时输出 v1 口径下的判定结果（\`legacyVerdict = ${data.verdictBasis.legacyVerdict}\`）作为留痕对照。`,
    `- 修正约束：为降低事后调线的自由裁量空间，修正只做了**一次**，且在 30 题门闩数据产生**之前**由用户明确批准；` +
      `30 题门闩一律**单轮固定 --seed ${opts.seed ?? '（未指定）'}**，不再多轮换 seed 择优。`,
    '',
    `## 判定线（v3 修正版，当前生效）`,
    '',
    `- **主判据**：提升题数 / headroom ≥ ${PASS_IMPROVED_OF_HEADROOM}。` +
      `headroom = 基线 R@3 未满（< 1.0）的题数，是提升题数的**数学上限**；` +
      `不同轮选题的基线难度不同，故必须按 headroom 归一，「提升 ≥ N 题」这种绝对数不可比。`,
    `- **安全判据**：回退题数 ≤ 提升题数，且 回退题数 ≤ ${MAX_REGRESSED_ABS}（30 题口径约 5%）。`,
    `- **兜底判据**：可链接子集命中率 ≥ ${PASS_LINKABLE_RATE}（低于此值说明链接层本身崩坏，检索端结论不可信）。`,
    `- REJECT：提升题数 = 0，或 回退 > 提升。REVIEW：主/安全/兜底任一不满足。其余 PASS。`,
    `- **linkRate（主口径 + 严格口径）降为诊断指标，不设门**——理由见上方修正声明。`,
    `- 归因口径：${data.preregistration.attribution}（补充位最多顶 1 个，最多翻 1 题，不夸大）。`,
    '',
    `## 判定结论：${verdict === 'PASS' ? '✅ PASS' : verdict === 'REJECT' ? '🔴 REJECT' : '🟡 REVIEW'}`,
    '',
    `| 指标 | 值 | 判定线 | 是否满足 |`,
    `|------|-----|--------|----------|`,
    `| **提升题数 / headroom（主判据）** | **${improvedCount} / ${headroomQuestions} = ${pct(improvedOfHeadroom)}** | ≥ ${PASS_IMPROVED_OF_HEADROOM} | ${improvedOfHeadroom >= PASS_IMPROVED_OF_HEADROOM ? '✅' : '❌'} |`,
    `| 回退题数（安全判据） | ${regressedCount} | ≤ 提升（${improvedCount}）且 ≤ ${MAX_REGRESSED_ABS} | ${regressedCount <= improvedCount && regressedCount <= MAX_REGRESSED_ABS ? '✅' : '❌'} |`,
    `| 可链接子集命中率（兜底判据） | ${pct(linkableLinkRate)}（${totalLinked}/${linkableMentions}） | ≥ ${PASS_LINKABLE_RATE} | ${linkableLinkRate >= PASS_LINKABLE_RATE ? '✅' : '❌'} |`,
    `| v1 口径判定（留痕对照，不参与定档） | ${data.verdictBasis.legacyVerdict} | — | — |`,
    '',
    `### 全量指标（含诊断项）`,
    '',
    `| 指标 | 值 |`,
    `|------|-----|`,
    `| 基线 R@3 | ${pct(data.attribution.baselineR3)} |`,
    `| merged R@3（补 1 位） | ${pct(data.attribution.mergedR3)}（Δ ${pct(data.attribution.deltaR3)}） |`,
    `| 纯图排序 R@3 | ${pct(data.attribution.graphOnlyR3)} |`,
    `| headroom（基线 R@3 未满的题数） | ${headroomQuestions} / ${results.length} |`,
    `| 提升 / 回退题数 | ${improvedCount} / ${regressedCount} |`,
    `| 新增可达 gold（基线 top10 未召回、图池命中） | ${data.attribution.totalNewGoldReach} |`,
    `| 〔诊断〕linkRate（micro，conf ≥ ${opts.linkConf}） | ${pct(linkRate)}（${totalLinked}/${totalMentions}） |`,
    `| 〔诊断〕严格口径 linkRate（conf ≥ ${STRICT_CONF_THRESHOLD}，与 v1 二元确认可比） | ${pct(strictLinkRate)}（${totalStrictLinked}/${totalMentions}） |`,
    `| 〔诊断〕不可链接 mention（表述不在 gold 正文，已从兜底判据分母剔除） | ${unlinkableMentions} / ${totalMentions}（${pct(totalMentions > 0 ? unlinkableMentions / totalMentions : 0)}） |`,
    `| 〔诊断〕题目级命中率（≥1 mention 链接成功） | ${pct(questionHitRate)} |`,
    `| 〔诊断〕纯精确归一化匹配率（不含 LLM 链接） | ${pct(exactRate)} |`,
    '',
    ...channelLines,
    ...comparisonLines,
    `## 数据域`,
    '',
    `- 题目：${results.length} 题（gate 选题前 ${opts.limit}，与 30 题门闩同口径可配对）`,
    `- gold 文档并集：${goldUnion.size} 篇，成功抽取 ${rows.length} 篇`,
    `- 唯一实体键：${index.keyToLabel.size}，三元组：${index.tripleCount}，倒排 token：${index.tokenToKeys.size}`,
    `- Token 用量：调用 ${usage.calls} 次 / 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}`,
    '',
    `## 逐题明细`,
    '',
    `| qid | mention | 链接 | 精确 | 基线R@3 | mergedR@3 | 纯图R@3 | 新增gold |`,
    `|-----|---------|------|------|---------|-----------|---------|----------|`,
    ...results.map(
      (r) =>
        `| ${r.questionId} | ${r.mentionCount} | ${r.linkedMentionCount} | ${r.exactMentionCount} | ` +
        `${pct(r.baselineR3)} | ${pct(r.mergedR3)} | ${pct(r.graphOnlyR3)} | ${r.newGoldReach} |`,
    ),
    '',
    `## 未链接 mention 归因样例`,
    '',
    `> textPresentInGold=true 表示该表述（或变体）在 gold 正文中原样出现，却没被抽成实体或没被链接上`,
    `> —— 属于「抽取/链接能力不足」；false 属于「问题改写与文档表述的语义鸿沟」。`,
    '',
  ];
  let diagCount = 0;
  for (const r of results) {
    for (const d of r.unlinkedDiag) {
      if (diagCount >= 20) break;
      lines.push(
        `- [${r.questionId}] "${d.surface}"　gold中出现=${d.textPresentInGold}　候选=${
          d.candidateLabels.length > 0
            ? d.candidateLabels.join(' / ')
            : '（无召回）'
        }`,
      );
      diagCount++;
    }
  }
  if (diagCount === 0) lines.push('- （全部 mention 均链接成功）');
  lines.push('', `## 链接成功样例（前 10 条）`, '');
  let sampleCount = 0;
  for (const r of results) {
    for (const m of r.mentions) {
      if (m.linkedKeys.length === 0 || sampleCount >= 10) continue;
      const labels = m.linkedKeys.map((k) => index.keyToLabel.get(k) ?? k);
      lines.push(`- [${r.questionId}] "${m.surface}" → ${labels.join(' / ')}`);
      sampleCount++;
    }
  }
  if (sampleCount === 0) lines.push('- （无）');

  // ==================== 局限（必须与结论同时阅读，防止过度解读） ====================
  lines.push(
    '',
    `## 局限（读结论前必看）`,
    '',
    results.length < 30
      ? `1. **题目系统性偏易（子集运行）**：本次只取 gate 选题前 ${results.length} 题，基线 R@3 = ${pct(data.attribution.baselineR3)}，` +
          `headroom 仅 ${headroomQuestions} 题。基线越高、headroom 越小，图补充位的可提升空间越小，` +
          `故本次 Δ R@3（${pct(data.attribution.deltaR3)}）**系统性低估** A 档在 30 题上的收益；` +
          `同理"回退题数"也被低估——高基线下几乎不存在可回退的题，抗回退能力未被真正检验。` +
          `headroom=${headroomQuestions} 时主判据的绝对题数意义极弱（1~2 题就能过线），**不得据此定档**。`
      : `1. **本轮为 30 题全量门闩**：headroom = ${headroomQuestions} 题（基线 R@3 已满的 ${results.length - headroomQuestions} 题在数学上不可能被提升）。` +
          `主判据要求 提升 ≥ ${Math.ceil(headroomQuestions * PASS_IMPROVED_OF_HEADROOM)} 题（${headroomQuestions} × ${PASS_IMPROVED_OF_HEADROOM}），` +
          `这是**在 headroom 内翻中一半**的强度，不是「30 题里提升一半」——后者在本归因口径下不可能达成，读数时切勿混淆。`,
    `2. **文档域仅 ${rows.length} 篇**（本次题目 gold 并集），实体键 ${index.keyToLabel.size} / 三元组 ${index.tripleCount}，` +
      `远小于全库（约 325 篇）规模。候选实体池越小，链接越容易命中，` +
      `故链接层指标 **系统性高估**全库表现；全库还需面对同名实体消歧问题，本次未覆盖。`,
    `3. **归因口径保守**：merged = 基线 top${3 - GRAPH_SUPPLEMENT_SLOTS} + 图补充 ${GRAPH_SUPPLEMENT_SLOTS} 位，` +
      `最多顶掉 1 个基线结果、最多翻 1 题，不夸大收益；` +
      `但也因此 merged R@3 无法反映图排序自身质量，须同时看"纯图排序 R@3"（${pct(data.attribution.graphOnlyR3)}）。`,
    `4. **模型思考块开销**：${opts.model} 为 Thinking 模式，输出 token 显著膨胀。` +
      `本次 ${usage.calls} 次调用消耗输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} token，` +
      `推广到 30 题门闩与全库离线抽取时，成本与耗时须按此折算。`,
    opts.seed != null && results.length < 30
      ? `5. **本轮为换 seed 复跑（seed=${opts.seed}）**：实体 / mention / 嵌入缓存全部命中，` +
          `差异只来自链接确认的重新采样，属「同图不同采样」的配对复跑。` +
          `两轮 n=10、每轮 59 mention，样本量仍不足以给出置信区间，单轮结果不单独决策。` +
          `10 题子集的 headroom 只有 ${headroomQuestions} 题，主判据在该样本上几乎无鉴别力，故 10 题结果仅用于**判据校准与归因**，定档一律以 30 题门闩为准。`
      : opts.seed != null
        ? `5. **本轮为 30 题门闩的正式定档轮（单轮固定 seed=${opts.seed}）**：按用户批准的修正判据，` +
          `门闩只跑**一轮**、seed 固定，不再多轮换 seed 择优——多轮择优等价于把判定线偷偷放宽。` +
          `代价是本轮无法给出采样噪声的置信区间；10 题两轮实测的采样一致率为 ${pct(0.881)}，` +
          `翻转项置信度全部落在 0.4~0.8 的阈值边界带，可据此估计本轮链接层抖动幅度，但检索端结论不再有重复验证。`
        : `5. **单次运行、无重复采样**：LLM 抽取与链接均含随机性，本结果未做多 seed 重复，指标置信区间未知。` +
          `若结论落在判定线附近（REVIEW），应换 seed 复跑一次再定档，不宜据单次结果决策。`,
    `6. **语义通道参数未做敏感性分析**：语义补充通道依赖本地 Ollama 嵌入模型（cos 阈值 ${EMBED_MIN_SIM}、补充槽位 ${EMBED_SUPPLEMENT_SLOTS}），` +
      `两者均为启发式取值——阈值调高会减少进池候选，槽位调大会放大语义通道影响。` +
      `词汇通道严格保持 v1 口径（top ${CANDIDATE_TOP_K}、score ≥ ${CANDIDATE_MIN_SCORE}）；嵌入服务任何失败都自动降级为纯词汇通道，不中断主流程。`,
    `7. **主判据分母（headroom）本身很小**：headroom = ${headroomQuestions} 题，` +
      `意味着 ${improvedCount} 题提升就对应 ${pct(improvedOfHeadroom)}——分母越小，单题抖动对判据的影响越大` +
      `（1 题 ≈ ${pct(headroomQuestions > 0 ? 1 / headroomQuestions : 0)}）。` +
      `因此**必须与「回退题数」「新增可达 gold」一起读**：若提升数刚好压线且回退 = 提升，应视为 REVIEW 而非 PASS。`,
  );

  const reportPath = path.join(opts.outDir, 'spike-report.md');
  const reportMd = lines.join('\n');
  const reportWritten = await safeWriteFile(reportPath, reportMd, 'overwrite');
  if (!reportWritten) {
    // 写盘被拦截（如沙箱路径限制）时把完整报告转储到 stdout，避免已付费的 LLM 结果丢失
    console.log('===SPIKE_REPORT_MD_BEGIN===');
    console.log(reportMd);
    console.log('===SPIKE_REPORT_MD_END===');
  }

  await writeCostFile(`${entitiesPath}.cost.json`, {
    stage: 'kg-link-spike',
    model: opts.model,
    questions: results.length,
    extractedDocs: rows.length,
    linkRate,
    verdict,
    finishedAt: new Date().toISOString(),
  });

  console.log(`\n=== KG 实体链接 spike ===`);
  console.log(
    `【主判据】提升 / headroom = ${improvedCount} / ${headroomQuestions} = ${pct(improvedOfHeadroom)}` +
      `（线 ≥ ${PASS_IMPROVED_OF_HEADROOM}）　${improvedOfHeadroom >= PASS_IMPROVED_OF_HEADROOM ? '✅' : '❌'}`,
  );
  console.log(
    `【安全判据】回退 ${regressedCount}（线 ≤ 提升 ${improvedCount} 且 ≤ ${MAX_REGRESSED_ABS}）　` +
      `${regressedCount <= improvedCount && regressedCount <= MAX_REGRESSED_ABS ? '✅' : '❌'}`,
  );
  console.log(
    `【兜底判据】可链接子集命中率 ${pct(linkableLinkRate)}（${totalLinked}/${linkableMentions}，线 ≥ ${PASS_LINKABLE_RATE}）　` +
      `${linkableLinkRate >= PASS_LINKABLE_RATE ? '✅' : '❌'}　` +
      `（剔除 ${unlinkableMentions} 个「表述不在 gold 正文」的不可链接 mention）`,
  );
  console.log(
    `R@3: 基线 ${pct(data.attribution.baselineR3)} → merged ${pct(data.attribution.mergedR3)}` +
      `（Δ ${pct(data.attribution.deltaR3)}）　纯图排序 ${pct(data.attribution.graphOnlyR3)}` +
      `　新增可达 gold ${data.attribution.totalNewGoldReach}`,
  );
  console.log(
    `〔诊断〕linkRate=${pct(linkRate)}（精确匹配 ${pct(exactRate)}）　严格口径 ${pct(strictLinkRate)}` +
      `　题目级命中 ${pct(questionHitRate)}　v1 口径判定=${data.verdictBasis.legacyVerdict}`,
  );
  console.log(
    `〔诊断〕语义通道 ${embed ? `启用（净贡献 ${totalSemanticLinked} mention）` : '未启用（降级为 v1 口径）'}` +
      `　别名命中 ${totalAliasLinked} mention`,
  );
  if (comparison) {
    console.log(
      `对比上一轮：linkRate ${pct(comparison.prev.linkRate)} → ${pct(linkRate)}` +
        `（Δ ${signedPct(comparison.deltaLinkRate)}），判定 ${comparison.prev.verdict} → ${verdict}`,
    );
  }
  console.log(`判定：${verdict}`);
  console.log(
    reportWritten
      ? `报告：${reportPath}`
      : `⚠️ 报告未能落盘（${reportPath}）——完整内容已转储到上方 stdout 标记块之间；` +
          `请检查输出目录是否在工作区之外被沙箱拦截`,
  );
  logger.info('KG 实体链接 spike 完成', {
    module: MODULE,
    improvedOfHeadroom,
    headroomQuestions,
    linkableLinkRate,
    linkRate,
    exactRate,
    improvedCount,
    regressedCount,
    legacyVerdict: data.verdictBasis.legacyVerdict,
    verdict,
  });
  await gracefulExit(verdict === 'PASS' ? 0 : verdict === 'REJECT' ? 3 : 4);
}

main().catch(async (error: unknown) => {
  console.error('KG spike 主流程异常:', error);
  logger.error('KG spike 主流程异常', {
    module: MODULE,
    error: errMsg(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  await gracefulExit(1);
});
