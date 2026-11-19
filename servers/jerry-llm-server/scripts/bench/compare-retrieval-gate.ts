/**
 * 通用检索回归门闩（benchmark-only）
 *
 * 与 compare-wiki-gate.ts 的关系：wiki 门闩只服务 wiki 实验（30 题 semantic，
 * 耦合 wiki 命中诊断与 judge 翻转）；本脚本是「任意两次评测运行」的检索指标
 * 配对对比——改 BM25 权重 / 切分参数 / 重排策略等任何检索改动后，用同一份
 * questions 的 gold 对比基线与实验组的 answers.jsonl，检索指标退化超阈值即
 * 以非零码拦截（可挂 CI）。
 *
 * 口径约定（与 run-erb-eval S3.4 / erb-internal-metrics 一致）：
 *   - 空 gold 题（expected_doc_ids 为空）剔除出分母；
 *   - 只统计两侧都有成功行的配对题（缺行/错误行计入报告但剔除出均值）；
 *   - 指标计算复用 src/fundamentals/eval/metrics.ts（evaluateQuery）。
 *
 * 判定规则：
 *   - 任一指标配对均值退化（Δ < -threshold，缺省 2.0pp）→ 否决，exit 3；
 *   - 配对数 < min-pairs（缺省 10）→ 拒绝判定（样本过小不可信），exit 2；
 *   - 两侧均值全为 0 → 口径/数据异常，拒绝产出报告，exit 2（同 wiki 门闩）。
 *
 * 用法：
 *   pnpm bench:retrieval-gate -- --baseline <answers.jsonl> --exp <answers.jsonl>
 *   可选：--k 3,5,10  --threshold 0.02  --min-pairs 10  --data-dir <dir>  --out-dir <dir>
 *
 * 退出码：0=通过 / 1=用法错误 / 2=数据异常或样本不足 / 3=否决
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量，与 wiki 门闩一致）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { loadQuestions, ERB_DATA_DIR } from './lib/erb-loader.js';
import { evaluateQuery } from '../../src/fundamentals/eval/metrics.js';

// ==================== 常量 ====================

const MODULE = 'BenchRetrievalGate';

/** 逐题指标默认 K 值（与 erb-internal-metrics 口径一致） */
const DEFAULT_K_VALUES = [3, 5, 10];

/** 否决阈值：任一指标均值退化超过 2.0pp 即否决（与 wiki 门闩污染否决同级） */
const DEFAULT_THRESHOLD = 0.02;

/** 最小配对数：低于此值拒绝判定（样本过小，门闩结论不可信） */
const DEFAULT_MIN_PAIRS = 10;

// ==================== gracefulExit ====================

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

// ==================== 类型与读取 ====================

/** answers.jsonl 单行（官方 harness schema + bench_meta 自有扩展） */
interface AnswerRow {
  question_id: string;
  answer?: string;
  document_ids: string[];
  contexts?: string[];
  bench_meta?: Record<string, unknown>;
  /** runner 失败行会带 error 字段（erb-internal-metrics 同款识别口径） */
  error?: string;
}

interface ReadStats {
  rows: Map<string, AnswerRow>;
  malformed: number;
  errorRows: number;
  orphans: number;
}

/**
 * 宽容解析 answers.jsonl：半行/损坏行跳过（与 wiki 门闩 --compact-only 容忍口径一致），
 * document_ids 非字符串数组视为脏行，带 error 字段的行单独计数。
 */
function readAnswers(filePath: string, validQids: Set<string>): ReadStats {
  const rows = new Map<string, AnswerRow>();
  let malformed = 0;
  let errorRows = 0;
  let orphans = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: AnswerRow;
    try {
      row = JSON.parse(line) as AnswerRow;
    } catch {
      malformed++;
      continue;
    }
    if (
      !row ||
      typeof row.question_id !== 'string' ||
      !Array.isArray(row.document_ids) ||
      !row.document_ids.every((id) => typeof id === 'string')
    ) {
      malformed++;
      continue;
    }
    if (row.error !== undefined) {
      errorRows++;
      continue;
    }
    if (!validQids.has(row.question_id)) {
      orphans++;
      continue;
    }
    // 同 qid 重复行后写覆盖（与 Map 语义一致，resume 场景可能追加重跑行）
    rows.set(row.question_id, row);
  }
  return { rows, malformed, errorRows, orphans };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ==================== CLI 解析 ====================

interface GateOptions {
  baselinePath: string;
  expPath: string;
  dataDir: string;
  kValues: number[];
  threshold: number;
  minPairs: number;
  outDir: string;
}

function parseCli(): GateOptions | null {
  const argv = process.argv.slice(2);
  const argOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const baselinePath = argOf('--baseline');
  const expPath = argOf('--exp');
  if (!baselinePath || !expPath) {
    console.error(
      '用法: compare-retrieval-gate.ts --baseline <answers.jsonl> --exp <answers.jsonl>' +
        ' [--k 3,5,10] [--threshold 0.02] [--min-pairs 10] [--data-dir <dir>] [--out-dir <dir>]',
    );
    return null;
  }

  // K 值解析：正整数、去重、升序（保证输出键稳定）
  const kValues = (argOf('--k') ?? DEFAULT_K_VALUES.join(','))
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  const uniqueK = [...new Set(kValues)].sort((a, b) => a - b);
  if (uniqueK.length === 0) {
    console.error(`非法 --k 参数（需为正整数列表，如 3,5,10）`);
    return null;
  }

  const threshold = Number(argOf('--threshold') ?? DEFAULT_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    console.error(`非法 --threshold（需 0 < t < 1，如 0.02 表示 2pp）`);
    return null;
  }

  const minPairs = Number.parseInt(
    argOf('--min-pairs') ?? String(DEFAULT_MIN_PAIRS),
    10,
  );
  if (!Number.isInteger(minPairs) || minPairs <= 0) {
    console.error(`非法 --min-pairs（需正整数）`);
    return null;
  }

  const dataDir = argOf('--data-dir') ?? ERB_DATA_DIR;
  const outDir = argOf('--out-dir') ?? path.dirname(path.resolve(expPath));

  return {
    baselinePath,
    expPath,
    dataDir,
    kValues: uniqueK,
    threshold,
    minPairs,
    outDir,
  };
}

// ==================== 主流程 ====================

// 返回 void 而非 never：TS 不把 `await Promise<never>` 视为流程终结，
// 显式 process.exit 的 gracefulExit 已保证运行时不穿透（与 compare-wiki-gate 同款）
async function runGate(opts: GateOptions): Promise<void> {
  // ① 输入文件存在性
  for (const [label, p] of [
    ['基线', opts.baselinePath],
    ['实验', opts.expPath],
  ] as const) {
    if (!fs.existsSync(p)) {
      console.error(`🔴 ${label}文件不存在: ${p}`);
      await gracefulExit(2);
    }
  }

  // ② 加载 gold（zod fail-fast；空 gold 题按既定口径剔除出分母）
  const questions = loadQuestions(opts.dataDir);
  const validQids = new Set(questions.map((q) => q.question_id));
  const goldByQid = new Map(
    questions
      .filter((q) => q.expected_doc_ids.length > 0)
      .map((q) => [q.question_id, q.expected_doc_ids] as const),
  );
  const emptyGoldCount = questions.length - goldByQid.size;

  // ③ 读取两侧运行结果
  const baseline = readAnswers(opts.baselinePath, validQids);
  const exp = readAnswers(opts.expPath, validQids);

  // ④ 逐题配对与指标计算
  interface PairedRow {
    questionId: string;
    goldCount: number;
    base: Record<string, number>;
    exp: Record<string, number>;
  }
  const pairs: PairedRow[] = [];
  let missingBase = 0;
  let missingExp = 0;
  for (const [qid, gold] of goldByQid) {
    const b = baseline.rows.get(qid);
    const e = exp.rows.get(qid);
    if (!b) missingBase++;
    if (!e) missingExp++;
    if (!b || !e) continue;
    pairs.push({
      questionId: qid,
      goldCount: gold.length,
      base: evaluateQuery(b.document_ids, gold, opts.kValues),
      exp: evaluateQuery(e.document_ids, gold, opts.kValues),
    });
  }

  if (pairs.length === 0) {
    console.error(
      `🔴 零配对（基线缺 ${missingBase} / 实验缺 ${missingExp} / 空 gold ${emptyGoldCount}），无可判定数据`,
    );
    await gracefulExit(2);
  }

  // ⑤ 汇总各指标配对均值与 Δ
  // 两侧用同一 kValues，evaluateQuery 产出的键集合同构，取首对键集即可
  //（每键均值仍跨全部配对题统计，缺失键的题不计入该键分母）
  const metricKeys = [
    ...new Set([...Object.keys(pairs[0].base), ...Object.keys(pairs[0].exp)]),
  ].sort();
  interface MetricSummary {
    base: number;
    exp: number;
    delta: number;
  }
  const summary = new Map<string, MetricSummary>();
  for (const key of metricKeys) {
    // 只统计拥有该键的配对题（与 metrics.ts averageMetrics 分组口径一致）
    const baseVals = pairs
      .map((p) => p.base[key])
      .filter((v): v is number => v !== undefined);
    const expVals = pairs
      .map((p) => p.exp[key])
      .filter((v): v is number => v !== undefined);
    const b = mean(baseVals);
    const e = mean(expVals);
    summary.set(key, { base: b, exp: e, delta: e - b });
  }

  // ⑥ 健全性检查：两侧全 0 只可能是口径/数据错误（同 wiki 门闩）
  const recallKeys = metricKeys.filter((k) => k.startsWith('Recall@'));
  const baseAllZero = recallKeys.every(
    (k) => (summary.get(k)?.base ?? 0) === 0,
  );
  const expAllZero = recallKeys.every((k) => (summary.get(k)?.exp ?? 0) === 0);
  if (baseAllZero && expAllZero) {
    console.error(
      '🔴 两侧 Recall 全为 0（口径或数据异常，如 gold 未入库/documentId 前缀不一致），拒绝产出报告',
    );
    await gracefulExit(2);
  }

  // ⑦ 样本量守卫
  if (pairs.length < opts.minPairs) {
    console.error(
      `🟡 配对数 ${pairs.length} < min-pairs ${opts.minPairs}，样本过小拒绝判定（可用 --min-pairs 调低）`,
    );
    await gracefulExit(2);
  }

  // ⑧ 否决判定：任一指标退化超阈值
  const vetoed = metricKeys.filter(
    (k) => (summary.get(k)?.delta ?? 0) < -opts.threshold,
  );

  // ⑨ 主指标（最小 K 的 Recall）翻转统计
  const primaryKey = `Recall@${opts.kValues[0]}`;
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  for (const p of pairs) {
    const b = p.base[primaryKey] ?? 0;
    const e = p.exp[primaryKey] ?? 0;
    if (e > b) improved++;
    else if (e < b) regressed++;
    else unchanged++;
  }

  // ⑩ 落盘 JSON + Markdown 报告
  const data = {
    generatedAt: new Date().toISOString(),
    inputs: {
      baseline: path.resolve(opts.baselinePath),
      exp: path.resolve(opts.expPath),
      dataDir: opts.dataDir,
    },
    params: {
      kValues: opts.kValues,
      threshold: opts.threshold,
      minPairs: opts.minPairs,
      primaryKey,
    },
    pairing: {
      questions: questions.length,
      goldQuestions: goldByQid.size,
      emptyGoldExcluded: emptyGoldCount,
      paired: pairs.length,
      missingBaseline: missingBase,
      missingExp: missingExp,
      baselineErrorRows: baseline.errorRows,
      expErrorRows: exp.errorRows,
      baselineMalformed: baseline.malformed,
      expMalformed: exp.malformed,
      baselineOrphans: baseline.orphans,
      expOrphans: exp.orphans,
    },
    metrics: Object.fromEntries(summary),
    primaryFlips: { improved, unchanged, regressed },
    verdict: {
      vetoThreshold: opts.threshold,
      vetoedMetrics: vetoed,
      passed: vetoed.length === 0,
    },
    perQuestion: pairs,
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  const dataPath = path.join(opts.outDir, 'retrieval-gate-data.json');
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');

  const pct = (v: number): string => (v * 100).toFixed(1) + '%';
  const pp = (v: number): string => {
    const s = (v * 100).toFixed(1);
    return Number(s) >= 0 ? `+${s}pp` : `${s}pp`;
  };
  const lines: string[] = [
    `# 检索回归门闩报告`,
    '',
    `生成时间：${data.generatedAt}`,
    '',
    `- 基线：\`${data.inputs.baseline}\``,
    `- 实验：\`${data.inputs.exp}\``,
    `- K 值：${opts.kValues.join('/')}，否决阈值：${pp(-opts.threshold)}，主指标：${primaryKey}`,
    '',
    `## 配对情况`,
    '',
    `| 项 | 值 |`,
    `|---|---|`,
    `| gold 题数（非空 gold） | ${goldByQid.size}（空 gold 剔除 ${emptyGoldCount}） |`,
    `| **配对成功** | **${pairs.length}** |`,
    `| 基线缺行 / 错误行 / 脏行 / 孤儿行 | ${missingBase} / ${baseline.errorRows} / ${baseline.malformed} / ${baseline.orphans} |`,
    `| 实验缺行 / 错误行 / 脏行 / 孤儿行 | ${missingExp} / ${exp.errorRows} / ${exp.malformed} / ${exp.orphans} |`,
    '',
    `## 指标对比（配对均值）`,
    '',
    `| 指标 | 基线 | 实验 | Δ |`,
    `|------|------|------|---|`,
    ...metricKeys.map((k) => {
      const s = summary.get(k);
      if (!s) return `| ${k} | - | - | - |`;
      return `| ${k} | ${pct(s.base)} | ${pct(s.exp)} | ${pp(s.delta)} |`;
    }),
    '',
    `## 主指标翻转（${primaryKey}）`,
    '',
    `改善 ${improved} / 持平 ${unchanged} / 退化 ${regressed}（共 ${pairs.length} 题）`,
    '',
    `## 判定`,
    '',
    vetoed.length === 0
      ? `✅ 通过：所有指标退化均在阈值 ${pp(-opts.threshold)} 内`
      : `🔴 否决：退化超阈值指标 → ${vetoed.map((k) => `${k}（${pp(summary.get(k)?.delta ?? 0)}）`).join('、')}`,
    '',
    `> 明细数据：${dataPath}`,
  ];
  const reportPath = path.join(opts.outDir, 'retrieval-gate-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  // ⑪ 控制台摘要
  console.log(`\n=== 检索回归门闩 ===`);
  console.log(
    `配对: ${pairs.length} 题（空 gold 剔除 ${emptyGoldCount}，基线缺 ${missingBase}，实验缺 ${missingExp}）`,
  );
  for (const k of metricKeys) {
    const s = summary.get(k);
    if (!s) continue;
    console.log(`${k}: ${pct(s.base)} → ${pct(s.exp)}（${pp(s.delta)}）`);
  }
  console.log(
    `${primaryKey} 翻转: 改善 ${improved} / 持平 ${unchanged} / 退化 ${regressed}`,
  );
  console.log(`报告: ${reportPath}`);

  if (vetoed.length > 0) {
    console.error(`🔴 门闩否决：${vetoed.join(', ')}`);
    logger.warn('检索回归门闩否决', { module: MODULE, vetoed });
    await gracefulExit(3);
  }
  console.log(`✅ 门闩通过`);
  logger.info('检索回归门闩通过', { module: MODULE, pairs: pairs.length });
  await gracefulExit(0);
}

// ==================== 入口 ====================

async function main(): Promise<void> {
  const opts = parseCli();
  if (!opts) {
    process.exit(1);
  }
  await runGate(opts);
}

main().catch(async (error) => {
  console.error('门闩脚本主流程异常:', error);
  await gracefulExit(1);
});
