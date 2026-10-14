/**
 * sheetTextToXlsx 单元测试
 *
 * 覆盖编辑器 Excel 导出的核心还原逻辑：
 * 多 sheet 拆分 / CSV 引号转义 / 散行兜底 / sheet 名清洗去重 / 空数据防护
 */
import * as XLSX from 'xlsx';
import { sheetTextToXlsx, detectTotalRowIndexes, buildSheetBlockText } from './document-parser';

/** 读取生成的 xlsx buffer 并转回 AOA（行数组），便于断言 */
function readBack(buffer: Buffer): Record<string, string[][]> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const result: Record<string, string[][]> = {};
  for (const name of wb.SheetNames) {
    result[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
    }) as string[][];
  }
  return result;
}

describe('sheetTextToXlsx', () => {
  it('多 sheet 文本还原为多 sheet 工作簿，数据逐格一致', () => {
    const text = [
      'Sheet: 销售明细',
      '日期,产品,数量',
      '2026-10-01,笔记本电脑,3',
      '',
      'Sheet: 汇总',
      '类别,金额',
      '电子产品,24393',
    ].join('\n');

    const buffer = sheetTextToXlsx(text);
    expect(buffer).not.toBeNull();

    const sheets = readBack(buffer!);
    expect(Object.keys(sheets)).toEqual(['销售明细', '汇总']);
    expect(sheets['销售明细']).toEqual([
      ['日期', '产品', '数量'],
      ['2026-10-01', '笔记本电脑', '3'],
    ]);
    expect(sheets['汇总']).toEqual([
      ['类别', '金额'],
      ['电子产品', '24393'],
    ]);
  });

  it('含引号转义的 CSV 正确还原（单元格含逗号/引号）', () => {
    const text = 'Sheet: 引号\n"值,含逗号",普通\n"他说""你好""",ok';
    const buffer = sheetTextToXlsx(text)!;
    const sheets = readBack(buffer);
    expect(sheets['引号']).toEqual([
      ['值,含逗号', '普通'],
      ['他说"你好"', 'ok'],
    ]);
  });

  it('标题前的散行归入 Sheet1（数据不丢）', () => {
    const text = '这是说明文字,第二列\nSheet: 数据\na,b';
    const buffer = sheetTextToXlsx(text)!;
    const sheets = readBack(buffer);
    expect(Object.keys(sheets)).toEqual(['Sheet1', '数据']);
    expect(sheets['Sheet1']).toEqual([['这是说明文字', '第二列']]);
  });

  it('HeaderRow 指令行不写进导出的 Excel（说明行与数据保留）', () => {
    const text = [
      'Sheet: 销售汇总报告',
      'HeaderRow: 3',
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品类别,金额小计',
      '冰箱,24393',
    ].join('\n');
    const buffer = sheetTextToXlsx(text)!;
    const sheets = readBack(buffer);
    expect(sheets['销售汇总报告']).toEqual([
      ['销售汇总报告', ''],
      ['2026-10-01 ~ 2026-10-11', ''],
      ['产品类别', '金额小计'],
      ['冰箱', '24393'],
    ]);
  });

  it('sheet 名非法字符被清洗、重名自动加序号、超长被截断', () => {
    const longName = 'S'.repeat(40);
    const text = [
      `Sheet: 非[法]:名`,
      'a,b',
      `Sheet: 非[法]:名`,
      'c,d',
      `Sheet: ${longName}`,
      'e,f',
      `Sheet: ${longName}`,
      'g,h',
    ].join('\n');

    const buffer = sheetTextToXlsx(text)!;
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const names = wb.SheetNames;

    expect(names).toHaveLength(4);
    // 非法字符（[ ] : 等）逐个替换为下划线
    expect(names[0]).toBe('非_法__名');
    // 重名自动加序号
    expect(names[1]).toBe('非_法__名(2)');
    // 超长截断到 28 字符，重名加序号
    expect(names[2]).toBe('S'.repeat(28));
    expect(names[3]).toBe(`${'S'.repeat(28)}(2)`);
  });

  it('空文本 / 无数据行返回 null（调用方走业务错误提示）', () => {
    expect(sheetTextToXlsx('')).toBeNull();
    expect(sheetTextToXlsx('Sheet: 只有标题\n\n\n')).toBeNull();
    expect(sheetTextToXlsx('普通文本没有逗号\n第二行')).not.toBeNull(); // 单列数据视为有效
  });
});

// ==================== 汇总行自动检测（上传时保守识别） ====================

describe('TotalRow 上传检测与 buildSheetBlockText', () => {
  it('detectTotalRowIndexes：从表头行之后扫描，返回内容行号', () => {
    const csv = [
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品,数量,销售额',
      '办公椅,2,1400',
      '总计,6,5800',
    ].join('\n');
    expect(detectTotalRowIndexes(csv, 3)).toEqual([5]);
  });

  it('detectTotalRowIndexes：表头未识别时从第 2 行扫起；标签须整格命中', () => {
    expect(detectTotalRowIndexes('名称,金额\na,100\n合计,200', null)).toEqual([3]);
    // "合计（含税）"整格不等于标签词 → 不命中；"总计:"（标签词+冒号）→ 命中
    const strict = ['名称,金额', '合计（含税）,100', '总计:,200'].join('\n');
    expect(detectTotalRowIndexes(strict, null)).toEqual([3]);
  });

  it('buildSheetBlockText：两项识别同时命中时按 HeaderRow → TotalRow 顺序落指令', () => {
    const csv = ['销售汇总报告,', '产品,数量', 'a,1', '总计,1'].join('\n');
    expect(buildSheetBlockText('汇总', csv)).toBe(
      ['Sheet: 汇总', 'HeaderRow: 2', 'TotalRow: 4', '销售汇总报告,', '产品,数量', 'a,1', '总计,1'].join('\n'),
    );
  });

  it('TotalRow 指令不写进导出的 Excel（与 HeaderRow 同处理）', () => {
    const text = [
      'Sheet: 销售汇总报告',
      'HeaderRow: 3',
      'TotalRow: 6',
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品,金额',
      '办公椅,1400',
      '总计,1400',
    ].join('\n');
    const buffer = sheetTextToXlsx(text)!;
    const sheets = readBack(buffer);
    expect(sheets['销售汇总报告']).toEqual([
      ['销售汇总报告', ''],
      ['2026-10-01 ~ 2026-10-11', ''],
      ['产品', '金额'],
      ['办公椅', '1400'],
      ['总计', '1400'],
    ]);
  });
});

// ==================== withFormulas：LookupFill → INDEX/MATCH 公式导出 ====================

describe('sheetTextToXlsx - withFormulas 公式导出', () => {
  /**
   * 两表 fixture：表二.数量a 由 表1.数量 按 名称 关联填充。
   * 桌子行已有值 99（验证不覆盖）、空键行/未命中键行（验证跳过）。
   * LookupFill 指令须在块首指令区（Sheet 行后第一个非空行）。
   */
  const text = [
    'Sheet: 表二',
    'LookupFill: 数量a|名称|表1|名称|数量',
    '名称,数量a',
    '椅子,',
    '桌子,99',
    ',',
    '灯,',
    '',
    'Sheet: 表1',
    '名称,数量',
    '椅子,10',
    '桌子,5',
  ].join('\n');

  it('withFormulas=true：空格写入 INDEX/MATCH 公式（带缓存值），已有值/键空/未命中不写', () => {
    const buffer = sheetTextToXlsx(text, { withFormulas: true })!;
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets['表二'];
    // 椅子行（Excel 第 2 行）数量a 为空 → 写公式 + 缓存值 10（SheetJS 会丢弃无 v 的公式格）
    expect(ws['B2']).toMatchObject({
      f: "INDEX('表1'!$B$2:$B$3,MATCH(A2,'表1'!$A$2:$A$3,0))",
      v: 10,
    });
    // 桌子行已有值 99 → 不覆盖（与 executor.lookupFill 同语义），无公式
    expect(ws['B3']?.f).toBeUndefined();
    expect(String(ws['B3']?.v)).toBe('99');
    // 空键行（第 3 行数据）→ 跳过
    expect(ws['B4']?.f).toBeUndefined();
    // 未命中键（表1 无"灯"）→ 留空，不写必然 #N/A 的公式
    expect(ws['B5']?.f).toBeUndefined();
  });

  it('缺省（withFormulas=false）：保持纯值导出，不写公式', () => {
    const buffer = sheetTextToXlsx(text)!;
    const wb = XLSX.read(buffer, { type: 'buffer' });
    expect(wb.Sheets['表二']['B2']?.f).toBeUndefined();
  });

  it('声明引用的源表不可定位 → 跳过该声明（宁缺勿错）', () => {
    const bad = [
      'Sheet: 孤表',
      'LookupFill: 数量a|名称|不存在的表|名称|数量',
      '名称,数量a',
      '椅子,',
    ].join('\n');
    const buffer = sheetTextToXlsx(bad, { withFormulas: true })!;
    const wb = XLSX.read(buffer, { type: 'buffer' });
    expect(wb.Sheets['孤表']['B2']?.f).toBeUndefined();
  });

  it('脏声明（段数不足/含空段）被丢弃，不写公式', () => {
    const dirty = [
      'Sheet: 脏声明',
      'LookupFill: 数量a|名称||名称|数量',
      '名称,数量a',
      '椅子,',
    ].join('\n');
    const buffer = sheetTextToXlsx(dirty, { withFormulas: true })!;
    const wb = XLSX.read(buffer, { type: 'buffer' });
    expect(wb.Sheets['脏声明']['B2']?.f).toBeUndefined();
  });

  it('目标表已声明汇总行（TotalRow）不写公式（与 executor.lookupFill 同语义）', () => {
    // 表二汇总行"总计"的键在表1 命中（表1 的总计行是未声明的普通行）——
    // 若不跳过汇总行，公式会被写到目标汇总行上，把来源聚合值传染进去
    const withTotal = [
      'Sheet: 表二',
      // 内容行 1 起（指令行不计数）：名称,数量a(1) 椅子,(2) 总计,(3)
      'TotalRow: 3',
      'LookupFill: 数量a|名称|表1|名称|数量',
      '名称,数量a',
      '椅子,',
      '总计,',
      '',
      'Sheet: 表1',
      '名称,数量',
      '椅子,10',
      '总计,15',
    ].join('\n');
    const buffer = sheetTextToXlsx(withTotal, { withFormulas: true })!;
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets['表二'];
    // 明细行椅子（Excel 第 2 行）正常写公式 + 缓存值
    expect(ws['B2']?.f).toContain('INDEX');
    expect(ws['B2']?.v).toBe(10);
    // 汇总行（Excel 第 3 行）跳过：不写公式，也不得从来源"总计,15"取值
    expect(ws['B3']?.f).toBeUndefined();
  });
});
