/**
 * table-ops/react.spec.ts - ReAct 工具循环测试
 *
 * 覆盖：决策 schema 条件必填（含 needsClarify 互斥约束）、操作进行时描述、
 *       循环主流程（决策→执行→观察→done）、执行失败的观察反馈与自我纠正、
 *       规则门禁逐 op 增量拦截与回滚、完备性闸门（无条件更新转 condition 反问、
 *       无条件删除拒绝回喂、semanticFill 一律转 fill-source 反问）、
 *       LLM 自报 needsClarify 的确定性反问、能力类错误降级、轮次上限兜底。
 */
import {
  ReactDecisionSchema,
  describeOpPending,
  runReactiveOps,
  MAX_REACT_TURNS,
  type TableOpsProgressEvent,
} from './react';
import type { TableRuleRuntime } from './rules';
import type { WhereClause } from './schema';
import { TableOpsError } from './executor';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// ==================== 测试夹具 ====================

const SHEET_TEXT = [
  'Sheet: 测试',
  '名称,数量,单价,金额',
  'a,2,10,20',
  'b,3,5,15',
].join('\n');

/** 构造决策序列的 mock LLM：withStructuredOutput 返回的 invoke 依次吐出 decisions */
function makeLLM(decisions: unknown[]): BaseChatModel {
  let i = 0;
  return {
    withStructuredOutput: () => ({
      invoke: async () => {
        const d = decisions[Math.min(i++, decisions.length - 1)];
        if (d instanceof Error) throw d;
        return d;
      },
    }),
  } as unknown as BaseChatModel;
}

/** 取值白名单规则（门禁测试用）：名称列只能是 a/b */
const NAME_WHITELIST: TableRuleRuntime = {
  id: 1,
  name: '名称白名单',
  type: 'allowedValues',
  params: { column: '名称', values: ['a', 'b'] },
} as unknown as TableRuleRuntime;

/** 决策工厂：执行一个带条件的 updateCells 后结束（无条件更新会被完备性闸门转反问） */
function updateThenDone(column: string, newValue: string, where: WhereClause): unknown[] {
  return [
    {
      thought: '需要更新单元格',
      done: false,
      op: { type: 'updateCells', targetColumn: column, newValue, where },
    },
    { thought: '已完成', done: true, summary: '更新完成' },
  ];
}

// ==================== 决策 Schema ====================

describe('ReactDecisionSchema', () => {
  it('done=false 缺 op → 校验失败', () => {
    const r = ReactDecisionSchema.safeParse({ thought: 'x', done: false });
    expect(r.success).toBe(false);
  });

  it('done=true 缺 summary → 校验失败', () => {
    const r = ReactDecisionSchema.safeParse({ thought: 'x', done: true });
    expect(r.success).toBe(false);
  });

  it('合法决策（op 决策 / done 决策）通过', () => {
    expect(
      ReactDecisionSchema.safeParse({
        thought: 'x',
        done: false,
        op: { type: 'noop', reason: '无需操作' },
      }).success,
    ).toBe(true);
    expect(
      ReactDecisionSchema.safeParse({ thought: 'x', done: true, summary: '完成' }).success,
    ).toBe(true);
  });

  it('needsClarify 反问决策：done=false 且无 op 时合法，夹带 op 或 done=true 时拒绝', () => {
    const clarify = { kind: 'fill-source', question: '空缺内容按什么策略补充？' };
    expect(
      ReactDecisionSchema.safeParse({ thought: 'x', done: false, needsClarify: clarify }).success,
    ).toBe(true);
    expect(
      ReactDecisionSchema.safeParse({
        thought: 'x',
        done: false,
        op: { type: 'noop', reason: 'r' },
        needsClarify: clarify,
      }).success,
    ).toBe(false);
    expect(
      ReactDecisionSchema.safeParse({
        thought: 'x',
        done: true,
        summary: '完成',
        needsClarify: clarify,
      }).success,
    ).toBe(false);
  });
});

// ==================== 操作进行时描述 ====================

describe('describeOpPending', () => {
  it('aggregateUpdateCell：聚合方式中文化 + 跨表来源 + 筛选条件', () => {
    const text = describeOpPending({
      type: 'aggregateUpdateCell',
      targetSheet: '汇总',
      rowLabel: '办公家具',
      column: '金额小计',
      sourceSheet: '销售明细',
      sourceColumn: '金额',
      where: { column: '类型', op: 'eq', value: '办公家具' },
      fn: 'sum',
    });
    expect(text).toContain('加法求和');
    expect(text).toContain('「汇总」的「办公家具」行');
    expect(text).toContain('从「销售明细」的「金额」列');
    expect(text).toContain('类型 等于 办公家具');
  });

  it('updateCells / deleteRows：条件描述可读', () => {
    expect(
      describeOpPending({ type: 'updateCells', targetColumn: '备注', newValue: 'x' }),
    ).toContain('正在更新');
    expect(
      describeOpPending({
        type: 'deleteRows',
        where: { mode: 'or', conditions: [
          { column: '名称', op: 'empty' },
          { column: '数量', op: 'lt', value: '0' },
        ] },
      }),
    ).toContain('名称 为空 或 数量 小于 0');
  });

  it('setHeaderRow / groupCreateSheet 文案', () => {
    expect(describeOpPending({ type: 'setHeaderRow', headerRow: 3, targetSheet: '汇总' })).toContain(
      '第 3 行设为表头',
    );
    expect(
      describeOpPending({
        type: 'groupCreateSheet',
        groupBy: '类型',
        valueColumn: '金额',
        fn: 'sum',
        newSheetName: '分类统计',
      }),
    ).toContain('分类统计');
  });

  it('lookupFill / fillConstant 文案', () => {
    expect(
      describeOpPending({
        type: 'lookupFill',
        targetSheet: '表二',
        targetColumn: 'a1',
        sourceSheet: '表1',
        sourceKeyColumn: '品名',
        sourceValueColumn: 'a1',
        targetKeyColumn: '名称',
      }),
    ).toContain('按「名称」从「表1」关联填充「表二」的「a1」');
    expect(
      describeOpPending({ type: 'fillConstant', targetColumn: '备注', value: '待定' }),
    ).toContain('空格填充为「待定」');
  });
});

// ==================== ReAct 循环 ====================

describe('runReactiveOps', () => {
  it('两轮完成：执行 op → done，进度事件按 thought/action/observation/thought 顺序推送', async () => {
    const events: TableOpsProgressEvent[] = [];
    const outcome = await runReactiveOps({
      instruction: '把 a 的金额改为 99',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM(updateThenDone('金额', '99', { column: '名称', op: 'eq', value: 'a' })),
      modelId: 'test-model',
      rules: [],
      onProgress: (e) => events.push(e),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.sheetText).toContain('a,2,10,99');
    expect(outcome.summary).toBe('更新完成');
    expect(outcome.report).toHaveLength(1);
    expect(events.map((e) => e.phase)).toEqual(['thought', 'action', 'observation', 'thought']);
    // action 文案是人类可读的进行时描述
    expect(events[1].text).toContain('正在更新');
  });

  it('首轮执行失败（引用不存在列）→ 失败原因回喂 → 第二轮纠正成功', async () => {
    const outcome = await runReactiveOps({
      instruction: '改金额',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        { thought: '改列', done: false, op: { type: 'updateCells', targetColumn: '不存在的列', newValue: '1', where: { column: '名称', op: 'eq', value: 'a' } } },
        { thought: '改对列', done: false, op: { type: 'updateCells', targetColumn: '金额', newValue: '1', where: { column: '名称', op: 'eq', value: 'a' } } },
        { thought: '完成', done: true, summary: '已更新' },
      ]),
      modelId: 'test-model',
      rules: [],
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.sheetText).toContain('a,2,10,1');
  });

  it('规则门禁逐 op 拦截：违规操作被回滚（文本不变），违规原因回喂模型', async () => {
    const events: TableOpsProgressEvent[] = [];
    const outcome = await runReactiveOps({
      instruction: '把 b 的名称改为 c',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        ...updateThenDone('名称', 'c', { column: '名称', op: 'eq', value: 'b' }),
        // 被拦截后模型放弃
      ]),
      modelId: 'test-model',
      rules: [NAME_WHITELIST],
      onProgress: (e) => events.push(e),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    // 回滚：名称列未被改动
    expect(outcome.sheetText).toContain('b,3,5,15');
    expect(outcome.sheetText).not.toContain('c,3,5,15');
    // 观察事件告知了门禁拦截
    const observation = events.find((e) => e.phase === 'observation');
    expect(observation?.text).toContain('门禁拦截');
  });

  it('规则门禁放行合法操作（基线差集语义：既有违规不拦截）', async () => {
    // 初始文本中 a 的金额 20 违反"金额必须大于 1000"——既有违规，
    // 更新 b 的金额为 2000 是新增合法操作，不应被连坐拦截
    const rangeRule: TableRuleRuntime = {
      id: 2,
      name: '金额下限',
      type: 'numericRange',
      params: { column: '金额', min: '1000' },
    } as unknown as TableRuleRuntime;
    const outcome = await runReactiveOps({
      instruction: '把 b 的金额改为 2000',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM(updateThenDone('金额', '2000', { column: '名称', op: 'eq', value: 'b' })),
      modelId: 'test-model',
      rules: [rangeRule],
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.sheetText).toContain('b,3,5,2000');
    // 既有违规行原样保留
    expect(outcome.sheetText).toContain('a,2,10,20');
  });

  it('semanticFill 决策 → 完备性闸门一律转 fill-source 反问（推断型填充永不静默执行）', async () => {
    const outcome = await runReactiveOps({
      instruction: '填充空缺',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        { thought: '语义填充', done: false, op: { type: 'semanticFill', targetColumn: '名称' } },
      ]),
      modelId: 'test-model',
      rules: [],
    });
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.payload.kind).toBe('fill-source');
    // 无前序操作时执行基底 = 原始文本原样，且带 hash 供 confirm 做 TOCTOU 校验
    expect(outcome.baseSheetText).toBe(SHEET_TEXT);
    expect(outcome.payload.baseSheetText).toBe(SHEET_TEXT);
    expect(outcome.payload.baseSheetTextHash).toBeTruthy();
  });

  it('前序操作后触发 clarify：baseSheetText 必须延续已执行结果（confirm 的执行基底）', async () => {
    const outcome = await runReactiveOps({
      instruction: '加一列再填充',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        { thought: '先加列', done: false, op: { type: 'addColumn', header: '备注' } },
        { thought: '再填充', done: false, op: { type: 'semanticFill', targetColumn: '备注' } },
      ]),
      modelId: 'test-model',
      rules: [],
    });
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    // 关键回归点：执行基底必须是"已加列"的中间态，confirm 基于它继续执行
    expect(outcome.baseSheetText).toContain('名称,数量,单价,金额,备注');
    expect(outcome.payload.baseSheetText).toBe(outcome.baseSheetText);
  });

  it('LLM 自报 needsClarify → 确定性反问载荷（措辞用模型 question，选项由分析器产出）', async () => {
    const outcome = await runReactiveOps({
      instruction: '把空缺内容补充齐全',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        {
          thought: '填充来源不明确，需要反问',
          done: false,
          needsClarify: { kind: 'fill-source', question: '空缺内容按什么策略补充？' },
        },
      ]),
      modelId: 'test-model',
      rules: [],
    });
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.payload.kind).toBe('fill-source');
    expect(outcome.payload.question).toBe('空缺内容按什么策略补充？');
    expect(outcome.baseSheetText).toBe(SHEET_TEXT);
  });

  it('闸门拦截无条件更新（列存在但数据依赖不明）→ 转 condition 反问，选项由分析器产出', async () => {
    const outcome = await runReactiveOps({
      instruction: '把金额改成 1',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        { thought: '全列更新', done: false, op: { type: 'updateCells', targetColumn: '金额', newValue: '1' } },
      ]),
      modelId: 'test-model',
      rules: [],
    });
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.payload.kind).toBe('condition');
    // 选项由值分布分析器确定性产出（逐值条件 + 全列更新兜底），LLM 未参与
    expect(outcome.payload.options?.length).toBeGreaterThan(0);
  });

  it('闸门拒绝无条件删除 → 观察回喂模型，循环不中断，模型可结束并说明', async () => {
    const events: TableOpsProgressEvent[] = [];
    const outcome = await runReactiveOps({
      instruction: '删数据',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        { thought: '整表删除', done: false, op: { type: 'deleteRows' } },
        { thought: '放弃', done: true, summary: '删除必须指明条件，已取消' },
      ]),
      modelId: 'test-model',
      rules: [],
      onProgress: (e) => events.push(e),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.report).toHaveLength(0);
    expect(outcome.sheetText).toBe(SHEET_TEXT);
    const observation = events.find((e) => e.phase === 'observation');
    expect(observation?.text).toContain('被拒绝');
  });

  it('决策连续解析失败（能力类 400）→ 降级旧路径并写进程级记忆', async () => {
    const outcome = await runReactiveOps({
      instruction: '任意',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        new Error('400 Thinking mode does not support this tool_choice'),
        new Error('400 Thinking mode does not support this tool_choice'),
      ]),
      modelId: 'thinking-test-model',
      rules: [],
    });
    expect(outcome.kind).toBe('fallback');
    if (outcome.kind !== 'fallback') return;
    expect(outcome.reason).toContain('tool_choice');
  });

  it('轮次耗尽兜底：已执行的部分保留，summary 说明上限', async () => {
    // 每轮都执行一个合法 op 且从不 done → MAX_REACT_TURNS 轮后被强制收束
    const decisions = Array.from({ length: MAX_REACT_TURNS + 2 }, () => ({
      thought: '继续追加',
      done: false,
      op: { type: 'appendRow', cells: { 名称: `row${Math.random()}` } },
    }));
    const outcome = await runReactiveOps({
      instruction: '一直追加',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM(decisions),
      modelId: 'test-model',
      rules: [],
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.report).toHaveLength(MAX_REACT_TURNS);
    expect(outcome.summary).toContain('上限');
  });

  it('执行器抛 TableOpsError（非能力类）→ 观察回喂，不降级', async () => {
    const events: TableOpsProgressEvent[] = [];
    const outcome = await runReactiveOps({
      instruction: '删列',
      sheetText: SHEET_TEXT,
      overview: '概览',
      llm: makeLLM([
        { thought: '删不存在的列', done: false, op: { type: 'deleteColumn', column: '不存在' } },
        { thought: '放弃', done: true, summary: '该列不存在，无法删除' },
      ]),
      modelId: 'test-model',
      rules: [],
      onProgress: (e) => events.push(e),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.report).toHaveLength(0);
    // 失败观察带可读原因（无"第 1 步失败："前缀）
    const observation = events.find((e) => e.phase === 'observation');
    expect(observation?.text).toContain('执行失败');
    expect(observation?.text).not.toContain('第 1 步失败');
  });
});
