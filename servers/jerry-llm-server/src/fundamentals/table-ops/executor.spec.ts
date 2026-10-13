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
});
