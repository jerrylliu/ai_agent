/**
 * scripts/bench/run-judge.ts
 *
 * LLM Judge 批量 runner：对 answers.jsonl 的生成答案做三维判分
 * （correctness 正确性 / faithfulness 忠实度 / relevance 切题度）。
 *
 * 与 run-erb-eval.ts 的关系：
 *   - run-erb-eval 产出 answers.jsonl（answer/document_ids/contexts，含检索指标聚合）；
 *   - 本脚本纯离线消费 answers.jsonl，只补"生成质量"维度——不连向量库、不重跑检索，
 *     需要 .env 里的 LLM API Key（DEEPSEEK_API_KEY 或 ZHIPU_API_KEY）。
 *
 * 输出（与 answers.jsonl 同目录）：
 *   - judge-results.jsonl：逐题三维判分（含 reason / unfaithful_claims），供 diff 与对比脚本消费
 *   - judge-report.json：聚合报告（机器可读）
 *   - judge-report.md：人读报告（含幻觉明细、低分题清单、人工抽查指引）
 *
 * 🔴 judge 模型独立于被评模型：默认 zhipu:glm-4.7（与被评的 deepseek 系错开厂商，
 *    避免同源自评偏置），可用 --judge-model 覆盖。断点续传：--resume 跳过已判题。
 *
 * 用法：
 *   pnpm bench:judge -- --answers E:\ragbench\bm25\wiki-gate\answers.jsonl
 *   pnpm bench:judge -- --answers ... --judge-model deepseek:deepseek-v4-flash --concurrency 5 --resume
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { closeLogger, logger } from '../../src/fundamentals/logger.js';
import {
  createLLM,
  getCurrentModelId,
  getDeepseekApiKey,
  getZhipuApiKey,
  loadApiKeysFromStorage,
  switchModel,
} from '../../src/fundamentals/model-provider.js';
import {
  getRedis,
  waitForRedisReady,
} from '../../src/fundamentals/redis-client.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { loadQuestions } from './lib/erb-loader.js';
import {
  aggregateVerdicts,
  judgeOne,
  type JudgeInput,
  type JudgeVerdict,
} from '../../src/fundamentals/eval/judge.js';

// ==================== 常量 ====================

const MODULE = 'BenchJudge';

/** 默认 judge 模型：与被评模型错开厂商（防同源自评偏置） */
const DEFAULT_JUDGE_MODEL = 'zhipu:glm-4.7';

/** judge 并发默认/上限（judge 是轻量调用，可比题目并发略高） */
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 10;

// ==================== gracefulExit（与 compare-wiki-gate 同款，防 libuv 断言崩溃） ====================

function scheduleForceExit(code: number): void {
  const t = setTimeout(() => process.exit(code), 6000);
  t.unref();
}

async function gracefulExit(code: number): Promise<never> {
  scheduleForceExit(code);
  try {
    await closeLogger();
  } catch {
    // 关日志失败不阻塞退出
  }
  process.exit(code);
}

// ==================== CLI ====================

interface JudgeCliOptions {
  /** answers.jsonl 路径（必填） */
  answers: string;
  /** judge 模型 id（缺省 zhipu:glm-4.7） */
  judgeModel: string;
  /** 并发数 */
  concurrency: number;
  /** 断点续传：跳过 judge-results.jsonl 已有成功行的题 */
  resume: boolean;
  /** 限定题型（逗号分隔），缺省全部 */
  types?: string[];
  /** 最多判 N 题（调试用，缺省全部） */
  limit?: number;
}

function parseArgs(argv: string[]): JudgeCliOptions {
  const opts: JudgeCliOptions = {
    answers: '',
    judgeModel: DEFAULT_JUDGE_MODEL,
    concurrency: DEFAULT_CONCURRENCY,
    resume: false,
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
      case '--answers':
        opts.answers = next();
        break;
      case '--judge-model':
        opts.judgeModel = next();
        break;
      case '--concurrency': {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0 || n > MAX_CONCURRENCY) {
          console.error(`--concurrency 必须是 1~${MAX_CONCURRENCY} 的整数`);
          process.exit(1);
        }
        opts.concurrency = n;
        break;
      }
      case '--resume':
        opts.resume = true;
        break;
      case '--type':
        opts.types = (opts.types ?? []).concat(
          next()
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        );
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
      case '--help':
      case '-h':
        console.log(
          [
            '用法：pnpm bench:judge -- [options]',
            '  --answers <path>        answers.jsonl 路径（必填）',
            '  --judge-model <modelId> judge 模型（缺省 zhipu:glm-4.7，建议与被评模型错开厂商）',
            '  --concurrency <n>       并发数（默认 5，上限 10）',
            '  --type <t1,t2>          限定题型（如 --type semantic）',
            '  --limit <n>             最多判 n 题（调试用）',
            '  --resume                断点续传：跳过已判题，追加落盘',
          ].join('\n'),
        );
        process.exit(0);
      default:
        console.error(`未知参数：${arg}（--help 查看用法）`);
        process.exit(1);
    }
  }
  if (!opts.answers) {
    console.error('缺少必填参数 --answers <answers.jsonl 路径>');
    process.exit(1);
  }
  return opts;
}

// ==================== 读取 ====================

/** answers.jsonl 成功行（结构与 run-erb-eval 的 AnswerRecord 对齐，只取 judge 所需字段） */
interface AnswerRow {
  question_id: string;
  answer: string;
  contexts: string[];
}

function readAnswerRows(filePath: string): Map<string, AnswerRow> {
  const map = new Map<string, AnswerRow>();
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: AnswerRow & Record<string, unknown>;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // malformed 行跳过（与 run-erb-eval 容忍口径一致）
    }
    if (
      typeof row.question_id !== 'string' ||
      typeof row.answer !== 'string' ||
      !Array.isArray(row.contexts)
    ) {
      continue;
    }
    map.set(row.question_id, {
      question_id: row.question_id,
      answer: row.answer,
      contexts: row.contexts,
    });
  }
  return map;
}

// ==================== judge 模型准备 ====================

/**
 * 准备 judge 模型实例。
 * Key 解析顺序：Redis 恢复 → .env（DEEPSEEK_API_KEY / ZHIPU_API_KEY）。
 */
async function prepareJudgeModel(modelId: string): Promise<BaseChatModel> {
  // 镜像 run-erb-eval 启动序列：getRedis 预热 → 等就绪 → 恢复（对 Redis 只读）。
  // 必须先于 switchModel：Redis 存有 Key 而 .env 没有时，switchModel 的 Key 校验
  // 依赖 loadApiKeysFromStorage 恢复后的模块态，顺序颠倒会误报"缺少 API Key"。
  // REDIS_ENABLED=false 或连不上时自动降级（本机未起 Redis 属常态，走 .env Key）。
  getRedis();
  await waitForRedisReady(3000);
  await loadApiKeysFromStorage();

  // switchModel 的 Key 校验走 getter（含 .env DEEPSEEK_API_KEY / ZHIPU_API_KEY 兜底），
  // 与 buildModelConfig 实际取 Key 的口径一致；模型 id 非法或 Key 缺失在此抛错。
  const modelConfig = switchModel(modelId);

  if (modelConfig.provider === 'deepseek' && !getDeepseekApiKey()) {
    console.error(
      'DeepSeek judge 模型缺少 API Key：请在 .env 配置 DEEPSEEK_API_KEY，或用 Redis 已存 Key',
    );
    await gracefulExit(2);
  }
  if (modelConfig.provider === 'zhipu' && !getZhipuApiKey()) {
    console.error(
      '智谱 judge 模型缺少 API Key：请在 .env 配置 ZHIPU_API_KEY，或用 Redis 已存 Key',
    );
    await gracefulExit(2);
  }
  return createLLM(modelConfig);
}

// ==================== 报告生成 ====================

interface JudgeReport {
  generatedAt: string;
  answersPath: string;
  judgeModel: string;
  judgedCount: number;
  judgeErrorCount: number;
  skippedExisting: number;
  aggregate: {
    correctnessRate: number;
    faithfulnessRate: number;
    relevanceRate: number;
  };
  perQuestionType: Record<
    string,
    { count: number; correctness: number; faithful: number; relevant: number }
  >;
  /** 幻觉明细：faithful=false 的题（含编造原句），回答质量盲区的核心产出 */
  unfaithfulDetails: Array<{
    question_id: string;
    question_type: string;
    claims: string[];
  }>;
  /** 错题明细 */
  incorrectDetails: Array<{
    question_id: string;
    question_type: string;
    reason: string;
  }>;
}

function buildMarkdownReport(report: JudgeReport): string {
  const lines: string[] = [];
  lines.push('# ERB Judge 报告');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- answers 来源：${report.answersPath}`);
  lines.push(`- judge 模型：${report.judgeModel}`);
  lines.push(
    `- 判分题数：${report.judgedCount}（judge 失败 ${report.judgeErrorCount}）`,
  );
  lines.push('');
  lines.push('| 维度 | 比率 |');
  lines.push('|------|------|');
  lines.push(
    `| 正确率 correctness | ${(report.aggregate.correctnessRate * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| 忠实度 faithfulness | ${(report.aggregate.faithfulnessRate * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| 切题度 relevance | ${(report.aggregate.relevanceRate * 100).toFixed(1)}% |`,
  );
  lines.push('');
  lines.push('## 按题型');
  lines.push('');
  lines.push('| 题型 | 数量 | correctness | faithfulness | relevance |');
  lines.push('|------|------|-------------|--------------|-----------|');
  for (const [type, s] of Object.entries(report.perQuestionType)) {
    lines.push(
      `| ${type} | ${s.count} | ${(s.correctness * 100).toFixed(1)}% | ${(s.faithful * 100).toFixed(1)}% | ${(s.relevant * 100).toFixed(1)}% |`,
    );
  }
  if (report.unfaithfulDetails.length > 0) {
    lines.push('');
    lines.push('## 幻觉明细（faithful=false）');
    lines.push('');
    for (const d of report.unfaithfulDetails) {
      lines.push(`### ${d.question_id}（${d.question_type}）`);
      for (const c of d.claims) {
        lines.push(`- ${c}`);
      }
      lines.push('');
    }
  }
  if (report.incorrectDetails.length > 0) {
    lines.push('');
    lines.push('## 错题明细（answer_correct=false）');
    lines.push('');
    lines.push('| 题目 | 题型 | judge 理由 |');
    lines.push('|------|------|-----------|');
    for (const d of report.incorrectDetails) {
      lines.push(`| ${d.question_id} | ${d.question_type} | ${d.reason} |`);
    }
  }
  lines.push('');
  lines.push('## 人工抽查校准指引');
  lines.push('');
  lines.push(
    '从 judge-results.jsonl 抽 10 题（建议：全部 faithful=false + 随机 6 题 faithful=true），',
  );
  lines.push(
    '对照 answer/contexts/gold 人工判定，与 judge 的三维结论比对；不一致题记录下来复核 prompt 口径。',
  );
  lines.push('');
  return lines.join('\n');
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.answers)) {
    console.error(`answers 文件不存在：${opts.answers}`);
    await gracefulExit(2);
  }

  const questions = loadQuestions();
  const questionById = new Map(questions.map((q) => [q.question_id, q]));
  const answers = readAnswerRows(opts.answers);
  logger.info('judge 启动', {
    module: MODULE,
    answersPath: opts.answers,
    answerRows: answers.size,
    judgeModel: opts.judgeModel,
    concurrency: opts.concurrency,
  });

  // 组装待判清单：题目存在 + 有成功答案行 + （题型过滤）+（limit 截取）
  let pending: Array<{ qid: string; input: JudgeInput }> = [];
  for (const [qid, row] of answers) {
    const q = questionById.get(qid);
    if (!q) continue; // 孤儿行（answers 里有、题集里无），与 run-erb-eval 口径一致直接忽略
    if (opts.types && !opts.types.includes(q.question_type)) continue;
    pending.push({
      qid,
      input: {
        question: q.question,
        answer: row.answer,
        goldAnswer: q.gold_answer,
        answerFacts: q.answer_facts,
        contexts: row.contexts,
        questionType: q.question_type,
      },
    });
  }
  if (opts.limit !== undefined) pending.splice(opts.limit);

  // 断点续传：读已有 judge-results.jsonl，跳过已成功行
  const dir = path.dirname(opts.answers);
  const resultsPath = path.join(dir, 'judge-results.jsonl');
  const verdictById = new Map<string, JudgeVerdict>();
  const errorIds = new Set<string>();
  let skippedExisting = 0;
  if (opts.resume && fs.existsSync(resultsPath)) {
    for (const line of fs.readFileSync(resultsPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as {
          question_id: string;
          verdict: JudgeVerdict | null;
        };
        if (row.verdict) verdictById.set(row.question_id, row.verdict);
        else errorIds.add(row.question_id);
      } catch {
        continue;
      }
    }
    const before = pending.length;
    pending = pending.filter((p) => !verdictById.has(p.qid));
    skippedExisting = before - pending.length;
    logger.info('judge 续传', {
      module: MODULE,
      skippedExisting,
      remaining: pending.length,
    });
  }

  if (pending.length === 0) {
    console.log('没有待判题目（全部已判或 answers 为空）');
  }

  const judgeLlm = await prepareJudgeModel(opts.judgeModel);

  // worker pool 并发判分（抢占式领取 + appendFileSync 同步写，与 run-erb-eval 同款模型）
  let cursor = 0;
  let done = 0;
  const total = pending.length;
  if (!opts.resume) {
    // 全新运行（非续传）时清空旧文件，避免把上次实验的行混进本次聚合
    fs.writeFileSync(resultsPath, '', 'utf-8');
  }
  const failedIds: string[] = [];

  async function worker(): Promise<void> {
    while (cursor < total) {
      const idx = cursor++;
      const { qid, input } = pending[idx];
      const verdict = await judgeOne(judgeLlm, input);
      // 落盘行：question_id + verdict（null = judge 失败，续传时会重跑）
      fs.appendFileSync(
        resultsPath,
        `${JSON.stringify({ question_id: qid, verdict })}\n`,
        'utf-8',
      );
      if (verdict) verdictById.set(qid, verdict);
      else failedIds.push(qid);
      done++;
      if (done % 5 === 0 || done === total) {
        logger.info('judge 进度', { module: MODULE, done, total });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, Math.max(total, 1)) }, () =>
      worker(),
    ),
  );

  // ==================== 聚合与报告 ====================
  const judgedVerdicts = [...verdictById.values()];
  const aggregate = aggregateVerdicts(
    judgedVerdicts,
    judgedVerdicts.length + failedIds.length,
  );

  const perQuestionType: JudgeReport['perQuestionType'] = {};
  const unfaithfulDetails: JudgeReport['unfaithfulDetails'] = [];
  const incorrectDetails: JudgeReport['incorrectDetails'] = [];
  for (const [qid, v] of verdictById) {
    const q = questionById.get(qid);
    const type = q?.question_type ?? 'unknown';
    const bucket = (perQuestionType[type] ??= {
      count: 0,
      correctness: 0,
      faithful: 0,
      relevant: 0,
    });
    bucket.count++;
    if (v.answer_correct) bucket.correctness++;
    if (v.faithful) bucket.faithful++;
    if (v.relevant) bucket.relevant++;
    if (!v.faithful && v.unfaithful_claims.length > 0) {
      unfaithfulDetails.push({
        question_id: qid,
        question_type: type,
        claims: v.unfaithful_claims,
      });
    }
    if (!v.answer_correct) {
      incorrectDetails.push({
        question_id: qid,
        question_type: type,
        reason: v.reason,
      });
    }
  }
  // 桶内比率
  for (const bucket of Object.values(perQuestionType)) {
    if (bucket.count > 0) {
      bucket.correctness /= bucket.count;
      bucket.faithful /= bucket.count;
      bucket.relevant /= bucket.count;
    }
  }

  const report: JudgeReport = {
    generatedAt: new Date().toISOString(),
    answersPath: opts.answers,
    judgeModel: opts.judgeModel,
    judgedCount: judgedVerdicts.length,
    judgeErrorCount: failedIds.length,
    skippedExisting,
    aggregate: {
      correctnessRate: aggregate.correctnessRate,
      faithfulnessRate: aggregate.faithfulnessRate,
      relevanceRate: aggregate.relevanceRate,
    },
    perQuestionType,
    unfaithfulDetails,
    incorrectDetails,
  };

  const reportJsonPath = path.join(dir, 'judge-report.json');
  const reportMdPath = path.join(dir, 'judge-report.md');
  fs.writeFileSync(
    reportJsonPath,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf-8',
  );
  fs.writeFileSync(reportMdPath, buildMarkdownReport(report), 'utf-8');

  // 控制台摘要
  console.log('');
  console.log('=== Judge 完成 ===');
  console.log(
    `判分 ${aggregate.judgedCount} 题（失败 ${aggregate.judgeErrorCount}，续传跳过 ${skippedExisting}）`,
  );
  console.log(
    `正确率   correctness  : ${(aggregate.correctnessRate * 100).toFixed(1)}%`,
  );
  console.log(
    `忠实度   faithfulness : ${(aggregate.faithfulnessRate * 100).toFixed(1)}%`,
  );
  console.log(
    `切题度   relevance    : ${(aggregate.relevanceRate * 100).toFixed(1)}%`,
  );
  console.log(`报告: ${reportMdPath}`);
  console.log(`明细: ${resultsPath}`);

  logger.info('judge 完成', { module: MODULE, ...aggregate });
  await gracefulExit(failedIds.length > 0 ? 1 : 0);
}

main().catch(async (e: unknown) => {
  console.error('judge 运行异常:', e);
  await gracefulExit(2);
});
