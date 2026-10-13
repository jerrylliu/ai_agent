/**
 * fundamentals/table-ops/parse.ts
 *
 * 自然语言表格指令 → 结构化操作序列（LLM 调用层）。
 *
 * 双路径兜底（工程规范 7.2：LLM 结构化输出必须可观察降级）：
 *   1. 主路径：withStructuredOutput(zodSchema)——走 function calling，
 *      模型侧保证 JSON 合法（qwen/deepseek/zhipu 均支持）；
 *   2. 兜底路径：普通 invoke + 强约束提示词 + extractJsonText 抽取 +
 *      zod safeParse——覆盖不支持 function calling 的本地模型（Ollama 等）。
 *
 * 两条路径都失败 → 抛错给上层（service 转结构化错误响应），绝不静默吞掉。
 *
 * 注意：LLM 只拿到"表头 + 每列前 2 行样本"概览，不接触全表数据——
 * 一是省 token（大表也不怕），二是计算本来就不归 LLM 管。
 */

import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  buildModelConfig,
  createRateLimitedLLM,
  getCurrentModelId,
} from '../model-provider.js';
import { extractJsonText } from '../llm-json-parser.js';
import { logger } from '../logger.js';
import { TableOpsPlanSchema, type TableOp } from './schema.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/** 指令解析的系统提示词（主/兜底路径共用） */
const SYSTEM_PROMPT = `你是表格数据操作助手。根据用户指令和表格概览，把指令解析为结构化操作序列。

规则：
- 你只负责"理解意图"，不要做任何数字计算（求和/平均等由执行器精确完成）
- 列名必须从表格概览的表头中逐字选取，不要编造
- 条件比较值来自指令原文或样本值
- 一条指令可拆为多个操作，按执行顺序排列（如"删掉A列再按B列排序"→ 两个 op）
- 无法理解的指令返回空数组，不要猜测
- 聚合类指令（把...加起来/平均/计数）用 aggregateAppendRow，label 用简洁中文（如"合计"）`;

/**
 * 把自然语言指令解析为操作序列。
 *
 * @param instruction   用户自然语言指令（如"把销售员3号的所有销售额加起来加到新的一行"）
 * @param sheetOverview buildSheetOverview 产出的表格概览
 * @returns 操作序列（可能为空数组——表示指令无法理解，上层提示用户）
 * @throws Error 主/兜底路径都失败时抛出（message 面向用户）
 */
export async function parseTableOpsInstruction(
  instruction: string,
  sheetOverview: string,
): Promise<TableOp[]> {
  const modelConfig = buildModelConfig(getCurrentModelId());
  // 指令解析要稳定，温度 0 减少发散
  modelConfig.temperature = 0;
  const llm: BaseChatModel = createRateLimitedLLM(modelConfig, 'fast');

  const messages: BaseMessage[] = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(
      `表格概览：\n${sheetOverview}\n\n用户指令：${instruction}`,
    ),
  ];

  // 主路径：function calling 结构化输出
  try {
    const structured = llm.withStructuredOutput(TableOpsPlanSchema);
    const plan = await structured.invoke(messages);
    return plan.ops;
  } catch (err) {
    logger.warn('表格指令 withStructuredOutput 失败，降级为提示词抽取路径', {
      module: 'TableOpsParse',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 兜底路径：普通调用 + extractJsonText + zod safeParse
  const fallbackMessages: BaseMessage[] = [
    ...messages,
    new HumanMessage('请严格只输出一个 JSON 对象，不要任何解释、markdown 围栏或多余文字。'),
  ];
  const raw = await llm.invoke(fallbackMessages);
  // content 可能是 string，也可能是 content-block 数组（部分 provider 如
  // qwen/deepseek 在多模态消息结构下返回 [{type:'text',text:'...'}]）
  const rawContent: unknown = raw.content;
  const rawText =
    typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent
            .map((block) =>
              typeof block === 'object' && block !== null && 'text' in block
                ? String((block as { text: unknown }).text ?? '')
                : '',
            )
            .join('')
        : String(rawContent ?? '');

  const jsonText = extractJsonText(rawText);
  if (!jsonText) {
    throw new Error('AI 未能理解该指令，请换一种说法（例如明确写出列名）');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    logger.error('表格指令兜底路径 JSON.parse 失败', {
      module: 'TableOpsParse',
      rawLength: rawText.length,
    });
    throw new Error('AI 返回的指令格式异常，请重试或换一种说法');
  }

  const result = TableOpsPlanSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn('表格指令兜底路径 zod 校验失败', {
      module: 'TableOpsParse',
      issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    throw new Error('AI 解析出的操作不合法，请重试或换一种说法');
  }

  return result.data.ops;
}
