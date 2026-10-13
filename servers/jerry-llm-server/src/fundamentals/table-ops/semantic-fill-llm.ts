/**
 * fundamentals/table-ops/semantic-fill-llm.ts
 *
 * 语义填充（功能 4）的 LLM 调用层：映射推断 + 分批逐行推断。
 *
 * 双路径兜底（与 parse.ts 同款，工程规范 7.2：LLM 结构化输出必须可观察降级）：
 *   1. 主路径：withStructuredOutput(zodSchema, {method:'functionCalling'})；
 *   2. 兜底路径：普通 invoke + 强约束提示词 + extractJsonText + zod safeParse。
 *
 * 两条路径都失败 → 抛错给上层（service 转任务失败/结构化错误），绝不静默吞掉。
 * LLM 只拿"去重值样本/批内行摘要"，不接触全表数据——省 token 且大表不怕。
 */

import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  buildModelConfig,
  createRateLimitedLLM,
  getCurrentModelId,
} from '../model-provider.js';
import { extractJsonText } from '../llm-json-parser.js';
import { logger } from '../logger.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import {
  FillMappingOutputSchema,
  BatchFillOutputSchema,
  FillRuleSuggestionSchema,
  type FillMappingOutput,
  type BatchFillOutput,
  type FillRuleSuggestion,
  type FillGapStats,
  MAX_MAPPING_ENTRIES,
} from './semantic-fill.js';

/** 映射推断的完整输出：映射 + 可选规则建议 */
const MappingInferOutputSchema = FillMappingOutputSchema.extend({
  suggestRule: FillRuleSuggestionSchema.optional().describe(
    '仅当填充规律非常稳定（如依据列取值固定就那几种）时给出：把依据列取值白名单提议存为规则，防止未来数据超出规律',
  ),
});
type MappingInferOutput = z.infer<typeof MappingInferOutputSchema>;

/**
 * "该模型不支持强制结构化输出"的进程级记忆（与 parse.ts 同款，独立记忆互不干扰）：
 * thinking 模型拒绝 tool_choice、部分兼容端点拒绝 json_schema——命中后同模型直接走兜底。
 */
let structuredOutputUnavailableModelId: string | null = null;

/** 递归把 JSON 里的 number/boolean 值转为字符串（兜底路径宽松化预处理） */
function stringifyPrimitives(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyPrimitives);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stringifyPrimitives(v);
    }
    return out;
  }
  return value;
}

/** 兜底路径通用 JSON 抽取 + zod 校验；两个输出 schema 的别名探测略有差异 */
async function invokeWithFallback<T extends z.ZodTypeAny>(
  llm: BaseChatModel,
  messages: BaseMessage[],
  schema: T,
  module: string,
  aliasKeys: string[],
): Promise<z.infer<T>> {
  const fallbackMessages: BaseMessage[] = [
    ...messages,
    new HumanMessage('请严格只输出一个 JSON 对象，不要任何解释、markdown 围栏或多余文字。'),
  ];
  const raw = await llm.invoke(fallbackMessages);
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
    throw new Error('AI 未返回有效 JSON，请重试');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    logger.error('语义填充兜底路径 JSON.parse 失败', { module, rawLength: rawText.length });
    throw new Error('AI 返回的格式异常，请重试');
  }

  // 容错提取：按别名探测主数组字段（部分模型不守约定）
  let payloadRaw: unknown = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const key of aliasKeys) {
      if (Array.isArray(obj[key])) {
        payloadRaw = { ...obj, [aliasKeys[0]]: obj[key] };
        break;
      }
    }
  }

  const normalized = stringifyPrimitives(payloadRaw);
  const result = schema.safeParse(normalized);
  if (!result.success) {
    const issueDesc = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    logger.warn('语义填充兜底路径 zod 校验失败', { module, issues: issueDesc.slice(0, 300) });
    throw new Error(`AI 返回的填充结果不合法（${issueDesc.slice(0, 120)}），请重试`);
  }
  return result.data as z.infer<T>;
}

/**
 * 路径 1：去重映射推断——LLM 只推断去重值，代码映射刷全表。
 *
 * @returns 映射清单 + 可选规则建议（AI 提议，用户确认后才入库）
 * @throws Error 主/兜底路径都失败时抛出（message 面向用户）
 */
export async function inferFillMapping(
  stats: FillGapStats,
  instruction: string,
): Promise<FillMappingOutput & { suggestRule?: FillRuleSuggestion }> {
  const modelId = getCurrentModelId();
  const modelConfig = buildModelConfig(modelId);
  modelConfig.temperature = 0;
  const llm: BaseChatModel = createRateLimitedLLM(modelConfig, 'fast');

  // 去重值 + 一行样本上下文（LLM 靠样本里的其他列推断）
  const valueLines = stats.distinctBasisValues
    .map((v) => `- ${v}（样本：${stats.rowSamples.get(v) ?? '（无样本）'}）`)
    .join('\n');

  const systemPrompt = `你是表格数据填充助手。表格中「${stats.targetColumn}」列有 ${stats.emptyRowIndexes.length} 个空缺，这些行的依据列取值去重后共 ${stats.distinctCount} 种。请根据每个依据值的样本信息推断其对应的「${stats.targetColumn}」填充值。

用户意图：${instruction || `补全「${stats.targetColumn}」列的空缺`}

要求：
- 每个依据值都必须给出填充值，一个都不能漏（to 不能为空）
- 填充值应与表格中该列已有的取值风格一致（如已有"华南/华北"就用同类词）
- 推断不出时给出最合理的猜测，不要留空
- ${stats.hintColumns.join('、')} 是可用的参考信息列

输出 JSON：{"mapping":[{"from":"依据值","to":"填充值"}]${stats.distinctCount <= 20 ? ',"suggestRule":{"name":"规则名","column":"依据列名","values":["取值1","取值2"]}' : ''}}
${stats.distinctCount <= 20 ? '若填充规律非常稳定（依据列取值就固定这几种），可额外给 suggestRule 提议把取值白名单存为校验规则；拿不准就省略该字段。' : '取值种类较多，不要输出 suggestRule。'}`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`去重值清单（共 ${stats.distinctCount} 个）：\n${valueLines}`),
  ];

  // 主路径
  if (structuredOutputUnavailableModelId !== modelId) {
    try {
      const structured = llm.withStructuredOutput(MappingInferOutputSchema, {
        method: 'functionCalling',
      });
      const result = await structured.invoke(messages);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/response_format|tool_choice|Thinking mode/i.test(msg)) {
        structuredOutputUnavailableModelId = modelId;
        logger.warn('当前模型不支持强制结构化输出，语义填充改走提示词抽取路径', {
          module: 'SemanticFillLlm',
          modelId,
          error: msg,
        });
      } else {
        logger.warn('语义填充映射推断 withStructuredOutput 失败，降级为提示词抽取路径', {
          module: 'SemanticFillLlm',
          error: msg,
        });
      }
    }
  }

  // 兜底路径
  return invokeWithFallback(llm, messages, MappingInferOutputSchema, 'SemanticFillLlm', [
    'mapping',
    'items',
    'pairs',
  ]);
}

/**
 * 路径 2 单批：批内逐行推断填充值。
 *
 * @returns 批内每行的填充值（校验由调用方做：缺行即整批失败）
 * @throws Error 该批 LLM 调用/校验失败（任务编排层批判为失败）
 */
export async function inferBatchFill(
  batchRowsText: string,
  targetColumn: string,
  batchRowCount: number,
  instruction: string,
): Promise<BatchFillOutput> {
  const modelId = getCurrentModelId();
  const modelConfig = buildModelConfig(modelId);
  modelConfig.temperature = 0;
  const llm: BaseChatModel = createRateLimitedLLM(modelConfig, 'fast');

  const systemPrompt = `你是表格数据填充助手。下面给出 ${batchRowCount} 行数据，每行的「${targetColumn}」列为空，需要你根据行内其他列的信息推断填充值。

用户意图：${instruction || `补全「${targetColumn}」列的空缺`}

要求：
- 每一行都必须给出填充值，一个都不能漏（共 ${batchRowCount} 行 → fills 数组必须正好 ${batchRowCount} 项）
- row 字段填输入中"第 N 行"的 N
- 填充值应与该列已有取值风格一致
- 推断不出时给出最合理的猜测，不要留空

输出 JSON：{"fills":[{"row":行号,"value":"填充值"}]}`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(batchRowsText),
  ];

  if (structuredOutputUnavailableModelId !== modelId) {
    try {
      const structured = llm.withStructuredOutput(BatchFillOutputSchema, {
        method: 'functionCalling',
      });
      return await structured.invoke(messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/response_format|tool_choice|Thinking mode/i.test(msg)) {
        structuredOutputUnavailableModelId = modelId;
        logger.warn('当前模型不支持强制结构化输出，语义填充批处理改走提示词抽取路径', {
          module: 'SemanticFillLlm',
          modelId,
          error: msg,
        });
      } else {
        logger.warn('语义填充批处理 withStructuredOutput 失败，降级为提示词抽取路径', {
          module: 'SemanticFillLlm',
          error: msg,
        });
      }
    }
  }

  return invokeWithFallback(llm, messages, BatchFillOutputSchema, 'SemanticFillLlm', [
    'fills',
    'results',
    'values',
  ]);
}

/** 导出映射条目上限（service 引用，避免跨文件私有常量） */
export { MAX_MAPPING_ENTRIES };
