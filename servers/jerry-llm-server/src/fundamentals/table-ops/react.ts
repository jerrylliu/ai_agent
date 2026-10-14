/**
 * fundamentals/table-ops/react.ts
 *
 * ReAct 工具循环：LLM 逐轮决策"本轮选哪个操作"，执行器执行后把结果作为
 * 观察反馈给 LLM，直到模型宣布完成。作为表格指令的新主路径，替代
 * "一次性解析全部 ops 再盲执行"（旧路径保留为降级出口，见 TableOpsService）。
 *
 * 为什么是 ReAct（根治"模型看不清就瞎做"）：
 *   - 一次性解析时模型必须凭概览一次猜对全部操作与参数，猜错要整条指令重来；
 *   - 循环模式下每步执行结果（成功消息/失败原因/门禁拦截）都回喂模型，
 *     它能自我纠正（如条件值写错时换一种写法重试），错误可观察、可恢复；
 *   - 每轮决策实时推送进度事件（thought/action/observation），用户能看到
 *     "正在对「汇总」的「办公家具」行执行加法求和……"的过程，消除黑盒感。
 *
 * 安全边界（与旧路径同级，不因循环而放宽）：
 *   - 模型只产"决策"，执行永远走 executeTableOps 的确定性执行器（纯函数）；
 *   - 完备性闸门（clarify.ts）：每个 op 执行前检查数据依赖参数（填充来源/
 *     关联键/更新条件/公式覆盖面/大范围删除），不全时停止循环转用户反问
 *     （SSE clarify 事件）——参数不明时 LLM 无权写数据，用户确认后走 confirm 端点；
 *   - 单 op 粒度：每个操作执行前校验、执行后过规则门禁（基线差集语义），
 *     违规则回滚该步（恢复执行前文本）并把违规原因回喂模型——坏操作
 *     进不了最终结果；
 *   - MAX_REACT_TURNS 硬上限防循环失控；决策连续解析失败降级旧路径。
 *
 * 注意：意图映射规则与 parse.ts 的 SYSTEM_PROMPT 保持同步（勿单侧增删）。
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from '../logger.js';
import { markStructuredOutputUnavailable } from './parse.js';
import { TableOpSchema, type TableOp } from './schema.js';
import type { OpReport, WhereClause } from './schema.js';
import {
  executeTableOps,
  TableOpsError,
} from './executor.js';
import {
  checkRules,
  diffViolations,
  formatViolationsByRule,
  type RuleCheckResult,
  type TableRuleRuntime,
} from './rules.js';
import {
  checkOpsCompleteness,
  buildClarifyPayload,
  hashSheetText,
  ClarifyKindSchema,
  type ClarifyPayload,
} from './clarify.js';

// ==================== 常量 ====================

/** 循环轮次硬上限（每轮一个操作；通常 1~3 轮完成，8 轮足够宽裕） */
export const MAX_REACT_TURNS = 8;

// ==================== 决策 Schema ====================

/**
 * 单轮决策：模型每轮只输出一个决策对象（不输出 ops 数组）。
 * 工具细节（各操作的字段与用途）由 function calling 的 schema describe
 * 直接传给模型，提示词只负责流程与意图规则。
 */
export const ReactDecisionSchema = z
  .object({
    thought: z
      .string()
      .min(1)
      .max(500)
      .describe('一两句中文：本轮的判断与打算（会实时展示给用户）'),
    done: z.boolean().describe('true = 所有必要操作已完成（或经判断无需任何操作）'),
    op: TableOpSchema.optional().describe(
      'done=false 且无 needsClarify 时必填：本轮要执行的一个操作',
    ),
    needsClarify: z
      .object({
        kind: ClarifyKindSchema.describe(
          '反问场景：fill-source 填充来源 / join-key 跨表关联键 / condition 更新条件 / aggregate-scope 聚合范围 / formula-preview 公式影响面 / destructive-preview 删除范围',
        ),
        question: z
          .string()
          .min(2)
          .max(500)
          .describe('一句中文向用户说明缺什么信息、需要确认什么（不要附带选项内容，选项由系统生成）'),
      })
      .optional()
      .describe(
        '指令的关键参数存在数据依赖不明（填充来源、关联键、更新条件等）且无法给出有把握的操作时填写；此时必须 done=false 且不输出 op，系统会向用户反问确认后再继续',
      ),
    summary: z
      .string()
      .min(2)
      .max(1000)
      .optional()
      .describe('done=true 时必填：面向用户的整体结果总结（做了什么、结果如何）'),
  })
  .superRefine((d, ctx) => {
    if (d.needsClarify) {
      // 反问轮：只许提问——夹带操作或结束都会绕过用户确认，schema 层直接拒绝
      if (d.done) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['needsClarify'],
          message: 'needsClarify（需反问）时不能同时 done=true，要么反问要么结束',
        });
      }
      if (d.op !== undefined && d.op !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['needsClarify'],
          message: 'needsClarify（需反问）时不得输出 op——参数由用户确认后生成，禁止猜测',
        });
      }
      return;
    }
    if (!d.done && (d.op === undefined || d.op === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['op'],
        message: 'done=false 时必须提供 op（本轮要执行的操作），或用 needsClarify 向用户反问',
      });
    }
    if (d.done && (d.summary === undefined || d.summary.trim() === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'done=true 时必须提供 summary（整体结果总结）',
      });
    }
  });
export type ReactDecision = z.infer<typeof ReactDecisionSchema>;

// ==================== 进度事件 ====================

/** 进度事件（SSE 出站，规范 7.4：出口 parse 防结构异常事件到前端） */
export const TableOpsProgressEventSchema = z.object({
  seq: z.number().int().min(1),
  phase: z.enum(['thought', 'action', 'observation']),
  text: z.string().min(1).max(2000),
});
export type TableOpsProgressEvent = z.infer<typeof TableOpsProgressEventSchema>;
export type ReactProgressListener = (event: TableOpsProgressEvent) => void;

// ==================== ReAct 系统提示词 ====================

/**
 * ReAct 系统提示词。操作参数细节由 function calling 的 JSON Schema（含
 * .describe() 中文说明）直接传给模型，这里只写使命、流程与意图规则。
 * 意图规则与 parse.ts 的 SYSTEM_PROMPT 同步维护（勿单侧增删）。
 */
const REACT_SYSTEM_PROMPT = `你是表格数据操作智能体。用户给你一条自然语言指令，你以"一轮一个操作"的方式完成它：

每轮输出一个决策对象：
- thought：本轮的判断与打算（一两句中文，会实时展示给用户）
- done=false 时：op = 本轮要执行的一个操作（可选操作及参数见 function 的字段说明）
- done=true 时：summary = 面向用户的整体结果总结

工作方式：
1. 先通读表格概览与指令，在心里规划需要哪几步操作
2. 每轮执行一个操作；服务端执行后会把结果（成功消息或失败原因）作为"执行观察"反馈给你
3. 操作失败时（如列不存在、条件值不匹配），根据观察调整参数重试，换用其他列名或写法；同一操作失败超过 2 次就不要再试，结束并如实说明
4. 所有操作完成后 done=true 并给出 summary；无需任何操作时直接 done=true，summary 说明原因（如唯一的空缺是标题行旁的刻意留白）

意图映射规则：
- 你只负责"理解意图"与"选择操作"，绝对不要做任何数字计算（求和/平均/表达式求值由执行器精确完成）
- 列名、工作表名、条件值必须从表格概览或指令原文中逐字选取，不要编造
- 反问协议：操作的关键参数存在数据依赖不明（填充来源/取值依据、跨表关联键、更新条件、公式影响范围、大范围删除）时，绝不猜测具体取值。优先输出你最有把握的操作（如 lookupFill 带你推断的关联键）——系统会自动校验参数完备性，参数不全或可疑时会转给用户确认；只有当连操作都无法成形时才用 needsClarify 反问（kind 填场景类型，question 一句话说明缺什么），此时 done=false 且不输出 op
- "把A表的某类数据汇总后加入B表并重算合计"：先 aggregateAppendRow（sourceSheet=A表，targetSheet=B表，beforeRow 填合计行标签），下一轮再 aggregateUpdateCell（targetSheet=B表，rowLabel=合计行标签）重算合计
- "按XX分类统计做成新表"固定用 groupCreateSheet，不要用多条 aggregateAppendRow 拼凑
- 指令里的背景陈述不是操作请求："由于/因为 XX 已发生变动/已完成"只是交代前提，绝不为它输出操作（尤其"XX的单价/数量发生变动"≠"请修改源表的值"——用户没给新值时，猜一个写进去是数据损坏）；只执行用户真正要求的动作
- "重新计算/重算 表A 的相关值（因源表数据变动）"类指令：重算目标是表A本身，绝不因此修改源数据表。对表A中受影响的汇总行逐轮输出 aggregateUpdateCell：targetSheet=表A、rowLabel=该行第一列标签、column=表A中要重算的列、fn=sum、sourceSheet=源数据表、sourceColumn=源表中对应的数值列（两表列名不同时必须填，如源表「金额」对应表A「金额小计」）、where 用源表中与该行标签对应的分类列过滤（分类列名与取值从概览取值示例对照）；表A末行的 总计/合计 行也要重算（省略 sourceSheet 的同列上方求和形态）
- 概览首行若注明"表头在第 N 行，上方为说明行"，说明该表是报表式布局：上方说明行（标题/日期范围等）不是数据，不参与填充/条件/规则
- 用户说"表头在第 N 行 / 把第 N 行设为表头"时，输出 setHeaderRow 操作（headerRow 填 N；N=1 表示恢复首行为表头）
- 用户说"把第 N 行标记为汇总行 / 第 N 行是合计行 / 取消汇总行标记"时，输出 setTotalRows 操作（rows 填 [N]，N 按含说明行的完整行序从 1 数起；取消标记时 rows 填 []）
- 概览中"汇总行：第 N 行（总计）"是该表聚合结果行的权威声明：填充/条件更新/规则校验已自动跳过该行，不要对这些行的明细列做空缺填充——补全其数值用 aggregateUpdateCell 重算
- 概览中"空缺单元格：列=N格（位于行：…）"是权威统计：汇总行（概览已声明"汇总行：第 N 行"的行）的空缺是真实缺失（用户要求补全时用 aggregateUpdateCell 重算填充），标题/日期行旁的空缺是刻意留白（不要填充）
- "把B表的新列/空列按A表的对应数据补充/关联进来"（跨表按键取值填充）：输出 lookupFill——targetColumn=B表目标列、sourceSheet=A表、sourceValueColumn=A表取值列、targetKeyColumn/sourceKeyColumn 填你推断的关联键（不确定就填最可能的同名键，系统会校验重合率并在可疑时转用户确认）；目标列不存在时先在前一轮输出 addColumn 建列
- "把某列的空格统一填成某个固定值"：输出 fillConstant（只填空格，不覆盖已有值）
- 用户要求"补上缺失值/填充空白/补空"且目标列显示有空缺时，必须选择对应操作（semanticFill 或带 empty 条件的操作），绝不以"没有空值"为由什么都不做
- 用户明确要求执行操作时必须选择对应操作，即使目标工作表/列已存在（同名工作表就地重建、已有列直接覆盖，都是期望行为）
- 指令引用的列/工作表在概览中确实不存在时，结束（done=true）并在 summary 如实说明找不到，不要编造
- semanticFill（语义填充）被选中时直接输出它即可，系统会先向用户确认填充策略（跨表关联/AI 映射/固定值/保留空缺）再执行并结束循环；它通常应该是第一步（先补齐数据再做其他操作）
- 通常 1~3 轮就能完成，最多不超过 ${MAX_REACT_TURNS} 轮`;

// ==================== 操作进行时描述（"正在使用加法求和计算……"） ====================

/** 聚合方式的中文动作名（进度事件的"正在使用XX计算"） */
const AGG_FN_LABEL: Record<string, string> = {
  sum: '加法求和',
  avg: '平均值计算',
  count: '计数统计',
  min: '最小值查找',
  max: '最大值查找',
};

/** 比较方式的中文动作名 */
const COND_OP_LABEL: Record<string, string> = {
  eq: '等于',
  ne: '不等于',
  contains: '包含',
  gt: '大于',
  lt: '小于',
  gte: '大于等于',
  lte: '小于等于',
  empty: '为空',
  notEmpty: '不为空',
};

/** 单条件的可读描述（如"类型 等于 办公家具"） */
function describeSimpleCondition(cond: {
  column: string;
  op: string;
  value?: string;
}): string {
  const opLabel = COND_OP_LABEL[cond.op] ?? cond.op;
  return cond.op === 'empty' || cond.op === 'notEmpty'
    ? `${cond.column} ${opLabel}`
    : `${cond.column} ${opLabel} ${cond.value ?? ''}`;
}

/** where 子句的可读描述（单条件或 and/or 组合） */
function describeWhere(where: WhereClause): string {
  if ('conditions' in where) {
    const joiner = where.mode === 'and' ? '且' : '或';
    return `（筛选：${where.conditions.map(describeSimpleCondition).join(` ${joiner} `)}）`;
  }
  return `（筛选：${describeSimpleCondition(where)}）`;
}

/** 目标表前缀（省略时不加表名——单表文档念表名反而啰嗦） */
function sheetPrefix(op: TableOp): string {
  if ('targetSheet' in op && op.targetSheet) return `「${op.targetSheet}」`;
  return '';
}

/**
 * 操作的进行时可读描述（SSE 进度事件的 action 文案），
 * 如"正在对「汇总」的「办公家具」行执行加法求和，从「销售明细」（筛选：类型 等于 办公家具）……"
 */
export function describeOpPending(op: TableOp): string {
  const sheet = sheetPrefix(op);
  switch (op.type) {
    case 'appendRow': {
      const cols = Object.keys(op.cells).join('、');
      return `正在向${sheet}追加一行（${cols}）……`;
    }
    case 'aggregateUpdateCell': {
      const fn = AGG_FN_LABEL[op.fn] ?? op.fn;
      const source = op.sourceSheet ? `，从「${op.sourceSheet}」` : '';
      const col = op.sourceColumn && op.sourceColumn !== op.column ? `的「${op.sourceColumn}」列` : '';
      const where = op.where ? describeWhere(op.where) : '';
      return `正在对${sheet}的「${op.rowLabel}」行执行${fn}${source}${col}${where}……`;
    }
    case 'aggregateAppendRow': {
      const fn = AGG_FN_LABEL[op.fn] ?? op.fn;
      const source = op.sourceSheet ? `从「${op.sourceSheet}」` : '';
      const where = op.where ? describeWhere(op.where) : '';
      const before = op.beforeRow ? `，插入到「${op.beforeRow}」行之前` : '';
      return `正在${fn}「${op.column}」${source}${where}，追加结果行${before}……`;
    }
    case 'updateCells': {
      const where = op.where ? describeWhere(op.where) : '';
      return `正在更新${sheet}的「${op.targetColumn}」列为「${op.newValue}」${where}……`;
    }
    case 'deleteRows': {
      return `正在按条件删除${sheet}的数据行${describeWhere(op.where)}……`;
    }
    case 'deleteColumn':
      return `正在删除${sheet}的「${op.column}」列……`;
    case 'addColumn':
      return `正在为${sheet}新增「${op.header}」列${op.value ? `（统一填「${op.value}」）` : ''}……`;
    case 'sortRows':
      return `正在对${sheet}按「${op.column}」${op.order === 'asc' ? '升序' : '降序'}排序……`;
    case 'renameColumn':
      return `正在把${sheet}的「${op.from}」列重命名为「${op.to}」……`;
    case 'groupCreateSheet': {
      const fn = AGG_FN_LABEL[op.fn] ?? op.fn;
      const source = op.sourceSheet ? `（来源「${op.sourceSheet}」）` : '';
      return `正在按「${op.groupBy}」对「${op.valueColumn}」做${fn}${source}，生成新表「${op.newSheetName}」……`;
    }
    case 'deriveColumn':
      return `正在计算${sheet}的「${op.targetColumn}」列（表达式 ${op.expression}）……`;
    case 'lookupFill': {
      const key = op.targetKeyColumn ? `按「${op.targetKeyColumn}」` : '';
      return `正在${key}从「${op.sourceSheet}」关联填充${sheet}的「${op.targetColumn}」……`;
    }
    case 'fillConstant':
      return `正在把${sheet}的「${op.targetColumn}」的空格填充为「${op.value}」……`;
    case 'semanticFill':
      return `正在构建「${op.targetColumn}」列的语义填充方案……`;
    case 'setHeaderRow':
      return `正在把${sheet}的第 ${op.headerRow} 行设为表头……`;
    case 'setTotalRows': {
      if (op.rows.length === 0) return `正在清除${sheet}的全部汇总行标记……`;
      const nums = op.rows.join('、');
      return `正在把${sheet}的第 ${nums} 行标记为汇总行……`;
    }
    case 'noop':
      return op.reason ? `判断：${op.reason}` : '正在判断是否需要操作……';
  }
}

// ==================== ReAct 循环 ====================

/** 循环结果（service 据此分流） */
export type ReactiveOutcome =
  | { kind: 'done'; sheetText: string; report: OpReport[]; summary: string }
  | {
      kind: 'semanticFill';
      op: Extract<TableOp, { type: 'semanticFill' }>;
      /** 已执行操作的中间结果文本（semanticFill 必须基于它继续，否则前序改动丢失） */
      sheetText: string;
    }
  | {
      kind: 'clarify';
      /** 确定性反问载荷（已含 baseSheetText/baseSheetTextHash，confirm 时回传作执行基底） */
      payload: ClarifyPayload;
      /** 触发 clarify 时的已执行结果文本（= payload.baseSheetText，service 留作核对/日志） */
      baseSheetText: string;
    }
  | { kind: 'fallback'; reason: string };

export interface ReactiveParams {
  instruction: string;
  sheetText: string;
  overview: string;
  /** 已注入限流的 chat model（temperature 0，由 service 构造） */
  llm: BaseChatModel;
  /** 当前模型 ID（能力类错误时写进程级记忆，后续指令直接走降级路径） */
  modelId: string;
  /** 该文档启用的表格规则（逐 op 门禁用；空数组 = 无门禁） */
  rules: TableRuleRuntime[];
  /** 进度事件监听（SSE 推送；可省略——单测/内部调用） */
  onProgress?: ReactProgressListener;
}

/**
 * ReAct 主循环：决策 → 执行 → 观察 → …… → done。
 * 决策解析失败自动纠正重试一次；连续失败 / 能力不支持 → fallback（上层走旧路径）。
 * 任何一步都不会让坏数据进最终文本（校验失败不执行、门禁违规即回滚）。
 */
export async function runReactiveOps(params: ReactiveParams): Promise<ReactiveOutcome> {
  const { instruction, sheetText, overview, llm, modelId, rules, onProgress } = params;

  const structured = llm.withStructuredOutput(ReactDecisionSchema, {
    method: 'functionCalling',
  });
  const messages: BaseMessage[] = [
    new SystemMessage(REACT_SYSTEM_PROMPT),
    new HumanMessage(`表格概览：\n${overview}\n\n用户指令：${instruction}`),
  ];

  let currentText = sheetText;
  const report: OpReport[] = [];
  let seq = 0;

  // 门禁基线：初始文本的违规多重集（只拒操作**新增**的违规，与旧路径同语义）
  const baseline = rules.length > 0 ? checkRules(sheetText, rules).violations : null;

  const emit = (phase: TableOpsProgressEvent['phase'], text: string): void => {
    const parsed = TableOpsProgressEventSchema.safeParse({
      seq: ++seq,
      phase,
      text: text.slice(0, 2000),
    });
    if (parsed.success) {
      onProgress?.(parsed.data);
    } else {
      logger.warn('表格指令进度事件校验失败，已丢弃', {
        module: 'TableOpsReact',
        phase,
        issues: parsed.error.issues.map((i) => i.message).join(';'),
      });
    }
  };

  // 决策轮：调用 + 解析失败纠正重试一次。返回 null = 应降级（reason 填入 outcome）
  const decide = async (): Promise<ReactDecision | { fallback: string }> => {
    try {
      return await structured.invoke(messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/tool_choice|Thinking mode|response_format/i.test(msg)) {
        // 能力类错误：进程级记忆，后续指令不再白打 400
        markStructuredOutputUnavailable(modelId);
        return { fallback: msg };
      }
      // 非能力类（偶发结构不合规等）：把失败作为反馈纠正重试一次
      logger.warn('ReAct 决策解析失败，纠正重试一次', {
        module: 'TableOpsReact',
        error: msg,
      });
      messages.push(
        new HumanMessage('你上一轮的输出无法解析为合法决策，请检查字段要求后重新输出本轮决策。'),
      );
      try {
        return await structured.invoke(messages);
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        if (/tool_choice|Thinking mode|response_format/i.test(msg2)) {
          markStructuredOutputUnavailable(modelId);
        }
        return { fallback: msg2 };
      }
    }
  };

  for (let turn = 1; turn <= MAX_REACT_TURNS; turn++) {
    const decisionOrFallback = await decide();
    if ('fallback' in decisionOrFallback) {
      return { kind: 'fallback', reason: decisionOrFallback.fallback };
    }
    const decision = decisionOrFallback;
    emit('thought', decision.thought);

    if (decision.done) {
      return {
        kind: 'done',
        sheetText: currentText,
        report,
        summary: decision.summary ?? '已完成',
      };
    }

    // LLM 自报反问（快捷路径）：模型只给措辞与场景类型，选项内容仍由确定性
    // 分析器产出（选项内容的生成权绝不下放给 LLM）。此时无成形 op，
    // 以模型声明的场景合成闸门结果——fill-source 能做全量列空缺分析，
    // 其余场景只产出问题文案（至少保证反问可达，绝不猜参数）。
    // 注意：必须先于下方 !decision.op 兜底——needsClarify 决策本就不带 op
    if (decision.needsClarify) {
      const syntheticGate = {
        action: 'clarify' as const,
        kind: decision.needsClarify.kind,
        opIndex: 0,
        reason: decision.needsClarify.question,
      };
      const payload = buildClarifyPayload(
        currentText,
        syntheticGate,
        [],
        decision.needsClarify.question,
      );
      payload.baseSheetText = currentText;
      payload.baseSheetTextHash = hashSheetText(currentText);
      // 发起指令时原文 hash：confirm 校验编辑器实时文本用（卡片停留期间的编辑检测）
      payload.originSheetTextHash = hashSheetText(sheetText);
      emit('action', `需要向你确认：${decision.needsClarify.question}`);
      return { kind: 'clarify', payload, baseSheetText: currentText };
    }

    if (!decision.op) {
      // superRefine 已保证 op 存在；防御性兜底（理论上不可达）
      messages.push(
        new HumanMessage('done=false 时必须提供 op。请重新输出本轮决策（或 done=true 结束）。'),
      );
      continue;
    }
    const op = decision.op;

    // 完备性闸门（权威兜底，先于执行与语义填充分流；LLM 漏报也在这里被拦）：
    // - semanticFill 一律转 fill-source clarify（推断型填充永不静默执行）；
    // - 其他 op 的数据依赖参数不全（关联键/更新条件/公式覆盖面/大范围删除）→ 转对应 clarify；
    // - deleteRows 无条件 → reject（回喂模型调整，整表删除不可确认后执行）
    const gate = checkOpsCompleteness(currentText, [op]);
    if (gate) {
      if (gate.action === 'reject') {
        emit('observation', `操作被拒绝：${gate.reason}`);
        messages.push(
          new AIMessage(JSON.stringify(decision)),
          new HumanMessage(
            `执行观察：操作被拒绝：${gate.reason}。请调整做法（如补上条件），或结束（done=true）并在 summary 说明原因`,
          ),
        );
        continue;
      }
      // clarify：停止循环。baseSheetText = currentText（已执行前缀的结果文本），
      // confirm 请求以它为执行基底；前端不应用它（编辑器保持干净）
      const payload = buildClarifyPayload(currentText, gate, [op]);
      payload.baseSheetText = currentText;
      payload.baseSheetTextHash = hashSheetText(currentText);
      // 发起指令时原文 hash（前缀已执行时与 baseSheetTextHash 不同）：
      // confirm 凭它校验编辑器实时文本——baseSheetText 是中间态、编辑器里没有，
      // 只对它校验防不住卡片停留期间的用户编辑
      payload.originSheetTextHash = hashSheetText(sheetText);
      emit('action', `需要向你确认：${payload.question}`);
      return { kind: 'clarify', payload, baseSheetText: currentText };
    }

    // 语义填充分流：仅当闸门无法解析文本（gate === null，解析失败/空表）时可达——
    // 文本可解析时 semanticFill 已被闸门转为 fill-source clarify。
    // 必须带上 currentText——前几轮已执行的操作结果要延续进填充流程
    if (op.type === 'semanticFill') {
      emit('action', describeOpPending(op));
      return { kind: 'semanticFill', op, sheetText: currentText };
    }

    emit('action', describeOpPending(op));

    // 单 op 执行（校验 + 执行一体；executeTableOps 是纯函数，失败/回滚都不损原文本）
    let observation: string;
    try {
      const result = executeTableOps(currentText, [op]);
      // 门禁增量检查：新增违规 → 回滚该步（恢复执行前文本），把违规原因回喂模型
      if (baseline !== null) {
        const check = checkRules(result.sheetText, rules);
        const fresh = diffViolations(baseline, check.violations);
        if (fresh.length > 0) {
          const freshCheck: RuleCheckResult = { ...check, violations: fresh };
          observation =
            `操作已撤销：它会新增违反表格规则的内容（${fresh.length} 处）：${formatViolationsByRule(freshCheck)}。` +
            '请调整做法避开这些规则（如修正条件或取值），或结束（done=true）并在 summary 说明无法完成的原因';
          emit('observation', '操作被规则门禁拦截，已撤销');
          messages.push(new AIMessage(JSON.stringify(decision)), new HumanMessage(`执行观察：${observation}`));
          continue;
        }
      }
      currentText = result.sheetText;
      report.push(...result.report);
      // "第 1 步失败：" 前缀是批量执行的步骤编号，单 op 场景去掉更自然
      observation = (result.report[0]?.message ?? '操作完成').replace(/^第 1 步失败：/, '');
      emit('observation', observation);
    } catch (err) {
      observation =
        err instanceof TableOpsError
          ? err.message.replace(/^第 1 步失败：/, '')
          : `执行异常：${err instanceof Error ? err.message : String(err)}`;
      emit('observation', `执行失败：${observation}`);
    }
    messages.push(new AIMessage(JSON.stringify(decision)), new HumanMessage(`执行观察：${observation}`));
  }

  // 轮次耗尽：已执行的部分仍然有效（每步都过了门禁），如实告知用户
  logger.warn('ReAct 循环达到轮次上限', { module: 'TableOpsReact', executedOps: report.length });
  return {
    kind: 'done',
    sheetText: currentText,
    report,
    summary: `已达到单次指令的操作步数上限（${MAX_REACT_TURNS} 轮），前面已完成的操作仍然有效。如需继续请再发指令`,
  };
}
