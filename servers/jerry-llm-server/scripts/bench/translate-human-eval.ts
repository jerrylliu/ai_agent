/**
 * 人工校准工作表翻译脚本（英 → 中）
 *
 * 把 gen-human-eval-worksheet.ts 抽样的 50 题（题目 / gold / 关键事实 / 模型答案）
 * 用 DeepSeek chat API 翻译成简体中文，产出 human-eval-samples-translated.json，
 * 之后重跑 gen-human-eval-worksheet.ts 即可生成双语工作表。
 *
 * 设计：
 *   - API Key 从 servers/jerry-llm-server/.env 读取（DEEPSEEK_API_KEY），不落日志
 *   - 断点续传：按 questionId 跳过已翻译条目，中断后重跑即续
 *   - 增量落盘：每完成一题即写盘，防进程中断丢进度
 *   - 术语保留：指标名 / 配置键 / 代码 / 数字保留英文；Markdown 结构原样保留
 *
 * 用法：
 *   pnpm ts-node scripts/bench/translate-human-eval.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ==================== 配置 ====================

const SAMPLES_FILE = path.join(__dirname, 'human-eval-samples.json');
const TRANSLATED_FILE = path.join(__dirname, 'human-eval-samples-translated.json');
const ENV_FILE = 'e:\\miaoma-ai-app\\servers\\jerry-llm-server\\.env';
const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const CONCURRENCY = 5;
/** 单题翻译超时（模型答案较长） */
const TIMEOUT_MS = 180000;

// ==================== 类型 ====================

/** 抽样条目（gen-human-eval-worksheet.ts 导出） */
interface Sample {
  questionId: string;
  questionType: string;
  question: string;
  goldAnswer: string;
  answerFacts: string[];
  modelAnswer: string;
}

/** 翻译产物（与 Sample 字段一一对应，全中文） */
interface ZhTranslation {
  question: string;
  goldAnswer: string;
  answerFacts: string[];
  modelAnswer: string;
}

// ==================== API Key ====================

function readDeepseekKey(): string {
  const env = fs.readFileSync(ENV_FILE, 'utf-8');
  const m = env.match(/^DEEPSEEK_API_KEY=(.+)$/m);
  if (!m) {
    throw new Error(`未在 ${ENV_FILE} 中找到 DEEPSEEK_API_KEY`);
  }
  return m[1].trim();
}

// ==================== Prompt ====================

const SYSTEM_PROMPT = `你是专业的英译中技术文档翻译员。输入是一个 JSON 对象，包含 RAG 评测题目的四个字段。请把它们翻译成简体中文，规则：

1. 专有名词、指标名（如 stream.timebox_finalized）、配置键名（如 max_file_size）、代码、命令、路径、数字与单位：保留英文原样，不翻译。
2. 保留 Markdown 结构（表格、列表、代码块、标题）原样，只翻译其中的自然语言内容；代码块内容不翻译。
3. 忠实翻译，不增不减、不总结、不解释。语气平淡客观。
4. answerFacts 数组必须逐条翻译，输出数组长度与输入一致，顺序不变。
5. goldAnswer 为空字符串时输出空字符串。

只输出一个 JSON 对象，格式：
{"question": "...", "goldAnswer": "...", "answerFacts": ["...", ...], "modelAnswer": "..."}`;

// ==================== 单题翻译 ====================

async function translateOne(key: string, sample: Sample): Promise<ZhTranslation> {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          question: sample.question,
          goldAnswer: sample.goldAnswer,
          answerFacts: sample.answerFacts,
          modelAnswer: sample.modelAnswer,
        }),
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 8192,
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = data.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw) as Partial<ZhTranslation>;

  // 结构校验：四字段齐全 + facts 数组长度一致，不合格直接报错（该题重跑）
  if (
    typeof parsed.question !== 'string' ||
    typeof parsed.goldAnswer !== 'string' ||
    typeof parsed.modelAnswer !== 'string' ||
    !Array.isArray(parsed.answerFacts) ||
    parsed.answerFacts.length !== sample.answerFacts.length
  ) {
    throw new Error('翻译输出结构不完整或 answerFacts 长度不一致');
  }

  return {
    question: parsed.question,
    goldAnswer: parsed.goldAnswer,
    answerFacts: parsed.answerFacts.map((f) => String(f)),
    modelAnswer: parsed.modelAnswer,
  };
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  console.log('=== 人工校准工作表翻译 ===\n');

  const samples = JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf-8')) as Sample[];
  console.log(`待翻译题目: ${samples.length}`);

  // 断点续传：加载已翻译条目
  const translated: Record<string, ZhTranslation> = fs.existsSync(TRANSLATED_FILE)
    ? (JSON.parse(fs.readFileSync(TRANSLATED_FILE, 'utf-8')) as Record<string, ZhTranslation>)
    : {};
  const pending = samples.filter((s) => !translated[s.questionId]);
  console.log(`已完成: ${samples.length - pending.length}，剩余: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('✅ 全部已翻译，直接重跑 gen-human-eval-worksheet.ts 即可');
    return;
  }

  const key = readDeepseekKey();

  const save = (): void => {
    fs.writeFileSync(TRANSLATED_FILE, JSON.stringify(translated, null, 2), 'utf-8');
  };

  // 简单 worker pool + 增量落盘
  let done = 0;
  let failed = 0;
  const queue = [...pending];

  async function worker(id: number): Promise<void> {
    while (queue.length > 0) {
      const sample = queue.shift();
      if (!sample) break;
      try {
        const zh = await translateOne(key, sample);
        translated[sample.questionId] = zh;
        done++;
        save();
        console.log(`  [w${id}] ✓ ${sample.questionId}（${done}/${pending.length}）`);
      } catch (e) {
        failed++;
        console.error(`  [w${id}] ✗ ${sample.questionId}: ${(e as Error).message}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n完成: ${done}，失败: ${failed}`);
  console.log(`产物: ${TRANSLATED_FILE}`);
  if (failed > 0) {
    console.log('存在失败条目，直接重跑本脚本即可续传失败题');
  } else {
    console.log('下一步: pnpm ts-node scripts/bench/gen-human-eval-worksheet.ts 重新生成双语工作表');
  }
}

main().catch((e) => {
  console.error('翻译失败:', e);
  process.exit(1);
});
