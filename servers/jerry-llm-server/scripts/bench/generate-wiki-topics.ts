/**
 * ERB 语义缺口 Wiki 主题页生成脚本（benchmark-only，LLM Wiki 门闩实验 第 1 阶段）
 *
 * 目标：把 semantic 题型 gold 文档按主题聚类，每主题用 LLM 合成一篇
 *       "wiki 主题页"（跨文档知识预合成），作为独立 chunk 入库参与检索，
 *       验证"生成侧知识密度"假设——检索侧已证伪饱和（FAQ -13.3pp / MQX -6.7pp），
 *       剩余杠杆在上下文密度而非召回面。
 *
 * 防泄题纪律（与 FAQ 试点同口径）：
 *   - 合成范围 = 全部 semantic 题 gold 文档（~200 篇），不对 gate 30 题单独定制；
 *   - 聚类仅依据文档 id + 文件名 + 正文前 240 字符，不接触题目内容；
 *   - 试点数字仅用于内部 gate 决策，不可对外报告。
 *
 * 两阶段解耦（本脚本只做生成）：
 *   1. 本脚本：LLM 聚类（1 次调用，可缓存）→ 逐主题合成（并发池 + 断点续传）；
 *   2. ingest-wiki-topics.ts：读 JSONL → 嵌入 → ChromaDB + tantivy BM25 双写。
 *
 * 成本核算：累计 LLM token 用量写入 <output>.cost.json（gate 否决线 2 需要它）。
 *
 * 用法：
 *   node --import ./scripts/ts-loader.mjs --experimental-transform-types \
 *     scripts/bench/generate-wiki-topics.ts --type semantic --concurrency 2
 *   # 中断后原命令重跑即自动续传（聚类缓存 + 按 topicId 跳过）
 */

// 必须最先加载 .env（model-provider / config 依赖完整环境变量）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { getRuntimeConfig } from '../../src/fundamentals/runtime-config.js';
import {
  buildEmbeddings,
  EMBEDDING_PROVIDER_PRESETS,
} from '../../src/fundamentals/vector-store/embedding-provider.js';
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
} from './lib/erb-loader.js';

// ==================== 常量 ====================

const MODULE = 'BenchWikiGen';

/** 输出默认路径（wiki-gate 独立目录，与 clean/hyde 物理隔离） */
const DEFAULT_OUTPUT = 'E:\\ragbench\\bm25\\wiki-gate\\wiki-topics.jsonl';
/** 聚类结果缓存（避免每次重跑都花一次聚类调用） */
const DEFAULT_CLUSTERS = 'E:\\ragbench\\bm25\\wiki-gate\\clusters.json';

/** 默认评测模型（与 gate 轮一致，deepseek-flash 单价最低） */
const DEFAULT_MODEL = 'deepseek:deepseek-v4-flash';

/** 合成并发（单题输入比 FAQ 大：多文档拼接，2 档保守） */
const DEFAULT_CONCURRENCY = 2;

/** 单主题重试次数 */
const RETRY_MAX = 2;

/** 嵌入批量调用重试（429 退避 2s/4s/6s；与 ingest 同契约） */
const EMBED_RETRY_MAX = 3;
const EMBED_RETRY_BASE_MS = 2000;

/** 合成阶段单篇文档正文截断（字符）；单主题最多取前 MAX_DOCS_PER_TOPIC 篇 */
const SYNTH_DOC_CHARS = 8000;
const MAX_DOCS_PER_TOPIC = 4;

/** 主题页正文目标长度（写入 prompt） */
const BODY_WORDS = '300-600';

// ==================== CLI ====================

interface CliOptions {
  /** 题型过滤（决定 gold 文档范围），默认 semantic */
  type: string;
  output: string;
  clusters: string;
  model: string;
  concurrency: number;
  /** 主题数上限（成本护栏） */
  maxTopics: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    type: 'semantic',
    output: DEFAULT_OUTPUT,
    clusters: DEFAULT_CLUSTERS,
    model: DEFAULT_MODEL,
    concurrency: DEFAULT_CONCURRENCY,
    maxTopics: 25,
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
      case '--type':
        opts.type = next();
        break;
      case '--output':
        opts.output = next();
        break;
      case '--clusters':
        opts.clusters = next();
        break;
      case '--model':
        opts.model = next();
        break;
      case '--concurrency':
        opts.concurrency = Number(next());
        break;
      case '--max-topics':
        opts.maxTopics = Number(next());
        break;
      default:
        console.error(`未知参数：${arg}`);
        process.exit(1);
    }
  }
  return opts;
}

// ==================== Zod Schema（LLM 结构化输出校验，禁止裸 JSON.parse 直用） ====================

/** 主题页合成输出 */
const TopicPageSchema = z.object({
  title: z.string().min(2).max(120).describe('主题页标题'),
  body: z
    .string()
    .min(200)
    .max(6000)
    // 上限与 ingest 的 PARENT_CONTENT_MAX(6000) 对齐；实测 DeepSeek V4 Flash
    // 对 "300-600 words" 无视率高，prompt 硬约束 + 放宽 zod 双管齐下
    .describe('主题综述正文，至多 600 词，仅基于给定文档事实'),
});

type TopicPage = z.infer<typeof TopicPageSchema>;

/** 主题聚类结果（嵌入聚类产出；title 仅为内部编号，正式标题由合成 LLM 命名） */
interface TopicCluster {
  title: string;
  documentIds: string[];
}

// ==================== 聚类参数（嵌入贪心聚类） ====================

/** 聚类正文预览长度（字符）：足够表达主题，控制嵌入成本 */
const CLUSTER_PREVIEW_CHARS = 800;

/** 归簇余弦相似度阈值（bge-m3；低于则自立新主题） */
const CLUSTER_SIM_THRESHOLD = 0.52;

/** 单主题成员上限（超出强制开新簇，防止单页吞掉半个语料库） */
const CLUSTER_MAX_SIZE = 6;

/** 主题数上限（与 --max-topics 一致的硬顶） */
const CLUSTER_MAX_TOPICS = 25;

// ==================== Prompt ====================

const SYNTH_PROMPT = `You are writing one page of an internal knowledge wiki for a retrieval-augmented AI system.

The page synthesizes knowledge from multiple related documents (given below). Write it so that a reader who only sees this page gets the combined picture:
- "title": the topic title. Keep it under 60 characters.
- "body": AT MOST 600 words. Synthesize across documents: shared facts, differences/contradictions between documents, key numbers, constraints, parties, decisions, timelines. Structure with short paragraphs; you may use "- " bullet lines for enumerations.
- Ground EVERY statement ONLY in the documents below. Do NOT invent facts, do NOT add outside knowledge, do NOT editorialize.
- Use the same language as the documents.
- Start the body directly with content (no preamble like "This page covers...").

Output ONLY a JSON object (no markdown fences): {"title":"...","body":"..."}

Documents:
`;

// ==================== gracefulExit（见项目记忆：禁止裸 process.exit 挂起事件循环） ====================

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

// ==================== Token 成本核算 ====================

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0, calls: 0 };

/** 从 LangChain 响应中提取 token 用量（不同版本字段名兼容处理） */
function accumulateUsage(resp: { usage_metadata?: { input_tokens?: number; output_tokens?: number } | null; response_metadata?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } } }): void {
  usage.calls++;
  const um = resp.usage_metadata;
  if (um && typeof um.input_tokens === 'number' && typeof um.output_tokens === 'number') {
    usage.inputTokens += um.input_tokens;
    usage.outputTokens += um.output_tokens;
    return;
  }
  const tm = resp.response_metadata?.tokenUsage;
  if (tm && typeof tm.promptTokens === 'number' && typeof tm.completionTokens === 'number') {
    usage.inputTokens += tm.promptTokens;
    usage.outputTokens += tm.completionTokens;
  }
}

function writeCostFile(costPath: string, extra: Record<string, unknown>): void {
  fs.writeFileSync(costPath, JSON.stringify({ ...usage, ...extra }, null, 2), 'utf8');
}

// ==================== JSON 提取（容忍 ```json 围栏） ====================

function extractJson<T>(text: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ message: string }> } } }, label: string): T {
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

// ==================== 主流程 ====================

interface TopicRow {
  topicId: string;
  title: string;
  body: string;
  /** 成员文档 id（升序）；[0] 为记分归属文档（metadata.documentId 用） */
  documentIds: string[];
  sourceType: string;
}

/** 从 questions.jsonl 收集指定题型的 gold 文档 id 全集 */
function collectGoldIds(questionType: string): Set<string> {
  const questions = loadQuestions();
  const ids = new Set<string>();
  for (const q of questions) {
    if (q.question_type !== questionType) continue;
    for (const id of q.expected_doc_ids) ids.add(id);
  }
  return ids;
}

/** 全库遍历找出目标文档（提前退出：找齐即止） */
function locateDocs(wanted: Set<string>): Map<string, ErbDoc> {
  const found = new Map<string, ErbDoc>();
  for (const doc of walkDocs({})) {
    if (wanted.has(doc.documentId)) {
      found.set(doc.documentId, doc);
      if (found.size === wanted.size) break;
    }
  }
  return found;
}

/** 嵌入批量调用（429 指数退避；与 ingest 同款重试契约） */
async function embedWithRetry(
  embeddings: ReturnType<typeof buildEmbeddings>,
  texts: string[],
): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await embeddings.embedDocuments(texts);
    } catch (error: any) {
      if (attempt >= EMBED_RETRY_MAX) throw error;
      const wait = EMBED_RETRY_BASE_MS * attempt;
      logger.warn('聚类嵌入失败，退避重试', {
        module: MODULE,
        attempt,
        waitMs: wait,
        error: error?.message ?? String(error),
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * 确定性主题聚类（bge-m3 嵌入 + 贪心质心归簇）。
 * 弃用 LLM 聚类的原因：DeepSeek V4 全系 Thinking 模式，思考块长度不可控，
 * 125 篇清单的单次聚类调用两次试跑一次 17K token、一次纯思考无输出——
 * 随机性不可接受。嵌入聚类可复现、无 LLM 成本、主题命名交给合成阶段。
 */
async function clusterDocsByEmbedding(
  docs: Map<string, ErbDoc>,
  embeddings: ReturnType<typeof buildEmbeddings>,
  clustersPath: string,
  maxTopics: number,
): Promise<TopicCluster[]> {
  // 缓存命中：聚类确定性，缓存只为省一次嵌入批量调用
  if (fs.existsSync(clustersPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(clustersPath, 'utf8')) as { topics: TopicCluster[] };
      if (cached.topics.length > 0) {
        console.log(`复用聚类缓存: ${cached.topics.length} 个主题（${clustersPath}）`);
        return cached.topics;
      }
    } catch {
      console.log('聚类缓存损坏，重新聚类');
    }
  }

  // 1. 嵌入正文预览（不接触题目内容，防泄题）
  const ids = [...docs.keys()];
  const previews = ids.map((id) => {
    const doc = docs.get(id)!;
    return readDocContent(doc).replace(/\s+/g, ' ').slice(0, CLUSTER_PREVIEW_CHARS);
  });
  const batchSize = EMBEDDING_PROVIDER_PRESETS[getRuntimeConfig().embedding.cloud.provider]?.batchSize ?? 16;
  const vectors: number[][] = [];
  for (let i = 0; i < previews.length; i += batchSize) {
    const batch = previews.slice(i, i + batchSize);
    vectors.push(...(await embedWithRetry(embeddings, batch)));
  }
  console.log(`嵌入完成: ${vectors.length} 篇（batchSize=${batchSize}）`);

  // 2. 归一化 + 贪心质心归簇：按语料顺序逐篇处理，与已有质心比余弦，
  //    ≥阈值且簇未满则并入（质心增量更新），否则自立新簇
  const norms = vectors.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1);
  const unit = vectors.map((v, i) => v.map((x) => x / norms[i]));
  const centroids: number[][] = [];
  const members: number[][] = []; // 簇 → 文档下标
  for (let i = 0; i < unit.length; i++) {
    let bestIdx = -1;
    let bestSim = -1;
    for (let c = 0; c < centroids.length; c++) {
      if (members[c].length >= CLUSTER_MAX_SIZE) continue;
      const sim = unit[i].reduce((s, x, d) => s + x * centroids[c][d], 0);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = c;
      }
    }
    if (bestIdx !== -1 && bestSim >= CLUSTER_SIM_THRESHOLD) {
      members[bestIdx].push(i);
      const n = members[bestIdx].length;
      const c = centroids[bestIdx];
      for (let d = 0; d < c.length; d++) c[d] = (c[d] * (n - 1) + unit[i][d]) / n;
    } else {
      centroids.push([...unit[i]]);
      members.push([i]);
    }
  }

  // 3. 过滤：单篇簇（即文档本身，无合成价值）剔除；documentIds 升序保证
  //    topicId（首成员）跨缓存/输出/续传一致；超限按成员数降序截断
  const topics: TopicCluster[] = members
    .map((idxs, i) => ({
      title: `Topic ${i + 1}`,
      documentIds: idxs.map((k) => ids[k]).sort(),
    }))
    .filter((t) => t.documentIds.length >= 2)
    .sort((a, b) => b.documentIds.length - a.documentIds.length)
    .slice(0, Math.min(maxTopics, CLUSTER_MAX_TOPICS));

  if (topics.length === 0) {
    console.error('🔴 嵌入聚类后 0 个有效主题（阈值或语料异常），拒绝继续');
    await gracefulExit(2);
  }

  fs.mkdirSync(path.dirname(clustersPath), { recursive: true });
  fs.writeFileSync(clustersPath, JSON.stringify({ topics }, null, 2), 'utf8');
  const covered = new Set(topics.flatMap((t) => t.documentIds)).size;
  console.log(
    `聚类完成：${topics.length} 个主题，覆盖 ${covered}/${ids.length} 篇 → ${clustersPath}`,
  );
  logger.info('嵌入聚类完成', {
    module: MODULE,
    topics: topics.length,
    covered,
    embedCalls: Math.ceil(previews.length / batchSize),
  });
  return topics;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // 1. 确定目标文档
  const goldIds = collectGoldIds(opts.type);
  if (goldIds.size === 0) {
    console.error(`题型 ${opts.type} 未找到任何 gold 文档`);
    await gracefulExit(1);
  }
  console.log(`题型 ${opts.type} gold 文档数: ${goldIds.size}，开始全库定位...`);
  const docs = locateDocs(goldIds);
  console.log(`定位成功 ${docs.size}/${goldIds.size} 篇`);

  // 2a. 限流 LLM 实例（仅合成阶段使用；聚类已改为确定性嵌入聚类）
  if (opts.model.startsWith('deepseek:') && process.env.DEEPSEEK_API_KEY) {
    setDeepseekApiKey(process.env.DEEPSEEK_API_KEY);
  }
  const llm = createRateLimitedLLM(switchModel(opts.model), 'fast');

  // 2b. 嵌入实例（与 bench 导入同款，显式 cloud 绕开 localEnabled 总开关）
  const embeddingConfig = getRuntimeConfig().embedding;
  const embeddings = buildEmbeddings(embeddingConfig, 'cloud');

  // 3. 确定性嵌入聚类（缓存复用）
  const topics = await clusterDocsByEmbedding(docs, embeddings, opts.clusters, opts.maxTopics);

  // 4. 断点续传：跳过输出文件已有的 topicId
  const done = new Set<string>();
  if (fs.existsSync(opts.output)) {
    for (const line of fs.readFileSync(opts.output, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        done.add((JSON.parse(line) as TopicRow).topicId);
      } catch {
        // 半行由重跑覆盖
      }
    }
    console.log(`续传：输出文件已有 ${done.size} 页，跳过`);
  } else {
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  }

  const pending = topics.filter((t) => !done.has(t.documentIds[0]));
  console.log(`本次待合成: ${pending.length} 页（模型 ${opts.model}，并发 ${opts.concurrency}）`);

  // topicId 用首成员文档 id（确定性；入库 chunk id = `${首成员}__wiki_${topicId}`）
  let cursor = 0;
  let okCount = 0;
  let failCount = 0;
  const startedAt = Date.now();

  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const topic = pending[cursor++];
      const topicId = topic.documentIds[0];
      const members = topic.documentIds.slice(0, MAX_DOCS_PER_TOPIC);
      let lastError = '';
      let success = false;
      for (let attempt = 1; attempt <= RETRY_MAX && !success; attempt++) {
        try {
          // 拼接成员文档正文（每篇截断 SYNTH_DOC_CHARS）
          const docBlocks = members.map((id, i) => {
            const doc = docs.get(id)!;
            const content = readDocContent(doc).slice(0, SYNTH_DOC_CHARS);
            return `--- Document ${i + 1} (id: ${id}) ---\n${content}`;
          });
          const prompt =
            SYNTH_PROMPT +
            docBlocks.join('\n\n') +
            (lastError ? `\n\nYour previous output failed: ${lastError}. Fix and try again.` : '');
          const resp = await llm.invoke(prompt);
          accumulateUsage(resp as never);
          const page = extractJson<TopicPage>(String(resp.content), TopicPageSchema, '主题页');
          const row: TopicRow = {
            topicId,
            title: page.title,
            body: page.body,
            documentIds: [...topic.documentIds].sort(),
            sourceType: docs.get(topicId)!.sourceType,
          };
          fs.appendFileSync(opts.output, JSON.stringify(row) + '\n', 'utf8');
          okCount++;
          success = true;
        } catch (error: any) {
          lastError = error?.message ?? String(error);
          logger.warn('主题页合成失败，准备重试', {
            module: MODULE,
            topicId,
            attempt,
            error: lastError,
          });
          if (attempt < RETRY_MAX) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
      }
      if (!success) failCount++;
      if ((okCount + failCount) % 5 === 0) {
        const elapsedMin = (Date.now() - startedAt) / 60000;
        console.log(
          `进度 ${okCount + failCount}/${pending.length} ok=${okCount} fail=${failCount} ` +
            `速率=${((okCount + failCount) / elapsedMin).toFixed(1)} 页/分钟`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, pending.length) }, () => worker()));

  console.log(`\n=== Wiki 主题页生成完成 ===`);
  console.log(`成功 ${okCount} / 失败 ${failCount}，输出: ${opts.output}`);
  console.log(
    `Token 用量: 调用 ${usage.calls} 次 / 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}`,
  );
  if (failCount > 0) console.log(`（失败主题重跑同一命令即可自动补齐）`);

  writeCostFile(`${opts.output}.cost.json`, {
    stage: 'generate-wiki-topics',
    model: opts.model,
    topicsOk: okCount,
    topicsFail: failCount,
    sourceDocs: docs.size,
    finishedAt: new Date().toISOString(),
  });

  logger.info('Wiki 主题页生成完成', {
    module: MODULE,
    ok: okCount,
    fail: failCount,
    usage,
    output: opts.output,
  });
  await gracefulExit(failCount > 0 ? 2 : 0);
}

main().catch(async (error) => {
  console.error('Wiki 生成主流程异常:', error);
  logger.error('Wiki 生成主流程异常', {
    module: MODULE,
    error: error?.message ?? String(error),
    stack: error?.stack,
  });
  await gracefulExit(1);
});
