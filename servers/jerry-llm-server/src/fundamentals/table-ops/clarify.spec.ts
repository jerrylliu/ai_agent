/**
 * table-ops/clarify.spec.ts - clarify 反问确认协议测试
 *
 * 覆盖：完备性闸门（semanticFill 一律转反问 / lookupFill 键缺失与重合率 /
 *       无条件更新 / 无条件删除拒绝 / 大范围删除预览 / 公式覆盖预览 / 跨表聚合
 *       无数字反问）、载荷分析器（fill-source 列分组与跨表候选 / join-key 候选键 /
 *       condition 值分布 / destructive-preview / formula-preview）、
 *       策略编译器（addColumn 前置 / confirm-pending 内嵌 / keep-empty）、
 *       baseOps/pendingOps 切分拼回、hash 稳定性。
 */
import {
  checkOpsCompleteness,
  buildClarifyPayload,
  compileStrategies,
  hashSheetText,
  StrategySchema,
  type GateResult,
} from './clarify';
import type { TableOp } from './schema';

/** 两表 fixture：表二.数量a 待按名称从表1关联填充（名称重合率 2/3 ≈ 67% > 60%） */
const TWO_SHEETS = [
  'Sheet: 表1',
  '名称,数量',
  '椅子,10',
  '桌子,5',
  '',
  'Sheet: 表二',
  '名称,数量a',
  '椅子,',
  '桌子,',
  '灯,',
].join('\n');

/** clarify 闸门断言的类型收窄辅助 */
function expectClarify(result: GateResult): Extract<GateResult, { action: 'clarify' }> {
  expect(result).not.toBeNull();
  expect((result as { action: string }).action).toBe('clarify');
  return result as Extract<GateResult, { action: 'clarify' }>;
}

// ==================== 完备性闸门 ====================

describe('checkOpsCompleteness - 闸门', () => {
  it('semanticFill 一律转 fill-source 反问（决策 3：推断型填充永不静默执行）', () => {
    const gate = expectClarify(
      checkOpsCompleteness(TWO_SHEETS, [{ type: 'semanticFill', targetColumn: '数量a' }]),
    );
    expect(gate.kind).toBe('fill-source');
    expect(gate.opIndex).toBe(0);
  });

  it('lookupFill 键重合率达标 → 放行（闸门不拦可信关联）', () => {
    const result = checkOpsCompleteness(TWO_SHEETS, [
      {
        type: 'lookupFill',
        targetSheet: '表二',
        targetColumn: '数量a',
        sourceSheet: '表1',
        sourceKeyColumn: '名称',
        sourceValueColumn: '数量',
        targetKeyColumn: '名称',
      },
    ]);
    // 名称重合率 = 2/3 ≈ 0.67 ≥ 0.6
    expect(result).toBeNull();
  });

  it('lookupFill 关联键可疑（重合率过低）→ 转 join-key 反问', () => {
    const gate = expectClarify(
      checkOpsCompleteness(TWO_SHEETS, [
        {
          type: 'lookupFill',
          targetSheet: '表二',
          targetColumn: '数量a',
          sourceSheet: '表1',
          sourceKeyColumn: '数量', // 表1.数量 {10,5} 与 表二.名称 {椅子,桌子,灯} 零重合
          sourceValueColumn: '名称',
          targetKeyColumn: '名称',
        },
      ]),
    );
    expect(gate.kind).toBe('join-key');
    expect(gate.reason).toContain('%');
  });

  it('lookupFill 键缺失（单键复合键都没给）→ 转 join-key 反问', () => {
    const gate = expectClarify(
      checkOpsCompleteness(TWO_SHEETS, [
        {
          type: 'lookupFill',
          targetSheet: '表二',
          targetColumn: '数量a',
          sourceSheet: '表1',
          sourceValueColumn: '数量',
        },
      ]),
    );
    expect(gate.kind).toBe('join-key');
    expect(gate.reason).toContain('关联');
  });

  it('updateCells 无条件且目标列存在 → 转 condition 反问', () => {
    const gate = expectClarify(
      checkOpsCompleteness(TWO_SHEETS, [
        { type: 'updateCells', targetSheet: '表二', targetColumn: '数量a', newValue: '1' },
      ]),
    );
    expect(gate.kind).toBe('condition');
  });

  it('updateCells 无条件但目标列不存在 → 放行（validateOp 报可读错误，不掩盖真实问题）', () => {
    expect(
      checkOpsCompleteness(TWO_SHEETS, [
        { type: 'updateCells', targetSheet: '表二', targetColumn: '不存在列', newValue: '1' },
      ]),
    ).toBeNull();
  });

  it('updateCells 带条件 → 放行', () => {
    expect(
      checkOpsCompleteness(TWO_SHEETS, [
        {
          type: 'updateCells',
          targetSheet: '表二',
          targetColumn: '数量a',
          where: { column: '名称', op: 'eq', value: '椅子' },
          newValue: '1',
        },
      ]),
    ).toBeNull();
  });

  it('deleteRows 无条件 → 直接拒绝（整表删除不可确认后执行）', () => {
    // where 在 schema 层必填（confirm 端点内嵌 op 也过不了校验）；本用例验证
    // 闸门对"绕过 schema 的兜底路径"的防御，故用 cast 构造非法 op
    const result = checkOpsCompleteness(TWO_SHEETS, [
      { type: 'deleteRows', targetSheet: '表二' } as TableOp,
    ]);
    expect(result).not.toBeNull();
    expect((result as { action: string }).action).toBe('reject');
    expect((result as { reason: string }).reason).toContain('必须指明条件');
  });

  it('deleteRows 条件命中少 → 放行；命中超过 max(20, 30%) → 转 destructive-preview', () => {
    const small = checkOpsCompleteness(TWO_SHEETS, [
      { type: 'deleteRows', targetSheet: '表二', where: { column: '名称', op: 'eq', value: '椅子' } },
    ]);
    expect(small).toBeNull();

    // 40 行数据全命中：threshold = max(20, ceil(40*0.3)=12) = 20，40 > 20
    const bigRows = Array.from({ length: 40 }, () => 'A,1');
    const bigText = `Sheet: 大表\n类别,数量\n${bigRows.join('\n')}`;
    const gate = expectClarify(
      checkOpsCompleteness(bigText, [
        { type: 'deleteRows', targetSheet: '大表', where: { column: '类别', op: 'eq', value: 'A' } },
      ]),
    );
    expect(gate.kind).toBe('destructive-preview');
    expect(gate.reason).toContain('40');
  });

  it('deriveColumn 试算覆盖非空格 → 转 formula-preview；全新列（无覆盖）→ 放行', () => {
    const gate = expectClarify(
      checkOpsCompleteness(TWO_SHEETS, [
        {
          type: 'deriveColumn',
          targetSheet: '表1',
          targetColumn: '数量',
          expression: '[数量]*2',
        },
      ]),
    );
    expect(gate.kind).toBe('formula-preview');

    expect(
      checkOpsCompleteness(TWO_SHEETS, [
        { type: 'deriveColumn', targetSheet: '表1', targetColumn: '翻倍', expression: '[数量]*2' },
      ]),
    ).toBeNull();
  });

  it('跨表聚合来源列无数字 → 转 aggregate-scope 反问；同表重算不拦（既定契约）', () => {
    const gate = expectClarify(
      checkOpsCompleteness(TWO_SHEETS, [
        {
          type: 'aggregateAppendRow',
          targetSheet: '表二',
          sourceSheet: '表二',
          column: '数量a', // 全空
          fn: 'sum',
          label: 'x',
        },
      ]),
    );
    expect(gate.kind).toBe('aggregate-scope');

    // 同表（无 sourceSheet）重算走"上方全部行求和"契约，闸门不拦
    expect(
      checkOpsCompleteness(TWO_SHEETS, [
        { type: 'aggregateUpdateCell', targetSheet: '表二', rowLabel: '灯', column: '数量a', fn: 'sum' },
      ]),
    ).toBeNull();
  });

  it('多 op 计划：第一个违规 op 的 opIndex 被返回', () => {
    const gate = expectClarify(
      checkOpsCompleteness(TWO_SHEETS, [
        { type: 'addColumn', targetSheet: '表二', header: '新列' },
        { type: 'semanticFill', targetSheet: '表二', targetColumn: '新列' },
        { type: 'updateCells', targetSheet: '表二', targetColumn: '名称', newValue: 'x' },
      ]),
    );
    expect(gate.opIndex).toBe(1);
  });

  it('解析失败/空表 → null（交给执行器报可读错误）', () => {
    // 同上：无条件 deleteRows 经 cast 构造，验证空文本短路逻辑
    expect(checkOpsCompleteness('', [{ type: 'deleteRows' } as TableOp])).toBeNull();
  });
});

// ==================== 载荷分析器 ====================

describe('buildClarifyPayload - 分析器', () => {
  it('fill-source：按列分组统计空缺，兜底三件套齐全', () => {
    // 表一.数量 无空缺；表二.数量a 有 3 格空缺
    const payload = buildClarifyPayload(
      TWO_SHEETS,
      { action: 'clarify', kind: 'fill-source', opIndex: 0, reason: 'r' },
      [{ type: 'semanticFill', targetSheet: '表二', targetColumn: '数量a' }],
    );
    expect(payload.kind).toBe('fill-source');
    expect(payload.columns).toHaveLength(1);
    const group = payload.columns![0];
    expect(group.column).toBe('数量a');
    expect(group.gapCount).toBe(3);
    const ids = group.candidates.map((c) => c.id);
    expect(ids.some((id) => id.startsWith('ai:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('const:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('skip:'))).toBe(true);
    // 每个 candidate 都是合法 Strategy（前端原样回传需能过 ConfirmRequestSchema）
    for (const c of group.candidates) {
      expect(() => StrategySchema.parse(c.strategy)).not.toThrow();
    }
  });

  it('fill-source 跨表同名列：给出 cross-sheet-lookup 候选（键达标才提供）', () => {
    const cross = [
      'Sheet: 表一',
      '名称,a1',
      '椅子,10',
      '桌子,5',
      '',
      'Sheet: 表二',
      '名称,a1',
      '椅子,',
      '桌子,',
      '灯,',
    ].join('\n');
    const payload = buildClarifyPayload(
      cross,
      { action: 'clarify', kind: 'fill-source', opIndex: 0, reason: 'r' },
      [{ type: 'semanticFill', targetSheet: '表二', targetColumn: 'a1' }],
    );
    const group = payload.columns![0];
    const lookup = group.candidates.find((c) => c.id.startsWith('lookup:'));
    expect(lookup).toBeDefined();
    if (!lookup || lookup.strategy.type !== 'cross-sheet-lookup') return;
    expect(lookup.strategy.sourceSheet).toBe('表一');
    expect(lookup.strategy.sourceKeyColumn).toBe('名称');
    expect(lookup.strategy.targetKeyColumn).toBe('名称');
  });

  it('join-key：候选键对降序（同名列置顶），选项可编译回合法 op', () => {
    const payload = buildClarifyPayload(
      TWO_SHEETS,
      { action: 'clarify', kind: 'join-key', opIndex: 0, reason: 'r' },
      [
        {
          type: 'lookupFill',
          targetSheet: '表二',
          targetColumn: '数量a',
          sourceSheet: '表1',
          sourceKeyColumn: '数量', // 故意给错键
          sourceValueColumn: '数量',
          targetKeyColumn: '名称',
        },
      ],
    );
    expect(payload.kind).toBe('join-key');
    expect(payload.keyCandidates!.length).toBeGreaterThan(0);
    // 同名键对 名称↔名称 置顶且重合率 2/3
    const top = payload.keyCandidates![0];
    expect(top.targetKeyColumn).toBe('名称');
    expect(top.sourceKeyColumn).toBe('名称');
    expect(top.overlapRate).toBeCloseTo(2 / 3, 5);
    // 选项 strategy 可过 schema 校验
    for (const opt of payload.options ?? []) {
      expect(() => StrategySchema.parse(opt.strategy)).not.toThrow();
    }
  });

  it('condition：值分布降序 + 逐值/空格/全列选项', () => {
    const text = [
      'Sheet: 表',
      '类别,数值',
      'A,1',
      'A,2',
      'B,3',
      ',4',
    ].join('\n');
    const payload = buildClarifyPayload(
      text,
      { action: 'clarify', kind: 'condition', opIndex: 0, reason: 'r' },
      [{ type: 'updateCells', targetColumn: '类别', newValue: 'X' }],
    );
    expect(payload.kind).toBe('condition');
    expect(payload.valueDistribution).toEqual([
      { value: 'A', count: 2 },
      { value: 'B', count: 1 },
    ]);
    const labels = payload.options!.map((o) => o.id);
    expect(labels).toEqual(['cond:0', 'cond:1', 'cond:empty', 'cond:all']);
    // 全列兜底 = 原样 op（无条件）
    const all = payload.options![3];
    expect(all.strategy.type).toBe('condition-op');
    if (all.strategy.type === 'condition-op' && all.strategy.op.type === 'updateCells') {
      expect(all.strategy.op.where).toBeUndefined();
    }
  });

  it('destructive-preview：预览行 + 影响数 + 确认选项内嵌原 op', () => {
    const bigRows = Array.from({ length: 25 }, (_, i) => `A,${i}`);
    const text = `Sheet: 大表\n类别,序号\n${bigRows.join('\n')}`;
    const op: TableOp = {
      type: 'deleteRows',
      targetSheet: '大表',
      where: { column: '类别', op: 'eq', value: 'A' },
    };
    const payload = buildClarifyPayload(
      text,
      { action: 'clarify', kind: 'destructive-preview', opIndex: 0, reason: 'r' },
      [op],
    );
    expect(payload.kind).toBe('destructive-preview');
    expect(payload.affectedCount).toBe(25);
    expect(payload.previewRows).toHaveLength(10); // 预览截断前 10 行
    expect(payload.previewHeaders).toEqual(['类别', '序号']);
    const confirm = payload.options![0];
    expect(confirm.strategy.type).toBe('confirm-pending');
    if (confirm.strategy.type === 'confirm-pending') {
      expect(confirm.strategy.op).toEqual(op); // 内嵌被确认的原 op（confirm 时编译执行）
    }
    expect(payload.options![1].strategy.type).toBe('keep-empty');
  });

  it('formula-preview：逐行试算预览 + 确认/只补空格/取消选项', () => {
    const payload = buildClarifyPayload(
      TWO_SHEETS,
      { action: 'clarify', kind: 'formula-preview', opIndex: 0, reason: 'r' },
      [
        {
          type: 'deriveColumn',
          targetSheet: '表1',
          targetColumn: '数量',
          expression: '[数量]*2',
        },
      ],
    );
    expect(payload.kind).toBe('formula-preview');
    expect(payload.affectedCount).toBe(2); // 椅子10/桌子5 两格非空将被覆盖
    expect(payload.previewHeaders).toEqual(['首列值', '当前值', '试算结果']);
    expect(payload.previewRows).toEqual([
      ['椅子', '10', '20'],
      ['桌子', '5', '10'],
    ]);
    const ids = payload.options!.map((o) => o.id);
    expect(ids).toEqual(['formula:confirm', 'formula:only-empty', 'formula:cancel']);
  });

  it('baseOps/pendingOps 切分：确认后拼回完整计划（legacy 多 op 场景）', () => {
    const base: TableOp = { type: 'addColumn', targetSheet: '表二', header: '备注' };
    const pending: TableOp = {
      type: 'updateCells',
      targetSheet: '表二',
      targetColumn: '名称',
      newValue: 'x',
    };
    const payload = buildClarifyPayload(
      TWO_SHEETS,
      { action: 'clarify', kind: 'fill-source', opIndex: 1, reason: 'r' },
      [base, { type: 'semanticFill', targetSheet: '表二', targetColumn: '数量a' }, pending],
    );
    expect(payload.baseOps).toEqual([base]);
    expect(payload.pendingOps).toEqual([pending]);
  });
});

// ==================== 策略编译器 ====================

describe('compileStrategies - 编译器（确认后无 LLM）', () => {
  it('cross-sheet-lookup：目标列已存在 → 只编译 lookupFill', () => {
    const ops = compileStrategies(
      TWO_SHEETS,
      [
        {
          type: 'cross-sheet-lookup',
          targetSheet: '表二',
          targetColumn: '数量a',
          targetKeyColumn: '名称',
          sourceSheet: '表1',
          sourceKeyColumn: '名称',
          sourceValueColumn: '数量',
        },
      ],
      [],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('lookupFill');
  });

  it('cross-sheet-lookup：目标列不存在 → 前置 addColumn（"表二新加一列 a1"场景）', () => {
    const ops = compileStrategies(
      TWO_SHEETS,
      [
        {
          type: 'cross-sheet-lookup',
          targetSheet: '表二',
          targetColumn: 'a1',
          targetKeyColumn: '名称',
          sourceSheet: '表1',
          sourceKeyColumn: '名称',
          sourceValueColumn: '数量',
        },
      ],
      [],
    );
    expect(ops.map((o) => o.type)).toEqual(['addColumn', 'lookupFill']);
    expect(ops[0]).toMatchObject({ type: 'addColumn', targetSheet: '表二', header: 'a1' });
  });

  it('fill-constant → fillConstant；keep-empty → 空', () => {
    expect(
      compileStrategies(
        TWO_SHEETS,
        [{ type: 'fill-constant', targetSheet: '表二', targetColumn: '数量a', value: '0' }],
        [],
      ),
    ).toEqual([{ type: 'fillConstant', targetSheet: '表二', targetColumn: '数量a', value: '0' }]);
    expect(compileStrategies(TWO_SHEETS, [{ type: 'keep-empty' }], [])).toEqual([]);
  });

  it('condition-op / aggregate-op / formula-confirm 原样透传内嵌 op', () => {
    const op: TableOp = {
      type: 'updateCells',
      targetSheet: '表二',
      targetColumn: '数量a',
      where: { column: '名称', op: 'eq', value: '椅子' },
      newValue: '1',
    };
    expect(compileStrategies(TWO_SHEETS, [{ type: 'condition-op', op }], [])).toEqual([op]);
  });

  it('confirm-pending：先执行内嵌原 op，再拼接 pendingOps（删除确认场景）', () => {
    const delOp: TableOp = {
      type: 'deleteRows',
      targetSheet: '表二',
      where: { column: '名称', op: 'eq', value: '灯' },
    };
    const pending: TableOp = { type: 'addColumn', targetSheet: '表二', header: '新列' };
    const ops = compileStrategies(
      TWO_SHEETS,
      [{ type: 'confirm-pending', op: delOp }],
      [pending],
    );
    expect(ops).toEqual([delOp, pending]);
  });

  it('ai-mapping-preview 不编译（服务层先出预览）', () => {
    expect(
      compileStrategies(
        TWO_SHEETS,
        [{ type: 'ai-mapping-preview', targetSheet: '表二', targetColumn: '数量a', basisColumns: [] }],
        [],
      ),
    ).toEqual([]);
  });
});

// ==================== hash（TOCTOU） ====================

describe('hashSheetText', () => {
  it('同一文本稳定，不同文本不同', () => {
    expect(hashSheetText('abc')).toBe(hashSheetText('abc'));
    expect(hashSheetText('abc')).not.toBe(hashSheetText('abd'));
  });
});
