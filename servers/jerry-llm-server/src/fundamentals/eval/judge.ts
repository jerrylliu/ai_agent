/**
 * fundamentals/eval/judge.ts
 *
 * LLM Judge：回答质量三维评估（纯函数 + 可复用模块，benchmark 与未来在线抽样共用）
 *
 * 三个维度：
 *   - correctness   正确性：答案是否与 gold_answer / answer_facts 一致（含信息等价转述）
 *   - faithfulness  忠实度：答案中的每个论断是否都能在 contexts 中找到依据（幻觉检测）
 *   - relevance     切题度：答案是否回答了问题本身（答非所问检测）
 *
 * 设计决策：
 *   1. 走 parseLlmJson（regex 抽 JSON + zod safeParse）而非 withStructuredOutput——
 *      与 llm-json-parser.ts 的设计说明一致：兼容所有 LLM Provider（judge 可能用
 *      不支持 function calling 的本地模型，见 model-provider AVAILABLE_MODELS）；
 *   2. 纯函数无副作用：模型由调用方注入（BaseChatModel），本模块不做 provider 耦合；
 *   3. info_not_found 题型特殊处理：这类题 gold 期望「拒答」，contexts 也可能为空，
 *      judge prompt 单独分支判断「是否正确拒答」而不是强行对照 facts；
 *   4. 判分标准偏严：correctness 要求关键事实全部命中（缺关键事实 = false），
 *      与官方 harness 的 answer_correct 口径对齐，避免分数虚高。
 *
 * 关联：scripts/bench/run-judge.ts（批量 runner）、
 *       scripts/bench/compare-wiki-gate.ts（既有 judge 正确率口径的来源）。
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from '../logger.js';
import { parseLlmJson } from '../llm-json-parser.js';

// ==================== Zod Schema ====================

/** 单题三维判分结果（zod 推导，禁止另写 interface） */
export const JudgeVerdictSchema = z.object({
  /** 正确性：答案关键事实是否与 gold 一致 */
  answer_correct: z.boolean().describe('答案是否正确（关键事实与 gold 一致）'),
  /** 忠实度：答案是否完全基于给定上下文，无编造细节 */
  faithful: z.boolean().describe('答案是否完全由上下文支撑（无编造/幻觉细节）'),
  /** 切题度：答案是否回答了问题 */
  relevant: z.boolean().describe('答案是否切题（回答了问题而非答非所问）'),
  /** 忠实度违例明细：编造/无法追溯的具体句子（faithful=true 时为空数组） */
  unfaithful_claims: z
    .array(z.string())
    .describe('答案中编造或上下文无法支撑的具体句子，无则空数组'),
  /** 一句话判分理由（中文），落报告供人工抽查校准 */
  reason: z.string().describe('一句话判分理由'),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** 单题 judge 输入（answer + gold + contexts 的最小三元组） */
export interface JudgeInput {
  question: string;
  answer: string;
  /** gold 标准答案（可为空串：info_not_found 题型） */
  goldAnswer: string;
  /** gold 关键事实清单（可为空数组） */
  answerFacts: string[];
  /** 实际送入生成的检索上下文 */
  contexts: string[];
  /** 题型（info_not_found 走拒答判定分支） */
  questionType: string;
}

// ==================== Prompt ====================

/**
 * 三维判分 system prompt。
 *
 * 判分口径（与 compare-wiki-gate 既有 judge 一致并扩展三维）：
 *   - correctness：answer_facts 逐条对照，关键事实缺一即 false；表述不同但信息等价算对；
 *   - faithfulness：只看 contexts，不看 gold——答案里有 contexts 支撑不了的
 *     具体数字/日期/名称/结论即 false（泛化措辞不算编造）；
 *   - relevance：答案主体是否在回应问题（部分回答 + 大量跑题 = false）。
 */
const JUDGE_SYSTEM_PROMPT = `你是一个严格的 RAG 问答质量评审员。给定：问题、检索上下文（contexts）、gold 标准答案与关键事实、以及待评的模型答案。你需要输出三个维度的判定。

判定规则：

1. answer_correct（正确性）
   - 以 gold_answer 和 answer_facts 为准，逐条对照关键事实。
   - 表述不同但信息等价（同义转述、单位换算、粒度合并）算正确。
   - 关键事实缺一条、数字对不上、结论相反，判 false。
   - 如果 gold 要求"信息不存在/应拒答"，答案正确承认无信息算正确，编造答案判 false。

2. faithful（忠实度）
   - 只依据 contexts 判断，不参照 gold。
   - 答案中每个具体论断（数字、日期、人名、产品名、因果结论）都必须能在 contexts 中找到直接依据。
   - contexts 支撑不了的具体细节 = 编造，把该句原文放入 unfaithful_claims。
   - 模糊概括（如"该方案有一定效果"）在 contexts 无直接反证时不视为编造。
   - 完全基于上下文则 faithful=true，unfaithful_claims 为空数组。

3. relevant（切题度）
   - 答案主体是否在回答问题。答非所问、只回答了问题的一部分且其余部分跑题、问题问 A 答 B，判 false。

输出要求：只输出一个 JSON 对象，不要输出任何其他文字、注释或 markdown 围栏。格式：
{"answer_correct": true/false, "faithful": true/false, "relevant": true/false, "unfaithful_claims": ["编造的原句", ...], "reason": "一句话中文理由"}`;

/**
 * 在线模式专用判分说明（拼在 system prompt 尾部，仅 contextScope='online' 时生效）。
 *
 * 为什么在线要放宽口径（benchmark 保持严格）：
 *   在线 FC 主路径下，模型生成时可见的信息窗口大于本次检索 contexts——
 *   检索工具返回的元信息（文档清单、片段统计、文档日期）会进入模型上下文，
 *   但不会出现在 judge 拿到的 contexts 里。若按 benchmark 严格口径
 *   （"contexts 无依据 = 编造"），这些真实信息会被系统性误判为幻觉
 *   （典型：回答里描述"知识库共 N 个文档"被标编造，但知识库里确实有）。
 *   在线口径改为"可证伪才判编造"：只有与 contexts 矛盾、或对问题核心
 *   事实凭空捏造才判 false；知识库元结构/背景补充类描述不强制要求依据。
 */
const ONLINE_FAITHFULNESS_SUFFIX = `

【在线判分口径补充】你看到的 contexts 只是本次检索命中的片段，不是模型生成时的全部信息来源——模型还可能看到检索工具返回的元信息（文档清单、片段数量统计、文档整理日期等）。因此忠实度判定按以下规则放宽：
- 关于知识库/检索过程本身的元描述（文档构成、片段数、文档清单、整理时间等）：只要与 contexts 中出现的内容不矛盾，就不算编造，不放入 unfaithful_claims。
- 背景补充、常识性解释：无直接反证不算编造。
- 仍判编造（faithful=false）的情形：答案与 contexts 内容明确矛盾；或对问题核心事实凭空捏造（给出了具体数字/名称/结论，contexts 中毫无对应，且该信息是回答问题所必需）。`;

/**
 * info_not_found 专用判分说明（拼在 user 消息尾部，覆盖 correctness 口径）。
 * 这类题 gold_answer 为空、期望模型拒答，不能拿 facts 对照。
 */
const INFO_NOT_FOUND_SUFFIX = `

【本题特殊口径】这是一道"信息不存在"题：gold 不提供标准答案，正确行为是明确说明文档中没有相关信息。判定规则：
- answer_correct：答案明确表达了"未找到/无相关信息/无法确定"等拒答语义 → true；给出了具体编造答案 → false；长篇大论但明确指出信息缺失 → true。
- faithful：答案是否编造了具体细节。即使拒答正确，若夹带编造的"可能情况"细节，判 false 并摘录。
- relevant：答案是否针对"找这个信息"这件事本身回应。`;

// ==================== 单题判分 ====================

/** 判分可见窗口口径：benchmark=严格（contexts 即全部信息源）；online=豁免元信息（模型可见窗口大于 contexts） */
export type JudgeContextScope = 'benchmark' | 'online';

/**
 * 对单题执行三维判分。
 *
 * @param llm 判分用模型（调用方注入，纯函数无 provider 耦合）
 * @param input 题目 + 答案 + gold + contexts
 * @param options 可选项：
 *        - signal 传入 AbortSignal.timeout(ms) 做真取消（在线路径必须带，防挂起；benchmark 可省）
 *        - contextScope 判分口径（默认 'benchmark' 严格口径；在线评估传 'online' 启用元信息豁免，
 *          否则检索工具返回的文档清单/统计等真实元信息会被系统性误判为编造）
 * @returns 判分结果；解析失败返回 null（调用方计入 judgeError，不静默当对/错）
 */
export async function judgeOne(
  llm: BaseChatModel,
  input: JudgeInput,
  options?: { signal?: AbortSignal; contextScope?: JudgeContextScope },
): Promise<JudgeVerdict | null> {
  const contextBlock =
    input.contexts.length > 0
      ? input.contexts
          .map((c, i) => `--- context ${i + 1} ---\n${c}`)
          .join('\n\n')
      : '（无检索上下文）';

  const goldBlock = [
    input.goldAnswer ? `gold_answer: ${input.goldAnswer}` : null,
    input.answerFacts.length > 0
      ? `answer_facts:\n${input.answerFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const userText = `【问题】\n${input.question}\n\n【检索上下文】\n${contextBlock}\n\n【gold 参考】\n${goldBlock || '（无 gold）'}\n\n【待评答案】\n${input.answer}${input.questionType === 'info_not_found' ? INFO_NOT_FOUND_SUFFIX : ''}`;

  const systemText =
    options?.contextScope === 'online'
      ? JUDGE_SYSTEM_PROMPT + ONLINE_FAITHFULNESS_SUFFIX
      : JUDGE_SYSTEM_PROMPT;

  try {
    const response = await llm.invoke(
      [new SystemMessage(systemText), new HumanMessage(userText)],
      { signal: options?.signal },
    );
    const raw =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    const parsed = parseLlmJson<z.infer<typeof JudgeVerdictSchema>>(
      raw,
      JudgeVerdictSchema,
      {
        module: 'EvalJudge',
        questionType: input.questionType,
      },
    );
    if (!parsed.success) {
      logger.warn('judge 输出解析失败，计入 judgeError', {
        module: 'EvalJudge',
        reason: parsed.reason,
      });
      return null;
    }
    return parsed.data;
  } catch (e) {
    logger.error('judge 调用异常，计入 judgeError', {
      module: 'EvalJudge',
      error: (e as Error).message,
    });
    return null;
  }
}

// ==================== 聚合 ====================

/** 三维聚合统计（roundN 精度与 metrics.ts 一致，4 位小数） */
export interface JudgeAggregate {
  /** 成功判分的题数（解析失败/调用异常不计入分母） */
  judgedCount: number;
  /** 解析失败/调用异常题数 */
  judgeErrorCount: number;
  correctnessRate: number;
  faithfulnessRate: number;
  relevanceRate: number;
}

/**
 * 聚合一批判分结果为三维比率。
 * @param verdicts 成功判分结果（null 已由调用方过滤，仅传成功值）
 * @param totalInput 输入总数（含 judge 失败），用于计算 judgeErrorCount
 */
export function aggregateVerdicts(
  verdicts: JudgeVerdict[],
  totalInput: number,
): JudgeAggregate {
  const n = verdicts.length;
  const round = (v: number): number => Math.round(v * 10000) / 10000;
  return {
    judgedCount: n,
    judgeErrorCount: totalInput - n,
    correctnessRate:
      n === 0 ? 0 : round(verdicts.filter((v) => v.answer_correct).length / n),
    faithfulnessRate:
      n === 0 ? 0 : round(verdicts.filter((v) => v.faithful).length / n),
    relevanceRate:
      n === 0 ? 0 : round(verdicts.filter((v) => v.relevant).length / n),
  };
}
