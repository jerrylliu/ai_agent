/**
 * fundamentals/output-review.ts
 *
 * AI 输出自检（方案 C：草稿态显示）的审核模块。
 *
 * 职责：流式输出结束后，用一个快速模型把"抑制后的最终回答"审一遍：
 *   - 通过 → 前端把草稿态"转正"（恢复全亮 + ✓ 徽章）；
 *   - 不通过 → 调用方（prompt.ts）让原对话模型重写修正，前端热替换。
 *
 * 设计决策：
 *   1. fail-open：任何异常（无 Key / 超时 / 解析失败 / 模型抛错）一律放行，
 *      绝不阻塞用户——审核是增益项，不是关卡；
 *   2. 走 parseLlmJson（regex 抽 JSON + zod safeParse）而非 withStructuredOutput，
 *      与 judge.ts 同一模式：兼容不支持 function calling 的审核模型；
 *   3. 模型由 config.outputReview.model 指定（'deepseek:xxx' 格式），
 *      复用 model-provider 的 buildModelConfig + createLLM 构建；
 *   4. 审核要点只盯"硬伤"（协议残留/乱码空话/自相矛盾/编造），不审风格与长度，
 *      且 prompt 明确"拿不准就通过"——宁可漏判，不可误杀。
 *
 * 关联：fundamentals/prompt.ts（调用方，重写热替换）、
 *       fundamentals/eval/judge.ts（模型构建与 JSON 解析模式来源）。
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { logger } from './logger.js';
import { parseLlmJson } from './llm-json-parser.js';
import { config } from './config.js';
import { buildModelConfig, createLLM } from './model-provider.js';

// ==================== Zod Schema ====================

/** 审核裁决（zod 推导，禁止另写 interface） */
export const ReviewVerdictSchema = z.object({
  /** 是否通过（true = 放行给用户） */
  pass: z.boolean().describe('回答是否通过自检'),
  /** 一句话理由（中文），不通过时说明命中的硬伤，通过时留空 */
  reason: z.string().max(500).describe('判定理由，通过时留空'),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/** reviewFinalAnswer 的返回结构 */
export interface OutputReviewResult {
  pass: boolean;
  reason: string;
  /** 是否真的执行了模型审核（false = 开关关闭或 fail-open 放行） */
  reviewed: boolean;
  /** 本次审核使用的模型 id（审核未执行时缺省） */
  model?: string;
}

// ==================== Prompt ====================

/** 审核 system prompt：角色、判定口径与输出格式（审核四要点在 user prompt 内，便于单测覆盖） */
const REVIEW_SYSTEM_PROMPT = `你是一个 AI 回答质检员。你只检查回答是否存在"硬伤"，不做任何风格、详略、好坏的主观评价。
判定口径：拿不准就通过——宁可漏判，不可误杀；只有确凿命中硬伤才判不通过。
输出要求：只输出一个 JSON 对象，不要输出任何其他文字、注释或 markdown 围栏。格式：
{"pass": true/false, "reason": "一句话中文理由，通过时留空"}`;

/**
 * 构建审核 user prompt（纯函数，便于测试）。
 *
 * 审核四要点（只盯硬伤）：
 *   ① DSML/工具调用协议残留（`<｜｜DSML｜｜`、`<invoke`、`<tool_call>` 等标记）
 *   ② 乱码/空泛到无意义
 *   ③ 自相矛盾
 *   ④ 若提供检索上下文则核查编造（未提供则跳过该要点）
 *
 * @param question 用户原始问题
 * @param answer 待审核的最终回答文本（调用方负责截断）
 * @param contexts 检索上下文（可选；有值时才启用"编造核查"要点）
 */
export function buildReviewPrompt(
  question: string,
  answer: string,
  contexts?: string[],
): string {
  const contextBlock =
    contexts && contexts.length > 0
      ? contexts.map((c, i) => `--- context ${i + 1} ---\n${c}`).join('\n\n')
      : '';
  const contextSection = contextBlock
    ? `【检索上下文】\n${contextBlock}\n\n`
    : '【检索上下文】（未提供，跳过"编造核查"要点）\n\n';

  return `【审核要点】只检查以下四类硬伤，命中任一确凿项才判不通过：
1. 协议残留：回答中残留工具调用/模型协议的原始文本，如 <｜｜DSML｜｜、<invoke、<tool_call>、function_call 等标记，或成对的协议标签结构、裸露的 JSON 工具参数体；
2. 内容无效：回答是乱码、无意义的重复堆砌，或空泛到完全没有回答问题（例如只有"好的，我来帮你"之类没有实质内容的话）；
3. 自相矛盾：同一回答内对同一事实给出互相冲突的结论，且未做任何解释；
4. 编造（仅当上方提供了检索上下文）：回答与上下文内容明确矛盾，或对问题核心事实凭空捏造出上下文中毫无对应的具体数字/名称/结论。
不要审：写作风格、详略长短、排版格式、主观好坏。
${contextSection}【用户问题】
${question}

【待检回答】
${answer}`;
}

/**
 * 构建重写指令（纯函数，prompt.ts 重写轮使用）。
 *
 * 把审核 reason + 原问题带给原对话模型，要求输出完整修正后的回答正文，
 * 并明确禁止协议格式文本（重写流同样过 StreamingDsmlSuppressor，双保险）。
 *
 * @param reason 审核不通过的理由（命中硬伤说明）
 */
export function buildRewriteInstruction(reason: string): string {
  return [
    `你上一条回答未通过质量自检，问题：${reason || '存在硬伤'}。`,
    '请重新审视并输出一份完整修正后的回答正文（覆盖原回答的全部要点，直接输出正文内容）。',
    '注意：绝对不要输出任何工具调用/协议格式的文本（如 <｜｜DSML｜｜、<invoke、<tool_call> 等标记），只输出自然的回答正文。',
  ].join('\n');
}

// ==================== 截断 ====================

/**
 * 审核输入截断：超长时保留 80% 头 + 20% 尾，中间用省略标记衔接。
 *
 * 为什么头多尾少：协议残留/编造通常出现在正文前中段，结论性内容在尾部，
 * 头部信息对判定的信息密度更高（与 judge 生态的窗口口径一致）。
 *
 * @param text 原始文本
 * @param maxChars 最大字符数
 */
export function truncateForReview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.8);
  const tailLen = maxChars - headLen;
  return (
    text.slice(0, headLen) +
    '\n……（中间内容省略）……\n' +
    text.slice(text.length - tailLen)
  );
}

// ==================== 审核入口 ====================

/** 审核输入截断上限：answer 6000 / question 2000 / contexts 每条 2400、最多 12 条 */
const ANSWER_MAX_CHARS = 6000;
const QUESTION_MAX_CHARS = 2000;
const CONTEXT_MAX_CHARS = 2400;
const CONTEXT_MAX_COUNT = 12;

/**
 * 对最终回答执行一次审核。
 *
 * fail-open 契约：开关关闭 / 无 Key / 构建模型抛错 / 调用超时 / 输出解析失败 /
 * 模型抛错，一律返回 `{ pass: true, reviewed: false }` 放行，绝不向上抛异常。
 *
 * @param params.question 用户原始问题（内部截断到 2000 字符）
 * @param params.answer 待审核的最终回答（内部截断到 6000 字符）
 * @param params.contexts 检索上下文（可选；最多 12 条、每条截断 2400 字符）
 */
export async function reviewFinalAnswer(params: {
  question: string;
  answer: string;
  contexts?: string[];
}): Promise<OutputReviewResult> {
  const { enabled, model, timeoutMs } = config.outputReview;
  // 开关关闭：不调模型，直接放行（不发任何模型请求，成本为零）
  if (!enabled) {
    return { pass: true, reason: '', reviewed: false };
  }
  try {
    // 模型构建复用 judge 生态的模式：'provider:model' id → buildModelConfig → createLLM。
    // 无 Key / 未知模型会在这里抛错，被下方 catch 捕获走 fail-open。
    const llm = createLLM(buildModelConfig(model, { isFCMode: false }));
    const userText = buildReviewPrompt(
      truncateForReview(params.question, QUESTION_MAX_CHARS),
      truncateForReview(params.answer, ANSWER_MAX_CHARS),
      (params.contexts ?? [])
        .slice(0, CONTEXT_MAX_COUNT)
        .map((c) => truncateForReview(c, CONTEXT_MAX_CHARS)),
    );
    // AbortSignal.timeout 真取消：审核模型挂起时到点中断，绝不拖住聊天主流程
    const response = await llm.invoke(
      [new SystemMessage(REVIEW_SYSTEM_PROMPT), new HumanMessage(userText)],
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const raw =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    const parsed = parseLlmJson<ReviewVerdict>(raw, ReviewVerdictSchema, {
      module: 'OutputReview',
    });
    if (!parsed.success) {
      logger.warn('输出自检：审核结果解析失败，fail-open 放行', {
        module: 'OutputReview',
        reason: parsed.reason,
      });
      return { pass: true, reason: '', reviewed: false, model };
    }
    logger.info('输出自检：审核完成', {
      module: 'OutputReview',
      model,
      pass: parsed.data.pass,
      reason: parsed.data.reason,
      answerLength: params.answer.length,
    });
    return {
      pass: parsed.data.pass,
      reason: parsed.data.reason,
      reviewed: true,
      model,
    };
  } catch (e) {
    // 无 Key / 超时 / 模型抛错等一切异常：放行 + 留痕，绝不阻塞用户
    logger.warn('输出自检：审核调用失败，fail-open 放行', {
      module: 'OutputReview',
      model,
      error: (e as Error).message,
    });
    return { pass: true, reason: '', reviewed: false };
  }
}
