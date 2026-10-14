/**
 * table-ops/executor.spec.ts - 表格指令执行器测试
 *
 * 覆盖：各操作类型的正向执行、数字感知、先校验后执行（引用不存在整体拒绝）、
 *       护栏（超行数/空内容）、round-trip 序列化一致性。
 */
import {
  executeTableOps,
  buildSheetOverview,
  parseSheetData,
  serializeSheetData,
  TableOpsError,
  MAX_DATA_ROWS,
} from './executor';

/** 快捷构造：单 sheet 的 sheetText */
function singleSheetText(headers: string, ...rows: string[]): string {
  return `Sheet: 测试\n${headers}\n${rows.join('\n')}`;
}

describe('executeTableOps - aggregateAppendRow', () => {
  it('sum：求和并追加为新行，数字带千分位逗号也能解析', () => {
    // 注：千分位 "2,500" 在 CSV 中会被解析为两列（parseExcelFile 产物不含千分位），
    // 宽松数字解析覆盖的是 "¥5000" / " 5000 " 这类前后缀噪音
    const fixed = singleSheetText('销售员,销售额', '销售员1号,1000', '销售员3号,2500', '销售员3号,4000');

    const { sheetText, report } = executeTableOps(fixed, [
      {
        type: 'aggregateAppendRow',
        column: '销售额',
        fn: 'sum',
        label: '销售员3号合计',
        labelColumn: '销售员',
      },
    ]);
    expect(report[0].message).toContain('7500');
    expect(sheetText).toContain('销售员3号合计,7500');
    // 原数据行仍在
    expect(sheetText).toContain('销售员1号,1000');
  });

  it('avg / count / min / max', () => {
    const text = singleSheetText('名称,分数', 'a,80', 'b,90', 'c,', 'd,100');
    const run = (fn: 'avg' | 'count' | 'min' | 'max'): string => {
      const { sheetText } = executeTableOps(text, [
        { type: 'aggregateAppendRow', column: '分数', fn, label: '结果' },
      ]);
      const lines = sheetText.split('\n');
      return lines[lines.length - 1];
    };
    // avg = (80+90+100)/3 = 90（空格 c 忽略）
    expect(run('avg')).toBe('结果,90');
    // count = 非空个数 3
    expect(run('count')).toBe('结果,3');
    expect(run('min')).toBe('结果,80');
    expect(run('max')).toBe('结果,100');
  });

  it('聚合列全空 → 整体失败且消息可读', () => {
    const text = singleSheetText('名称,分数', 'a,', 'b,');
    expect(() =>
      executeTableOps(text, [
        { type: 'aggregateAppendRow', column: '分数', fn: 'min', label: 'x' },
      ]),
    ).toThrow(TableOpsError);
  });
});

describe('executeTableOps - 行级操作', () => {
  const text = singleSheetText(
    '区域,销售员,销售额',
    '华南,销售员1号,1000',
    '华北,销售员3号,2500',
    '华南,销售员3号,4000',
    '东北,销售员2号,500',
  );

  it('deleteRows：数值条件删行', () => {
    const { sheetText, report } = executeTableOps(text, [
      { type: 'deleteRows', where: { column: '销售额', op: 'lte', value: '1000' } },
    ]);
    expect(report[0].message).toContain('删除 2 行');
    expect(sheetText).not.toContain('销售员1号,1000');
    expect(sheetText).not.toContain('销售员2号,500');
    expect(sheetText).toContain('销售员3号,2500');
  });

  it('updateCells：字符串 eq 条件更新', () => {
    const { sheetText, report } = executeTableOps(text, [
      {
        type: 'updateCells',
        targetColumn: '销售额',
        where: { column: '销售员', op: 'eq', value: '销售员3号' },
        newValue: '9999',
      },
    ]);
    expect(report[0].message).toContain('2 行');
    expect(sheetText).toContain('华北,销售员3号,9999');
    expect(sheetText).toContain('华南,销售员3号,9999');
    expect(sheetText).toContain('华南,销售员1号,1000');
  });

  it('updateCells：无条件 = 全列更新', () => {
    const { sheetText } = executeTableOps(text, [
      { type: 'updateCells', targetColumn: '区域', newValue: '全国' },
    ]);
    expect(sheetText).toContain('全国,销售员1号,1000');
    expect(sheetText).toContain('全国,销售员2号,500');
  });

  it('sortRows：数字感知升序 + 空值沉底', () => {
    const withEmpty = singleSheetText('名称,分数', 'a,30', 'b,', 'c,20');
    const { sheetText } = executeTableOps(withEmpty, [
      { type: 'sortRows', column: '分数', order: 'asc' },
    ]);
    const lines = sheetText.split('\n');
    // lines[0]=Sheet 标题、lines[1]=表头，数据从 lines[2] 起
    expect(lines[2]).toContain('c,20');
    expect(lines[3]).toContain('a,30');
    expect(lines[4]).toContain('b,');
  });
});

describe('executeTableOps - 列级操作', () => {
  const text = singleSheetText('名称,数量,备注', 'a,1,note1', 'b,2,note2');

  it('addColumn：带固定值 / 不带值', () => {
    const { sheetText } = executeTableOps(text, [
      { type: 'addColumn', header: '状态', value: '正常' },
    ]);
    expect(sheetText).toContain('名称,数量,备注,状态');
    expect(sheetText).toContain('a,1,note1,正常');

    const { sheetText: s2 } = executeTableOps(text, [{ type: 'addColumn', header: '空列' }]);
    expect(s2).toContain('a,1,note1,');
  });

  it('deleteColumn：删列后行同步收缩', () => {
    const { sheetText } = executeTableOps(text, [{ type: 'deleteColumn', column: '备注' }]);
    expect(sheetText).toContain('名称,数量');
    expect(sheetText).toContain('a,1');
    expect(sheetText).not.toContain('note1');
  });

  it('renameColumn', () => {
    const { sheetText } = executeTableOps(text, [
      { type: 'renameColumn', from: '数量', to: '库存' },
    ]);
    expect(sheetText).toContain('名称,库存,备注');
  });

  it('appendRow：按列名给值，缺的列留空', () => {
    const { sheetText, report } = executeTableOps(text, [
      { type: 'appendRow', cells: { 名称: 'c', 数量: '3' } },
    ]);
    expect(report[0].message).toContain('追加 1 行');
    expect(sheetText).toContain('c,3,');
  });
});

describe('executeTableOps - 先校验后执行（整体性）', () => {
  const text = singleSheetText('名称,数量', 'a,1');

  it('引用不存在的列 → TableOpsError，且第二个合法 op 也不执行', () => {
    expect(() =>
      executeTableOps(text, [
        { type: 'deleteColumn', column: '不存在的列' },
        { type: 'appendRow', cells: { 名称: 'b' } },
      ]),
    ).toThrow(/找不到列/);
    // 整体未执行：原文本结构不变（由调用方持有原文本保证，这里验证异常类型即可）
  });

  it('引用不存在的 sheet（多 sheet 场景）→ 报错列出可用 sheet', () => {
    const multi = `Sheet: A\n名称,数量\na,1\n\nSheet: B\n名称,数量\nb,2`;
    expect(() =>
      executeTableOps(multi, [
        { type: 'deleteColumn', column: '数量', targetSheet: 'C' },
      ]),
    ).toThrow(/找不到工作表/);
  });

  it('单 sheet 时 LLM 记错 sheet 名 → 容错命中', () => {
    const { sheetText } = executeTableOps(text, [
      { type: 'deleteColumn', column: '数量', targetSheet: '销售明细' },
    ]);
    expect(sheetText).toContain('名称');
  });
  it('新增列重名 → 拒绝', () => {
    expect(() =>
      executeTableOps(text, [{ type: 'addColumn', header: '名称' }]),
    ).toThrow(/已存在/);
  });

  it('依赖前序 op：删除列后再新增同名列 → 合法（顺序校验）', () => {
    // 本 describe 的 text 是 2 列表（名称,数量）
    const { sheetText, report } = executeTableOps(text, [
      { type: 'deleteColumn', column: '数量' },
      { type: 'addColumn', header: '数量', value: '0' },
    ]);
    expect(report).toHaveLength(2);
    expect(sheetText).toContain('名称,数量');
    expect(sheetText).toContain('a,0');
  });

  it('第 2 步失败 → 报错带步骤编号，且整体不返回结果', () => {
    expect(() =>
      executeTableOps(text, [
        { type: 'renameColumn', from: '名称', to: '品名' },
        { type: 'deleteColumn', column: '名称' }, // 第 1 步已改名，此引用失效
      ]),
    ).toThrow(/第 2 步失败/);
  });
});

describe('executeTableOps - 护栏与边界', () => {
  it('超行数上限 → 拒绝执行', () => {
    const rows = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => `r${i},${i}`);
    const text = `Sheet: 大表\n名称,数量\n${rows.join('\n')}`;
    expect(() =>
      executeTableOps(text, [{ type: 'deleteColumn', column: '数量' }]),
    ).toThrow(/超过单次指令处理上限/);
  });

  it('空内容 → 拒绝', () => {
    expect(() =>
      executeTableOps('   \n\n  ', [{ type: 'deleteColumn', column: 'x' }]),
    ).toThrow(/表格内容为空/);
  });

  it('序列化 round-trip：含逗号/引号单元格不丢真', () => {
    const text = 'Sheet: 转义\n名称,备注\n"a","含,逗号"\n"b","说""你好"""';
    const { sheetText } = executeTableOps(text, [
      { type: 'appendRow', cells: { 名称: 'c', 备注: 'x,y' } },
    ]);
    expect(sheetText).toContain('"含,逗号"');
    expect(sheetText).toContain('"说""你好"""');
    // 单元格 'c' 无特殊字符不包裹，'x,y' 含逗号需引号包裹
    expect(sheetText).toContain('c,"x,y"');
  });

  it('多 op 顺序执行：删行后再聚合', () => {
    const text = singleSheetText(
      '销售员,销售额',
      '销售员1号,1000',
      '销售员3号,2500',
      '销售员3号,4000',
    );
    const { sheetText, report } = executeTableOps(text, [
      { type: 'deleteRows', where: { column: '销售员', op: 'ne', value: '销售员3号' } },
      {
        type: 'aggregateAppendRow',
        column: '销售额',
        fn: 'sum',
        label: '合计',
        labelColumn: '销售员',
      },
    ]);
    expect(report).toHaveLength(2);
    expect(sheetText).toContain('销售员3号,2500');
    expect(sheetText).toContain('合计,6500');
    expect(sheetText).not.toContain('销售员1号');
  });
});

describe('executeTableOps - 跨表聚合与重算（真实用户场景）', () => {
  // 模拟真实测试文件：汇总 sheet 顶部有合并单元格标题行（真实表头"产品类别,金额小计"落在数据行）
  const multi = [
    'Sheet: 汇总',
    '销售汇总报告,',
    '2026-10-01 ~ 2026-10-10,',
    '产品类别,金额小计',
    '电子产品,24393',
    '电脑配件,7215',
    '办公家具,9792',
    '总计,41400',
    '',
    'Sheet: 大表压力测试',
    '序号,区域,销售员,销售额,备注',
    '1,华南,销售员2号,1037,重点客户',
    '2,华北,销售员3号,1074,',
    '3,西南,销售员4号,1111,重点客户',
    '4,华东,销售员5号,9400,重点客户',
  ].join('\n');

  it('端到端：跨表聚合重点客户 → 插到总计前 → 重算总计', () => {
    const { sheetText, report } = executeTableOps(multi, [
      {
        type: 'aggregateAppendRow',
        targetSheet: '汇总',
        sourceSheet: '大表压力测试',
        column: '销售额',
        where: { column: '备注', op: 'eq', value: '重点客户' },
        fn: 'sum',
        label: '重点客户合计',
        valueColumn: '金额小计',
        beforeRow: '总计',
      },
      {
        type: 'aggregateUpdateCell',
        targetSheet: '汇总',
        rowLabel: '总计',
        column: '金额小计',
        fn: 'sum',
      },
    ]);
    // 重点客户 = 1037 + 1111 + 9400 = 11548；重算总计 = 24393+7215+9792+11548 = 52948
    expect(report[0].message).toContain('11548');
    expect(report[1].message).toContain('52948');
    const lines = sheetText.split('\n');
    // 新行插在"总计"之前；插入行被自动标记为汇总行 → 序列化多出一行 TotalRow: 7 指令
    expect(lines[8]).toBe('重点客户合计,11548');
    expect(lines[9]).toBe('总计,52948');
    // 大表数据未被改动
    expect(sheetText).toContain('1,华南,销售员2号,1037,重点客户');
  });

  it('合并单元格标题表：按数据行中的真实表头列名操作（扩展列查找）', () => {
    const { sheetText } = executeTableOps(multi, [
      {
        type: 'updateCells',
        targetSheet: '汇总',
        targetColumn: '金额小计',
        where: { column: '产品类别', op: 'eq', value: '电子产品' },
        newValue: '25000',
      },
    ]);
    expect(sheetText).toContain('电子产品,25000');
  });

  it('aggregateUpdateCell 指定来源表聚合', () => {
    const { sheetText } = executeTableOps(multi, [
      {
        type: 'aggregateUpdateCell',
        targetSheet: '汇总',
        rowLabel: '总计',
        column: '金额小计',
        sourceSheet: '大表压力测试',
        sourceColumn: '销售额',
        fn: 'max',
      },
    ]);
    expect(sheetText).toContain('总计,9400');
  });

  it('where 条件 0 匹配 → 报错（宁失败不静默算 0）', () => {
    expect(() =>
      executeTableOps(multi, [
        {
          type: 'aggregateAppendRow',
          targetSheet: '汇总',
          sourceSheet: '大表压力测试',
          column: '销售额',
          where: { column: '备注', op: 'eq', value: 'VIP客户' },
          fn: 'sum',
          label: 'x',
        },
      ]),
    ).toThrow(/没有满足条件/);
  });

  it('appendRow 兼容合并单元格标题表（列名在数据行中，不丢值）', () => {
    // 回归：旧实现执行时按表头取值，"产品类别"只在数据行里 → 追加全空行静默丢数据
    const { sheetText } = executeTableOps(multi, [
      { type: 'appendRow', targetSheet: '汇总', cells: { 产品类别: '测试类别', 金额小计: '123' } },
    ]);
    expect(sheetText).toContain('测试类别,123');
  });

  it('重复执行同一条聚合指令 → 幂等（不重复插入、数值不翻倍）', () => {
    // 回归：重复执行会插出多行同名合计，重算总计把旧合计也累计进去
    const op = {
      type: 'aggregateAppendRow' as const,
      targetSheet: '汇总',
      sourceSheet: '大表压力测试',
      column: '销售额',
      where: { column: '备注', op: 'eq' as const, value: '重点客户' },
      fn: 'sum' as const,
      label: '重点客户合计',
      valueColumn: '金额小计',
      beforeRow: '总计',
    };
    const first = executeTableOps(multi, [op]);
    const second = executeTableOps(first.sheetText, [op]);
    expect(second.report[0].message).toContain('就地更新');
    expect(
      second.sheetText.split('\n').filter((l) => l.startsWith('重点客户合计')),
    ).toHaveLength(1);
    expect(second.sheetText).toBe(first.sheetText);
  });

  it('beforeRow 锚点不存在 → 报错', () => {
    expect(() =>
      executeTableOps(multi, [
        {
          type: 'aggregateAppendRow',
          targetSheet: '汇总',
          column: '金额小计',
          fn: 'sum',
          label: 'x',
          beforeRow: '不存在的行',
        },
      ]),
    ).toThrow(/找不到标签/);
  });

  it('rowLabel 行不存在 → 报错', () => {
    expect(() =>
      executeTableOps(multi, [
        {
          type: 'aggregateUpdateCell',
          targetSheet: '汇总',
          rowLabel: '合计（不存在）',
          column: '金额小计',
          fn: 'sum',
        },
      ]),
    ).toThrow(/找不到标签含/);
  });
});

describe('executeTableOps - groupCreateSheet（功能 1：分组建表）', () => {
  // 丙的销售额为空：其组无可计算数字，应被跳过且不导致整体失败
  const text = singleSheetText(
    '销售员,销售额',
    '甲,100',
    '乙,200',
    '甲,300',
    '丙,',
    '乙,50',
  );

  it('基础分组求和：新表含分组行 + 总计行，跳过无可算数字的组', () => {
    const { sheetText, report } = executeTableOps(text, [
      {
        type: 'groupCreateSheet',
        groupBy: '销售员',
        valueColumn: '销售额',
        fn: 'sum',
        resultLabel: '销售额合计',
        newSheetName: '按销售员统计',
      },
    ]);
    // 甲=100+300=400，乙=200+50=250，丙空值跳过；总计=650
    expect(report[0].message).toContain('已新建工作表「按销售员统计」');
    expect(report[0].message).toContain('共 2 组');
    expect(report[0].message).toContain('总计 650');
    expect(report[0].message).toContain('1 组无可计算数字已跳过（丙）');
    expect(sheetText).toContain('Sheet: 按销售员统计');
    expect(sheetText).toContain('销售员,销售额合计');
    expect(sheetText).toContain('甲,400');
    expect(sheetText).toContain('乙,250');
    expect(sheetText).toContain('总计,650');
    // 结果表在原文之后追加，原数据未被改动
    expect(sheetText).toContain('甲,100');
  });

  it('resultLabel 省略时用统计列原名作为结果表数值列名', () => {
    const { sheetText } = executeTableOps(text, [
      { type: 'groupCreateSheet', groupBy: '销售员', valueColumn: '销售额', fn: 'count', newSheetName: '统计' },
    ]);
    expect(sheetText).toContain('销售员,销售额');
    // count 统计非空格数：甲 2、乙 2，丙组全空 0 → count 不需要数字，丙=0
    expect(sheetText).toContain('甲,2');
    expect(sheetText).toContain('丙,0');
    expect(sheetText).toContain('总计,4');
  });

  it('分组键为空的行归入"(空)"组', () => {
    const withEmptyKey = singleSheetText('区域,销售额', ',100', '华南,200');
    const { sheetText } = executeTableOps(withEmptyKey, [
      { type: 'groupCreateSheet', groupBy: '区域', valueColumn: '销售额', fn: 'sum', newSheetName: '分区统计' },
    ]);
    expect(sheetText).toContain('(空),100');
    expect(sheetText).toContain('华南,200');
    expect(sheetText).toContain('总计,300');
  });

  it('同名 sheet 已存在 → 整表重建（幂等），不插出多张同名表', () => {
    const op = {
      type: 'groupCreateSheet' as const,
      groupBy: '销售员',
      valueColumn: '销售额',
      fn: 'sum' as const,
      resultLabel: '销售额合计',
      newSheetName: '按销售员统计',
    };
    const first = executeTableOps(text, [op]);
    const second = executeTableOps(first.sheetText, [op]);
    expect(second.report[0].message).toContain('已重建工作表');
    // 只有一张同名表（不重复追加）
    expect(
      second.sheetText.split('\n').filter((l) => l.startsWith('Sheet: 按销售员统计')),
    ).toHaveLength(1);
    // 重建后内容一致（不叠加）
    expect(second.sheetText).toBe(first.sheetText);
  });

  it('新表名含 Excel 非法字符 → 清洗为下划线', () => {
    const { sheetText } = executeTableOps(text, [
      { type: 'groupCreateSheet', groupBy: '销售员', valueColumn: '销售额', fn: 'sum', newSheetName: '统计/汇总:2026' },
    ]);
    expect(sheetText).toContain('Sheet: 统计_汇总_2026');
  });

  it('sourceSheet 跨表分组 + where 过滤', () => {
    const multi = [
      'Sheet: 汇总',
      '类别,金额',
      '',
      'Sheet: 明细',
      '类别,金额,备注',
      'A,100,重点客户',
      'B,200,',
      'A,300,重点客户',
      'C,400,',
    ].join('\n');
    const { sheetText, report } = executeTableOps(multi, [
      {
        type: 'groupCreateSheet',
        sourceSheet: '明细',
        groupBy: '类别',
        valueColumn: '金额',
        fn: 'sum',
        where: { column: '备注', op: 'eq', value: '重点客户' },
        newSheetName: '重点客户统计',
      },
    ]);
    // 只统计重点客户：A=400，总计=400；源表"明细"保持原样（where 只作用于分组统计）
    expect(report[0].message).toContain('共 1 组');
    expect(report[0].message).toContain('总计 400');
    const newSection = sheetText.split('Sheet: 重点客户统计')[1] ?? '';
    expect(newSection).toContain('A,400');
    expect(newSection).toContain('总计,400');
    expect(newSection).not.toContain('B');
  });

  it('分组列/统计列不存在 → 报错', () => {
    expect(() =>
      executeTableOps(text, [
        { type: 'groupCreateSheet', groupBy: '不存在的列', valueColumn: '销售额', fn: 'sum', newSheetName: 'x' },
      ]),
    ).toThrow(/找不到列/);
    expect(() =>
      executeTableOps(text, [
        { type: 'groupCreateSheet', groupBy: '销售员', valueColumn: '不存在列', fn: 'sum', newSheetName: 'x' },
      ]),
    ).toThrow(/找不到列/);
  });

  it('统计列全空 → 报错（无任何可计算数字）', () => {
    const allEmpty = singleSheetText('销售员,销售额', '甲,', '乙,');
    expect(() =>
      executeTableOps(allEmpty, [
        { type: 'groupCreateSheet', groupBy: '销售员', valueColumn: '销售额', fn: 'sum', newSheetName: 'x' },
      ]),
    ).toThrow(/没有可计算的数字/);
  });

  it('where 过滤后 0 匹配 → 报错', () => {
    expect(() =>
      executeTableOps(text, [
        {
          type: 'groupCreateSheet',
          groupBy: '销售员',
          valueColumn: '销售额',
          fn: 'sum',
          where: { column: '销售员', op: 'eq', value: '不存在的人' },
          newSheetName: 'x',
        },
      ]),
    ).toThrow(/没有满足条件/);
  });
});

describe('executeTableOps - deriveColumn（功能 2：公式补数）', () => {
  const text = singleSheetText(
    '名称,数量,单价,销售额',
    'a,2,10,999',
    'b,3,5,',
    'c,,4,',
    'd,0,10,',
  );

  it('表达式逐行计算 + where 限定：只补空行，已有值保留', () => {
    const { sheetText, report } = executeTableOps(text, [
      {
        type: 'deriveColumn',
        targetColumn: '销售额',
        expression: '[数量]*[单价]',
        where: { column: '销售额', op: 'empty', value: '' },
      },
    ]);
    // a 行已有 999 不动；b=3*5=15 补上；c 数量为空跳过；d=0*10=0 写 0
    expect(report[0].message).toContain('计算写入 2 行');
    expect(report[0].message).toContain('跳过 1 行');
    expect(sheetText).toContain('a,2,10,999');
    expect(sheetText).toContain('b,3,5,15');
    expect(sheetText).toContain('c,,4,');
    expect(sheetText).toContain('d,0,10,0');
  });

  it('目标列不存在 → 新增该列并全量计算', () => {
    const base = singleSheetText('名称,数量,单价', 'a,2,10', 'b,3,5');
    const { sheetText, report } = executeTableOps(base, [
      { type: 'deriveColumn', targetColumn: '金额', expression: '[数量]*[单价]' },
    ]);
    expect(report[0].message).toContain('已新增列「金额」');
    expect(sheetText).toContain('名称,数量,单价,金额');
    expect(sheetText).toContain('a,2,10,20');
    expect(sheetText).toContain('b,3,5,15');
  });

  it('除零 → 该行跳过保留原值（不中断整体）', () => {
    const withZero = singleSheetText('名称,数量,除数,结果', 'a,10,2,', 'b,10,0,', 'c,10,5,99');
    const { sheetText, report } = executeTableOps(withZero, [
      { type: 'deriveColumn', targetColumn: '结果', expression: '[数量]/[除数]' },
    ]);
    expect(report[0].message).toContain('计算写入 2 行');
    expect(report[0].message).toContain('跳过 1 行');
    expect(sheetText).toContain('a,10,2,5');
    expect(sheetText).toContain('b,10,0,');
    expect(sheetText).toContain('c,10,5,2'); // 无 where → 全表计算，c=10/5=2
  });

  it('表达式支持括号/加减/一元负号：[数量]*([单价]-2)+5', () => {
    const base = singleSheetText('名称,数量,单价', 'a,3,10', 'b,2,0');
    const { sheetText } = executeTableOps(base, [
      { type: 'deriveColumn', targetColumn: '运费', expression: '[数量]*([单价]-2)+5' },
    ]);
    // a: 3*(10-2)+5=29；b: 2*(0-2)+5=1
    expect(sheetText).toContain('a,3,10,29');
    expect(sheetText).toContain('b,2,0,1');
  });

  it('语法错误 → 报错（表达式不完整/非法字符/多余内容）', () => {
    const base = singleSheetText('名称,数量', 'a,1');
    expect(() =>
      executeTableOps(base, [{ type: 'deriveColumn', targetColumn: 'x', expression: '[数量]*' }]),
    ).toThrow(/表达式不完整/);
    expect(() =>
      executeTableOps(base, [{ type: 'deriveColumn', targetColumn: 'x', expression: '[数量]abs' }]),
    ).toThrow(/不支持的内容/);
    expect(() =>
      executeTableOps(base, [{ type: 'deriveColumn', targetColumn: 'x', expression: '1 2' }]),
    ).toThrow(/多余内容/);
    expect(() =>
      executeTableOps(base, [{ type: 'deriveColumn', targetColumn: 'x', expression: '[数量' }]),
    ).toThrow(/\[缺少对应的 \]/);
    // 绝不 eval：system 命令注入在词法阶段被拒
    expect(() =>
      executeTableOps(base, [
        { type: 'deriveColumn', targetColumn: 'x', expression: 'process.exit(1)' },
      ]),
    ).toThrow(/不支持的内容/);
  });

  it('引用列不存在 → 报错', () => {
    const base = singleSheetText('名称,数量', 'a,1');
    expect(() =>
      executeTableOps(base, [
        { type: 'deriveColumn', targetColumn: 'x', expression: '[不存在列]*2' },
      ]),
    ).toThrow(/找不到列/);
  });
});

describe('executeTableOps - 多条件 where（功能 3：AND/OR）', () => {
  const text = singleSheetText(
    '区域,销售员,销售额',
    '华南,甲,100',
    '华北,乙,200',
    '华南,丙,3000',
    '东北,丁,50',
  );

  it('and 组合删行：区域=华南 且 销售额>1000 → 只删丙', () => {
    const { sheetText, report } = executeTableOps(text, [
      {
        type: 'deleteRows',
        where: {
          mode: 'and',
          conditions: [
            { column: '区域', op: 'eq', value: '华南' },
            { column: '销售额', op: 'gt', value: '1000' },
          ],
        },
      },
    ]);
    expect(report[0].message).toContain('删除 1 行');
    expect(report[0].message).toContain('区域 = 华南 且 销售额 > 1000');
    expect(sheetText).not.toContain('华南,丙,3000');
    // 甲虽然区域=华南但销售额 1000 不满足 >1000，保留
    expect(sheetText).toContain('华南,甲,100');
  });

  it('or 组合更新：区域=华北 或 销售额<=50 → 更新 2 行', () => {
    const { sheetText, report } = executeTableOps(text, [
      {
        type: 'updateCells',
        targetColumn: '区域',
        where: {
          mode: 'or',
          conditions: [
            { column: '区域', op: 'eq', value: '华北' },
            { column: '销售额', op: 'lte', value: '50' },
          ],
        },
        newValue: '特殊',
      },
    ]);
    expect(report[0].message).toContain('2 行');
    expect(sheetText).toContain('特殊,乙,200');
    expect(sheetText).toContain('特殊,丁,50');
    // 未匹配的行不动
    expect(sheetText).toContain('华南,甲,100');
    expect(sheetText).toContain('华南,丙,3000');
  });

  it('组合条件用于聚合 where：or 过滤后求和', () => {
    const { sheetText, report } = executeTableOps(text, [
      {
        type: 'aggregateAppendRow',
        column: '销售额',
        fn: 'sum',
        label: '重点区域合计',
        where: {
          mode: 'or',
          conditions: [
            { column: '区域', op: 'eq', value: '华南' },
            { column: '区域', op: 'eq', value: '东北' },
          ],
        },
      },
    ]);
    // 华南 100+3000 + 东北 50 = 3150；3 列表追加行：标签在第一列，第二列（销售员）留空
    expect(report[0].message).toContain('3150');
    expect(sheetText).toContain('重点区域合计,,3150');
  });

  it('组合条件内列不存在 → 报错（校验阶段拦截）', () => {
    expect(() =>
      executeTableOps(text, [
        {
          type: 'deleteRows',
          where: {
            mode: 'and',
            conditions: [
              { column: '区域', op: 'eq', value: '华南' },
              { column: '不存在列', op: 'eq', value: 'x' },
            ],
          },
        },
      ]),
    ).toThrow(/找不到列/);
  });

  it('单条件写法向后兼容（回归：既有 deleteRows/updateCells 行为不变）', () => {
    const { sheetText } = executeTableOps(text, [
      { type: 'deleteRows', where: { column: '销售额', op: 'gte', value: '200' } },
    ]);
    expect(sheetText).not.toContain('华北,乙,200');
    expect(sheetText).not.toContain('华南,丙,3000');
    expect(sheetText).toContain('华南,甲,100');
    expect(sheetText).toContain('东北,丁,50');
  });
});

describe('buildSheetOverview', () => {
  it('框线表格输出表头 + 最多 2 行样本，不含全表数据', () => {
    const text = singleSheetText('名称,数量', 'a,1', 'b,2', 'c,3', 'd,4');
    const overview = buildSheetOverview(text);
    expect(overview).toContain('工作表「测试」共 4 行');
    expect(overview).toContain('│ 名称 │ 数量 │');
    expect(overview).toContain('│ a    │ 1    │');
    expect(overview).toContain('│ b    │ 2    │');
    expect(overview).not.toContain('│ c');
    expect(overview).not.toContain('│ d');
    // 完整框线结构
    expect(overview).toContain('┌');
    expect(overview).toContain('├');
    expect(overview).toContain('└');
  });

  it('CJK 全角按显示宽度对齐（中文表头不破坏框线）', () => {
    const text = singleSheetText('产品,单价', '冰箱,1200');
    const overview = buildSheetOverview(text);
    // 产品 显示宽 4 → 框宽 6（4+2 侧距）；单价 同宽
    expect(overview).toContain('│ 产品 │ 单价 │');
    expect(overview).toContain('│ 冰箱 │ 1200 │');
  });

  it('空样本单元格渲染为 ∅（显式可读，防误判为无数据列）', () => {
    const text = singleSheetText('名称,备注', 'a,重点客户', 'b,');
    const overview = buildSheetOverview(text);
    // 备注列宽由"重点客户"（显示宽 8）决定 → ∅ 后补 7 个空格
    expect(overview).toContain('│ b    │ ∅        │');
  });

  it('无名块标注为 (未命名)', () => {
    const overview = buildSheetOverview('名称,数量\na,1');
    expect(overview).toContain('(未命名)');
  });

  it('输出每列去重取值示例（帮 LLM 选对 where 条件值）', () => {
    const text = singleSheetText('名称,备注', 'a,重点客户', 'b,普通客户');
    const overview = buildSheetOverview(text);
    expect(overview).toContain('备注={重点客户|普通客户}');
  });

  it('输出每列空缺单元格统计（填充类意图的关键依据，样本行看不到空缺）', () => {
    // 空缺在第 3 行——不在前 2 行样本里，取值示例也只收非空值
    const text = singleSheetText('名称,金额', 'a,100', 'b,200', 'c,', 'd,300');
    const overview = buildSheetOverview(text);
    // 空缺统计行只含金额列（无空缺的"名称"列不出现），并标注空缺所在行
    expect(overview).toMatch(/空缺单元格：金额=1格（位于行：c）$/);
  });

  it('空缺行标签取该行第一个非空单元格（区分刻意留白与真实缺失的关键）', () => {
    // 未锚定的报表式表格：日期行与总计行的空缺混在同一列，
    // 标签让 LLM 看清"总计行的空缺是真实缺失"而不是全部当成留白（实测 bug）
    const text = [
      'Sheet: 汇总',
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品类别,金额小计',
      '电子产品,24393',
      '总计,',
    ].join('\n');
    const overview = buildSheetOverview(text);
    // 日期标签超 20 字符截断（与其他概览字段同一上限），仍足以区分两处空缺的行身份
    expect(overview).toMatch(/空缺单元格：第2列=2格（位于行：2026-10-01 ~ 2026-10、总计）/);
  });

  it('空缺超过 5 行时截断展示并注明总数', () => {
    const rows = ['a,', 'b,', 'c,', 'd,', 'e,', 'f,'];
    const overview = buildSheetOverview(singleSheetText('名称,金额', ...rows));
    expect(overview).toMatch(/金额=6格（位于行：a、b、c、d、e 等6行）/);
  });

  it('多列都有空缺时逐一列出；纯空格也计入空缺', () => {
    const text = singleSheetText('区域,金额', ' ,100', '华东,', '华南,300');
    const overview = buildSheetOverview(text);
    expect(overview).toContain('区域=1格');
    expect(overview).toContain('金额=1格');
  });

  it('没有任何空缺时不输出空缺统计行', () => {
    const overview = buildSheetOverview(singleSheetText('名称,数量', 'a,1', 'b,2'));
    expect(overview).not.toContain('空缺单元格');
  });

  it('超宽单元格截断加省略号，不撑破框线', () => {
    const longValue = '这是一个特别特别特别长的单元格内容超过二十个显示宽度需要截断处理';
    const text = singleSheetText('名称,备注', 'a,x', `b,${longValue}`);
    const overview = buildSheetOverview(text);
    expect(overview).toContain('…');
    expect(overview).not.toContain(longValue);
  });
});

// ==================== noop 操作（刻意留白确认） ====================

describe('executeTableOps - noop', () => {
  it('不修改表格任何内容，报告返回原因', () => {
    const text = singleSheetText('名称,金额', 'a,1', 'b,2');
    const result = executeTableOps(text, [
      { type: 'noop', targetSheet: '测试', reason: '唯一的空缺是日期范围行旁的刻意留白（报表式布局），无需填充' },
    ]);
    expect(result.sheetText).toBe(text);
    expect(result.report).toHaveLength(1);
    expect(result.report[0].type).toBe('noop');
    expect(result.report[0].targetSheet).toBe('测试');
    expect(result.report[0].message).toContain('刻意留白');
  });

  it('targetSheet 不存在时报错（与其他操作同一口径；双 sheet 文档规避单表容错）', () => {
    const text = 'Sheet: 测试\n名称,金额\na,1\nSheet: 明细\n名称,数量\nb,2';
    expect(() =>
      executeTableOps(text, [{ type: 'noop', targetSheet: '不存在的表', reason: '无需执行' }]),
    ).toThrow(TableOpsError);
    expect(() =>
      executeTableOps(text, [{ type: 'noop', targetSheet: '不存在的表', reason: '无需执行' }]),
    ).toThrow('找不到工作表');
  });
});

// ==================== 表头行锚定（HeaderRow 指令 + setHeaderRow 操作） ====================

/** 报表式表格 fixture：标题行 + 日期行 + 真表头在第 3 行 */
const REPORT_TEXT = [
  'Sheet: 销售汇总报告',
  '销售汇总报告,',
  '2026-10-01 ~ 2026-10-11,',
  '产品类别,金额小计',
  '冰箱,24393',
  '洗衣机,79215',
].join('\n');

/** 已锚定的报表式表格 fixture：REPORT_TEXT 插入 HeaderRow: 3 指令（上传自动识别 / setHeaderRow 的产物形态） */
const ANCHORED_REPORT_TEXT = [
  'Sheet: 销售汇总报告',
  'HeaderRow: 3',
  '销售汇总报告,',
  '2026-10-01 ~ 2026-10-11,',
  '产品类别,金额小计',
  '冰箱,24393',
  '洗衣机,79215',
].join('\n');

describe('parseSheetData / serializeSheetData - HeaderRow 指令', () => {
  it('指令锚定：说明行归 preambleRows，表头取第 N 行，其余为数据行', () => {
    const [sheet] = parseSheetData(ANCHORED_REPORT_TEXT);
    expect(sheet.headerRowIndex).toBe(3);
    expect(sheet.preambleRows).toEqual([['销售汇总报告', ''], ['2026-10-01 ~ 2026-10-11', '']]);
    expect(sheet.headers).toEqual(['产品类别', '金额小计']);
    expect(sheet.rows).toEqual([
      ['冰箱', '24393'],
      ['洗衣机', '79215'],
    ]);
  });

  it('round-trip：含指令文本解析后序列化原样', () => {
    expect(serializeSheetData(parseSheetData(ANCHORED_REPORT_TEXT))).toBe(ANCHORED_REPORT_TEXT);
  });

  it('无指令的旧格式：headerRowIndex=1、说明行为空（完全兼容）', () => {
    const [sheet] = parseSheetData(singleSheetText('名称,金额', 'a,1'));
    expect(sheet.headerRowIndex).toBe(1);
    expect(sheet.preambleRows).toEqual([]);
    expect(serializeSheetData(parseSheetData(singleSheetText('名称,金额', 'a,1')))).toBe(
      singleSheetText('名称,金额', 'a,1'),
    );
  });

  it('指令超界收敛到内容行数（防脏数据，绝不丢行）', () => {
    const text = 'Sheet: 表\nHeaderRow: 99\n标题,\n名称,数量\na,1';
    const [sheet] = parseSheetData(text);
    expect(sheet.headerRowIndex).toBe(3); // 内容共 3 行 → 表头收敛到最后一行
    expect(sheet.headers).toEqual(['a', '1']);
    expect(sheet.rows).toEqual([]);
  });

  it('含引号逗号的说明行与表头 round-trip 不丢内容', () => {
    const text = 'Sheet: 表\nHeaderRow: 2\n"标题,含逗号",\n"列,一",列二\n"a","b"';
    const [sheet] = parseSheetData(text);
    expect(sheet.preambleRows).toEqual([['标题,含逗号', '']]);
    expect(sheet.headers).toEqual(['列,一', '列二']);
    expect(sheet.rows).toEqual([['a', 'b']]);
    // 序列化只对含逗号/引号的单元格加引号（"a"→a），内容不丢即 round-trip 成立
    expect(serializeSheetData([sheet])).toBe(
      'Sheet: 表\nHeaderRow: 2\n"标题,含逗号",\n"列,一",列二\na,b',
    );
  });
});

describe('executeTableOps - setHeaderRow', () => {
  it('把第 3 行设为表头：说明行归位、真表头生效、报告明确', () => {
    const result = executeTableOps(REPORT_TEXT, [
      { type: 'setHeaderRow', targetSheet: '销售汇总报告', headerRow: 3 },
    ]);
    expect(result.report[0].message).toContain('第 3 行设为表头');
    expect(result.report[0].message).toContain('上方 2 行归为说明行');
    // 锚定后按真列名直接命中（无需两级查找兜底）
    const [sheet] = parseSheetData(result.sheetText);
    expect(sheet.headerRowIndex).toBe(3);
    expect(sheet.headers).toEqual(['产品类别', '金额小计']);
    // 锚定后指令写入文本，前端网格据此渲染真表头
    expect(result.sheetText).toContain('HeaderRow: 3');
  });

  it('幂等：重复设置同一行报"已是表头行"，文本不变', () => {
    const once = executeTableOps(REPORT_TEXT, [
      { type: 'setHeaderRow', targetSheet: '销售汇总报告', headerRow: 3 },
    ]);
    const twice = executeTableOps(once.sheetText, [
      { type: 'setHeaderRow', targetSheet: '销售汇总报告', headerRow: 3 },
    ]);
    expect(twice.report[0].message).toContain('已是表头行');
    expect(twice.sheetText).toBe(once.sheetText);
  });

  it('设到数据行：原表头降级为说明行，不丢数据', () => {
    const anchored = executeTableOps(REPORT_TEXT, [
      { type: 'setHeaderRow', targetSheet: '销售汇总报告', headerRow: 3 },
    ]);
    const result = executeTableOps(anchored.sheetText, [
      { type: 'setHeaderRow', targetSheet: '销售汇总报告', headerRow: 4 },
    ]);
    const [sheet] = parseSheetData(result.sheetText);
    expect(sheet.headerRowIndex).toBe(4);
    expect(sheet.preambleRows).toHaveLength(3);
    expect(sheet.preambleRows[2]).toEqual(['产品类别', '金额小计']);
    expect(sheet.headers).toEqual(['冰箱', '24393']);
    expect(sheet.rows).toEqual([['洗衣机', '79215']]);
  });

  it('恢复默认（N=1）：说明行清空、首行回表头', () => {
    const anchored = executeTableOps(REPORT_TEXT, [
      { type: 'setHeaderRow', targetSheet: '销售汇总报告', headerRow: 3 },
    ]);
    const result = executeTableOps(anchored.sheetText, [
      { type: 'setHeaderRow', targetSheet: '销售汇总报告', headerRow: 1 },
    ]);
    const [sheet] = parseSheetData(result.sheetText);
    expect(sheet.headerRowIndex).toBe(1);
    expect(sheet.headers).toEqual(['销售汇总报告', '']);
  });

  it('空行不能设为表头；越界行报错', () => {
    const text = 'Sheet: 表\n标题,\n名称,数量\na,1\n,';
    expect(() =>
      executeTableOps(text, [{ type: 'setHeaderRow', targetSheet: '表', headerRow: 4 }]),
    ).toThrow('空行，不能设为表头');
    expect(() =>
      executeTableOps(text, [{ type: 'setHeaderRow', targetSheet: '表', headerRow: 99 }]),
    ).toThrow('第 99 行不存在');
  });
});

describe('buildSheetOverview - 表头锚定', () => {
  it('锚定表概览注明表头行号与说明行内容，空缺统计不含说明行', () => {
    // 日期行旁的"刻意留白"在锚定后不再计入空缺统计（说明行已排除）
    const overview = buildSheetOverview(ANCHORED_REPORT_TEXT);
    expect(overview).toContain('表头在第 3 行');
    expect(overview).toContain('销售汇总报告；2026-10-01 ~ 2026-10-11');
    expect(overview).toContain('数据共 2 行');
    expect(overview).toContain('│ 产品类别 │ 金额小计 │');
    expect(overview).not.toContain('HeaderRow');
    // 说明行只出现在首行的文字描述里，不进框线（不是数据行）
    expect(overview).not.toContain('│ 销售汇总报告');
    expect(overview).not.toContain('│ 2026-10-01');
    // 数据行样本正常渲染
    expect(overview).toContain('│ 冰箱');
  });

  it('未锚定的合并单元格标题表仍走旧口径（概览首行不出现表头行号）', () => {
    const legacy = 'Sheet: 汇总\n销售汇总报告,\n产品类别,金额小计\n冰箱,100';
    const overview = buildSheetOverview(legacy);
    expect(overview).toContain('工作表「汇总」共 2 行');
    expect(overview).not.toContain('表头在第');
  });
});

describe('executeTableOps - 未锚定报表表的总计空缺重算（概览"位于行"引导的推荐路径）', () => {
  // 用户实测场景：未锚定报表表（标题/日期行仍在数据区），总计值被删掉，
  // "补全空内容"曾被 noop 拒绝；现引导 LLM 输出 aggregateUpdateCell 重算
  const report = [
    'Sheet: 汇总',
    '销售汇总报告,',
    '2026-10-01 ~ 2026-10-11,',
    '产品类别,金额小计',
    '电子产品,24393',
    '电脑配件,79215',
    '办公家具,9792',
    '总计,',
  ].join('\n');

  it('aggregateUpdateCell 按行标签定位总计行，对上方数据行求和回填', () => {
    const { sheetText, report: ops } = executeTableOps(report, [
      { type: 'aggregateUpdateCell', targetSheet: '汇总', rowLabel: '总计', column: '金额小计', fn: 'sum' },
    ]);
    // 24393 + 79215 + 9792 = 113400（"金额小计"文本行被数字过滤自然跳过）
    expect(sheetText).toContain('总计,113400');
    // 标题/日期行的刻意留白不受影响
    expect(sheetText).toContain('销售汇总报告,');
    expect(sheetText).toContain('2026-10-01 ~ 2026-10-11,');
    expect(ops[0].message).toContain('113400');
  });

  it('重算分类行：sourceSheet + sourceColumn + where 跨表求和回填（源数据变动后的重算场景）', () => {
    // 用户场景：办公椅单价在销售明细已变动，要求重算汇总表——
    // 目标是汇总表本身，绝不碰销售明细；按分类过滤源表求和
    const text = [
      'Sheet: 销售明细',
      '日期,产品,类型,数量,单价,金额',
      '2026-10-01,办公椅,办公家具,2,700,1400',
      '2026-10-02,办公桌,办公家具,1,800,800',
      '2026-10-03,显示器,电子产品,3,1200,3600',
      '',
      'Sheet: 汇总',
      '产品类别,金额小计',
      '办公家具,9999',
      '电子产品,3600',
    ].join('\n');
    const { sheetText, report: ops } = executeTableOps(text, [
      {
        type: 'aggregateUpdateCell',
        targetSheet: '汇总',
        rowLabel: '办公家具',
        column: '金额小计',
        fn: 'sum',
        sourceSheet: '销售明细',
        sourceColumn: '金额',
        where: { column: '类型', op: 'eq', value: '办公家具' },
      },
    ]);
    // 1400 + 800 = 2200；其他行与源表不动
    expect(sheetText).toContain('办公家具,2200');
    expect(sheetText).toContain('电子产品,3600');
    expect(sheetText).toContain('2026-10-01,办公椅,办公家具,2,700,1400');
    expect(ops[0].message).toContain('2200');
  });
});

// ==================== 汇总行声明式契约（TotalRow 指令 + setTotalRows 操作） ====================

/** 汇总行契约 fixture：标题/日期为说明行，表头第 3 行，总计第 7 行（与前端 table-convert.test 对齐） */
const TOTAL_TEXT = [
  'Sheet: 汇总',
  'HeaderRow: 3',
  'TotalRow: 7',
  '销售汇总报告,',
  '2026-10-01 ~ 2026-10-11,',
  '产品,数量,销售额',
  '办公椅,2,1400',
  '办公桌,1,800',
  '显示器,3,3600',
  '总计,6,5800',
].join('\n');

describe('parseSheetData / serializeSheetData - TotalRow 指令', () => {
  it('指令锚定：内容行号换算为 rows 下标，说明行/表头/数据行解析不受影响', () => {
    const [sheet] = parseSheetData(TOTAL_TEXT);
    expect(sheet.totalRowIndexes).toEqual([3]);
    expect(sheet.preambleRows).toEqual([['销售汇总报告', ''], ['2026-10-01 ~ 2026-10-11', '']]);
    expect(sheet.headers).toEqual(['产品', '数量', '销售额']);
    expect(sheet.rows).toHaveLength(4);
    expect(sheet.rows[3]).toEqual(['总计', '6', '5800']);
  });

  it('与 HeaderRow 顺序不限：TotalRow 在前同样解析', () => {
    const reversed = TOTAL_TEXT.replace('HeaderRow: 3\nTotalRow: 7', 'TotalRow: 7\nHeaderRow: 3');
    const [sheet] = parseSheetData(reversed);
    expect(sheet.headerRowIndex).toBe(3);
    expect(sheet.totalRowIndexes).toEqual([3]);
  });

  it('round-trip：含指令文本解析后序列化原样', () => {
    expect(serializeSheetData(parseSheetData(TOTAL_TEXT))).toBe(TOTAL_TEXT);
  });

  it('多值去重：TotalRow: 7,7,6 → 两个下标，序列化规范为 6,7', () => {
    const text = TOTAL_TEXT.replace('TotalRow: 7', 'TotalRow: 7,7,6');
    const [sheet] = parseSheetData(text);
    expect(sheet.totalRowIndexes).toEqual([2, 3]);
    expect(serializeSheetData(parseSheetData(text))).toContain('TotalRow: 6,7');
  });

  it('脏标记丢弃：落在说明行/表头/越界的标记全部忽略，绝不误标数据行', () => {
    const text = TOTAL_TEXT.replace('TotalRow: 7', 'TotalRow: 1,2,3,99');
    const [sheet] = parseSheetData(text);
    expect(sheet.totalRowIndexes).toEqual([]);
    // 序列化不残留无效指令
    expect(serializeSheetData(parseSheetData(text))).not.toContain('TotalRow');
  });

  it('未声明（旧格式）totalRowIndexes 为空数组，行为完全兼容', () => {
    const [sheet] = parseSheetData(singleSheetText('名称,金额', 'a,1', '总计,2'));
    expect(sheet.totalRowIndexes).toEqual([]);
  });
});

describe('executeTableOps - setTotalRows', () => {
  /** 去掉指令行的裸 fixture（模拟旧文档，供操作标记） */
  const bare = TOTAL_TEXT.replace('TotalRow: 7\n', '');

  it('标记：第 7 行声明为汇总行，消息带标签、文本写入指令', () => {
    const { sheetText, report } = executeTableOps(bare, [
      { type: 'setTotalRows', targetSheet: '汇总', rows: [7] },
    ]);
    expect(report[0].message).toContain('第 7 行（总计） 标记为汇总行');
    expect(sheetText).toContain('TotalRow: 7');
    const [sheet] = parseSheetData(sheetText);
    expect(sheet.totalRowIndexes).toEqual([3]);
  });

  it('多行一次标记：行号去重升序，消息逐行带标签', () => {
    const { sheetText, report } = executeTableOps(bare, [
      { type: 'setTotalRows', targetSheet: '汇总', rows: [7, 6, 7] },
    ]);
    expect(report[0].message).toContain('第 6 行（显示器）');
    expect(report[0].message).toContain('第 7 行（总计）');
    expect(sheetText).toContain('TotalRow: 6,7');
  });

  it('幂等：重复标记同一集合 → "已是汇总行"，文本不变', () => {
    const once = executeTableOps(bare, [
      { type: 'setTotalRows', targetSheet: '汇总', rows: [7] },
    ]);
    const twice = executeTableOps(once.sheetText, [
      { type: 'setTotalRows', targetSheet: '汇总', rows: [7] },
    ]);
    expect(twice.report[0].message).toContain('已是汇总行');
    expect(twice.sheetText).toBe(once.sheetText);
  });

  it('清除：rows=[] 移除全部标记；无标记时幂等提示', () => {
    const cleared = executeTableOps(TOTAL_TEXT, [
      { type: 'setTotalRows', targetSheet: '汇总', rows: [] },
    ]);
    expect(cleared.report[0].message).toContain('已清除');
    expect(cleared.sheetText).not.toContain('TotalRow');
    const again = executeTableOps(cleared.sheetText, [
      { type: 'setTotalRows', targetSheet: '汇总', rows: [] },
    ]);
    expect(again.report[0].message).toContain('没有汇总行标记');
  });

  it('校验：越界/表头行/说明行/空行四种非法标记全部拒绝', () => {
    expect(() =>
      executeTableOps(bare, [{ type: 'setTotalRows', targetSheet: '汇总', rows: [99] }]),
    ).toThrow('第 99 行不存在');
    expect(() =>
      executeTableOps(bare, [{ type: 'setTotalRows', targetSheet: '汇总', rows: [3] }]),
    ).toThrow('是表头行，不能标记为汇总行');
    expect(() =>
      executeTableOps(bare, [{ type: 'setTotalRows', targetSheet: '汇总', rows: [1] }]),
    ).toThrow('是说明行，不能标记为汇总行');
    // 逗号行（整行无有效单元格）不能标记
    const withBlank = 'Sheet: 表\n标题,\n,\n名称,金额\na,1\n总计,2';
    expect(() =>
      executeTableOps(withBlank, [{ type: 'setTotalRows', targetSheet: '表', rows: [2] }]),
    ).toThrow('是空行，不能标记为汇总行');
  });
});

describe('executeTableOps - setHeaderRow 与汇总行标记跟随', () => {
  it('表头下移（3→4）：汇总行内容行号不变，rows 下标跟随重算', () => {
    const result = executeTableOps(TOTAL_TEXT, [
      { type: 'setHeaderRow', targetSheet: '汇总', headerRow: 4 },
    ]);
    expect(result.sheetText).toContain('HeaderRow: 4');
    expect(result.sheetText).toContain('TotalRow: 7');
    const [sheet] = parseSheetData(result.sheetText);
    expect(sheet.totalRowIndexes).toEqual([2]);
  });

  it('表头移到汇总行上：标记落入说明行区被丢弃（不再有汇总行声明）', () => {
    const result = executeTableOps(TOTAL_TEXT, [
      { type: 'setHeaderRow', targetSheet: '汇总', headerRow: 7 },
    ]);
    const [sheet] = parseSheetData(result.sheetText);
    expect(sheet.totalRowIndexes).toEqual([]);
    expect(result.sheetText).not.toContain('TotalRow');
  });
});

describe('executeTableOps - 聚合类操作与汇总行契约', () => {
  it('aggregateAppendRow：聚合池排除已声明汇总行（不双重计数），新行自动标记、既有标记移位', () => {
    const { sheetText, report } = executeTableOps(TOTAL_TEXT, [
      {
        type: 'aggregateAppendRow',
        targetSheet: '汇总',
        column: '销售额',
        fn: 'sum',
        label: '重点客户合计',
        labelColumn: '产品',
        beforeRow: '总计',
      },
    ]);
    // 1400+800+3600=5800；若总行混入池会算出 11600
    expect(report[0].message).toContain('5800');
    const lines = sheetText.split('\n');
    expect(lines[9]).toBe('重点客户合计,,5800'); // 插在总计行之前
    expect(lines[10]).toBe('总计,6,5800');
    // 新行（内容行 7）与总计（下移到内容行 8）都带标记
    expect(sheetText).toContain('TotalRow: 7,8');
  });

  it('aggregateUpdateCell 同表重算：重算 = 上方全部行求和（含其他汇总行，既定契约）', () => {
    // 既有契约（端到端场景）：插入"重点客户合计"后重算总计要包含它；
    // 这里验证同类语义——上方小计行参与总计重算（列求和/跨表/分组池才排除汇总行）
    const withSubtotal = [
      'Sheet: 汇总',
      'HeaderRow: 3',
      'TotalRow: 7,8',
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品,数量,销售额',
      '办公椅,2,1400',
      '办公桌,1,800',
      '显示器,3,3600',
      '小计,,5800',
      '总计,,',
    ].join('\n');
    const { sheetText, report } = executeTableOps(withSubtotal, [
      { type: 'aggregateUpdateCell', targetSheet: '汇总', rowLabel: '总计', column: '销售额', fn: 'sum' },
    ]);
    // 明细 1400+800+3600=5800 + 小计行 5800 = 11600（"上方全部行求和"的机械语义）
    expect(report[0].message).toContain('11600');
    expect(sheetText).toContain('总计,,11600');
  });

  it('aggregateUpdateCell 跨表：来源表已声明的汇总行不进池', () => {
    const cross = [
      'Sheet: 明细',
      '名称,金额',
      'a,100',
      'b,200',
      '合计,300',
      '',
      'Sheet: 汇总',
      '项目,数值',
      '总计,',
    ].join('\n');
    // 先在来源表声明汇总行（模拟用户已确认的契约）
    const declared = executeTableOps(cross, [
      { type: 'setTotalRows', targetSheet: '明细', rows: [4] },
    ]);
    const { sheetText, report } = executeTableOps(declared.sheetText, [
      {
        type: 'aggregateUpdateCell',
        targetSheet: '汇总',
        rowLabel: '总计',
        column: '数值',
        fn: 'sum',
        sourceSheet: '明细',
        sourceColumn: '金额',
      },
    ]);
    // 100+200=300；若合计行混入 → 600
    expect(report[0].message).toContain('300');
    expect(sheetText).toContain('总计,300');
  });

  it('groupCreateSheet：来源表已声明的汇总行不进分组池（不双重计数）', () => {
    const src = [
      'Sheet: 明细',
      'TotalRow: 4',
      '类别,金额',
      'A,100',
      'B,200',
      '总计,300',
    ].join('\n');
    const { sheetText, report } = executeTableOps(src, [
      {
        type: 'groupCreateSheet',
        sourceSheet: '明细',
        groupBy: '类别',
        valueColumn: '金额',
        fn: 'sum',
        newSheetName: '统计',
      },
    ]);
    expect(report[0].message).toContain('共 2 组');
    expect(report[0].message).toContain('总计 300');
    const section = sheetText.split('Sheet: 统计')[1] ?? '';
    expect(section).toContain('A,100');
    expect(section).toContain('B,200');
    expect(section).toContain('总计,300');
    expect(section).not.toContain('总计,600');
  });

  it('deleteRows：删明细行后汇总行标记前移；显式条件命中总行也照样删且标记移除', () => {
    const shrunk = executeTableOps(TOTAL_TEXT, [
      { type: 'deleteRows', where: { column: '产品', op: 'eq', value: '办公椅' } },
    ]);
    expect(shrunk.sheetText).toContain('TotalRow: 6');
    // 条件匹配对总行保持可用（用户明确说删"总计"就该删）
    const removed = executeTableOps(TOTAL_TEXT, [
      { type: 'deleteRows', where: { column: '产品', op: 'eq', value: '总计' } },
    ]);
    expect(removed.sheetText).not.toContain('总计,6,5800');
    expect(removed.sheetText).not.toContain('TotalRow');
  });

  it('sortRows：汇总行保持原位不参与排序', () => {
    const { sheetText, report } = executeTableOps(TOTAL_TEXT, [
      { type: 'sortRows', targetSheet: '汇总', column: '销售额', order: 'desc' },
    ]);
    expect(report[0].message).toContain('1 个汇总行保持原位');
    const lines = sheetText.split('\n');
    // 降序：显示器 3600、办公椅 1400、办公桌 800；总计仍在末行
    expect(lines[6]).toBe('显示器,3,3600');
    expect(lines[7]).toBe('办公椅,2,1400');
    expect(lines[8]).toBe('办公桌,1,800');
    expect(lines[9]).toBe('总计,6,5800');
    expect(sheetText).toContain('TotalRow: 7');
  });

  it('deriveColumn：汇总行跳过公式计算（总行数值不被明细公式改写）', () => {
    const text = [
      'Sheet: 明细',
      'TotalRow: 4',
      '产品,数量,单价,金额',
      'a,2,10,',
      'b,3,5,',
      '总计,5,15,80',
    ].join('\n');
    const { sheetText, report } = executeTableOps(text, [
      { type: 'deriveColumn', targetColumn: '金额', expression: '[数量]*[单价]' },
    ]);
    // 明细行 a=20、b=15；总行若不跳过会被算成 75 覆盖 80
    expect(report[0].message).toContain('计算写入 2 行');
    expect(sheetText).toContain('a,2,10,20');
    expect(sheetText).toContain('b,3,5,15');
    expect(sheetText).toContain('总计,5,15,80');
  });

  it('旧文档无指令：aggregateAppendRow 就地更新合计行时自动补标记（旧数据纳入契约）', () => {
    const legacy = singleSheetText('销售员,销售额', '销售员1号,1000', '销售员3号,2500', '合计,3500');
    const { sheetText, report } = executeTableOps(legacy, [
      { type: 'aggregateAppendRow', column: '销售额', fn: 'sum', label: '合计', labelColumn: '销售员' },
    ]);
    expect(report[0].message).toContain('就地更新');
    expect(sheetText).toContain('TotalRow: 4');
  });

  it('buildSheetOverview：输出汇总行声明行，总行空缺不计入空缺统计', () => {
    // 总计行销售额留空：声明为汇总行后不算"空缺"（补全走 aggregateUpdateCell 重算）
    const withEmptyTotal = TOTAL_TEXT.replace('总计,6,5800', '总计,6,');
    const overview = buildSheetOverview(withEmptyTotal);
    expect(overview).toContain('汇总行：第 7 行（总计）');
    expect(overview).toContain('aggregateUpdateCell');
    // 唯一的空格在总行上 → 不产生空缺统计行
    expect(overview).not.toContain('空缺单元格');
  });
});

// ==================== lookupFill / fillConstant（clarify 协议配套） ====================

describe('executeTableOps - lookupFill（跨表关联填充）', () => {
  /** 两表 fixture：表二的数量a 待按名称从表1关联填充 */
  const twoSheets = [
    'Sheet: 表1',
    '名称,数量',
    '椅子,10',
    '桌子,5',
    '灯,',
    '',
    'Sheet: 表二',
    '名称,数量a',
    '椅子,',
    '桌子,',
    '灯,',
  ].join('\n');

  const op = {
    type: 'lookupFill' as const,
    targetSheet: '表二',
    targetColumn: '数量a',
    sourceSheet: '表1',
    sourceKeyColumn: '名称',
    sourceValueColumn: '数量',
    targetKeyColumn: '名称',
  };

  it('按键精确关联填充空格：命中写入、未命中留空、不覆盖已有值', () => {
    const mixed = twoSheets.replace('桌子,', '桌子,99'); // 已有值不被覆盖
    const { sheetText, report } = executeTableOps(mixed, [op]);
    expect(report[0].message).toContain('共 2 格');
    expect(report[0].message).toContain('未在来源表命中'); // 灯 在来源表无数量值
    const section = sheetText.split('Sheet: 表二')[1] ?? '';
    expect(section).toContain('椅子,10');
    expect(section).toContain('桌子,99');
    expect(section).toContain('灯,');
  });

  it('键在来源表完全缺失：该行留空并计入未命中样本', () => {
    const withUnknown = `${twoSheets}\n沙发,`;
    const { report } = executeTableOps(withUnknown, [op]);
    expect(report[0].message).toContain('沙发');
  });

  it('跳过双方已声明汇总行：目标总行不填、来源总行不入池', () => {
    const withTotals = [
      'Sheet: 表1',
      // 内容行号 1 起含说明行：名称,数量(1) 椅子,10(2) 桌子,5(3) 总计,15(4)
      'TotalRow: 4',
      '名称,数量',
      '椅子,10',
      '桌子,5',
      '总计,15',
      '',
      'Sheet: 表二',
      'TotalRow: 4',
      '名称,数量a',
      '椅子,',
      '桌子,',
      '总计,',
    ].join('\n');
    const { sheetText, report } = executeTableOps(withTotals, [op]);
    expect(report[0].message).toContain('共 2 格');
    const section = sheetText.split('Sheet: 表二')[1] ?? '';
    expect(section).toContain('椅子,10');
    // 目标总行不被填充；来源总行 15 未混入键池（若混入且目标有"总计"键会被填 15）
    expect(section).toContain('总计,');
  });

  it('重复键取首个并计数', () => {
    const dup = [
      'Sheet: 表1',
      '名称,数量',
      '椅子,10',
      '椅子,20',
      '',
      'Sheet: 表二',
      '名称,数量a',
      '椅子,',
    ].join('\n');
    const { report } = executeTableOps(dup, [
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
    expect(report[0].message).toContain('1 个重复键取首个值');
  });

  it('单键场景写入 LookupFill 溯源指令（round-trip 保持）', () => {
    const { sheetText } = executeTableOps(twoSheets, [op]);
    expect(sheetText).toContain('LookupFill: 数量a|名称|表1|名称|数量');
    // 指令在 parse → serialize 后原样保留（导出 xlsx 与再执行依赖）
    expect(serializeSheetData(parseSheetData(sheetText))).toBe(sheetText);
  });

  it('复合键（keyMappings）不写单键溯源指令', () => {
    const { sheetText } = executeTableOps(twoSheets, [
      {
        type: 'lookupFill',
        targetSheet: '表二',
        targetColumn: '数量a',
        sourceSheet: '表1',
        sourceValueColumn: '数量',
        keyMappings: [{ targetKeyColumn: '名称', sourceKeyColumn: '名称' }],
      },
    ]);
    expect(sheetText).not.toContain('LookupFill:');
    expect(sheetText).toContain('椅子,10');
  });

  it('目标列被后续 updateCells 改写 → 溯源指令自动失效（防导出公式与实际值不符）', () => {
    const first = executeTableOps(twoSheets, [op]);
    expect(first.sheetText).toContain('LookupFill:');
    const second = executeTableOps(first.sheetText, [
      {
        type: 'updateCells',
        targetSheet: '表二',
        targetColumn: '数量a',
        where: { column: '名称', op: 'eq', value: '椅子' },
        newValue: '999',
      },
    ]);
    expect(second.sheetText).not.toContain('LookupFill:');
  });

  it('排序/删行不失效溯源（行内键值对随行移动，按键公式仍一致）', () => {
    const first = executeTableOps(twoSheets, [op]);
    const sorted = executeTableOps(first.sheetText, [
      { type: 'sortRows', targetSheet: '表二', column: '名称', order: 'desc' },
    ]);
    expect(sorted.sheetText).toContain('LookupFill:');
    const deleted = executeTableOps(first.sheetText, [
      { type: 'deleteRows', targetSheet: '表二', where: { column: '名称', op: 'eq', value: '桌子' } },
    ]);
    expect(deleted.sheetText).toContain('LookupFill:');
  });

  it('目标列/来源列不存在 → 报错', () => {
    expect(() =>
      executeTableOps(twoSheets, [{ ...op, targetColumn: '不存在列' }]),
    ).toThrow(/找不到列/);
    expect(() =>
      executeTableOps(twoSheets, [{ ...op, sourceKeyColumn: '不存在键' }]),
    ).toThrow(/找不到列/);
  });

  it('缺关联键（单键与复合键都没给）→ 校验拒绝', () => {
    expect(() =>
      executeTableOps(twoSheets, [
        {
          type: 'lookupFill',
          targetSheet: '表二',
          targetColumn: '数量a',
          sourceSheet: '表1',
          sourceValueColumn: '数量',
        },
      ]),
    ).toThrow(/缺少关联键/);
  });
});

describe('executeTableOps - fillConstant（固定值填充）', () => {
  const text = [
    'Sheet: 表',
    // 内容行号 1 起：名称,备注(1) a,(2) b,已有(3) 总计,,(4)
    'TotalRow: 4',
    '名称,备注',
    'a,',
    'b,已有',
    '总计,,',
  ].join('\n');

  it('只填明细行空格：不覆盖已有值、跳过汇总行', () => {
    const { sheetText, report } = executeTableOps(text, [
      { type: 'fillConstant', targetColumn: '备注', value: '待定' },
    ]);
    expect(report[0].message).toContain('共 1 格');
    expect(sheetText).toContain('a,待定');
    expect(sheetText).toContain('b,已有');
    expect(sheetText).toContain('总计,,');
  });
});
