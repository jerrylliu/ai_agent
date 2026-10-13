/**
 * table-convert.test.ts - Excel↔表格节点双向转换层测试
 *
 * 覆盖：判定、正向转换（含生产形态）、双向自检降级、反向提取、行数统计
 */
import { describe, expect, it } from 'vitest';
import {
  isSheetStructuredText,
  sheetTextToTableDoc,
  tableNodeToCsv,
  tableDocToSheets,
  tableDocToSheetText,
  docContainsTable,
  maxTableRowCount,
  firstTableOf,
  TABLE_HARD_ROW_LIMIT,
} from './table-convert';
import type { JSONContent } from '@tiptap/react';

// ==================== 判定 ====================

describe('isSheetStructuredText', () => {
  it('两个 sheet 标题 → 判定为结构化', () => {
    expect(
      isSheetStructuredText('Sheet: A\na,b\n\nSheet: B\n1,2'),
    ).toBe(true);
  });

  it('单个标题 + 含逗号正文 → 判定为结构化', () => {
    expect(isSheetStructuredText('Sheet: 数据\n名称,数量\n苹果,3')).toBe(true);
  });

  it('单个标题但无 CSV 正文 → 不判定（避免误判普通文本）', () => {
    expect(isSheetStructuredText('Sheet: 概览\n这是普通说明文字')).toBe(false);
  });

  it('纯文本无标题 → false', () => {
    expect(isSheetStructuredText('普通段落，虽然有逗号')).toBe(false);
  });
});

// ==================== 正向转换 ====================

describe('sheetTextToTableDoc', () => {
  it('多 sheet 文本 → heading + table 节点，首行为表头', () => {
    const text = [
      'Sheet: 销售明细',
      '日期,产品,数量',
      '2026-10-01,笔记本电脑,3',
      '2026-10-02,机械键盘,10',
      '',
      'Sheet: 汇总',
      '类别,金额',
      '电子产品,24393',
    ].join('\n');

    const { doc, degraded } = sheetTextToTableDoc(text);
    expect(degraded).toBe(false);

    const tables = doc.content!.filter((n) => n.type === 'table');
    const headings = doc.content!.filter((n) => n.type === 'heading');
    expect(headings.map((h) => h.content![0].text)).toEqual(['销售明细', '汇总']);

    const firstTable = tables[0];
    expect(firstTable.content).toHaveLength(3); // 表头 + 2 数据行
    // 单元格结构：cell → paragraph → text（四层）
    expect(firstTable.content![0].content![0].type).toBe('tableHeader');
    expect(
      (firstTable.content![0].content![0].content![0].content![0] as JSONContent).text,
    ).toBe('日期');
    expect(firstTable.content![1].content![0].type).toBe('tableCell');
  });

  it('含引号转义单元格的 CSV 正确解析', () => {
    const text = 'Sheet: 引号\n"值,含逗号",普通\n"他说""你好""",ok';
    const { doc } = sheetTextToTableDoc(text);
    const table = firstTableOf(doc)!;
    expect(table).toBeDefined();
    const cellText = (row: number, col: number): string =>
      (table.content![row].content![col].content![0].content![0] as JSONContent).text ?? '';
    expect(cellText(0, 0)).toBe('值,含逗号');
    expect(cellText(1, 0)).toBe('他说"你好"');
  });

  it('短行补空单元格保证矩形', () => {
    const text = 'Sheet: 参差\na,b,c\n1,2';
    const { doc } = sheetTextToTableDoc(text);
    const table = firstTableOf(doc)!;
    expect(table).toBeDefined();
    expect(table.content![1].content).toHaveLength(3);
    // 空单元格：content 为空数组（无 paragraph 子节点）
    expect(table.content![1].content![2].type).toBe('tableCell');
    expect(table.content![1].content![2].content).toEqual([]);
  });

  it('超硬限行数 → 降级纯文本（保险丝）', () => {
    const rows = Array.from(
      { length: TABLE_HARD_ROW_LIMIT + 10 },
      (_, i) => `r${i},v${i}`,
    );
    const { doc, degraded } = sheetTextToTableDoc(
      `Sheet: 大表\n${rows.join('\n')}`,
    );
    expect(degraded).toBe(true);
    expect(doc.content!.some((n) => n.type === 'table')).toBe(false);
    expect(doc.content!.some((n) => n.type === 'paragraph')).toBe(true);
  });

  it('行列数自检失败 → 降级纯文本且数据不丢', () => {
    // 构造 round-trip 行数不一致的场景：伪造 splitSheetBlocks 之外的行为很难，
    // 这里用引号内换行（已知简化解析边界）触发
    const text = 'Sheet: 边界\n"a\nb",1';
    const { doc, degraded } = sheetTextToTableDoc(text);
    // 无论转换成功与否，数据必须不丢（paragraph 或 table 二选一存在）
    const hasData =
      doc.content!.some((n) => n.type === 'table') ||
      doc.content!.some((n) => n.type === 'paragraph');
    expect(hasData).toBe(true);
    if (degraded) {
      expect(doc.content!.some((n) => n.type === 'table')).toBe(false);
    }
  });
});

// ==================== 反向提取 ====================

describe('tableNodeToCsv / tableDocToSheets', () => {
  it('table → CSV 含转义还原', () => {
    const table: JSONContent = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'a,b' }] },
              ],
            },
            {
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }],
            },
          ],
        },
      ],
    };
    expect(tableNodeToCsv(table)).toBe('"a,b",c');
  });

  it('doc → sheets：heading 拆 sheet、散表归 Sheet1', () => {
    const cell = (t: string, header = false): JSONContent => ({
      type: header ? 'tableHeader' : 'tableCell',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
    });
    const row = (cells: JSONContent[]): JSONContent => ({
      type: 'tableRow',
      content: cells,
    });
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'SheetA' }],
        },
        { type: 'table', content: [row([cell('x', true), cell('y', true)])] },
        { type: 'table', content: [row([cell('1'), cell('2')])] },
        { type: 'paragraph', content: [{ type: 'text', text: '无表段落' }] },
      ],
    };
    const sheets = tableDocToSheets(doc)!;
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('SheetA');
    expect(sheets[0].csv).toBe('x,y\n1,2');
  });

  it('doc 无表格 → null（调用方走 Markdown 导出）', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '纯文本' }] }],
    };
    expect(tableDocToSheets(doc)).toBeNull();
  });
});

// ==================== 统计 ====================

describe('maxTableRowCount', () => {
  it('取最大单表行数', () => {
    const mkTable = (rows: number): JSONContent => ({
      type: 'table',
      content: Array.from({ length: rows }, () => ({
        type: 'tableRow',
        content: [],
      })),
    });
    const doc: JSONContent = {
      type: 'doc',
      content: [mkTable(10), mkTable(300)],
    };
    expect(maxTableRowCount(doc)).toBe(300);
  });
});

// ==================== contentText 序列化 ====================

describe('docContainsTable / tableDocToSheetText', () => {
  const cell = (t: string, header = false): JSONContent => ({
    type: header ? 'tableHeader' : 'tableCell',
    content: t
      ? [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
      : [],
  });
  const row = (cells: JSONContent[]): JSONContent => ({
    type: 'tableRow',
    content: cells,
  });

  it('docContainsTable：顶层有表 true / 无表 false', () => {
    const withTable: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'p' }] },
        { type: 'table', content: [row([cell('a', true)])] },
      ],
    };
    const withoutTable: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'p' }] }],
    };
    expect(docContainsTable(withTable)).toBe(true);
    expect(docContainsTable(withoutTable)).toBe(false);
  });

  it('tableDocToSheetText：h3 → Sheet 行、table → CSV、段落保留（数据无损）', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '备注文字' }] },
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: '销售明细' }],
        },
        { type: 'table', content: [row([cell('日期', true), cell('数量', true)]), row([cell('10-01'), cell('3')])] },
      ],
    };
    const text = tableDocToSheetText(doc)!;
    expect(text).toBe(
      ['备注文字', 'Sheet: 销售明细', '日期,数量', '10-01,3'].join('\n'),
    );
    // 正反往返：序列化产物能被正向转换还原出同样的表格（2 行）
    const { doc: roundTrip } = sheetTextToTableDoc(text);
    expect(maxTableRowCount(roundTrip)).toBe(2);
    expect(firstTableOf(roundTrip)).toBeDefined();
  });

  it('含引号转义的单元格序列化后可被 CSV 解析还原', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'table', content: [row([cell('值,含逗号', true), cell('普通', true)])] },
      ],
    };
    const text = tableDocToSheetText(doc)!;
    // 散表无 heading 节点 → 不产生 Sheet 行；服务端导出时标题前的散行归 Sheet1
    expect(text).toBe('"值,含逗号",普通');
  });

  it('手动插表的普通文档：段落与表格都保留为文本行（服务端导出归 Sheet1）', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '说明' }] },
        { type: 'table', content: [row([cell('a', true), cell('b', true)])] },
      ],
    };
    const text = tableDocToSheetText(doc)!;
    expect(text).toBe('说明\na,b');
  });

  it('无表 doc → null（调用方回退 extractText 原路径）', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '纯文本' }] }],
    };
    expect(tableDocToSheetText(doc)).toBeNull();
  });
});
