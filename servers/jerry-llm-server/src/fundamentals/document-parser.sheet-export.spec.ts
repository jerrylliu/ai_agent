/**
 * sheetTextToXlsx 单元测试
 *
 * 覆盖编辑器 Excel 导出的核心还原逻辑：
 * 多 sheet 拆分 / CSV 引号转义 / 散行兜底 / sheet 名清洗去重 / 空数据防护
 */
import * as XLSX from 'xlsx';
import { sheetTextToXlsx } from './document-parser';

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
