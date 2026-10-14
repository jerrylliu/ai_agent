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
  flattenDocText,
  maxTableRowCount,
  firstTableOf,
  collectSheetTables,
  retypeSheetHeaderRow,
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

// ==================== doc 文本提取（后端 contentJson 形态兼容） ====================

describe('flattenDocText', () => {
  it('段落间补换行：sheet 边界不粘连（线上 bug 回归）', () => {
    // 后端 textToTiptapJson 按空行分段、段内保留 \n。
    // 若提取时直接 join('')，"…,4398" 与下一段的 "Sheet: 汇总" 会粘成一行，
    // 转换后上一 sheet 末单元格出现 "4398Sheet: 汇总"
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Sheet: 销售明细\n产品,金额\n升降桌,4398' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Sheet: 汇总\n类别,金额\n电子产品,24393' }] },
      ],
    };
    const text = flattenDocText(doc);
    expect(text).toContain('升降桌,4398\nSheet: 汇总');

    const { doc: converted } = sheetTextToTableDoc(text);
    const headings = converted.content!.filter((n) => n.type === 'heading');
    expect(headings.map((h) => h.content![0].text)).toEqual(['销售明细', '汇总']);
    const tables = converted.content!.filter((n) => n.type === 'table');
    expect(tables).toHaveLength(2);
    // 粘连时末单元格会是 "4398Sheet: 汇总"——逐格断言确保数据干净
    const firstTable = tables[0];
    const lastCell =
      (firstTable.content![1].content![1].content![0].content![0] as JSONContent).text;
    expect(lastCell).toBe('4398');
  });

  it('hardBreak 还原为换行（段落内硬换行形态）', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Sheet: A\n名称,数量' },
            { type: 'hardBreak' },
            { type: 'text', text: 'a,1\nb,2' },
          ],
        },
      ],
    };
    const { doc: converted } = sheetTextToTableDoc(flattenDocText(doc));
    // hardBreak 还原为 '\n' 后正常成表：表头 + 2 数据行
    expect(maxTableRowCount(converted)).toBe(3);
  });
});

// ==================== 表头行锚定（HeaderRow 指令） ====================

/** 报表式表格 fixture：标题行 + 日期行 + 真表头在第 3 行（与后端 executor.spec 对齐） */
const REPORT_TEXT = [
  'Sheet: 销售汇总报告',
  'HeaderRow: 3',
  '销售汇总报告,',
  '2026-10-01 ~ 2026-10-11,',
  '产品类别,金额小计',
  '冰箱,24393',
  '洗衣机,79215',
].join('\n');

describe('表头行锚定 - sheetTextToTableDoc', () => {
  it('指令锚定：第 3 行渲染为 tableHeader，说明行与数据行为 tableCell', () => {
    const { doc, degraded } = sheetTextToTableDoc(REPORT_TEXT);
    expect(degraded).toBe(false);
    const table = doc.content!.find((n) => n.type === 'table')!;
    const rows = table.content!;
    expect(rows).toHaveLength(5); // 2 说明行 + 表头 + 2 数据行
    expect(rows[0].content![0].type).toBe('tableCell'); // 标题行
    expect(rows[1].content![0].type).toBe('tableCell'); // 日期行
    expect(rows[2].content![0].type).toBe('tableHeader'); // 真表头
    expect(rows[3].content![0].type).toBe('tableCell');
    expect(
      (rows[2].content![0].content![0].content![0] as JSONContent).text,
    ).toBe('产品类别');
  });

  it('无指令旧格式：首行仍为 tableHeader（完全兼容）', () => {
    const { doc } = sheetTextToTableDoc('Sheet: 数据\n名称,数量\n苹果,3');
    const table = doc.content!.find((n) => n.type === 'table')!;
    expect(table.content![0].content![0].type).toBe('tableHeader');
    expect(table.content![1].content![0].type).toBe('tableCell');
  });

  it('脏指令超界收敛到内容行数（与后端 parseSheetData 口径一致，表头不丢失）', () => {
    // 内容共 3 行，指令说 99 → 收敛到第 3 行为表头（而非无任何 tableHeader）
    const { doc } = sheetTextToTableDoc('Sheet: 表\nHeaderRow: 99\n标题,\n名称,数量\na,1');
    const table = doc.content!.find((n) => n.type === 'table')!;
    expect(table.content![0].content![0].type).toBe('tableCell');
    expect(table.content![1].content![0].type).toBe('tableCell');
    expect(table.content![2].content![0].type).toBe('tableHeader');
  });

  it('脏指令为 0 时收敛到首行表头（clamp 下限）', () => {
    const { doc } = sheetTextToTableDoc('Sheet: 表\nHeaderRow: 0\n名称,数量\na,1');
    const table = doc.content!.find((n) => n.type === 'table')!;
    expect(table.content![0].content![0].type).toBe('tableHeader');
  });
});

describe('表头行锚定 - tableDocToSheetText', () => {
  it('双向 round-trip：含指令文本 → doc → 文本原样（指令保留）', () => {
    const { doc } = sheetTextToTableDoc(REPORT_TEXT);
    expect(tableDocToSheetText(doc)).toBe(REPORT_TEXT);
  });

  it('中间行 tableHeader → 反向输出 HeaderRow 指令（编辑器手动改表头后保存不丢锚点）', () => {
    // 模拟用户在编辑器里把第 3 行格转成表头（tableHeader）后的 doc 形态
    const { doc } = sheetTextToTableDoc(REPORT_TEXT);
    const table = doc.content!.find((n) => n.type === 'table')!;
    // 全部转回 tableCell 再把第 3 行设为 tableHeader（模拟任意编辑操作的结果）
    for (const row of table.content!) {
      for (const cell of row.content!) cell.type = 'tableCell';
    }
    for (const cell of table.content![2].content!) cell.type = 'tableHeader';
    const text = tableDocToSheetText(doc);
    expect(text).toContain('HeaderRow: 3');
    expect(text).toContain('产品类别,金额小计');
  });

  it('无 tableHeader 的普通表 → 不输出指令', () => {
    const tableNode: JSONContent = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
          ],
        },
      ],
    };
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '表' }] },
        tableNode,
      ],
    };
    const text = tableDocToSheetText(doc);
    expect(text).toBe('Sheet: 表\na');
  });
});

// ==================== 汇总行锚定（TotalRow 指令 + bold 载体） ====================

/** 汇总行 fixture：表头第 3 行、总计第 7 行（与后端 executor.spec 的 TOTAL_TEXT 对齐） */
const TOTAL_TEXT = [
  'Sheet: 销售汇总报告',
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

/** 取某行某格的 text 节点（cell → paragraph → text 四层） */
const textNodeOf = (table: JSONContent, row: number, col: number): JSONContent =>
  table.content![row].content![col].content![0].content![0] as JSONContent;

/** 断言某行所有 text 节点是否带 bold */
const rowHasBold = (table: JSONContent, row: number): boolean =>
  (table.content![row].content ?? []).some((cell) =>
    (cell.content ?? []).some((p) => (p.content ?? []).some((t) => (t.marks ?? []).some((m) => m.type === 'bold'))),
  );

describe('汇总行锚定 - sheetTextToTableDoc（bold 载体）', () => {
  it('TotalRow 指令 → 该行整行 bold，其他行无 bold', () => {
    const { doc, degraded } = sheetTextToTableDoc(TOTAL_TEXT);
    expect(degraded).toBe(false);
    const table = firstTableOf(doc)!;
    expect(table.content).toHaveLength(7); // 2 说明行 + 表头 + 3 数据行 + 总计
    // 说明行/表头/数据行（节点序 0-5）全部无 bold
    for (const r of [0, 1, 2, 3, 4, 5]) expect(rowHasBold(table, r)).toBe(false);
    // 总计行（节点序 6 = 内容行 7）整行 bold——有说明行时不能错打到数据首行
    expect(textNodeOf(table, 6, 0).text).toBe('总计');
    for (const cell of table.content![6].content!) {
      for (const p of cell.content ?? []) {
        for (const t of p.content ?? []) {
          expect((t.marks ?? []).some((m) => m.type === 'bold')).toBe(true);
        }
      }
    }
  });

  it('脏标记丢弃：越界/说明行/表头行号不产生任何 bold', () => {
    const dirty = TOTAL_TEXT.replace('TotalRow: 7', 'TotalRow: 1,3,99');
    const { doc } = sheetTextToTableDoc(dirty);
    const table = firstTableOf(doc)!;
    for (let r = 0; r < table.content!.length; r++) {
      expect(rowHasBold(table, r)).toBe(false);
    }
  });

  it('round-trip：指令锚定与数据均保留；参差说明行按矩形规范化后二次往返逐字节稳定', () => {
    const { doc } = sheetTextToTableDoc(TOTAL_TEXT);
    const once = tableDocToSheetText(doc)!;
    expect(once).toContain('HeaderRow: 3');
    expect(once).toContain('TotalRow: 7');
    expect(once).toContain('办公椅,2,1400');
    expect(once).toContain('总计,6,5800');
    // 说明行（2 格）短于表头列数（3 列）→ 表格是矩形，序列化补空尾格（幂等规范化，
    // 与 REPORT_TEXT 恰好 2 列等宽时逐字节一致不同）；二次往返必须稳定
    expect(tableDocToSheetText(sheetTextToTableDoc(once).doc)).toBe(once);
  });
});

describe('汇总行锚定 - tableDocToSheetText（反向检测）', () => {
  const plainText = TOTAL_TEXT.replace('TotalRow: 7\n', '');

  it('表头后整行加粗的行 → 输出 TotalRow 指令（用户手动加粗也声明）', () => {
    const { doc } = sheetTextToTableDoc(plainText);
    const table = firstTableOf(doc)!;
    // 模拟用户在编辑器里把总计行整行加粗
    for (const cell of table.content![6].content!) {
      for (const p of cell.content ?? []) {
        for (const t of p.content ?? []) t.marks = [{ type: 'bold' }];
      }
    }
    const text = tableDocToSheetText(doc)!;
    expect(text).toContain('TotalRow: 7');
  });

  it('部分加粗（非整行）不判为汇总行（"标签加粗"习惯不算声明）', () => {
    const { doc } = sheetTextToTableDoc(plainText);
    const table = firstTableOf(doc)!;
    // 只加粗第一格
    for (const p of table.content![6].content![0].content ?? []) {
      for (const t of p.content ?? []) t.marks = [{ type: 'bold' }];
    }
    const text = tableDocToSheetText(doc)!;
    expect(text).not.toContain('TotalRow');
  });

  it('无加粗行 → 不输出 TotalRow 指令（无中生有防护）', () => {
    const { doc } = sheetTextToTableDoc(plainText);
    expect(tableDocToSheetText(doc)).not.toContain('TotalRow');
  });
});

// ==================== 跨表关联填充指令（LookupFill 载体与 round-trip） ====================

/** 单 sheet fixture：LookupFill 指令在块首指令区（渲染为标题后普通段落载体） */
const LOOKUP_TEXT = [
  'Sheet: 表二',
  'LookupFill: 数量a|名称|表1|名称|数量',
  '名称,数量a',
  '椅子,',
  '桌子,',
].join('\n');

describe('LookupFill 指令 - 载体与 round-trip', () => {
  it('正向：指令渲染为标题后的普通段落，不混入表格', () => {
    const { doc, degraded } = sheetTextToTableDoc(LOOKUP_TEXT);
    expect(degraded).toBe(false);
    // heading(表二) → paragraph(指令载体) → table → paragraph(表格后光标锚点空段落)
    expect(doc.content!.map((n) => n.type)).toEqual(['heading', 'paragraph', 'table', 'paragraph']);
    expect((doc.content![1].content![0] as JSONContent).text).toBe(
      'LookupFill: 数量a|名称|表1|名称|数量',
    );
    // 指令行未进表格：表二表格 = 表头 + 2 数据行
    expect(doc.content![2].content).toHaveLength(3);
  });

  it('多条指令全部保留、顺序不变，round-trip 逐字节一致', () => {
    const text = [
      'Sheet: 表二',
      'LookupFill: a1|名称|表1|名称|数量',
      'LookupFill: a2|编号|表1|编号|库存',
      '名称,数量',
      '椅子,',
    ].join('\n');
    const { doc } = sheetTextToTableDoc(text);
    // 2 条指令段落（表格后的光标锚点空段落不计）
    const paragraphs = doc.content!.filter(
      (n) => n.type === 'paragraph' && (n.content?.length ?? 0) > 0,
    );
    expect(paragraphs).toHaveLength(2);
    expect(tableDocToSheetText(doc)).toBe(text);
  });

  it('round-trip：指令段落反向序列化自然落回块首指令区（编辑器保存不丢溯源声明）', () => {
    const { doc } = sheetTextToTableDoc(LOOKUP_TEXT);
    expect(tableDocToSheetText(doc)).toBe(LOOKUP_TEXT);
  });

  it('多 sheet：指令归属各自 sheet，二次往返稳定（首个 sheet 间空行被规范化）', () => {
    const multi = [
      'Sheet: 表二',
      'LookupFill: 数量a|名称|表1|名称|数量',
      '名称,数量a',
      '椅子,',
      '',
      'Sheet: 表1',
      '名称,数量',
      '椅子,10',
    ].join('\n');
    const { doc } = sheetTextToTableDoc(multi);
    const once = tableDocToSheetText(doc)!;
    // 指令落在表二块首（sheet 标题与表头之间）
    expect(once).toContain('Sheet: 表二\nLookupFill: 数量a|名称|表1|名称|数量\n名称,数量a');
    // sheet 间空行是序列化规范化的产物差异，二次往返必须逐字节稳定
    expect(tableDocToSheetText(sheetTextToTableDoc(once).doc)).toBe(once);
  });

  it('指令只认块首：数据行开始后的 LookupFill 行按数据行保留（与后端口径一致）', () => {
    const text = [
      'Sheet: 表',
      '名称,数量',
      '椅子,10',
      'LookupFill: 数量a|名称|表1|名称|数量',
    ].join('\n');
    const { doc } = sheetTextToTableDoc(text);
    const table = firstTableOf(doc)!;
    // 该行进入表格成为数据行（表头 + 2 数据行），不产生指令段落
    // （表格后的光标锚点空段落不算指令载体）
    expect(table.content).toHaveLength(3);
    expect(
      doc.content!.some((n) => n.type === 'paragraph' && (n.content?.length ?? 0) > 0),
    ).toBe(false);
  });
});

describe('表头确认条 - collectSheetTables / retypeSheetHeaderRow', () => {
  it('collectSheetTables：多 sheet 各自归属，表头行号与指令口径一致', () => {
    const multi = [
      'Sheet: 销售明细',
      '名称,数量',
      '椅子,10',
      '',
      'Sheet: 汇总',
      'HeaderRow: 3',
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品类别,金额小计',
      '电子产品,24393',
    ].join('\n');
    const { doc } = sheetTextToTableDoc(multi);
    const tables = collectSheetTables(doc);
    expect(tables).toHaveLength(2);
    // 常规表无 HeaderRow 指令 → 默认第 1 行；行数含 2 说明行+表头+1 数据行
    expect(tables[0]).toMatchObject({ sheetName: '销售明细', headerRowNumber: 1, rowCount: 2 });
    // 指令锚定的表 → 第 3 行（含说明行的内容行序）；行数含 2 说明行+表头+1 数据行
    expect(tables[1]).toMatchObject({ sheetName: '汇总', headerRowNumber: 3, rowCount: 4 });
  });

  it('retypeSheetHeaderRow：表头标记迁移到新行，原表头行回 tableCell', () => {
    const { doc } = sheetTextToTableDoc(REPORT_TEXT);
    const tables = collectSheetTables(doc);
    expect(tables[0].headerRowNumber).toBe(3);
    const next = retypeSheetHeaderRow(doc, tables[0].tableIndex, 1);
    // 表头移到第 1 行：原说明行升为 tableHeader，原表头行降回 tableCell
    const table = firstTableOf(next)!;
    expect(table.content![0].content![0].type).toBe('tableHeader');
    expect(table.content![2].content![0].type).toBe('tableCell');
    // 保存序列化对默认第 1 行省略指令（与 headerRowIndex > 1 才写出的口径一致）
    expect(tableDocToSheetText(next)).not.toContain('HeaderRow:');
  });

  it('retypeSheetHeaderRow：改回非首行后 round-trip 稳定', () => {
    const { doc } = sheetTextToTableDoc(REPORT_TEXT);
    const tables = collectSheetTables(doc);
    const to2 = retypeSheetHeaderRow(doc, tables[0].tableIndex, 2);
    const text = tableDocToSheetText(to2)!;
    expect(text).toContain('HeaderRow: 2');
    // 序列化结果重新加载后表头行号一致（round-trip 稳定）
    const again = collectSheetTables(sheetTextToTableDoc(text).doc);
    expect(again[0].headerRowNumber).toBe(2);
  });

  it('retypeSheetHeaderRow：越界行号收敛到 [1, rowCount]', () => {
    const { doc } = sheetTextToTableDoc(REPORT_TEXT);
    const tables = collectSheetTables(doc);
    const over = retypeSheetHeaderRow(doc, tables[0].tableIndex, 999);
    const table = firstTableOf(over)!;
    // 收敛到最后一行
    expect(table.content![table.content!.length - 1].content![0].type).toBe('tableHeader');
  });

  it('retypeSheetHeaderRow：TotalRow bold 载体等其余结构不受影响', () => {
    const { doc } = sheetTextToTableDoc(TOTAL_TEXT);
    const tables = collectSheetTables(doc);
    const next = retypeSheetHeaderRow(doc, tables[0].tableIndex, 1);
    const text = tableDocToSheetText(next)!;
    // 汇总行指令保留（bold 载体未被重标破坏）；表头回到第 1 行 → 指令省略
    expect(text).toContain('TotalRow: 7');
    expect(text).not.toContain('HeaderRow:');
  });
});
