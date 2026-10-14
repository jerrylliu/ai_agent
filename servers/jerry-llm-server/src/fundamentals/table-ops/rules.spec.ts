/**
 * table-ops/rules.spec.ts - 表格规则引擎测试
 *
 * 覆盖：5 类规则检查（非空/白名单/数值范围/唯一/公式）、修复三类动作
 *       （固定值/公式重算/删行）、失效规则（列不存在/表达式错误不中断）、
 *       多规则修复的行号安全（改写先行、删行最后从大到小）、
 *       违规截断护栏、列级统计、parseTableRuleJson 脏数据兜底、
 *       diffViolations（门禁"只拒绝新增违规"的多重集差集）。
 */
import {
  checkRules,
  applyRuleFixes,
  buildColumnStats,
  columnStatsToOverview,
  diffViolations,
  parseTableRuleJson,
  type RuleViolation,
  type TableRuleRuntime,
} from './rules';

/** 快捷构造：单 sheet 的 sheetText */
function singleSheetText(headers: string, ...rows: string[]): string {
  return `Sheet: 测试\n${headers}\n${rows.join('\n')}`;
}

// ==================== 汇总行声明式跳过 ====================

describe('checkRules / buildColumnStats - 汇总行跳过', () => {
  // 表头第 3 行，明细 3 行，总计在第 7 行（声明 TotalRow: 7）；
  // 总计行销售员留空、区域是"总计"（白名单外）、销售额 600（超明细上限）
  const text = [
    'Sheet: 测试',
    'HeaderRow: 3',
    'TotalRow: 7',
    '销售汇总报告,',
    '2026-10-01 ~ 2026-10-11,',
    '区域,销售员,销售额',
    '华南,甲,100',
    '华北,乙,200',
    '华南,丙,300',
    '总计,,600',
  ].join('\n');

  it('notEmpty：总行留空的格不违规', () => {
    const rules: TableRuleRuntime[] = [
      { id: 1, name: '销售员不能留空', type: 'notEmpty', params: { column: '销售员' } },
    ];
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(0);
  });

  it('allowedValues：总行"总计"标签不在白名单也不违规', () => {
    const rules: TableRuleRuntime[] = [
      { id: 2, name: '区域白名单', type: 'allowedValues', params: { column: '区域', values: ['华南', '华北'] } },
    ];
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(0);
  });

  it('numericRange：总行 600 超上限不违规', () => {
    const rules: TableRuleRuntime[] = [
      { id: 3, name: '销售额上限', type: 'numericRange', params: { column: '销售额', max: 500 } },
    ];
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(0);
  });

  it('unique：总行与明细行同值不算重复', () => {
    const dupText = text.replace('总计,,600', '总计,甲,600');
    const rules: TableRuleRuntime[] = [
      { id: 4, name: '销售员唯一', type: 'unique', params: { column: '销售员' } },
    ];
    const result = checkRules(dupText, rules);
    expect(result.violations).toHaveLength(0);
  });

  it('formula：总行不满足明细公式不违规（总行=明细合计，天然不满足）', () => {
    const fText = [
      'Sheet: 测试',
      'HeaderRow: 3',
      'TotalRow: 7',
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品,数量,单价,销售额',
      'a,2,10,20',
      'b,3,5,15',
      'c,1,4,4',
      '总计,6,5800,600',
    ].join('\n');
    const rules: TableRuleRuntime[] = [
      { id: 5, name: '销售额公式', type: 'formula', params: { targetColumn: '销售额', expression: '[数量]*[单价]' } },
    ];
    const result = checkRules(fText, rules);
    expect(result.violations).toHaveLength(0);
  });

  it('buildColumnStats：总行不计入行数/空值率/数值分布（防统计污染）', () => {
    const stats = buildColumnStats(text);
    const sales = stats[0].columns.find((c) => c.column === '销售额')!;
    const seller = stats[0].columns.find((c) => c.column === '销售员')!;
    expect(sales.totalRows).toBe(3);
    expect(sales.numericMax).toBe(300); // 600 被排除
    expect(seller.emptyCount).toBe(0); // 总行空格不算空值率
  });
});

describe('checkRules - notEmpty 非空', () => {
  const rules: TableRuleRuntime[] = [
    { id: 1, name: '区域不能留空', type: 'notEmpty', params: { column: '区域' } },
  ];

  it('空单元格违规，行号从 1 起且不含表头', () => {
    const text = singleSheetText('区域,销售额', ',100', '华南,200', '  ,300');
    const result = checkRules(text, rules);
    expect(result.checkedRules).toBe(1);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toMatchObject({
      ruleId: 1,
      ruleName: '区域不能留空',
      ruleType: 'notEmpty',
      rowIndex: 1,
      column: '区域',
      expectation: '不能留空',
      fixable: false,
    });
    // "  " 纯空格也算空
    expect(result.violations[1].rowIndex).toBe(3);
    expect(result.invalidRules).toHaveLength(0);
  });

  it('规则绑定的列不存在 → 归入 invalidRules（标红，不静默跳过）', () => {
    const text = singleSheetText('名称,销售额', 'a,100');
    const result = checkRules(text, rules);
    expect(result.checkedRules).toBe(0);
    expect(result.violations).toHaveLength(0);
    expect(result.invalidRules).toEqual([
      { ruleId: 1, ruleName: '区域不能留空', reason: expect.stringContaining('找不到列') },
    ]);
  });
});

describe('checkRules - allowedValues 白名单', () => {
  const rules: TableRuleRuntime[] = [
    {
      id: 2,
      name: '区域取值受限',
      type: 'allowedValues',
      params: { column: '区域', values: ['华南', '华北'] },
    },
  ];

  it('不在白名单内违规；空值跳过（空值归非空规则管）', () => {
    const text = singleSheetText('区域', '华南', '东北', '', '华北');
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rowIndex).toBe(2);
    expect(result.violations[0].currentValue).toBe('东北');
    expect(result.violations[0].expectation).toContain('华南/华北');
  });
});

describe('checkRules - numericRange 数值范围', () => {
  it('min~max 越界违规；非数字违规；空值跳过', () => {
    const rules: TableRuleRuntime[] = [
      {
        id: 3,
        name: '销售额范围',
        type: 'numericRange',
        params: { column: '销售额', min: 0, max: 10000 },
      },
    ];
    const text = singleSheetText('销售额', '500', '-10', '99999', 'abc', '');
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(3);
    // -10 越下界
    expect(result.violations[0].rowIndex).toBe(2);
    expect(result.violations[0].expectation).toContain('0 ~ 10000');
    // 99999 越上界
    expect(result.violations[1].rowIndex).toBe(3);
    // abc 不是数字
    expect(result.violations[2].currentValue).toBe('abc');
    expect(result.violations[2].expectation).toContain('不是数字');
    // 第 5 行空值跳过
    expect(result.violations.some((v) => v.rowIndex === 5)).toBe(false);
  });

  it('只设 min / 只设 max 的单边范围', () => {
    const minOnly: TableRuleRuntime[] = [
      { id: 4, name: '下限', type: 'numericRange', params: { column: '数量', min: 1 } },
    ];
    const result = checkRules(singleSheetText('数量', '5', '-3', ''), minOnly);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rowIndex).toBe(2);
    expect(result.violations[0].expectation).toContain('≥ 1');

    const maxOnly: TableRuleRuntime[] = [
      { id: 5, name: '上限', type: 'numericRange', params: { column: '数量', max: 100 } },
    ];
    const result2 = checkRules(singleSheetText('数量', '50', '200'), maxOnly);
    expect(result2.violations).toHaveLength(1);
    expect(result2.violations[0].rowIndex).toBe(2);
    expect(result2.violations[0].expectation).toContain('≤ 100');
  });
});

describe('checkRules - unique 唯一性', () => {
  const rules: TableRuleRuntime[] = [
    { id: 6, name: '订单号唯一', type: 'unique', params: { column: '订单号' } },
  ];

  it('重复出现（首次除外）即违规，且指明与第几行重复；空值不参与比对', () => {
    // 注：空行会被 CSV 解析跳过，空单元格行必须写成 ','（两个空字段）
    const text = singleSheetText('订单号', 'A001', 'A002', 'A001', ',', 'A002', ',');
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].rowIndex).toBe(3);
    expect(result.violations[0].expectation).toContain('与第 1 行重复');
    expect(result.violations[1].rowIndex).toBe(5);
    expect(result.violations[1].expectation).toContain('与第 2 行重复');
  });
});

describe('checkRules - formula 跨列公式', () => {
  const rules: TableRuleRuntime[] = [
    {
      id: 7,
      name: '销售额=数量×单价',
      type: 'formula',
      params: { targetColumn: '销售额', expression: '[数量]*[单价]' },
    },
  ];

  it('目标列与表达式不符违规；容差 0.01 内通过；无法计算的行跳过', () => {
    const text = singleSheetText(
      '数量,单价,销售额',
      '2,3,6', // 一致
      '4,5,20.005', // |20.005-20|=0.005 容差内
      '4,5,19', // 不符 → 违规
      'x,y,9', // 引用列非数字 → 无法计算，跳过
      '1,0,5', // 计算得 0，与 5 不符 → 违规
    );
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].rowIndex).toBe(3);
    expect(result.violations[0].expectation).toContain('销售额 = [数量]*[单价]');
    expect(result.violations[1].rowIndex).toBe(5);
  });

  it('目标列为空算违规（可用公式修复补数）', () => {
    const text = singleSheetText('数量,单价,销售额', '4,5,');
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rowIndex).toBe(1);
    expect(result.violations[0].column).toBe('销售额');
  });

  it('表达式语法错误 / 引用列缺失 → 规则失效不中断', () => {
    const badSyntax: TableRuleRuntime[] = [
      { id: 8, name: '语法错', type: 'formula', params: { targetColumn: '销售额', expression: '[数量]*+' } },
    ];
    const r1 = checkRules(singleSheetText('数量,单价,销售额', '1,2,3'), badSyntax);
    expect(r1.invalidRules).toHaveLength(1);
    expect(r1.violations).toHaveLength(0);

    const missingRef: TableRuleRuntime[] = [
      { id: 9, name: '引用缺失', type: 'formula', params: { targetColumn: '销售额', expression: '[库存]*[单价]' } },
    ];
    const r2 = checkRules(singleSheetText('数量,单价,销售额', '1,2,3'), missingRef);
    expect(r2.invalidRules[0].ruleId).toBe(9);
    expect(r2.invalidRules[0].reason).toContain('找不到列');
  });
});

describe('checkRules - 护栏', () => {
  it('违规超过 1000 条 → 截断并标记 truncated', () => {
    const rows = Array.from({ length: 1001 }, () => ',');
    const text = `Sheet: 大表\n区域,数量\n${rows.join('\n')}`;
    const rules: TableRuleRuntime[] = [
      { id: 10, name: '区域非空', type: 'notEmpty', params: { column: '区域' } },
    ];
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('恰好 1000 条违规（无丢弃）→ truncated 保持 false', () => {
    const rows = Array.from({ length: 1000 }, () => ',');
    const text = `Sheet: 大表\n区域,数量\n${rows.join('\n')}`;
    const rules: TableRuleRuntime[] = [
      { id: 12, name: '区域非空', type: 'notEmpty', params: { column: '区域' } },
    ];
    const result = checkRules(text, rules);
    expect(result.violations).toHaveLength(1000);
    expect(result.truncated).toBe(false);
  });

  it('无违规时 truncated 为 false', () => {
    const rules: TableRuleRuntime[] = [
      { id: 11, name: '区域非空', type: 'notEmpty', params: { column: '区域' } },
    ];
    const result = checkRules(singleSheetText('区域', '华南'), rules);
    expect(result.truncated).toBe(false);
  });
});

describe('applyRuleFixes - 修复动作', () => {
  it('fixedValue：违规单元格改写为固定值', () => {
    const text = singleSheetText('区域,数量', ',10', '华南,20', ',30');
    const rules: TableRuleRuntime[] = [
      {
        id: 20,
        name: '区域非空',
        type: 'notEmpty',
        params: { column: '区域' },
        fixAction: { kind: 'fixedValue', value: '未知' },
      },
    ];
    const check = checkRules(text, rules);
    expect(check.violations).toHaveLength(2);
    const { sheetText, report } = applyRuleFixes(text, rules, check.violations);
    const lines = sheetText.split('\n');
    expect(lines[2]).toBe('未知,10');
    expect(lines[3]).toBe('华南,20');
    expect(lines[4]).toBe('未知,30');
    expect(report[0].message).toContain('2 个违规单元格');
  });

  it('formula：按表达式重算违规单元格；无法计算的行跳过', () => {
    const text = singleSheetText('数量,单价,销售额', '2,3,99', '4,5,19', 'x,y,9');
    const rules: TableRuleRuntime[] = [
      {
        id: 21,
        name: '销售额=数量×单价',
        type: 'formula',
        params: { targetColumn: '销售额', expression: '[数量]*[单价]' },
        fixAction: { kind: 'formula', expression: '[数量]*[单价]' },
      },
    ];
    const check = checkRules(text, rules);
    // 第 3 行引用列非数字 → 检查期跳过不违规，只有第 1、2 行违规
    expect(check.violations.map((v) => v.rowIndex)).toEqual([1, 2]);
    const { sheetText, report } = applyRuleFixes(text, rules, check.violations);
    const lines = sheetText.split('\n');
    expect(lines[2]).toBe('2,3,6');
    expect(lines[3]).toBe('4,5,20');
    // 第 4 行未被误改
    expect(lines[4]).toBe('x,y,9');
    expect(report[0].message).toContain('重算 2 行');
  });

  it('deleteRow：删行修复；违规行号在删行前列表内有效', () => {
    const text = singleSheetText('区域,数量', '华南,-5', '华北,10', '东北,-1');
    const rules: TableRuleRuntime[] = [
      {
        id: 22,
        name: '数量非负',
        type: 'numericRange',
        params: { column: '数量', min: 0 },
        fixAction: { kind: 'deleteRow' },
      },
    ];
    const check = checkRules(text, rules);
    expect(check.violations.map((v) => v.rowIndex)).toEqual([1, 3]);
    const { sheetText, report } = applyRuleFixes(text, rules, check.violations);
    const lines = sheetText.split('\n');
    expect(lines).toHaveLength(3); // Sheet 标题 + 表头 + 剩余 1 行
    expect(lines[2]).toBe('华北,10');
    expect(report[0].message).toContain('删除 2 行');
  });

  it('未配置修复动作 → 只标记不修复', () => {
    const text = singleSheetText('区域,数量', ',10');
    const rules: TableRuleRuntime[] = [
      { id: 23, name: '区域非空', type: 'notEmpty', params: { column: '区域' } },
    ];
    const check = checkRules(text, rules);
    const { sheetText, report } = applyRuleFixes(text, rules, check.violations);
    expect(sheetText).toBe(text); // 原文未动
    expect(report[0].message).toContain('未配置修复动作');
  });

  it('多规则混合修复：改写类先行、删行类最后从大到小删除（行号安全）', () => {
    // 行1 区域空+销售额负、行2 正常、行3 销售额非数字、行4 区域空
    const text = singleSheetText(
      '区域,销售额',
      ',-100',
      '华北,200',
      '华南,abc',
      ',300',
    );
    const rules: TableRuleRuntime[] = [
      {
        id: 30,
        name: '区域非空',
        type: 'notEmpty',
        params: { column: '区域' },
        fixAction: { kind: 'fixedValue', value: '未知' },
      },
      {
        id: 31,
        name: '销售额必须为非负数字',
        type: 'numericRange',
        params: { column: '销售额', min: 0 },
        fixAction: { kind: 'deleteRow' },
      },
    ];
    const check = checkRules(text, rules);
    // 行1 两规则都违规；行3、行4 各违反其一
    // violations 按规则顺序分组产出（先规则 30 全部，再规则 31 全部）
    expect(check.violations.map((v) => [v.ruleId, v.rowIndex])).toEqual([
      [30, 1],
      [30, 4],
      [31, 1],
      [31, 3],
    ]);
    const { sheetText } = applyRuleFixes(text, rules, check.violations);
    const lines = sheetText.split('\n');
    // 行1：区域先改写为"未知"，随后因销售额 -100 被删 → 不存在
    // 行3：销售额 abc 被删；行4：区域改写"未知"后保留
    expect(lines).toHaveLength(4); // 标题 + 表头 + 行2 + 行4
    expect(lines[2]).toBe('华北,200');
    expect(lines[3]).toBe('未知,300');
    expect(sheetText).not.toContain('-100');
    expect(sheetText).not.toContain('abc');
  });

  it('修复期目标列又被改名 → 该规则修复失败但不中断其他规则', () => {
    // 文本中"区域"列存在，但规则改用别的列名触发修复失败
    const text = singleSheetText('区域,数量', ',10', '华南,20');
    const rules: TableRuleRuntime[] = [
      {
        id: 40,
        name: '区域非空',
        type: 'notEmpty',
        params: { column: '区域' },
        fixAction: { kind: 'fixedValue', value: '未知' },
      },
      {
        id: 41,
        name: '备注非空（列已不存在）',
        type: 'notEmpty',
        params: { column: '备注' },
        fixAction: { kind: 'fixedValue', value: '待补' },
      },
    ];
    const check = checkRules(text, rules);
    // 检查期：备注列不存在 → 规则 41 失效，只有规则 40 有违规
    expect(check.invalidRules).toHaveLength(1);
    expect(check.violations).toHaveLength(1);
    const { sheetText, report } = applyRuleFixes(text, rules, check.violations);
    // 规则 40 正常修复
    expect(sheetText).toContain('未知,10');
    // 规则 41 无违规 → 不出现在报告中（按规则分组，无违规跳过）
    expect(report).toHaveLength(1);
  });
});

describe('buildColumnStats / columnStatsToOverview', () => {
  it('统计空值率、去重值、数值分布', () => {
    // 注：空行会被 CSV 解析跳过，空单元格行必须写成 ','（两个空字段）
    const text = singleSheetText(
      '区域,销售额',
      '华南,100',
      ',',
      '华南,abc',
      '华北,900',
      '华南,',
    );
    const stats = buildColumnStats(text);
    expect(stats).toHaveLength(1);
    expect(stats[0].sheetName).toBe('测试');
    const [region, amount] = stats[0].columns;
    expect(region).toMatchObject({
      column: '区域',
      totalRows: 5,
      emptyCount: 1,
      distinctCount: 2,
    });
    expect(region.distinctValues).toEqual(['华南', '华北']); // 按出现次数降序
    expect(amount).toMatchObject({
      column: '销售额',
      emptyCount: 2,
      numericCount: 2,
      numericMin: 100,
      numericMax: 900,
    });
  });

  it('columnStatsToOverview 输出紧凑人读文本', () => {
    const text = singleSheetText('区域,销售额', '华南,100', '华北,200');
    const overview = columnStatsToOverview(buildColumnStats(text));
    expect(overview).toContain('工作表「测试」');
    expect(overview).toContain('- 区域：');
    expect(overview).toContain('- 销售额：');
    expect(overview).toContain('数字 2 个');
    expect(overview).toContain('取值：华南/华北');
  });
});

describe('parseTableRuleJson - 脏数据兜底', () => {
  it('合法 paramsJson + fixActionJson → 完整运行时规则', () => {
    const rule = parseTableRuleJson(
      1,
      '销售额范围',
      'numericRange',
      JSON.stringify({ column: '销售额', min: 0, max: 100 }),
      JSON.stringify({ kind: 'deleteRow' }),
    );
    expect(rule).toEqual({
      id: 1,
      name: '销售额范围',
      type: 'numericRange',
      params: { column: '销售额', min: 0, max: 100 },
      fixAction: { kind: 'deleteRow' },
    });
  });

  it('fixActionJson 为 null → 无修复动作', () => {
    const rule = parseTableRuleJson(2, '非空', 'notEmpty', JSON.stringify({ column: '区域' }), null);
    expect(rule).toEqual({
      id: 2,
      name: '非空',
      type: 'notEmpty',
      params: { column: '区域' },
    });
    expect(rule?.fixAction).toBeUndefined();
  });

  it('paramsJson 非法 JSON / 校验不过 / type 不认识 → 返回 null 不抛错', () => {
    expect(parseTableRuleJson(3, 'x', 'notEmpty', '{broken', null)).toBeNull();
    // params 缺 column 字段
    expect(parseTableRuleJson(4, 'x', 'notEmpty', JSON.stringify({ min: 1 }), null)).toBeNull();
    // 未知的规则类型
    expect(parseTableRuleJson(5, 'x', 'unknownType', JSON.stringify({}), null)).toBeNull();
    // fixAction 形状非法
    expect(
      parseTableRuleJson(
        6,
        'x',
        'notEmpty',
        JSON.stringify({ column: '区域' }),
        JSON.stringify({ kind: 'noSuchKind' }),
      ),
    ).toBeNull();
  });

  it('带 targetSheet → 运行时规则携带绑定的工作表名', () => {
    const rule = parseTableRuleJson(
      7,
      '明细区域不能留空',
      'notEmpty',
      JSON.stringify({ column: '区域' }),
      null,
      '销售明细',
    );
    expect(rule).toEqual({
      id: 7,
      name: '明细区域不能留空',
      type: 'notEmpty',
      params: { column: '区域' },
      targetSheet: '销售明细',
    });
    // NULL/空串 → 未绑定（无 targetSheet 键，作用于第一个工作表）
    expect(parseTableRuleJson(8, 'x', 'notEmpty', JSON.stringify({ column: '区域' }), null, null))
      .not.toHaveProperty('targetSheet');
  });
});

// ==================== 多 sheet 工作表绑定（targetSheet） ====================

describe('checkRules - targetSheet 工作表绑定', () => {
  /** 双 sheet 文本：第一个"目标"，第二个"销售明细"（列名与第一个 sheet 互不重叠） */
  const multiText = [
    'Sheet: 目标\n日期,金额\n2026-01-01,100',
    'Sheet: 销售明细\n区域,销售额\n,100\n华南,200',
  ].join('\n\n');

  it('绑定第二个 sheet 的规则检查那张表；未绑定规则检查第一个 sheet', () => {
    const rules: TableRuleRuntime[] = [
      // 未绑定 → 第一个 sheet"目标"，金额 100 在范围内，无违规
      { id: 1, name: '目标金额范围', type: 'numericRange', params: { column: '金额', min: 0, max: 10000 } },
      // 绑定第二个 sheet"销售明细"，第 1 行区域为空
      {
        id: 2,
        name: '明细区域不能留空',
        type: 'notEmpty',
        params: { column: '区域' },
        targetSheet: '销售明细',
      },
    ];
    const result = checkRules(multiText, rules);
    expect(result.invalidRules).toHaveLength(0);
    expect(result.checkedRules).toBe(2);
    // 只有绑定规则产生违规，且违规行号/工作表名都来自"销售明细"
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 2,
      rowIndex: 1,
      column: '区域',
      sheetName: '销售明细',
    });
  });

  it('绑定的工作表不存在 → 归入 invalidRules（不静默跳过）', () => {
    const rules: TableRuleRuntime[] = [
      {
        id: 1,
        name: '明细区域不能留空',
        type: 'notEmpty',
        params: { column: '区域' },
        targetSheet: '不存在表',
      },
    ];
    const result = checkRules(multiText, rules);
    expect(result.checkedRules).toBe(0);
    expect(result.violations).toHaveLength(0);
    expect(result.invalidRules).toEqual([
      { ruleId: 1, ruleName: '明细区域不能留空', reason: expect.stringContaining('找不到工作表') },
    ]);
  });

  it('单 sheet 容错：targetSheet 名字记错仍命中唯一的工作表', () => {
    const rules: TableRuleRuntime[] = [
      {
        id: 1,
        name: '区域不能留空',
        type: 'notEmpty',
        params: { column: '区域' },
        targetSheet: '销售明细表',
      },
    ];
    // 第 2 行区域为空但销售额有值（纯空行会被解析器跳过，不能用空行测空缺）
    const result = checkRules(singleSheetText('区域,销售额', '华南,100', ',200'), rules);
    expect(result.invalidRules).toHaveLength(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rowIndex).toBe(2);
  });
});

describe('applyRuleFixes - 多 sheet 修复', () => {
  it('各规则修复各自绑定的工作表：固定值写对表、删行只删绑定表', () => {
    const rules: TableRuleRuntime[] = [
      // 绑定"目标"：金额越界 → 固定值修复（改写类，不删行）
      {
        id: 1,
        name: '目标金额范围',
        type: 'numericRange',
        params: { column: '金额', min: 0, max: 10000 },
        targetSheet: '目标',
        fixAction: { kind: 'fixedValue', value: '0' },
      },
      // 绑定"销售明细"：区域为空 → 删行
      {
        id: 2,
        name: '明细区域删行',
        type: 'notEmpty',
        params: { column: '区域' },
        targetSheet: '销售明细',
        fixAction: { kind: 'deleteRow' },
      },
    ];
    const text = [
      'Sheet: 目标\n日期,金额\n2026-01-01,-5',
      'Sheet: 销售明细\n区域,销售额\n,100\n华南,200',
    ].join('\n\n');

    const check = checkRules(text, rules);
    expect(check.violations).toHaveLength(2);
    // 默认字符串排序：目(U+76EE) < 销(U+9500)
    expect(check.violations.map((v) => v.sheetName).sort()).toEqual(['目标', '销售明细']);

    const result = applyRuleFixes(text, rules, check.violations);
    // 无修复失败报告
    expect(result.report.every((r) => !r.message.startsWith('修复失败'))).toBe(true);
    // 目标 sheet：-5 被固定值改写为 0，数据行数不变（删行没有波及第一个 sheet）
    const blocks = result.sheetText.split('\n\n');
    expect(blocks[0]).toContain('2026-01-01,0');
    // 标题行 + 表头行 + 1 行数据
    expect(blocks[0].trim().split('\n')).toHaveLength(3);
    // 销售明细 sheet：空区域行被删除，只剩华南行
    expect(blocks[1].trim().split('\n')).toEqual(['Sheet: 销售明细', '区域,销售额', '华南,200']);
  });
});

// ==================== diffViolations（门禁"只拒绝新增违规"） ====================

describe('diffViolations - 多重集差集', () => {
  const mk = (over: Partial<RuleViolation>): RuleViolation => ({
    ruleId: 1,
    ruleName: '区域不能留空',
    ruleType: 'notEmpty',
    sheetName: '测试',
    rowIndex: 1,
    column: '区域',
    currentValue: '',
    expectation: '不能留空',
    fixable: false,
    ...over,
  });

  it('after 与 before 完全一致 → 无新增', () => {
    const list = [mk({}), mk({ rowIndex: 2, currentValue: 'x', expectation: '应为 A/B 之一' })];
    expect(diffViolations(list, list.map((v) => ({ ...v })))).toEqual([]);
  });

  it('after 多出的违规 → 报告为新增', () => {
    const before = [mk({})];
    const after = [mk({}), mk({ rowIndex: 3 })];
    expect(diffViolations(before, after).map((v) => v.rowIndex)).toEqual([3]);
  });

  it('行号位移但内容相同（删行后整体上移）→ 不算新增（键不含行号）', () => {
    const before = [mk({ rowIndex: 5, currentValue: '脏值' })];
    const after = [mk({ rowIndex: 4, currentValue: '脏值' })];
    expect(diffViolations(before, after)).toEqual([]);
  });

  it('同内容违规数量增加 → 增量部分报为新增（多重集而非集合）', () => {
    const before = [mk({})];
    const after = [mk({}), mk({ rowIndex: 9 })];
    expect(diffViolations(before, after)).toHaveLength(1);
  });

  it('同内容违规数量减少 → 无新增（修好了不算坏事）', () => {
    const before = [mk({}), mk({ rowIndex: 2 })];
    const after = [mk({ rowIndex: 2 })];
    expect(diffViolations(before, after)).toEqual([]);
  });

  it('不同规则/不同列的相似违规不互抵（键含 ruleId 与列名）', () => {
    const before = [mk({ ruleId: 1, column: '区域' })];
    const after = [mk({ ruleId: 2, column: '负责人', ruleName: '负责人不能留空' })];
    expect(diffViolations(before, after)).toHaveLength(1);
  });
});
