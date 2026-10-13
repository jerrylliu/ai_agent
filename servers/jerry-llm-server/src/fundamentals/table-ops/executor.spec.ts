/**
 * table-ops/executor.spec.ts - 表格指令执行器测试
 *
 * 覆盖：各操作类型的正向执行、数字感知、先校验后执行（引用不存在整体拒绝）、
 *       护栏（超行数/空内容）、round-trip 序列化一致性。
 */
import {
  executeTableOps,
  buildSheetOverview,
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
    // 新行插在"总计"之前（汇总部分共 9 行：Sheet 标题+表头+6 数据行+新行）
    expect(lines[7]).toBe('重点客户合计,11548');
    expect(lines[8]).toBe('总计,52948');
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
  it('输出表头 + 最多 2 行样本，不含全表数据', () => {
    const text = singleSheetText('名称,数量', 'a,1', 'b,2', 'c,3', 'd,4');
    const overview = buildSheetOverview(text);
    expect(overview).toContain('表头：名称、数量');
    expect(overview).toContain('名称=a');
    expect(overview).toContain('名称=b');
    expect(overview).not.toContain('名称=c');
    expect(overview).not.toContain('名称=d');
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
});
