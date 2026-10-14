/**
 * fundamentals/table-ops/rules-suggest.ts
 *
 * AI 看列级统计提议表格规则（功能 5"规则来源"之一）。
 *
 * 关键约束（方案原文）：AI 只"提议"——返回候选规则列表，由用户在规则面板
 * 确认后才入库（source='ai'），绝不静默生成。本模块不接触数据库。
 *
 * 双路径兜底与 parse.ts 同款（工程规范 7.2：结构化输出必须可观察降级）：
 *   1. 主路径：withStructuredOutput（function calling）；
 *   2. 兜底路径：普通 invoke + extractJsonText + zod safeParse。
 * 两条路径都失败 → 抛错给上层转结构化错误响应，绝不静默吞掉。
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  buildModelConfig,
  createRateLimitedLLM,
  getCurrentModelId,
  getModelCapabilities,
} from '../model-provider.js';
import { extractJsonText } from '../llm-json-parser.js';
import { logger } from '../logger.js';
import { TableRuleSchema, columnStatsToOverview } from './rules.js';
import type { SheetColumnStats, TableRuleInput } from './rules.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * "该模型不支持强制结构化输出"的进程级记忆（与 parse.ts 同款）：
 * thinking 模型拒绝 tool_choice——运行时命中后同模型直接走兜底，
 * 避免每次提议都白打一轮注定失败的 400。
 */
let structuredOutputUnavailableModelId: string | null = null;

/** 提议的系统提示词（主/兜底路径共用） */
const SUGGEST_PROMPT = `你是表格数据治理助手。根据表格的列级统计（空值率、去重值、数值分布），提议最多 8 条数据质量规则，输出 JSON 对象 {"rules":[...]}。

可用规则类型（params 结构必须严格一致）：
- 非空：{"type":"notEmpty","params":{"column":"列名"}}——适合主键/名称类几乎不空的列
- 取值白名单：{"type":"allowedValues","params":{"column":"列名","values":["值1","值2"]}}——适合去重值少且稳定的分类列
- 数值范围：{"type":"numericRange","params":{"column":"列名","min":0,"max":1000000}}——适合数值分布集中的数量/金额列
- 唯一性：{"type":"unique","params":{"column":"列名"}}——适合序号/编号类列
- 跨列公式：{"type":"formula","params":{"targetColumn":"结果列","expression":"[列A]*[列B]"}}——仅当列名暗示明显乘除关系（如 销售额=数量×单价）时提议

可选修复动作 fixAction（只提议修复明确安全的规则；不确定就省略，规则只标记不修复）：
- {"kind":"fixedValue","value":"固定值"}——仅当违规应统一改成一个明确值
- {"kind":"formula","expression":"[列A]*[列B]"}——仅当公式规则本身就能重算
- {"kind":"deleteRow"}——仅当违规行明显是垃圾数据

规则：
- name 用简短中文（如"区域不能留空"）
- 只提议有统计依据的规则，宁缺毋滥；没有把握一条都不提就返回 {"rules":[]}
- 列名必须从统计中逐字选取，不要编造
- 数值范围的 min/max 参考统计给出的分布并留合理余量
- targetSheet 必须填该列所在工作表的名称（逐字取自统计里"工作表「××」"的名字）；统计只有一个工作表时可省略该字段`;

/** LLM 产出包裹 schema：{"rules":[...]} */
const SuggestPlanSchema = z.object({
  rules: z.array(TableRuleSchema).max(10).describe('提议的规则列表'),
});
type SuggestPlan = z.infer<typeof SuggestPlanSchema>;

/** 递归把 JSON 里的 number/boolean 转字符串（仅 fixAction.fixedValue.value 是字符串字段）。
 * LLM 常把固定值输出成数字，预先宽松化再校验，比让用户重试体验好 */
function normalizeSuggestedRules(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSuggestedRules);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'value' && (typeof v === 'number' || typeof v === 'boolean')) {
        out[k] = String(v);
      } else {
        out[k] = normalizeSuggestedRules(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * 根据列级统计提议规则候选（不落库，用户确认后由 service 层入库）。
 *
 * @throws Error 主/兜底路径都失败时抛出（message 面向用户）
 */
export async function suggestRulesFromStats(
  stats: SheetColumnStats[],
): Promise<TableRuleInput[]> {
  const modelId = getCurrentModelId();
  const modelConfig = buildModelConfig(modelId);
  // 提议要稳定，温度 0 减少发散
  modelConfig.temperature = 0;
  const llm: BaseChatModel = createRateLimitedLLM(modelConfig, 'fast');

  const messages: BaseMessage[] = [
    new SystemMessage(SUGGEST_PROMPT),
    new HumanMessage(`列级统计：\n${columnStatsToOverview(stats)}`),
  ];

  // 主路径：function calling 结构化输出（jsonSchema 方法会被部分兼容端点拒绝，见 parse.ts 注释）。
  // 前置能力检查：静态标注不支持 tool_choice 的模型（如 thinking 模式）主路径必然
  // 撞 400，直接跳过走兜底——省一次注定失败的请求（能力探测可能测不出 thinking 限制）
  if (
    structuredOutputUnavailableModelId === modelId ||
    !getModelCapabilities(modelId).supportsToolChoice
  ) {
    logger.info('当前模型不支持强制结构化输出，规则提议直接走提示词抽取路径', {
      module: 'TableRulesSuggest',
      modelId,
    });
  } else {
    try {
      const structured = llm.withStructuredOutput(SuggestPlanSchema, { method: 'functionCalling' });
      const plan = await structured.invoke(messages);
      return plan.rules;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/response_format|tool_choice|Thinking mode/i.test(msg)) {
        structuredOutputUnavailableModelId = modelId;
        logger.warn('当前模型不支持强制结构化输出，规则提议后续直接走提示词抽取路径', {
          module: 'TableRulesSuggest',
          modelId,
          error: msg,
        });
      } else {
        logger.warn('规则提议 withStructuredOutput 失败，降级为提示词抽取路径', {
          module: 'TableRulesSuggest',
          modelId,
          error: msg,
        });
      }
    }
  }

  // 兜底路径：普通调用 + extractJsonText + zod safeParse
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
    throw new Error('AI 未能生成规则提议，请重试');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    logger.error('规则提议兜底路径 JSON.parse 失败', {
      module: 'TableRulesSuggest',
      rawLength: rawText.length,
    });
    throw new Error('AI 返回的提议格式异常，请重试');
  }

  // 容错提取 rules：部分模型会用 rules/suggestions 等别名，或直接返回裸数组
  let rulesRaw: unknown = undefined;
  if (Array.isArray(parsed)) {
    rulesRaw = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    rulesRaw = obj.rules;
    if (!Array.isArray(rulesRaw)) {
      for (const key of ['suggestions', 'items', 'tableRules']) {
        if (Array.isArray(obj[key])) {
          rulesRaw = obj[key];
          break;
        }
      }
    }
  }
  if (!Array.isArray(rulesRaw)) {
    throw new Error('AI 返回的提议格式异常，请重试');
  }

  const result = SuggestPlanSchema.safeParse({ rules: normalizeSuggestedRules(rulesRaw) });
  if (!result.success) {
    logger.warn('规则提议兜底路径 zod 校验失败', {
      module: 'TableRulesSuggest',
      issues: result.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    throw new Error('AI 提议的规则不合法，请重试');
  }
  return result.data.rules as TableRuleInput[];
}
