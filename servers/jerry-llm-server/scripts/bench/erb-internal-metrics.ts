/**
 * ERB 内部检索指标独立计算脚本（S4.3 回归门禁用）
 *
 * 动机：run-erb-eval.ts 的 S3.4 聚合在其进程内执行——runner 尾部写盘被沙箱/文件锁
 * 拦截时聚合随之中断。本脚本从已落盘的 answers.jsonl 独立重算同一套指标，
 * 复用 src/fundamentals/eval/metrics.ts 的 evaluateQuery/aggregateResults，口径与
 * runner 完全一致（同一函数，无重复实现）。
 *
 * 用法：
 *   node --import ./scripts/ts-loader.mjs --experimental-transform-types scripts/bench/erb-internal-metrics.ts \
 *     --answers E:\ragbench\bm25\hyde\answers.jsonl [--limit 201] [--ids-file <ids.txt>] [--questions D:\ragatest\questions.jsonl]
 *
 * 题目集合选择（三选一，--ids-file 优先）：
 *   - --ids-file：按文件中的 question_id 列表选题（一行一个）——与 runner 的
 *     `--type semantic --limit 26` 等「先过滤后截断」口径精确对应（runner 跑的
 *     题目集合不是题目文件的前 N 题，--limit 会把这类行误判为孤儿）；
 *   - --limit N：取题目文件前 N 题（runner 全量顺序跑时的口径）；
 *   - 都不传：全量题目。
 *
 * 输出：官方口径（空 gold 剔除）的 Recall@3/5/10、Precision@3、NDCG@3、MRR 总量 + 分题型。
 */
import fs from 'node:fs';

import { loadQuestions, type ErbQuestion } from './lib/erb-loader.js';
import {
  aggregateResults,
  evaluateQuery,
  type SingleQueryEval,
} from '../../src/fundamentals/eval/metrics.js';

const K_VALUES = [3, 5, 10];

// ==================== CLI 解析 ====================

function parseArgs(argv: string[]): {
  answers: string;
  questions?: string;
  limit?: number;
  idsFile?: string;
} {
  const opts: { answers: string; questions?: string; limit?: number; idsFile?: string } = {
    answers: '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--answers') opts.answers = argv[++i] ?? '';
    else if (argv[i] === '--questions') opts.questions = argv[++i];
    else if (argv[i] === '--limit') opts.limit = Number(argv[++i]);
    else if (argv[i] === '--ids-file') opts.idsFile = argv[++i];
    else if (argv[i] === '--ids') opts.idsFile = argv[++i];
  }
  if (!opts.answers) {
    console.error('缺少 --answers <answers.jsonl 路径>');
    process.exit(2);
  }
  if (opts.idsFile && !fs.existsSync(opts.idsFile)) {
    console.error(`--ids-file 不存在: ${opts.idsFile}`);
    process.exit(2);
  }
  return opts;
}

// ==================== 主流程 ====================

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  const allQuestions = loadQuestions();
  let questions: ErbQuestion[];
  if (opts.idsFile) {
    // 按 id 列表选题（--ids-file 优先）：与 runner「先 --type 过滤再 --limit 截断」
    // 的题目集合精确对应，避免把合法行误判为孤儿
    const idList = fs
      .readFileSync(opts.idsFile, 'utf-8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const byId = new Map(allQuestions.map((q) => [q.question_id, q]));
    const missingIds: string[] = [];
    questions = idList
      .map((id) => {
        const q = byId.get(id);
        if (!q) missingIds.push(id);
        return q;
      })
      .filter((q): q is ErbQuestion => q !== undefined);
    if (missingIds.length > 0) {
      console.error(`警告：ids-file 中 ${missingIds.length} 个 id 不在题库中（已跳过）: ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? ' …' : ''}`);
    }
  } else if (opts.limit && opts.limit > 0) {
    questions = allQuestions.slice(0, opts.limit);
  } else {
    questions = allQuestions;
  }
  const questionById = new Map(questions.map((q) => [q.question_id, q]));

  // 行解析：与 runner 同规则——error 行跳过、孤儿行跳过、重复行 last-wins
  const raw = fs.readFileSync(opts.answers, 'utf-8');
  const okById = new Map<string, { document_ids: string[] }>();
  let errorLines = 0;
  let malformedLines = 0;
  let orphanLines = 0;
  for (const lineText of raw.split('\n')) {
    const trimmed = lineText.trim();
    if (!trimmed) continue;
    try {
      const obj: unknown = JSON.parse(trimmed);
      if (
        obj !== null &&
        typeof obj === 'object' &&
        'error' in obj &&
        (obj as { error: unknown }).error !== undefined
      ) {
        errorLines++;
        continue;
      }
      const rec = obj as { question_id?: unknown; document_ids?: unknown };
      if (
        typeof rec.question_id === 'string' &&
        Array.isArray(rec.document_ids) &&
        rec.document_ids.every((x) => typeof x === 'string')
      ) {
        if (!questionById.has(rec.question_id)) {
          orphanLines++;
          continue;
        }
        okById.set(rec.question_id, { document_ids: rec.document_ids as string[] });
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }

  // 官方口径：空 gold 剔除出分母（与 runner S3.4 一致）
  const evals: SingleQueryEval[] = [];
  let excludedEmptyGold = 0;
  let missing = 0;
  for (const q of questions) {
    const ok = okById.get(q.question_id);
    if (!ok) {
      missing++;
      continue;
    }
    if (q.expected_doc_ids.length === 0) {
      excludedEmptyGold++;
      continue;
    }
    evals.push({
      sampleId: q.question_id,
      query: q.question,
      retrievedDocIds: ok.document_ids,
      expectedDocIds: q.expected_doc_ids,
      metrics: evaluateQuery(ok.document_ids, q.expected_doc_ids, K_VALUES),
      category: q.question_type,
      durationMs: 0,
    });
  }

  const agg = aggregateResults(evals, {
    topK: K_VALUES[K_VALUES.length - 1],
    kValues: K_VALUES,
    searchType: 'hybrid-bench',
  });

  console.log(
    JSON.stringify(
      {
        answersPath: opts.answers,
        questionCount: questions.length,
        answered: evals.length + excludedEmptyGold,
        missing,
        errorLines,
        malformedLines,
        orphanLines,
        excludedEmptyGold,
        evaluableCount: evals.length,
        aggregate: agg.aggregate,
        byQuestionType: agg.byCategory,
      },
      null,
      2,
    ),
  );
}

main();
