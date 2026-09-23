/**
 * KG 在线链路连通性复验脚本（a6 门闩复验 · 6 题）
 *
 * 目的：验证已落地的在线链路 `linkQueryToEntities`（A 分级降级：免 LLM 精确通道 →
 * mention 抽取 LLM → 链接确认 LLM → 图扩展）在门闩同口径数据上跑通，且指标不倒退。
 * ⚠️ 本脚本只构成「链路连通性复验」，不构成门闩结论（30 题复验为独立实验）。
 *
 * 数据来源（30 题门闩 PASS 产物，只读复用，不触业务库）：
 *   .tmp/kg-spike-v2-gate30/entities.jsonl          30 篇文档抽取结果（DocEntityRow 形态）
 *   .tmp/kg-spike-v2-gate30/entity-embeddings.json  实体键向量缓存（{model, vectors}）
 *   .tmp/kg-spike-v2-gate30/spike-data.json         门闩基准（perQuestion 对比基线）
 *
 * 复验范围：
 *   ✅ linkQueryToEntities 全程（只读内存快照，不触库）
 *   ⚠️ resolveGraphSupplements 末步 fetchSupplementChunks 触业务库向量存储，
 *      门闩 ERB chunk 不在库，该段留给真实环境验证（本脚本不覆盖）。
 *
 * 选题口径（用户拍板）：门闩提升的 6 题（improved === true，即
 * qst_0178/0184/0193/0201/0203/0205）；mention 抽取走真实 LLM 重新抽取
 * （不复用 question-mentions.json 缓存），接受采样抖动，「不倒退」看量级。
 *
 * 判定「不倒退」标准：
 *   1. 6/6 题 linkQueryToEntities 返回非 null（无失败降级，链路连通）；
 *   2. 6/6 题 graphDocs 命中 goldDocIds（任意位次）；
 *   3. ≥5/6 题重跑 linkedKeys 与门闩基准 linkedKeys 有交集（链接能力量级相当）；
 *   4. 参考项（不参与判定）：top supplementSlots 命中 gold 题数、图池规模量级。
 *
 * 运行（servers/jerry-llm-server 目录下）：
 *   node --import ./scripts/ts-loader.mjs --experimental-transform-types \
 *     scripts/bench/kg-online-link-check.ts [--model deepseek:deepseek-v4-flash]
 *
 * 前置条件：.env 中 KG_ENABLED=true、DEEPSEEK_API_KEY 已配置、本地 Ollama
 * 嵌入模型可用（与门闩同一嵌入后端，否则语义候选通道失效）。
 */

// 必须最先加载 .env（config 在 import 时初始化，KG_ENABLED 需先就位）
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../src/fundamentals/config.js';
import {
  buildIndex,
  setKgIndexSnapshot,
} from '../../src/fundamentals/kg/kg-index.js';
import type { DocEntityRow } from '../../src/fundamentals/kg/kg-index.js';
import { linkQueryToEntities } from '../../src/fundamentals/kg/kg-link.js';
import {
  setDeepseekApiKey,
  switchModel,
} from '../../src/fundamentals/model-provider.js';
import { getEmbeddings } from '../../src/fundamentals/vector-store/index.js';

// ==================== 类型（门闩 spike-data.json 的 perQuestion 子集） ====================

interface GateMention {
  mentionId: string;
  surface: string;
  variants: string[];
  exactKeys: string[];
  linkedKeys: string[];
}

interface GateQuestion {
  questionId: string;
  question: string;
  goldDocIds: string[];
  mentionCount: number;
  linkedMentionCount: number;
  baselineR3: number;
  mergedR3: number;
  improved: boolean;
  regressed: boolean;
  graphPoolSize: number;
  mentions: GateMention[];
}

interface QuestionCheckResult {
  questionId: string;
  question: string;
  goldDocIds: string[];
  /** 门闩基准 */
  gate: {
    mentionCount: number;
    linkedMentionCount: number;
    baselineLinkedKeys: string[];
    graphPoolSize: number;
    baselineR3: number;
    mergedR3: number;
  };
  /** 本次重跑（在线链路真实输出） */
  run: {
    connected: boolean;
    exactOnly: boolean;
    mentionCount: number;
    linkedKeys: string[];
    graphPoolSize: number;
    /** 完整图扩展文档列表（按图权重降序，池规模 ≤ 数十条，全量保留供命中判定） */
    graphDocs: Array<{ documentId: string; score: number; via: string[] }>;
    elapsedMs: number;
    error: string | null;
  };
  /** 对比指标 */
  compare: {
    linkedKeyOverlap: string[];
    goldHitAny: boolean;
    goldHitTopSlots: boolean;
  };
}

// ==================== 参数与路径 ====================

// 脚本统一由服务器根目录的 pnpm bench:kg-online-check 启动，与 measure-runtime.ts 一致用 cwd 定位；
// 不用 import.meta.url：本仓库 tsc 编译为 CommonJS，import.meta 会被 TS1470 拦截
const SERVER_ROOT = process.cwd();
const DEFAULT_MODEL = 'deepseek:deepseek-v4-flash';

function parseArgs(argv: string[]): {
  gateDir: string;
  outDir: string;
  model: string;
  qids: string[] | null;
  repeat: number;
} {
  const opts = {
    gateDir: path.join(SERVER_ROOT, '.tmp', 'kg-spike-v2-gate30'),
    outDir: path.join(SERVER_ROOT, '.tmp', 'kg-online-link-check'),
    model: DEFAULT_MODEL,
    /** 限定复验题目（逗号分隔 qid）；null = 全部门闩提升题 */
    qids: null as string[] | null,
    /** 每题重复采样次数（LLM 抖动归因用），默认 1 */
    repeat: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${arg} 缺少值`);
      return v;
    };
    switch (arg) {
      case '--gate-dir':
        opts.gateDir = path.resolve(SERVER_ROOT, next());
        break;
      case '--out-dir':
        opts.outDir = path.resolve(SERVER_ROOT, next());
        break;
      case '--model':
        opts.model = next();
        break;
      case '--qids':
        opts.qids = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--repeat':
        opts.repeat = Math.max(1, parseInt(next(), 10) || 1);
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}

// ==================== 数据加载 ====================

/** 加载门闩 entities.jsonl（每行一个 DocEntityRow）并构建内存索引 */
function loadGateIndex(gateDir: string): { rows: DocEntityRow[] } {
  const entitiesPath = path.join(gateDir, 'entities.jsonl');
  const rows: DocEntityRow[] = [];
  for (const line of fs.readFileSync(entitiesPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed) as DocEntityRow);
  }
  if (rows.length === 0)
    throw new Error(`entities.jsonl 为空: ${entitiesPath}`);
  return { rows };
}

/** 加载门闩实体向量缓存（{model?, vectors?}），模型不一致仅告警（由嵌入连通性检查兜底） */
function loadGateEmbeddings(gateDir: string): {
  keyToEmbedding: Map<string, number[]>;
  cacheModel: string | null;
} {
  const embeddingsPath = path.join(gateDir, 'entity-embeddings.json');
  if (!fs.existsSync(embeddingsPath)) {
    console.warn(
      `⚠️ 未找到向量缓存 ${embeddingsPath}，语义候选通道将失效（仅词汇通道）`,
    );
    return { keyToEmbedding: new Map(), cacheModel: null };
  }
  const raw = JSON.parse(fs.readFileSync(embeddingsPath, 'utf-8')) as {
    model?: string;
    vectors?: Record<string, number[]>;
  };
  const keyToEmbedding = new Map<string, number[]>(
    Object.entries(raw.vectors ?? {}),
  );
  return { keyToEmbedding, cacheModel: raw.model ?? null };
}

/** 从门闩 spike-data.json 提取提升题（improved === true）作为复验基准 */
function loadGateQuestions(gateDir: string): GateQuestion[] {
  const dataPath = path.join(gateDir, 'spike-data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as {
    perQuestion: GateQuestion[];
  };
  const improved = data.perQuestion.filter((q) => q.improved);
  if (improved.length === 0)
    throw new Error('spike-data.json 中没有 improved 题，无法复验');
  return improved;
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // 前置检查：KG 开关必须打开（linkQueryToEntities 首行会因关闭直接返回 null）
  if (!config.kg.enabled) {
    console.error(
      '❌ KG_ENABLED 未开启，在线链路会直接返回 null。请在 .env 设置 KG_ENABLED=true 后重试。',
    );
    process.exit(1);
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) {
    console.error(
      '❌ 缺少 DEEPSEEK_API_KEY 环境变量，无法调用 mention 抽取 / 链接确认 LLM。',
    );
    process.exit(1);
  }

  console.log('========== KG 在线链路连通性复验（6 题） ==========');
  console.log(`门闩数据目录: ${opts.gateDir}`);
  console.log(`输出目录:     ${opts.outDir}`);
  console.log(`LLM 模型:     ${opts.model}（与门闩一致）`);
  console.log(`补充槽位数:   ${config.kg.supplementSlots}`);

  // 1. 构建内存索引快照（绕过 MySQL 三表，直接喂门闩图数据）
  const { rows } = loadGateIndex(opts.gateDir);
  const index = buildIndex(rows);
  const { keyToEmbedding, cacheModel } = loadGateEmbeddings(opts.gateDir);
  setKgIndexSnapshot(index, keyToEmbedding);
  console.log(
    `内存索引就绪: ${rows.length} 篇文档 / ${index.keyToLabel.size} 实体键 / ` +
      `${index.tripleCount} 三元组 / 向量 ${keyToEmbedding.size} 条（缓存模型: ${cacheModel ?? '无'}）`,
  );

  // 2. LLM 初始化（在线函数内部走 createRateLimitedLLM(undefined, 'fast')，
  //    依赖 switchModel 设置的全局 currentModelId）
  setDeepseekApiKey(deepseekKey);
  switchModel(opts.model);

  // 3. 嵌入后端连通性预检（失败则语义通道全灭，提前失败并给出明确原因）
  try {
    await getEmbeddings().embedQuery('connectivity check');
    console.log('嵌入后端连通性检查通过');
  } catch (err) {
    console.error(
      `❌ 嵌入后端不可用（${err instanceof Error ? err.message : String(err)}）。` +
        '请确认本地 Ollama 已启动且嵌入模型可用。',
    );
    process.exit(1);
  }

  // 4. 逐题复验（真实 LLM 抽取，不复用门闩 mention 缓存；--qids 可限定题目，--repeat 重复采样）
  let questions = loadGateQuestions(opts.gateDir);
  if (opts.qids) {
    questions = questions.filter((q) => opts.qids!.includes(q.questionId));
    if (questions.length === 0) {
      throw new Error(`--qids 未匹配到任何门闩提升题: ${opts.qids.join(', ')}`);
    }
  }
  console.log(
    `\n复验题目（${questions.length} 道 × ${opts.repeat} 次采样）: ${questions.map((q) => q.questionId).join(', ')}\n`,
  );

  const results: QuestionCheckResult[] = [];
  for (let attempt = 1; attempt <= opts.repeat; attempt++) {
    for (const q of questions) {
      const baselineLinkedKeys = Array.from(
        new Set(q.mentions.flatMap((m) => m.linkedKeys)),
      );
      process.stdout.write(
        `▶ ${q.questionId}${opts.repeat > 1 ? `（第 ${attempt}/${opts.repeat} 次）` : ''} ... `,
      );
      const startedAt = Date.now();
      let run: QuestionCheckResult['run'];
      try {
        const linkResult = await linkQueryToEntities(q.question);
        run = {
          connected: linkResult !== null,
          exactOnly: linkResult?.exactOnly ?? false,
          mentionCount: linkResult?.mentionCount ?? 0,
          linkedKeys: linkResult?.linkedKeys ?? [],
          graphPoolSize: linkResult?.graphDocs.length ?? 0,
          graphDocs: (linkResult?.graphDocs ?? []).map((d) => ({
            documentId: d.documentId,
            score: d.score,
            via: d.via,
          })),
          elapsedMs: Date.now() - startedAt,
          error:
            linkResult === null
              ? 'linkQueryToEntities 返回 null（链路降级）'
              : null,
        };
      } catch (err) {
        run = {
          connected: false,
          exactOnly: false,
          mentionCount: 0,
          linkedKeys: [],
          graphPoolSize: 0,
          graphDocs: [],
          elapsedMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const overlap = run.linkedKeys.filter((k) =>
        baselineLinkedKeys.includes(k),
      );
      // gold 命中判定：任意位次 / top supplementSlots（补充位实际占用的槽深）
      const goldSet = new Set(q.goldDocIds);
      const goldHitAny = run.graphDocs.some((d) => goldSet.has(d.documentId));
      const goldHitTopSlots = run.graphDocs
        .slice(0, config.kg.supplementSlots)
        .some((d) => goldSet.has(d.documentId));

      results.push({
        questionId: q.questionId,
        question: q.question,
        goldDocIds: q.goldDocIds,
        gate: {
          mentionCount: q.mentionCount,
          linkedMentionCount: q.linkedMentionCount,
          baselineLinkedKeys,
          graphPoolSize: q.graphPoolSize,
          baselineR3: q.baselineR3,
          mergedR3: q.mergedR3,
        },
        run,
        compare: { linkedKeyOverlap: overlap, goldHitAny, goldHitTopSlots },
      });
      console.log(
        `mention ${q.mentionCount}→${run.mentionCount} / ` +
          `linkedKeys ${baselineLinkedKeys.length}→${run.linkedKeys.length}（交集 ${overlap.length}） / ` +
          `图池 ${q.graphPoolSize}→${run.graphPoolSize} / ` +
          `gold ${goldHitAny ? '命中' : '未命中'}${goldHitTopSlots ? '(top槽)' : ''} / ${run.elapsedMs}ms` +
          (run.error ? ` ❌ ${run.error}` : ''),
      );
    }
  }

  // 5. 汇总判定
  const connectedCount = results.filter((r) => r.run.connected).length;
  const overlapCount = results.filter(
    (r) => r.compare.linkedKeyOverlap.length >= 1,
  ).length;
  const goldTopCount = results.filter((r) => r.compare.goldHitTopSlots).length;

  const pass =
    connectedCount === results.length &&
    results.every((r) => r.compare.goldHitAny) &&
    overlapCount >= results.length - 1;

  console.log('\n========== 复验汇总 ==========');
  console.log(`链路连通（非 null）:   ${connectedCount}/${results.length}`);
  console.log(
    `graphDocs 命中 gold:   ${results.filter((r) => r.compare.goldHitAny).length}/${results.length}`,
  );
  console.log(
    `top${config.kg.supplementSlots} 命中 gold:      ${goldTopCount}/${results.length}（参考项）`,
  );
  console.log(`linkedKeys 有交集:     ${overlapCount}/${results.length}`);
  console.log(
    `判定: ${pass ? '✅ PASS（链路连通且指标不倒退）' : '❌ FAIL（见逐题明细）'}`,
  );

  // 6. 落盘产物
  fs.mkdirSync(opts.outDir, { recursive: true });
  const dataPath = path.join(opts.outDir, 'link-check-data.json');
  fs.writeFileSync(
    dataPath,
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        model: opts.model,
        gateDir: opts.gateDir,
        supplementSlots: config.kg.supplementSlots,
        summary: { connectedCount, overlapCount, goldTopCount, pass },
        results,
      },
      null,
      2,
    ),
    'utf-8',
  );
  const reportPath = path.join(opts.outDir, 'link-check-report.md');
  fs.writeFileSync(reportPath, buildReport(results, opts.model, pass), 'utf-8');
  console.log(`\n产物: ${dataPath}\n      ${reportPath}`);

  process.exit(pass ? 0 : 1);
}

/** 生成 Markdown 复验报告 */
function buildReport(
  results: QuestionCheckResult[],
  model: string,
  pass: boolean,
): string {
  const lines: string[] = [
    '# KG 在线链路连通性复验报告（6 题）',
    '',
    `- 复验时间: ${new Date().toISOString()}`,
    `- LLM 模型: ${model}（与门闩一致）`,
    `- 数据来源: .tmp/kg-spike-v2-gate30（门闩 PASS 产物，只读复用）`,
    `- 复验范围: linkQueryToEntities 全程（fetchSupplementChunks 触业务库，不在本次范围）`,
    `- 判定: ${pass ? '✅ PASS' : '❌ FAIL'}`,
    '',
    '| 题目 | mention 门闩→重跑 | linkedKeys 门闩→重跑(交集) | 图池 门闩→重跑 | gold 命中 | top槽命中 | 耗时 |',
    '|------|------|------|------|------|------|------|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.questionId} | ${r.gate.mentionCount}→${r.run.mentionCount} | ` +
        `${r.gate.baselineLinkedKeys.length}→${r.run.linkedKeys.length}(${r.compare.linkedKeyOverlap.length}) | ` +
        `${r.gate.graphPoolSize}→${r.run.graphPoolSize} | ` +
        `${r.compare.goldHitAny ? '✅' : '❌'} | ${r.compare.goldHitTopSlots ? '✅' : '—'} | ` +
        `${r.run.elapsedMs}ms |`,
    );
  }
  lines.push(
    '',
    '## 说明',
    '',
    '- 选题口径：门闩提升的 6 题（improved === true），是 PASS 结论的核心证据。',
    '- mention 抽取为真实 LLM 重新抽取（不复用门闩缓存），存在采样抖动（门闩实测一致率 88.1%），',
    '  「不倒退」按量级判定：链路全连通 + graphDocs 命中 gold + linkedKeys 有交集。',
    '- 本复验不构成门闩结论；30 题完整复验为独立实验（延后）。',
    '',
  );
  return lines.join('\n');
}

main().catch((err) => {
  console.error('❌ 复验脚本异常终止:', err);
  process.exit(1);
});
