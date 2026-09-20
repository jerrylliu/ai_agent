/**
 * ERB 语义缺口 FAQ 副本生成脚本（benchmark-only，路径 1 方法 A）
 *
 * 目标：为 semantic 题型的 gold 文档生成 FAQ 问答对副本（问题形态文本），
 *       与"问题形态查询"对齐，从源头缩小嵌入语义鸿沟（查询是问句、
 *       文档是陈述句，bge-m3 对这种形态差异不敏感 → semantic R@3 0.568）。
 *
 * 两阶段解耦（本脚本只做第 1 阶段）：
 *   1. 本脚本：LLM 逐篇生成 3-5 条 FAQ（断点续传，输出 JSONL 中间产物）；
 *   2. ingest-faq-chunks.ts：读 JSONL → 嵌入 → ChromaDB + tantivy BM25 双写。
 *
 * 试点范围（--type semantic，默认）：仅 semantic 题的 gold 文档（~200 篇），
 * 用于机制验证；机制有效后再全量 3617 篇拿官方口径数字
 * （试点数字不可对外报告——只给 gold 文档配了 FAQ 等于考试泄题）。
 *
 * FAQ 质量要求（写入 prompt，直接决定机制成败）：
 *   - question 必须换措辞（同义词/不同句式），禁止照抄原文句子——
 *     照抄等于复制原文块，对语义鸿沟零增益；
 *   - answer 只基于文档事实，≤80 词，自包含；
 *   - 覆盖文档最显著的事实（人名/数字/约束/关系）。
 *
 * 用法：
 *   node --import ./scripts/ts-loader.mjs --experimental-transform-types \
 *     scripts/bench/generate-faq-chunks.ts --type semantic --concurrency 3
 *   # 中断后原命令重跑即自动续传（按输出文件已有 dsid 跳过）
 */

// 必须最先加载 .env（model-provider / config 依赖完整环境变量）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
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

const MODULE = 'BenchFaqGen';

/** FAQ 输出默认路径（与 gate 评测产物同目录） */
const DEFAULT_OUTPUT = 'E:\\ragbench\\bm25\\hyde\\faq-pilot.jsonl';

/** 默认评测模型（与 gate 轮一致，deepseek-flash 单价最低） */
const DEFAULT_MODEL = 'deepseek:deepseek-v4-flash';

/** FAQ 生成并发（DeepSeek 白天限流余量内；改写类短调用 429 风险低） */
const DEFAULT_CONCURRENCY = 3;

/** 单篇重试次数（zod 校验失败 / 网络错误的兜底轮次） */
const RETRY_MAX = 2;

// ==================== CLI ====================

interface CliOptions {
  /** 题型过滤（决定 gold 文档范围），默认 semantic */
  type: string;
  output: string;
  model: string;
  concurrency: number;
  /** 本次最多生成多少篇（成本护栏；缺省不限制） */
  limit?: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    type: 'semantic',
    output: DEFAULT_OUTPUT,
    model: DEFAULT_MODEL,
    concurrency: DEFAULT_CONCURRENCY,
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
      case '--model':
        opts.model = next();
        break;
      case '--concurrency':
        opts.concurrency = Number(next());
        break;
      case '--limit':
        opts.limit = Number(next());
        break;
      default:
        console.error(`未知参数：${arg}（支持 --type/--output/--model/--concurrency/--limit）`);
        process.exit(1);
    }
  }
  return opts;
}

// ==================== Zod Schema（LLM 结构化输出校验，禁止裸 JSON.parse 直用） ====================

const FaqPairSchema = z.object({
  question: z
    .string()
    .min(8)
    .max(300)
    .describe('用户可能自然问出的问题（必须换措辞，禁止照抄原文句子）'),
  answer: z
    .string()
    .min(10)
    .max(800)
    .describe('仅基于文档事实的简明回答，自包含，不超过 80 词'),
});
type FaqPair = z.infer<typeof FaqPairSchema>;

const FaqListSchema = z.object({
  faqs: z.array(FaqPairSchema).min(3).max(5).describe('3-5 条 FAQ 问答对'),
});

// ==================== Prompt ====================

const FAQ_PROMPT = `You are building an FAQ index for a knowledge-base retrieval system.

Read the document below and generate 3-5 FAQ pairs:
- "question": phrased the way a real user would naturally ask about this content. You MUST paraphrase — use synonyms and different sentence structures. NEVER copy sentences from the document (copied text adds no retrieval value).
- "answer": concise factual answer grounded ONLY in the document, self-contained, at most 80 words.
- Cover the document's most salient facts: names, numbers, constraints, relationships, decisions.
- Use the same language as the document.

Output ONLY a JSON object (no markdown fences): {"faqs":[{"question":"...","answer":"..."}]}

Document:
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

// ==================== 主流程 ====================

/** 从 LLM 返回文本中提取 JSON 并 zod 校验（容忍 ```json 围栏） */
function parseFaqResponse(text: string): FaqPair[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('返回文本中未找到 JSON 对象');
  }
  const parsed = FaqListSchema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
  if (!parsed.success) {
    throw new Error(`zod 校验失败: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data.faqs;
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
  const missing = [...goldIds].filter((id) => !docs.has(id));
  if (missing.length > 0) {
    logger.warn('部分 gold 文档未在语料目录找到', {
      module: MODULE,
      missing: missing.length,
      sample: missing.slice(0, 5),
    });
  }
  console.log(`定位成功 ${docs.size}/${goldIds.size} 篇`);

  // 2. 断点续传：跳过输出文件已有的 dsid
  const done = new Set<string>();
  if (fs.existsSync(opts.output)) {
    for (const line of fs.readFileSync(opts.output, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        done.add((JSON.parse(line) as { documentId: string }).documentId);
      } catch {
        // 半行由下次全量重跑覆盖（append 模式下残行不影响本进程）
      }
    }
    console.log(`续传：输出文件已有 ${done.size} 篇，跳过`);
  } else {
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  }

  const pending = [...docs.values()].filter((d) => !done.has(d.documentId));
  if (opts.limit !== undefined) pending.splice(opts.limit);
  console.log(`本次待生成: ${pending.length} 篇（模型 ${opts.model}，并发 ${opts.concurrency}）`);

  // 3. 限流 LLM 实例（与生产改写/多跳同一条限流通道）
  // API Key 注入：switchModel 校验进程内 Key 存储，headless 场景从 .env 直读
  // （评测 runner 走 Redis 恢复 + --deepseek-key 兜底；本脚本场景简单，dotenv 已加载）
  if (opts.model.startsWith('deepseek:') && process.env.DEEPSEEK_API_KEY) {
    setDeepseekApiKey(process.env.DEEPSEEK_API_KEY);
  }
  const llm = createRateLimitedLLM(switchModel(opts.model), 'fast');

  // 4. 简易并发池
  let cursor = 0;
  let okCount = 0;
  let failCount = 0;
  const startedAt = Date.now();

  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const doc = pending[cursor++];
      let lastError = '';
      let success = false;
      for (let attempt = 1; attempt <= RETRY_MAX && !success; attempt++) {
        try {
          const content = readDocContent(doc);
          if (!content.trim()) throw new Error('文档内容为空');
          // 重试时把上次的失败原因附进 prompt，引导模型自纠
          const prompt =
            FAQ_PROMPT +
            content.slice(0, 12000) +
            (lastError ? `\n\nYour previous output failed: ${lastError}. Fix and try again.` : '');
          const resp = await llm.invoke(prompt);
          const faqs = parseFaqResponse(String(resp.content));
          const row = {
            documentId: doc.documentId,
            filePath: doc.filePath,
            sourceType: doc.sourceType,
            faqs,
          };
          fs.appendFileSync(opts.output, JSON.stringify(row) + '\n', 'utf8');
          okCount++;
          success = true;
        } catch (error: any) {
          lastError = error?.message ?? String(error);
          logger.warn('FAQ 生成失败，准备重试', {
            module: MODULE,
            documentId: doc.documentId,
            attempt,
            error: lastError,
          });
          if (attempt < RETRY_MAX) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
      }
      if (!success) failCount++;
      // 进度心跳：每 10 篇打一条
      if ((okCount + failCount) % 10 === 0) {
        const elapsedMin = (Date.now() - startedAt) / 60000;
        console.log(
          `进度 ${okCount + failCount}/${pending.length} ok=${okCount} fail=${failCount} ` +
            `速率=${((okCount + failCount) / elapsedMin).toFixed(1)} 篇/分钟`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  console.log(`\n=== FAQ 生成完成 ===`);
  console.log(`成功 ${okCount} / 失败 ${failCount}，输出: ${opts.output}`);
  if (failCount > 0) console.log(`（失败篇目重跑同一命令即可自动补齐）`);

  logger.info('FAQ 生成完成', {
    module: MODULE,
    ok: okCount,
    fail: failCount,
    output: opts.output,
  });
  await gracefulExit(failCount > 0 ? 2 : 0);
}

main().catch(async (error) => {
  console.error('FAQ 生成主流程异常:', error);
  logger.error('FAQ 生成主流程异常', {
    module: MODULE,
    error: error?.message ?? String(error),
    stack: error?.stack,
  });
  await gracefulExit(1);
});
