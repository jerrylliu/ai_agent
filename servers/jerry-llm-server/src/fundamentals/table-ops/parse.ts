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
 * 注意：LLM 只拿到"框线表格（表头 + 前 2 行样本）+ 取值示例 + 空缺统计"概览，
 * 不接触全表数据——一是省 token（大表也不怕），二是计算本来就不归 LLM 管。
 */

import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  buildModelConfig,
  createRateLimitedLLM,
  getCurrentModelId,
  getModelCapabilities,
} from '../model-provider.js';
import { extractJsonText } from '../llm-json-parser.js';
import { logger } from '../logger.js';
import { TableOpsPlanSchema, type TableOp, type ClarifyHint } from './schema.js';
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
- setTotalRows: {"type":"setTotalRows","rows":[N1,N2]} 标记汇总行（总计/合计/小计等聚合结果行）；rows 填行号数组（按含说明行的完整行序从 1 数起），空数组 [] 表示清除全部汇总行标记
- groupCreateSheet: {"type":"groupCreateSheet","groupBy":"分组列","valueColumn":"统计列","fn":"sum|avg|count|min|max","resultLabel?":"结果列名","newSheetName":"新工作表名","sourceSheet?":"来源工作表","where?":{...}} 按 groupBy 分组统计 valueColumn，结果写入一张新工作表（每行 = 分组值 + 统计值，末尾自动带总计行；"按XX统计/分组汇总做出一张新表"用这个）。同名工作表会被就地重建，重复执行不会产生重复表——用户再次要求同样的统计时也要输出此操作，不要因为结果表已存在就不输出
- deriveColumn: {"type":"deriveColumn","targetColumn":"目标列","expression":"算术表达式","where?":{...}} 用表达式逐行计算填入目标列。表达式只支持数字、[列名] 引用和 + - * / ( )（如 "[数量]*[单价]"、"[销售额]/[数量]"）；目标列已存在则覆盖匹配行的值，不存在则新增该列；某行无法计算（非数字/除零）时自动跳过保留原值
- semanticFill: {"type":"semanticFill","targetColumn":"要填充的列","hintColumns?":["依据列1","依据列2"]} 语义填充——把目标列的空缺单元格按依据列取值的对应关系推断补全（"把区域列的空缺按城市补全"、"根据门店名填充负责人"用这个）；hintColumns 填用于推断依据的列（从表头逐字选取，省略时自动选）。注意：语义填充必须单独一条指令，不能与其他操作同时输出；汇总行（概览已声明的"汇总行"）的空缺自动排除，不会被填充。系统会先向用户确认填充策略（跨表关联/AI 映射/固定值/保留空缺）再执行
- lookupFill: {"type":"lookupFill","targetColumn":"目标列","sourceSheet":"来源工作表","sourceKeyColumn":"来源表键列","sourceValueColumn":"来源表取值列","targetKeyColumn?":"目标表键列"} 跨表关联填充——按关联键从来源表精确查值，填入目标列的空格（键精确匹配、未命中留空、不覆盖已有值，绝不发明值）；"把B表的新列/空列按A表对应数据补充/关联进来"用这个。targetKeyColumn/sourceKeyColumn 不确定就填最可能的同名键（系统会校验重合率并在可疑时转用户确认）；目标列不存在时先在前一个操作输出 addColumn 建列
- fillConstant: {"type":"fillConstant","targetColumn":"列","value":"固定值"} 把目标列的全部空格统一填为固定值（只填空格不覆盖已有值，汇总行自动跳过）；"把某列空缺统一填成XX"用这个

条件 where 支持两种写法（单条件直接写对象；"同时满足/且"或"任一满足/或"的复合条件用 conditions 数组，1~5 个）：
- 单条件：{"column":"列","op":"eq|ne|contains|gt|lt|gte|lte","value":"比较值"}（比较类必须带 value）；为空/不为空用 {"column":"列","op":"empty"} 或 {"column":"列","op":"notEmpty"}（不需要 value）
- 组合条件：{"mode":"and|or","conditions":[{"column":"列1","op":"...","value":"..."},{"column":"列2","op":"...","value":"..."}]}

规则：
- 你只负责"理解意图"，绝对不要做任何数字计算（求和/平均/表达式求值等由执行器精确完成）
- 列名、工作表名、条件值必须从表格概览或指令原文中逐字选取，不要编造
- 反问协议：操作的关键参数存在数据依赖不明（填充来源/取值依据、跨表关联键、更新条件、公式影响范围、大范围删除）时，绝不猜测具体取值。优先输出你最有把握的操作（如 lookupFill 带你推断的关联键），系统会自动校验参数完备性并在需要时转给用户确认；只有当连操作都无法成形时才返回 {"ops":[],"needsClarify":{"kind":"fill-source|join-key|condition|aggregate-scope|formula-preview|destructive-preview","question":"一句中文说明缺什么、要确认什么"}}——question 不要附带选项内容（选项由系统生成）
- "把A表的某类数据汇总后加入B表并重算合计"的固定套路：先 aggregateAppendRow（sourceSheet=A表，targetSheet=B表，beforeRow 填合计行标签），再 aggregateUpdateCell（targetSheet=B表，rowLabel=合计行标签）重算合计
- "按XX分类统计做成新表"固定用 groupCreateSheet，不要用多条 aggregateAppendRow 拼凑
- 语义填充（semanticFill）只能单独输出一个操作，绝不能与任何其他操作出现在同一个 ops 数组里
- semanticFill 的 targetColumn 填"列名"（从表头逐字选），不是工作表名；要指定填充哪张工作表用 targetSheet 字段（省略 = 第一个工作表）
- 跨表填充（如"把 A 表的空缺按 B 表的内容补上"）：targetSheet=A 表名、referenceSheet=B 表名、hintColumns 填 A 表中在 B 表也有同名列的对照列（如两表共有的"产品"列）；指令没有明确列名时，targetColumn 选空缺统计中最能用参照表对照推断的那一列（一次填一列，其余空缺列提示用户再发指令）
- 指令里的背景陈述不是操作请求："由于/因为 XX 已发生变动/已完成"只是交代前提，绝不为它输出操作（尤其"XX的单价/数量发生变动"≠"请修改源表的值"——用户没给新值时，猜一个写进去是数据损坏）；只执行用户真正要求的动作
- "重新计算/重算 表A 的相关值（因源表数据变动）"类指令：重算目标是表A本身，绝不因此修改源数据表。对表A中受影响的汇总行逐个输出 aggregateUpdateCell：targetSheet=表A、rowLabel=该行第一列标签、column=表A中要重算的列、fn=sum、sourceSheet=源数据表、sourceColumn=源表中对应的数值列（两表列名不同时必须填，如源表「金额」对应表A「金额小计」）、where 用源表中与该行标签对应的分类列过滤（分类列名与取值从概览取值示例对照）；表A末行的 总计/合计 行也要重算（可用省略 sourceSheet 的同列上方求和形态）
- 概览首行若注明"表头在第 N 行，上方为说明行"，说明该表是报表式布局：上方说明行（标题/日期范围等）不是数据，不参与填充/条件/规则，其旁的空缺也不计入"空缺单元格"统计
- 用户说"表头在第 N 行 / 真正的列名在第 N 行 / 把第 N 行设为表头"时，输出 setHeaderRow 操作（headerRow 填 N，按含说明行的完整行序从 1 数起；N=1 表示恢复首行为表头）
- 用户说"把第 N 行标记为汇总行 / 第 N 行是合计行 / 取消汇总行标记"时，输出 setTotalRows 操作（rows 填 [N]，N 按含说明行的完整行序从 1 数起；取消标记时 rows 填 []）
- 概览中"汇总行：第 N 行（总计）"是该表聚合结果行的权威声明：填充/条件更新/规则校验已自动跳过该行（它不是明细数据），不要对这些行的明细列做空缺填充——补全其数值用 aggregateUpdateCell 重算
- 概览中"空缺单元格：列=N格（位于行：…）"是该列空单元格数与其所在行的权威统计（样本行空格显示 ∅，仅供目视；以这行统计为准）；用户要求"补上缺失值/填充空白/补空"且目标列显示有空缺时，必须输出对应操作（semanticFill 或带 empty 条件的操作），绝不以"没有空值"为由返回空；唯一例外见下条
- 报表式表格（数据上方有标题行、日期范围行，如"2026-10-01 ~ 2026-10-11"）中，标题/日期行旁的空单元格是刻意留白（合并单元格效果），不是缺失数据，不要对它们填充（表头已锚定时说明行已自动排除在数据外；未锚定时用户可直接说"把第 N 行设为表头"根治）。空缺统计的"位于行：…"标注了每处空缺所在行，据此区分：汇总行（概览已声明"汇总行：第 N 行"的行，通常为总计/合计/小计标签）的空缺是**真实缺失**（汇总值本来就该有值），不是刻意留白——用户要求补全时，数值列用 aggregateUpdateCell（rowLabel=该行标签、column=空缺列、fn=sum，自动对上方数据行求和）重算填充。仅当"位于行"显示全部空缺都来自标题/日期行等说明行时，才输出 noop 操作并在 reason 说明；仍有真实空缺时照常填充（semanticFill 无法按行跳过刻意留白，其提议会列在确认卡中由用户把关，报告里说明标题行的填充项可放弃）
- 用户明确要求执行操作时必须输出对应操作，即使目标工作表/列已存在（同名工作表就地重建、已有列直接覆盖，都是期望行为）——绝不因为"看起来已经做过了"就不输出操作
- 指令引用的列/工作表在概览中确实不存在时，如实返回 {"ops":[]}（不要编造列名或操作）；除此之外一律必须输出操作

输出示例：{"ops":[{"type":"aggregateAppendRow","targetSheet":"汇总","sourceSheet":"大表压力测试","column":"销售额","where":{"column":"备注","op":"eq","value":"重点客户"},"fn":"sum","label":"重点客户合计","valueColumn":"金额小计","beforeRow":"总计"},{"type":"aggregateUpdateCell","targetSheet":"汇总","rowLabel":"总计","column":"金额小计","fn":"sum"}]}
无操作场景输出：{"ops":[{"type":"noop","targetSheet":"销售汇总报告","reason":"唯一的空缺是日期范围行旁的刻意留白（报表式布局），无需填充"}]}
参数不明需反问的输出示例：{"ops":[],"needsClarify":{"kind":"join-key","question":"请确认按哪一列把表1的数据关联到表二"}}`;

/**
 * 空 ops 纠正反馈（自动重试一次用）。
 * 空 ops 多数是模型误判"看起来已经做过了/没看清"，真正无法执行的指令极少——
 * 带反馈重试一次能救回大部分误判；重试后仍为空才判定"无需执行"。
 */
const EMPTY_OPS_RETRY_FEEDBACK = `你上一轮返回了 {"ops":[]}，这很可能是误判。请重新检查用户指令：
- 用户明确要求执行操作（统计/分组/填充/修改/删除等）时，必须输出对应操作——即使目标工作表已存在（同名工作表会被就地重建，这是期望行为）
- 如果表格确实无需修改（如唯一的空缺是标题/日期行旁的刻意留白），输出 noop 操作并在 reason 里说明原因，而不是返回空 ops；注意总计/合计行的空缺是真实缺失，不算刻意留白
- 如果指令的关键参数（填充来源、关联键、更新条件等）确实不明确，输出 {"ops":[],"needsClarify":{"kind":"fill-source|join-key|condition|aggregate-scope|formula-preview|destructive-preview","question":"缺什么"}} 让用户确认，而不是编造参数
- 只有指令引用的列/工作表在表格概览中确实不存在时，才允许返回 {"ops":[]}
请重新输出 JSON 对象 {"ops":[...]}（需反问时 {"ops":[],"needsClarify":{...}}）。`;

/** 校验失败纠正反馈（自动重试一次用）：把 zod 校验明细直接回喂给模型修正 */
const INVALID_OPS_RETRY_FEEDBACK = (issues: string) => `你上一轮输出的 JSON 未通过校验：${issues.slice(0, 200)}。
常见原因与修正方式：
- empty/notEmpty 条件不需要 value 字段；比较条件（eq/ne/contains/gt/lt/gte/lte）必须带 value
- 操作 type 必须是清单里逐字列出的类型之一；列名/工作表名必须与表格概览逐字一致
请修正后重新输出 JSON 对象 {"ops":[...]}，不要输出任何解释。`;

/** 单轮解析结果：ok 成功（ops 或 needsClarify 反问）/ empty 模型空手而归（视为误判，可纠正）/ invalid 校验失败（可纠正） */
type ParseAttempt =
  | { kind: 'ok'; ops: TableOp[]; needsClarify?: ClarifyHint }
  | { kind: 'empty' }
  | { kind: 'invalid'; issues: string };

/**
 * "该模型不支持强制结构化输出"的进程级记忆（按模型 ID 区分）：
 *   - thinking 模型拒绝 tool_choice（"Thinking mode does not support this tool_choice"）
 *   - 部分兼容端点拒绝 response_format=json_schema（400）
 * 命中后同一模型直接走兜底路径，避免每次指令都白打一轮 400；
 * 运行时切换到其他模型（如换智谱标准版）会自动重试主路径——
 * 思考型不通的模型，标准型可能就通。
 */
let structuredOutputUnavailableModelId: string | null = null;

/** 是否已标记该模型不支持强制结构化输出（进程级记忆，parse / react 两处结构化调用共用） */
export function isStructuredOutputUnavailable(modelId: string): boolean {
  return structuredOutputUnavailableModelId === modelId;
}

/** 标记该模型不支持强制结构化输出（结构化调用命中 tool_choice/response_format 类 400 时调用） */
export function markStructuredOutputUnavailable(modelId: string): void {
  structuredOutputUnavailableModelId = modelId;
}

/** 递归把 JSON 里的 number/boolean/null 值转为字符串。
 * LLM 常把 "数量: 20" 输出成数字 20、把无值字段写成 null，而操作 schema 的值
 * 字段全为 string——预先宽松化再校验，比让用户重试体验好得多 */
function stringifyPrimitives(value: unknown): unknown {
  if (value === null) return '';
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
 * 把自然语言指令解析为操作序列（或反问请求）。
 *
 * @param instruction   用户自然语言指令（如"把销售员3号的所有销售额加起来加到新的一行"）
 * @param sheetOverview buildSheetOverview 产出的表格概览
 * @returns ops 操作序列（可能为空数组——表示指令无法理解或需反问，看 needsClarify）；
 *          needsClarify 非空时 ops 必为空——指令的关键参数存在数据依赖不明，
 *          上层应向用户反问（clarify 协议），不得猜测执行
 * @throws Error 主/兜底路径都失败时抛出（message 面向用户）
 */
export async function parseTableOpsInstruction(
  instruction: string,
  sheetOverview: string,
): Promise<{ ops: TableOp[]; needsClarify?: ClarifyHint }> {
  const modelId = getCurrentModelId();
  const modelConfig = buildModelConfig(modelId);
  // 指令解析要稳定，温度 0 减少发散
  modelConfig.temperature = 0;
  const llm: BaseChatModel = createRateLimitedLLM(modelConfig, 'fast');

  const messages: BaseMessage[] = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(
      `表格概览：\n${sheetOverview}\n\n用户指令：${instruction}`,
    ),
  ];

  /**
   * 单次完整请求（主路径 FC → 失败/不可用转兜底文本抽取）。
   * 返回结果态而非抛错——空/校验失败都视为"可纠正"，由外层统一编排重问。
   */
  const requestOps = async (roundMessages: BaseMessage[]): Promise<ParseAttempt> => {
    // 主路径：function calling 结构化输出。
    // 显式指定 method: 'functionCalling'——默认的 jsonSchema 方法会发
    // response_format=json_schema，zhipu 等兼容端点返回 400
    // "This response_format type is unavailable now"
    // 前置能力检查：静态标注不支持 tool_choice 的模型（thinking 模式端点会拒绝
    // tool_choice 返回 400）主路径必然失败，直接跳过走兜底（能力探测可能测不出
    // thinking 限制）；运行时命中后另有按模型 ID 的进程级记忆
    if (
      structuredOutputUnavailableModelId === modelId ||
      !getModelCapabilities(modelId).supportsToolChoice
    ) {
      logger.info('当前模型不支持强制结构化输出，指令解析直接走提示词抽取路径', {
        module: 'TableOpsParse',
        modelId,
      });
    } else {
      try {
        const structured = llm.withStructuredOutput(TableOpsPlanSchema, {
          method: 'functionCalling',
        });
        const plan = await structured.invoke(roundMessages);
        // 契约：needsClarify（参数不明需反问）合法且优先——此时 ops 可为空，不算误判
        if (plan.needsClarify) {
          return { kind: 'ok', ops: plan.ops ?? [], needsClarify: plan.needsClarify };
        }
        // 裸空 ops 不是合法解析结果——返回 empty 态，由外层统一纠正重问
        if (!plan.ops || plan.ops.length === 0) return { kind: 'empty' };
        return { kind: 'ok', ops: plan.ops };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/response_format|tool_choice|Thinking mode/i.test(msg)) {
          structuredOutputUnavailableModelId = modelId;
          logger.warn('当前模型不支持强制结构化输出，后续指令直接走提示词抽取路径', {
            module: 'TableOpsParse',
            modelId,
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
      ...roundMessages,
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
    let needsClarifyRaw: unknown = undefined;
    if (Array.isArray(parsed)) {
      opsRaw = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      opsRaw = obj.ops;
      needsClarifyRaw = obj.needsClarify;
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

    // 契约：裸空 ops 不是合法解析结果——在 safeParse 前早退（schema 会把空
    // 数组判成校验错误，那会伪装成"格式异常"绕过纠正重问），交外层统一纠正重问；
    // 带 needsClarify 的空 ops 是合法反问，不算 empty
    if (
      Array.isArray(normalized) &&
      normalized.length === 0 &&
      needsClarifyRaw === undefined
    ) {
      return { kind: 'empty' };
    }

    const result = TableOpsPlanSchema.safeParse({
      ops: normalized,
      needsClarify: needsClarifyRaw,
    });
    if (!result.success) {
      const issueDesc = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      logger.warn('表格指令兜底路径 zod 校验失败', {
        module: 'TableOpsParse',
        issues: issueDesc,
      });
      // 返回 invalid 态而非抛错——校验失败多数可纠正（如 empty 条件误带/漏带
      // value），由外层把明细回喂给模型重问一次
      return { kind: 'invalid', issues: issueDesc };
    }

    return { kind: 'ok', ops: result.data.ops, needsClarify: result.data.needsClarify };
  };

  let attempt = await requestOps(messages);
  // 纠正重问协议：empty（模型误判"无需执行"）与 invalid（输出不合规）各带
  // 反馈自动重试一次——多数解析失败在这一层自愈，用户无感
  if (attempt.kind === 'empty') {
    logger.warn('表格指令解析出空操作，带纠正反馈自动重试一次', {
      module: 'TableOpsParse',
      modelId,
      instruction: instruction.slice(0, 200),
    });
    attempt = await requestOps([...messages, new HumanMessage(EMPTY_OPS_RETRY_FEEDBACK)]);
  } else if (attempt.kind === 'invalid') {
    logger.warn('表格指令解析结果校验失败，带纠正反馈自动重试一次', {
      module: 'TableOpsParse',
      modelId,
      issues: attempt.issues,
      instruction: instruction.slice(0, 200),
    });
    attempt = await requestOps([
      ...messages,
      new HumanMessage(INVALID_OPS_RETRY_FEEDBACK(attempt.issues)),
    ]);
  }
  // 重问后仍失败：empty 交给上层报"无需执行"；invalid 抛可读错误
  if (attempt.kind === 'empty') return { ops: [] };
  if (attempt.kind === 'invalid') {
    throw new Error(`AI 解析出的操作不合法（${attempt.issues.slice(0, 120)}），请重试或换一种说法`);
  }
  return { ops: attempt.ops, needsClarify: attempt.needsClarify };
}
