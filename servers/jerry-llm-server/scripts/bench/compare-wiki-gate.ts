/**
 * Wiki 门闩对比脚本（benchmark-only，LLM Wiki 门闩实验 第 4 阶段）
 *
 * 两个子命令：
 *   extract-baseline  从全量 500 题基线 answers.jsonl 中提取 gate 30 题的
 *                     基线行 → baseline-30.jsonl（随后用 run-erb-eval
 *                     --aggregate-only 打分，与实验组同口径）。
 *                     选题逻辑与 run-erb-eval 严格一致：按题型过滤后取前 N 题
 *                     （L915-948：先过滤再 --limit 截取），保证两组题目完全配对。
 *
 *   compare           配对对比基线 vs 实验组：
 *                     - 检索指标逐题差值（R@3/P@3/NDCG@3/MRR）
 *                     - judge 正确率翻转（污染翻转 = 基线对→实验错，否决线 2 题）
 *                     - wiki 命中诊断（主题页正文前缀匹配 contexts，统计命中率/
 *                       挤占证据）
 *                     产出 compare-data.json + compare-report.md。
 *
 * 用法：
 *   node ... compare-wiki-gate.ts extract-baseline
 *   node ... compare-wiki-gate.ts compare \
 *     --exp-judge E:\ragbench\harness\results-wiki-gate30.json
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { loadQuestions, type ErbQuestion } from './lib/erb-loader.js';
import { evaluateQuery } from '../../src/fundamentals/eval/metrics.js';

// ==================== 常量 ====================

const MODULE = 'BenchWikiCompare';

const GATE_DIR = 'E:\\ragbench\\bm25\\wiki-gate';
const FULL500_ANSWERS = 'E:\\ragbench\\bm25\\answers.jsonl';
const FULL500_JUDGE = 'E:\\ragbench\\harness\\results-full500.json';

const GATE_TYPE = 'semantic';
const GATE_LIMIT = 30;
const K_VALUES = [3, 5, 10];

/** 污染否决线：基线答对被实验组答错 > 2 题 → 否决 */
const POLLUTION_VETO = 2;

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

// ==================== 共用类型与读取 ====================

interface AnswerRow {
  question_id: string;
  answer: string;
  document_ids: string[];
  contexts: string[];
  bench_meta?: Record<string, unknown>;
}

interface JudgeQuestion {
  question_id: string;
  answer_correct: boolean;
  question_type: string;
  completeness_pct?: number;
}

function readAnswers(filePath: string): Map<string, AnswerRow> {
  const map = new Map<string, AnswerRow>();
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: AnswerRow;
    try {
      row = JSON.parse(line) as AnswerRow;
    } catch {
      continue; // 半行/损坏行跳过（与 --compact-only 容忍口径一致）
    }
    if (!row.question_id || !Array.isArray(row.document_ids)) continue;
    map.set(row.question_id, row);
  }
  return map;
}

/** 选题：与 run-erb-eval L915-948 严格一致（先题型过滤，再前 N 截取） */
function selectGateQuestions(limit: number): ErbQuestion[] {
  const questions = loadQuestions();
  return questions.filter((q) => q.question_type === GATE_TYPE).slice(0, limit);
}

// ==================== extract-baseline ====================

async function extractBaseline(): Promise<void> {
  const selected = selectGateQuestions(GATE_LIMIT);
  const qids = selected.map((q) => q.question_id);
  console.log(`gate 选题（${GATE_TYPE} 前 ${GATE_LIMIT} 题）: ${qids[0]} ... ${qids[qids.length - 1]}`);

  const baseline = readAnswers(FULL500_ANSWERS);
  const missing = qids.filter((id) => !baseline.has(id));
  if (missing.length > 0) {
    console.error(`🔴 基线 500 题文件缺少 ${missing.length} 题: ${missing.slice(0, 5).join(',')}`);
    await gracefulExit(2);
  }

  fs.mkdirSync(GATE_DIR, { recursive: true });
  const outPath = path.join(GATE_DIR, 'baseline-30.jsonl');
  fs.writeFileSync(
    outPath,
    qids.map((id) => JSON.stringify(baseline.get(id))).join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(GATE_DIR, 'selected-qids.json'),
    JSON.stringify({ type: GATE_TYPE, limit: GATE_LIMIT, questionIds: qids }, null, 2),
    'utf8',
  );
  console.log(`已写出 ${qids.length} 行基线 → ${outPath}`);
  console.log(`下一步: run-erb-eval --aggregate-only --output ${outPath}（gate 环境变量）`);
  await gracefulExit(0);
}

// ==================== compare ====================

interface CompareOptions {
  expJudge: string;
  baseJudge: string;
  wikiTopics: string;
  outDir: string;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function compare(opts: CompareOptions): Promise<void> {
  const qidsDoc = JSON.parse(
    fs.readFileSync(path.join(GATE_DIR, 'selected-qids.json'), 'utf8'),
  ) as { questionIds: string[] };
  const qids = qidsDoc.questionIds;
  const questions = new Map(loadQuestions().map((q) => [q.question_id, q]));

  const baselineAnswers = readAnswers(path.join(GATE_DIR, 'baseline-30.jsonl'));
  const expAnswers = readAnswers(path.join(GATE_DIR, 'answers.jsonl'));
  const baselineJudgeRaw = JSON.parse(fs.readFileSync(opts.baseJudge, 'utf8')) as {
    questions: JudgeQuestion[];
  };
  const expJudgeRaw = JSON.parse(fs.readFileSync(opts.expJudge, 'utf8')) as {
    questions: JudgeQuestion[];
  };
  const baselineJudge = new Map(baselineJudgeRaw.questions.map((q) => [q.question_id, q]));
  const expJudge = new Map(expJudgeRaw.questions.map((q) => [q.question_id, q]));

  // wiki 正文前缀表（parent_content 展开后 contexts 里是 body 本体，无【主题】前缀）
  const wikiBodies: string[] = [];
  if (fs.existsSync(opts.wikiTopics)) {
    for (const line of fs.readFileSync(opts.wikiTopics, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { body: string };
      wikiBodies.push(row.body.slice(0, 80));
    }
  }
  const countWikiHits = (contexts: string[]): number =>
    contexts.filter((c) => wikiBodies.some((w) => c.includes(w))).length;

  // 逐题配对
  interface PairedRow {
    questionId: string;
    baseR3: number;
    expR3: number;
    baseCorrect: boolean | null;
    expCorrect: boolean | null;
    wikiHits: number;
    expDocIds: number;
  }
  const rows: PairedRow[] = [];
  const baseR3List: number[] = [];
  const expR3List: number[] = [];
  const baseP3List: number[] = [];
  const expP3List: number[] = [];
  const baseN3List: number[] = [];
  const expN3List: number[] = [];
  const baseMrrList: number[] = [];
  const expMrrList: number[] = [];

  for (const qid of qids) {
    const q = questions.get(qid);
    const b = baselineAnswers.get(qid);
    const e = expAnswers.get(qid);
    if (!q || !b || !e) {
      console.error(`⚠️ 配对缺失: ${qid}（question=${!!q} base=${!!b} exp=${!!e}）`);
      continue;
    }
    const bm = evaluateQuery(b.document_ids, q.expected_doc_ids, K_VALUES);
    const em = evaluateQuery(e.document_ids, q.expected_doc_ids, K_VALUES);
    const bj = baselineJudge.get(qid);
    const ej = expJudge.get(qid);
    rows.push({
      questionId: qid,
      baseR3: bm['Recall@3'] ?? 0,
      expR3: em['Recall@3'] ?? 0,
      baseCorrect: bj ? bj.answer_correct : null,
      expCorrect: ej ? ej.answer_correct : null,
      wikiHits: countWikiHits(e.contexts ?? []),
      expDocIds: e.document_ids.length,
    });
    baseR3List.push(bm['Recall@3'] ?? 0);
    expR3List.push(em['Recall@3'] ?? 0);
    baseP3List.push(bm['Precision@3'] ?? 0);
    expP3List.push(em['Precision@3'] ?? 0);
    baseN3List.push(bm['NDCG@3'] ?? 0);
    expN3List.push(em['NDCG@3'] ?? 0);
    baseMrrList.push(bm['MRR'] ?? 0);
    expMrrList.push(em['MRR'] ?? 0);
  }

  // 健全性检查：30 题两组检索全为 0 只可能是口径/数据错误，报错退出而非产出假报告
  if (rows.length > 0 && mean(baseR3List) === 0 && mean(expR3List) === 0) {
    console.error('🔴 两组 Recall@3 全为 0（口径或数据异常），拒绝产出报告');
    await gracefulExit(2);
  }

  // judge 翻转统计
  let pollution = 0; // 基线对 → 实验错
  let rescue = 0; // 基线错 → 实验对
  const judged = rows.filter((r) => r.baseCorrect !== null && r.expCorrect !== null);
  for (const r of judged) {
    if (r.baseCorrect && !r.expCorrect) pollution++;
    if (!r.baseCorrect && r.expCorrect) rescue++;
  }

  // 汇总
  const data = {
    generatedAt: new Date().toISOString(),
    gate: { type: GATE_TYPE, limit: GATE_LIMIT, questions: qids.length },
    retrieval: {
      recallAt3: { baseline: mean(baseR3List), exp: mean(expR3List), delta: mean(expR3List) - mean(baseR3List) },
      precisionAt3: { baseline: mean(baseP3List), exp: mean(expP3List), delta: mean(expP3List) - mean(baseP3List) },
      ndcgAt3: { baseline: mean(baseN3List), exp: mean(expN3List), delta: mean(expN3List) - mean(baseN3List) },
      mrr: { baseline: mean(baseMrrList), exp: mean(expMrrList), delta: mean(expMrrList) - mean(baseMrrList) },
    },
    correctness: {
      judgedCount: judged.length,
      baselineCorrect: judged.filter((r) => r.baseCorrect).length,
      expCorrect: judged.filter((r) => r.expCorrect).length,
      pollutionFlips: pollution,
      rescueFlips: rescue,
      pollutionVeto: POLLUTION_VETO,
      vetoTriggered: pollution > POLLUTION_VETO,
    },
    wikiDiag: {
      wikiPages: wikiBodies.length,
      questionsWithWikiHit: rows.filter((r) => r.wikiHits > 0).length,
      totalWikiHits: rows.reduce((a, r) => a + r.wikiHits, 0),
    },
    perQuestion: rows,
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(
    path.join(opts.outDir, 'compare-data.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );

  // Markdown 报告
  const pct = (v: number): string => (v * 100).toFixed(1) + '%';
  const lines: string[] = [
    `# Wiki 门闩对比报告（${GATE_TYPE} × ${rows.length} 题）`,
    '',
    `生成时间：${data.generatedAt}`,
    '',
    `## 检索指标（配对均值）`,
    '',
    `| 指标 | 基线 | 实验组 | Δ |`,
    `|------|------|--------|---|`,
    `| Recall@3 | ${pct(data.retrieval.recallAt3.baseline)} | ${pct(data.retrieval.recallAt3.exp)} | ${pct(data.retrieval.recallAt3.delta)} |`,
    `| Precision@3 | ${pct(data.retrieval.precisionAt3.baseline)} | ${pct(data.retrieval.precisionAt3.exp)} | ${pct(data.retrieval.precisionAt3.delta)} |`,
    `| NDCG@3 | ${pct(data.retrieval.ndcgAt3.baseline)} | ${pct(data.retrieval.ndcgAt3.exp)} | ${pct(data.retrieval.ndcgAt3.delta)} |`,
    `| MRR | ${pct(data.retrieval.mrr.baseline)} | ${pct(data.retrieval.mrr.exp)} | ${pct(data.retrieval.mrr.delta)} |`,
    '',
    `## Judge 正确率（${judged.length} 题已判）`,
    '',
    `| | 基线对 | 基线错 |`,
    `|---|--------|--------|`,
    `| 实验对 | ${judged.filter((r) => r.baseCorrect && r.expCorrect).length} | ${rescue}（救援翻转） |`,
    `| 实验错 | ${pollution}（**污染翻转**） | ${judged.filter((r) => !r.baseCorrect && !r.expCorrect).length} |`,
    '',
    `污染翻转 ${pollution} 题（否决线 ${POLLUTION_VETO}）→ ${data.correctness.vetoTriggered ? '🔴 触发否决' : '✅ 未触发'}`,
    '',
    `## Wiki 命中诊断`,
    '',
    `- 主题页入库：${wikiBodies.length} 页`,
    `- 出现 wiki 命中的题目：${data.wikiDiag.questionsWithWikiHit}/${rows.length}`,
    `- wiki 命中总次数：${data.wikiDiag.totalWikiHits}`,
    '',
    `## 逐题明细`,
    '',
    `| qid | 基线R@3 | 实验R@3 | 基线对 | 实验对 | wiki命中 |`,
    `|-----|---------|---------|--------|--------|----------|`,
    ...rows.map(
      (r) =>
        `| ${r.questionId} | ${pct(r.baseR3)} | ${pct(r.expR3)} | ${r.baseCorrect} | ${r.expCorrect} | ${r.wikiHits} |`,
    ),
    '',
    `> 记分口径注：wiki chunk 记分给首成员文档（与 FAQ 同构），主题页实际覆盖`,
    `> 多文档的检索贡献被系统性低估；主决策指标为 judge 正确率与污染翻转。`,
  ];
  fs.writeFileSync(path.join(opts.outDir, 'compare-report.md'), lines.join('\n'), 'utf8');

  console.log(`\n=== Wiki 门闩对比 ===`);
  console.log(
    `Recall@3: ${pct(data.retrieval.recallAt3.baseline)} → ${pct(data.retrieval.recallAt3.exp)}（Δ${pct(data.retrieval.recallAt3.delta)}）`,
  );
  console.log(
    `正确率: ${data.correctness.baselineCorrect}/${judged.length} → ${data.correctness.expCorrect}/${judged.length}；污染翻转 ${pollution}（线 ${POLLUTION_VETO}）/ 救援翻转 ${rescue}`,
  );
  console.log(`wiki 命中: ${data.wikiDiag.questionsWithWikiHit}/${rows.length} 题命中共 ${data.wikiDiag.totalWikiHits} 次`);
  console.log(`报告: ${path.join(opts.outDir, 'compare-report.md')}`);
  logger.info('Wiki 门闩对比完成', { module: MODULE, pollution, rescue, veto: data.correctness.vetoTriggered });
  await gracefulExit(data.correctness.vetoTriggered ? 3 : 0);
}

// ==================== 入口 ====================

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'extract-baseline') {
    await extractBaseline();
  } else if (mode === 'compare') {
    const argOf = (flag: string): string | undefined => {
      const i = process.argv.indexOf(flag);
      return i !== -1 ? process.argv[i + 1] : undefined;
    };
    await compare({
      expJudge: argOf('--exp-judge') ?? 'E:\\ragbench\\harness\\results-wiki-gate30.json',
      baseJudge: argOf('--base-judge') ?? 'E:\\ragbench\\harness\\results-wiki-gate30-baseline.json',
      wikiTopics: argOf('--wiki-topics') ?? path.join(GATE_DIR, 'wiki-topics-v3.jsonl'),
      outDir: argOf('--out-dir') ?? GATE_DIR,
    });
  } else {
    console.error(
      '用法: compare-wiki-gate.ts <extract-baseline|compare> [--exp-judge <json>] [--base-judge <json>] [--wiki-topics <jsonl>] [--out-dir <dir>]',
    );
    await gracefulExit(1);
  }
}

main().catch(async (error) => {
  console.error('对比脚本主流程异常:', error);
  await gracefulExit(1);
});
