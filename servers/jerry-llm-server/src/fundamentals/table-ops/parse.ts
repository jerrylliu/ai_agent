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

/** 指令解析的系统提示词（主/兜底路径共用）。
 * 操作清单 + 输出示例直接内联——FC 路径靠 schema describe，兜底路径靠这段示例约束 JSON 形状 */
const SYSTEM_PROMPT = `你是表格数据操作助手。根据表格概览和用户指令，输出一个 JSON 对象 {"ops":[...]}，ops 为按执行顺序排列的操作。

可用操作（targetSheet 均可选，指定要操作的工作表）：
- appendRow: {"type":"appendRow","cells":{"列名":"值"}} 追加一行
- aggregateAppendRow: {"type":"aggregateAppendRow","column":"聚合列","fn":"sum|avg|count|min|max","label":"结果行标签","labelColumn?":"标签写入列","valueColumn?":"数值写入列","sourceSheet?":"来源工作表","where?":{"column":"列","op":"eq|ne|contains|gt|lt|gte|lte|empty|notEmpty","value":"比较值"},"beforeRow?":"插入到该行标签之前"} 聚合并插入新行（跨表聚合必填 sourceSheet；新行要插到"总计"行上方时填 beforeRow）
- aggregateUpdateCell: {"type":"aggregateUpdateCell","rowLabel":"目标行标签如总计","column":"写入列","fn":"...","sourceSheet?":"来源工作表","sourceColumn?":"来源列","where?":{...}} 把某行的单元格更新为聚合结果（省略 sourceSheet 时聚合同列目标行上方的所有行，用于重算总计）
- updateCells: {"type":"updateCells","targetColumn":"列","where?":{...},"newValue":"新值"} 条件更新
- deleteRows: {"type":"deleteRows","where":{...}} 条件删行
- deleteColumn: {"type":"deleteColumn","column":"列"} / addColumn: {"type":"addColumn","header":"新列名","value?":"固定值"}
- sortRows: {"type":"sortRows","column":"列","order":"asc|desc"} / renameColumn: {"type":"renameColumn","from":"旧名","to":"新名"}

规则：
- 你只负责"理解意图"，绝对不要做任何数字计算（求和/平均等由执行器精确完成）
- 列名、工作表名、条件值必须从表格概览或指令原文中逐字选取，不要编造
- "把A表的某类数据汇总后加入B表并重算合计"的固定套路：先 aggregateAppendRow（sourceSheet=A表，targetSheet=B表，beforeRow 填合计行标签），再 aggregateUpdateCell（targetSheet=B表，rowLabel=合计行标签）重算合计
- 无法理解的指令返回 {"ops":[]}，不要猜测

输出示例：{"ops":[{"type":"aggregateAppendRow","targetSheet":"汇总","sourceSheet":"大表压力测试","column":"销售额","where":{"column":"备注","op":"eq","value":"重点客户"},"fn":"sum","label":"重点客户合计","valueColumn":"金额小计","beforeRow":"总计"},{"type":"aggregateUpdateCell","targetSheet":"汇总","rowLabel":"总计","column":"金额小计","fn":"sum"}]}`;

/**
 * 端点不支持强制结构化输出的开关（进程级记忆）：
 *   - thinking 模型拒绝 tool_choice（"Thinking mode does not support this tool_choice"）
 *   - 部分兼容端点拒绝 response_format=json_schema（400）
 * 命中过一次后本进程内直接走兜底路径，避免每次指令都白打一轮 400。
 * 重启服务 / 切换模型后自动重试主路径。
 */
let structuredOutputUnavailable = false;

/** 递归把 JSON 里的 number/boolean 值转为字符串。
 * LLM 常把 "数量: 20" 输出成数字 20，而操作 schema 的值字段全为 string——
 * 预先宽松化再校验，比让用户重试体验好得多 */
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

  // 主路径：function calling 结构化输出。
  // 显式指定 method: 'functionCalling'——默认的 jsonSchema 方法会发
  // response_format=json_schema，zhipu 等兼容端点返回 400
  // "This response_format type is unavailable now"
  // 注意：thinking 模型的端点会拒绝 tool_choice（400），这类端点主路径
  // 必然失败——命中后置 structuredOutputUnavailable 跳过，直接走兜底
  if (!structuredOutputUnavailable) {
    try {
      const structured = llm.withStructuredOutput(TableOpsPlanSchema, { method: 'functionCalling' });
      const plan = await structured.invoke(messages);
      return plan.ops;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/response_format|tool_choice|Thinking mode/i.test(msg)) {
        structuredOutputUnavailable = true;
        logger.warn('端点不支持强制结构化输出，本进程内改走提示词抽取路径', {
          module: 'TableOpsParse',
          error: msg,
        });
      } else {
        logger.warn('表格指令 withStructuredOutput 失败，降级为提示词抽取路径', {
          module: 'TableOpsParse',
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

  // 容错提取 ops：部分模型不守约定，会用 operations/actions/steps 等别名，
  // 或直接返回裸数组——按常见命名依次探测
  let opsRaw: unknown = undefined;
  if (Array.isArray(parsed)) {
    opsRaw = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    opsRaw = obj.ops;
    if (!Array.isArray(opsRaw)) {
      for (const key of ['operations', 'actions', 'steps', 'tableOps']) {
        if (Array.isArray(obj[key])) {
          opsRaw = obj[key];
          break;
        }
      }
    }
  }

  // 宽松化预处理：数字/布尔 → 字符串（LLM 常把 "数量: 20" 输出成数字 20）
  const normalized = stringifyPrimitives(opsRaw ?? []);

  const result = TableOpsPlanSchema.safeParse({ ops: normalized });
  if (!result.success) {
    const issueDesc = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    logger.warn('表格指令兜底路径 zod 校验失败', {
      module: 'TableOpsParse',
      issues: issueDesc,
    });
    throw new Error(`AI 解析出的操作不合法（${issueDesc.slice(0, 120)}），请重试或换一种说法`);
  }

  return result.data.ops;
}
