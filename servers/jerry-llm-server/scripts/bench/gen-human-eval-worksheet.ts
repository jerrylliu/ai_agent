/**
 * 人工校准工作表生成器（方案 A：人工校准官方 harness 判分）
 *
 * 输入（全量 500 题三件套）：
 *   - E:\ragbench\harness\EnterpriseRAG-Bench\questions.jsonl   （题目 + gold + answer_facts）
 *   - E:\ragbench\bm25\hyde\answers-full500.jsonl               （模型答案 + document_ids）
 *   - E:\ragbench\harness\results-full500.json                  （官方 harness 每题 answer_correct 判分）
 *
 * 输出：
 *   - e:\miaoma-ai-app\human-eval-worksheet.html  盲判工作表（官方判分嵌入但隐藏，
 *     判完点击"揭示官方判分"计算人工 vs 官方一致率、双向分歧清单，可导出 JSON）
 *
 * 抽样设计（50 题，分层 + 正误配比）：
 *   - 按题型分层，配比向低分段型倾斜（completeness / intra_document_reasoning 多抽）
 *   - 每层内保证 incorrect 题至少 2 题（pool 允许时），确保能算出双向分歧
 *   - 固定随机种子，重跑生成同一批样本，保证可复现
 *
 * 用法：
 *   pnpm ts-node scripts/bench/gen-human-eval-worksheet.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ==================== 配置 ====================

const QUESTIONS_FILE = 'E:\\ragbench\\harness\\EnterpriseRAG-Bench\\questions.jsonl';
const ANSWERS_FILE = 'E:\\ragbench\\bm25\\hyde\\answers-full500.jsonl';
const RESULTS_FILE = 'E:\\ragbench\\harness\\results-full500.json';
const OUTPUT_HTML = 'e:\\miaoma-ai-app\\human-eval-worksheet.html';
/** 抽样中间产物（供翻译脚本消费，固定种子保证重跑一致） */
const SAMPLES_FILE = path.join(__dirname, 'human-eval-samples.json');
/** 中文翻译（由 translate-human-eval.ts 产出，存在则嵌入双语工作表） */
const TRANSLATED_FILE = path.join(__dirname, 'human-eval-samples-translated.json');

/** 固定种子，保证抽样可复现 */
const RANDOM_SEED = 20261113;

/** 各题型抽样配额（合计 50），低分段型倾斜 */
const TYPE_QUOTA: Record<string, number> = {
  basic: 8,
  semantic: 8,
  intra_document_reasoning: 6,
  project_related: 6,
  constrained: 4,
  conflicting_info: 4,
  completeness: 6,
  high_level: 2,
  info_not_found: 5,
  miscellaneous: 1,
};

// ==================== 可复现随机数（mulberry32） ====================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ==================== 数据加载 ====================

interface ErbQuestion {
  question_id: string;
  question_type: string;
  question: string;
  expected_doc_ids: string[];
  gold_answer: string;
  answer_facts: string[];
}

interface ErbAnswer {
  question_id: string;
  answer: string;
  document_ids: string[];
  bench_meta?: { model_id?: string; duration_ms?: number };
}

interface HarnessQuestionResult {
  question_id: string;
  answer_correct: boolean;
  correctness_reasoning: string;
  completeness_pct: number;
}

function loadJsonl<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

// ==================== 分层抽样 ====================

/** 单题中文翻译（translate-human-eval.ts 产出，缺省 undefined 表示该题未翻译） */
interface ZhTranslation {
  question: string;
  goldAnswer: string;
  answerFacts: string[];
  modelAnswer: string;
}

interface SampledItem {
  question: ErbQuestion;
  answer: string;
  officialCorrect: boolean;
  officialReasoning: string;
  completenessPct: number;
  zh?: ZhTranslation;
}

/**
 * 层内抽样：保证 incorrect 至少 2 题（pool 允许时），其余给 correct。
 * incorrect 太少时（如 info_not_found 全对）全取 correct。
 */
function pickFromType(
  pool: Array<{ q: ErbQuestion; official: HarnessQuestionResult }>,
  quota: number,
  rand: () => number,
): Array<{ q: ErbQuestion; official: HarnessQuestionResult }> {
  const incorrect = shuffle(
    pool.filter((x) => !x.official.answer_correct),
    rand,
  );
  const correct = shuffle(
    pool.filter((x) => x.official.answer_correct),
    rand,
  );

  const nIncorrect = Math.min(incorrect.length, Math.max(0, Math.min(2, quota - 1)));
  const nCorrect = Math.min(correct.length, quota - nIncorrect);
  // correct 池不够时用 incorrect 补足配额
  const extraIncorrect = incorrect.slice(nIncorrect, nIncorrect + (quota - nIncorrect - nCorrect));

  return [...correct.slice(0, nCorrect), ...incorrect.slice(0, nIncorrect), ...extraIncorrect];
}

// ==================== HTML 生成 ====================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildWorksheetHtml(items: SampledItem[]): string {
  const payload = JSON.stringify(
    items.map((it, idx) => ({
      idx: idx + 1,
      questionId: it.question.question_id,
      questionType: it.question.question_type,
      question: it.question.question,
      goldAnswer: it.question.gold_answer,
      answerFacts: it.question.answer_facts,
      modelAnswer: it.answer,
      officialCorrect: it.officialCorrect,
      officialReasoning: it.officialReasoning,
      completenessPct: it.completenessPct,
      zh: it.zh ?? null,
    })),
  ).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>ERB 人工校准工作表（50 题 · 盲判）</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f3f4f6; color: #1f2937; padding: 24px; max-width: 980px; margin: 0 auto; }
  header { position: sticky; top: 0; background: #f3f4f6; padding: 12px 0; z-index: 10; border-bottom: 1px solid #d1d5db; margin-bottom: 16px; }
  header h1 { font-size: 18px; margin-bottom: 6px; }
  .progress-wrap { display: flex; align-items: center; gap: 12px; }
  .progress-bar { flex: 1; height: 8px; background: #d1d5db; border-radius: 4px; overflow: hidden; }
  .progress-fill { height: 100%; background: #2563eb; width: 0%; transition: width .2s; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .card.judged-yes { border-left: 4px solid #16a34a; }
  .card.judged-no { border-left: 4px solid #dc2626; }
  .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .qid { font-weight: 700; font-size: 14px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e5e7eb; color: #374151; }
  .qtext { font-size: 15px; font-weight: 600; margin-bottom: 12px; line-height: 1.5; }
  section { margin-bottom: 12px; }
  section h3 { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; }
  .answer-box, .gold-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 340px; overflow-y: auto; }
  .gold-box { background: #fefce8; border-color: #fde68a; }
  .facts li { font-size: 13px; line-height: 1.6; margin-left: 18px; margin-bottom: 3px; }
  .verdict { display: flex; gap: 10px; margin-top: 14px; }
  .verdict button { flex: 1; padding: 10px; font-size: 14px; border-radius: 8px; border: 2px solid #d1d5db; background: #fff; cursor: pointer; font-weight: 600; }
  .verdict button.v-yes.active { border-color: #16a34a; background: #dcfce7; color: #166534; }
  .verdict button.v-no.active { border-color: #dc2626; background: #fee2e2; color: #991b1b; }
  .note-input { width: 100%; margin-top: 8px; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; font-family: inherit; }
  .official { display: none; margin-top: 12px; padding: 12px; border-radius: 8px; font-size: 13px; line-height: 1.6; }
  .official.show { display: block; }
  .official.match { background: #ecfdf5; border: 1px solid #a7f3d0; }
  .official.mismatch { background: #fef2f2; border: 1px solid #fecaca; }
  .toolbar { position: sticky; bottom: 0; background: #f3f4f6; padding: 14px 0; border-top: 1px solid #d1d5db; display: flex; gap: 10px; z-index: 10; }
  .toolbar button { padding: 10px 20px; font-size: 14px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; }
  #revealBtn { background: #2563eb; color: #fff; }
  #exportBtn { background: #16a34a; color: #fff; display: none; }
  #statsPanel { display: none; background: #fff; border: 2px solid #2563eb; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  #statsPanel h2 { font-size: 16px; margin-bottom: 12px; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .stat-box { background: #f9fafb; border-radius: 8px; padding: 12px; text-align: center; }
  .stat-box .num { font-size: 24px; font-weight: 700; color: #2563eb; }
  .stat-box .lbl { font-size: 11px; color: #6b7280; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
  th { background: #f9fafb; }
  .disagree-item { margin-bottom: 8px; padding: 10px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; font-size: 12px; line-height: 1.6; }
  .hint { font-size: 12px; color: #6b7280; line-height: 1.7; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  .mode-wrap { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .mode-wrap select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; }
  .orig-block { }
  .zh-block { display: none; }
  .zh-block .qtext, .zh-block .answer-box, .zh-block .gold-box { background: #eff6ff; border-color: #bfdbfe; color: #1e3a8a; }
  .mode-both .zh-block { display: block; }
  .mode-zh .orig-block { display: none; }
  .mode-zh .zh-block { display: block; }
</style>
</head>
<body>
<header>
  <h1>ERB 人工校准工作表 · 50 题 · 盲判模式</h1>
  <div class="progress-wrap">
    <span id="progressText">已判 0 / 50</span>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
  </div>
  <div class="mode-wrap">
    <label style="font-size:12px;color:#6b7280">显示模式：</label>
    <select id="modeSelect" onchange="setMode(this.value)">
      <option value="zh">仅中文（翻译辅助）</option>
      <option value="both">双语（原文 + 中文）</option>
      <option value="orig">仅原文</option>
    </select>
    <span id="zhCoverage" style="font-size:11px;color:#9ca3af"></span>
  </div>
</header>

<div class="hint">
  <b>判分口径（与官方 harness 对齐）：</b><br>
  ① 只判 <b>correctness（正确性）</b>：模型答案的关键事实是否与 gold 一致。<b>表述不同但信息等价（同义转述、单位换算、粒度合并）算正确</b>；关键事实缺一条、数字对不上、结论相反 = 不正确。<br>
  ② <b>info_not_found 题型特殊口径</b>：gold 无标准答案，期望模型拒答——答案明确表达"未找到/无相关信息" = 正确；编造具体答案 = 不正确；拒答正确但夹带编造细节 = 不正确。<br>
  ③ <b>盲判纪律</b>：判完全部 50 题之前不要点底部"揭示官方判分"按钮。判分状态自动保存在浏览器，中途关掉可继续。<br>
  ④ <b>显示模式</b>：下方可切换 原文 / 双语 / 仅中文。中文为 AI 翻译仅供理解辅助，若译文与原文疑似有出入，以原文为准并在备注里说明。
</div>

<div id="statsPanel"></div>
<div id="cards"></div>

<div class="toolbar">
  <button id="revealBtn" onclick="reveal()">揭示官方判分并计算一致率</button>
  <button id="exportBtn" onclick="exportResults()">导出判分结果 JSON</button>
</div>

<script>
const DATA = ${payload};
const STORE_KEY = 'erb-human-eval-v1';
let judged = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
let revealed = false;

function render() {
  const container = document.getElementById('cards');
  container.innerHTML = '';
  DATA.forEach((d) => {
    const j = judged[d.questionId] || {};
    const card = document.createElement('div');
    card.className = 'card' + (j.verdict === true ? ' judged-yes' : j.verdict === false ? ' judged-no' : '');
    const factsHtml = d.answerFacts.map((f) => '<li>' + f + '</li>').join('');
    const zhFactsHtml = d.zh ? d.zh.answerFacts.map((f) => '<li>' + escapeHtml(f) + '</li>').join('') : '';
    const zhGold = d.zh ? (d.zh.goldAnswer || '（无 gold —— info_not_found 题，期望拒答）') : '';
    card.innerHTML =
      '<div class="card-head"><span class="qid">#' + d.idx + ' · ' + d.questionId + '</span>' +
      '<span class="badge">' + d.questionType + '</span>' +
      (d.zh ? '<span class="badge" style="background:#dbeafe;color:#1d4ed8">已翻译</span>' : '') +
      '</div>' +
      '<div class="qtext orig-block">' + escapeHtml(d.question) + '</div>' +
      (d.zh ? '<div class="qtext zh-block">' + escapeHtml(d.zh.question) + '</div>' : '<div class="qtext zh-block" style="color:#dc2626">⚠ 此题暂无翻译，请参考原文</div>') +
      '<section class="orig-block"><h3>模型答案</h3><div class="answer-box">' + escapeHtml(d.modelAnswer) + '</div></section>' +
      (d.zh ? '<section class="zh-block"><h3>模型答案（中文）</h3><div class="answer-box">' + escapeHtml(d.zh.modelAnswer) + '</div></section>' : '') +
      '<section class="orig-block"><h3>Gold 标准答案</h3><div class="gold-box">' + escapeHtml(d.goldAnswer || '（无 gold —— info_not_found 题，期望拒答）') + '</div></section>' +
      (d.zh ? '<section class="zh-block"><h3>Gold 标准答案（中文）</h3><div class="gold-box">' + escapeHtml(zhGold) + '</div></section>' : '') +
      (d.answerFacts.length ? '<section class="orig-block"><h3>关键事实清单</h3><ul class="facts">' + factsHtml + '</ul></section>' : '') +
      (d.zh && d.answerFacts.length ? '<section class="zh-block"><h3>关键事实清单（中文）</h3><ul class="facts">' + zhFactsHtml + '</ul></section>' : '') +
      '<div class="verdict">' +
      '<button class="v-yes' + (j.verdict === true ? ' active' : '') + '" onclick="setVerdict(\\'' + d.questionId + '\\', true)">✓ 判定正确</button>' +
      '<button class="v-no' + (j.verdict === false ? ' active' : '') + '" onclick="setVerdict(\\'' + d.questionId + '\\', false)">✗ 判定不正确</button>' +
      '</div>' +
      '<textarea class="note-input" placeholder="备注（分歧原因 / 犹豫点，可选）" oninput="setNote(\\'' + d.questionId + '\\', this.value)">' + (j.note || '') + '</textarea>' +
      '<div class="official" id="official-' + d.questionId + '">' +
      '<b>官方判分：</b>' + (d.officialCorrect ? 'answer_correct = true' : 'answer_correct = false') +
      '（completeness ' + d.completenessPct + '%）<br>' +
      '<b>官方理由：</b>' + d.officialReasoning +
      '</div>';
    container.appendChild(card);
  });
  updateProgress();
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setVerdict(qid, v) {
  if (!judged[qid]) judged[qid] = {};
  judged[qid].verdict = v;
  localStorage.setItem(STORE_KEY, JSON.stringify(judged));
  render();
}

function setNote(qid, note) {
  if (!judged[qid]) judged[qid] = {};
  judged[qid].note = note;
  localStorage.setItem(STORE_KEY, JSON.stringify(judged));
}

function setMode(mode) {
  document.body.classList.remove('mode-orig', 'mode-both', 'mode-zh');
  document.body.classList.add('mode-' + mode);
  localStorage.setItem(STORE_KEY + '-mode', mode);
  document.getElementById('modeSelect').value = mode;
}

function updateProgress() {
  const done = DATA.filter((d) => judged[d.questionId] && judged[d.questionId].verdict !== undefined).length;
  document.getElementById('progressText').textContent = '已判 ' + done + ' / ' + DATA.length;
  document.getElementById('progressFill').style.width = (done / DATA.length * 100) + '%';
}

function reveal() {
  const done = DATA.filter((d) => judged[d.questionId] && judged[d.questionId].verdict !== undefined).length;
  if (done < DATA.length && !confirm('还有 ' + (DATA.length - done) + ' 题未判，确定提前揭示吗？未判题不计入统计。')) return;
  revealed = true;

  // 逐题显示官方判分
  DATA.forEach((d) => {
    const el = document.getElementById('official-' + d.questionId);
    if (!el) return;
    const j = judged[d.questionId];
    const match = j && j.verdict !== undefined && j.verdict === d.officialCorrect;
    el.classList.add('show', match ? 'match' : 'mismatch');
  });

  // 计算一致率
  const valid = DATA.filter((d) => judged[d.questionId] && judged[d.questionId].verdict !== undefined);
  const agree = valid.filter((d) => judged[d.questionId].verdict === d.officialCorrect);
  const disagree = valid.filter((d) => judged[d.questionId].verdict !== d.officialCorrect);
  const humanYes = valid.filter((d) => judged[d.questionId].verdict === true).length;
  const offYes = valid.filter((d) => d.officialCorrect).length;
  const n = valid.length;

  // Cohen's Kappa
  const po = n ? agree.length / n : 0;
  const pe = n ? (humanYes / n) * (offYes / n) + ((n - humanYes) / n) * ((n - offYes) / n) : 0;
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);

  // 分歧双向拆分
  const falsePositive = disagree.filter((d) => judged[d.questionId].verdict === true && !d.officialCorrect); // 人工放水
  const falseNegative = disagree.filter((d) => judged[d.questionId].verdict === false && d.officialCorrect); // 人工过严

  const disagreeHtml = disagree.length === 0
    ? '<p>无分歧 🎉</p>'
    : disagree.map((d) => {
        const j = judged[d.questionId];
        return '<div class="disagree-item"><b>' + d.questionId + '</b>（' + d.questionType + '）' +
          ' 人工=' + (j.verdict ? '正确' : '不正确') + ' / 官方=' + (d.officialCorrect ? '正确' : '不正确') +
          '<br><b>官方理由：</b>' + d.officialReasoning +
          (j.note ? '<br><b>人工备注：</b>' + j.note : '') +
          '</div>';
      }).join('');

  const panel = document.getElementById('statsPanel');
  panel.innerHTML =
    '<h2>人工 vs 官方 harness 一致性（n=' + n + '）</h2>' +
    '<div class="stat-grid">' +
    '<div class="stat-box"><div class="num">' + (po * 100).toFixed(1) + '%</div><div class="lbl">总体一致率</div></div>' +
    '<div class="stat-box"><div class="num">' + kappa.toFixed(3) + '</div><div class="lbl">Cohen Kappa</div></div>' +
    '<div class="stat-box"><div class="num">' + falsePositive.length + '</div><div class="lbl">人工放水（官方判错人工判对）</div></div>' +
    '<div class="stat-box"><div class="num">' + falseNegative.length + '</div><div class="lbl">人工过严（官方判对人工判错）</div></div>' +
    '</div>' +
    '<h3 style="margin-bottom:8px;font-size:13px;color:#6b7280">分歧题清单（' + disagree.length + ' 题）</h3>' + disagreeHtml;
  panel.style.display = 'block';
  document.getElementById('exportBtn').style.display = 'inline-block';
  panel.scrollIntoView({ behavior: 'smooth' });
}

function exportResults() {
  const valid = DATA.filter((d) => judged[d.questionId] && judged[d.questionId].verdict !== undefined);
  const out = {
    exportedAt: new Date().toISOString(),
    sampleSize: DATA.length,
    judgedSize: valid.length,
    judgments: valid.map((d) => ({
      question_id: d.questionId,
      question_type: d.questionType,
      human_correct: judged[d.questionId].verdict,
      official_correct: d.officialCorrect,
      agree: judged[d.questionId].verdict === d.officialCorrect,
      human_note: judged[d.questionId].note || '',
      official_reasoning: d.officialReasoning,
    })),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'human-eval-results.json';
  a.click();
}

render();

// 初始化显示模式：有翻译默认"仅中文"，否则回退"仅原文"
const hasZh = DATA.some((d) => d.zh);
const savedMode = localStorage.getItem(STORE_KEY + '-mode');
setMode(savedMode || (hasZh ? 'zh' : 'orig'));
const zhCount = DATA.filter((d) => d.zh).length;
document.getElementById('zhCoverage').textContent = '翻译覆盖 ' + zhCount + ' / ' + DATA.length + ' 题';
</script>
</body>
</html>`;
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  console.log('=== 人工校准工作表生成器 ===\n');

  const questions = loadJsonl<ErbQuestion>(QUESTIONS_FILE);
  const answers = loadJsonl<ErbAnswer>(ANSWERS_FILE);
  const resultsRaw = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')) as {
    questions: HarnessQuestionResult[];
  };

  const answerMap = new Map(answers.map((a) => [a.question_id, a]));
  const resultMap = new Map(resultsRaw.questions.map((r) => [r.question_id, r]));

  console.log(`题目: ${questions.length} | 答案: ${answers.length} | 官方判分: ${resultsRaw.questions.length}`);

  // 组装全量池
  const pool: Array<{ q: ErbQuestion; official: HarnessQuestionResult }> = [];
  for (const q of questions) {
    const official = resultMap.get(q.question_id);
    const ans = answerMap.get(q.question_id);
    if (!official || !ans) continue;
    pool.push({ q, official });
  }
  console.log(`三表齐全题目: ${pool.length}\n`);

  // 分层抽样
  const rand = mulberry32(RANDOM_SEED);
  const byType = new Map<string, Array<{ q: ErbQuestion; official: HarnessQuestionResult }>>();
  for (const item of pool) {
    const list = byType.get(item.q.question_type) || [];
    list.push(item);
    byType.set(item.q.question_type, list);
  }

  const sampled: Array<{ q: ErbQuestion; official: HarnessQuestionResult }> = [];
  for (const [type, quota] of Object.entries(TYPE_QUOTA)) {
    const typePool = byType.get(type) || [];
    const picked = pickFromType(typePool, quota, rand);
    sampled.push(...picked);
    const incorrectCount = picked.filter((x) => !x.official.answer_correct).length;
    console.log(`  ${type}: 池 ${typePool.length} → 抽 ${picked.length}（含 incorrect ${incorrectCount}）`);
  }

  const total = sampled.length;
  const incorrectTotal = sampled.filter((x) => !x.official.answer_correct).length;
  console.log(`\n合计抽样: ${total} 题（official incorrect ${incorrectTotal} / correct ${total - incorrectTotal}）`);
  if (total !== 50) console.warn(`⚠️ 抽样数 ${total} ≠ 50，请检查题型配额配置`);

  // 组装工作表数据（按题型排序，判起来有条理）
  sampled.sort((a, b) => a.q.question_type.localeCompare(b.q.question_type) || a.q.question_id.localeCompare(b.q.question_id));

  // 导出抽样中间产物（供 translate-human-eval.ts 消费；固定种子保证重跑同一批）
  const samplesForTranslate = sampled.map(({ q }) => ({
    questionId: q.question_id,
    questionType: q.question_type,
    question: q.question,
    goldAnswer: q.gold_answer,
    answerFacts: q.answer_facts,
    modelAnswer: answerMap.get(q.question_id)!.answer,
  }));
  fs.writeFileSync(SAMPLES_FILE, JSON.stringify(samplesForTranslate, null, 2), 'utf-8');
  console.log(`抽样已导出: ${SAMPLES_FILE}`);

  // 加载已有翻译（若有），按 questionId 合并
  const zhMap = new Map<string, ZhTranslation>();
  if (fs.existsSync(TRANSLATED_FILE)) {
    const translated = JSON.parse(fs.readFileSync(TRANSLATED_FILE, 'utf-8')) as Record<string, ZhTranslation>;
    for (const [qid, zh] of Object.entries(translated)) {
      if (zh && typeof zh.question === 'string') zhMap.set(qid, zh);
    }
    console.log(`已加载翻译: ${zhMap.size} 题（${TRANSLATED_FILE}）`);
  } else {
    console.log('未找到翻译文件，先运行 translate-human-eval.ts 生成中文翻译');
  }

  const items: SampledItem[] = sampled.map(({ q, official }) => ({
    question: q,
    answer: answerMap.get(q.question_id)!.answer,
    officialCorrect: official.answer_correct,
    officialReasoning: official.correctness_reasoning,
    completenessPct: official.completeness_pct,
    zh: zhMap.get(q.question_id),
  }));

  fs.writeFileSync(OUTPUT_HTML, buildWorksheetHtml(items), 'utf-8');
  console.log(`\n✅ 工作表已生成: ${OUTPUT_HTML}`);
  console.log('打开 HTML → 盲判 50 题 → 点"揭示官方判分"看一致率 → 导出 JSON');
}

main().catch((e) => {
  console.error('生成失败:', e);
  process.exit(1);
});
