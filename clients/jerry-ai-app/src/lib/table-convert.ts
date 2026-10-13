/**
 * table-convert - Excel 内容与 Tiptap 表格节点的双向转换层
 *
 * 服务端 /upload/extract 对 Excel 的产物是 "## Sheet: 名称" 标题 + CSV 文本块
 * （见 document-parser.ts parseExcelFile）。本模块职责：
 *   1. isSheetStructuredText：判定文本是否为"Excel 解析产物"（sheet 标题 + CSV 段）
 *   2. sheetTextToTableDoc：把该文本转为 Tiptap doc（标题 heading + table 节点）
 *   3. tableDocToSheetText：反向序列化（xlsx 导出自检 + 下载 Markdown 复用）
 *
 * 设计约束（对应 EXCEL_GRID_EDITOR_PLAN.md D1/D3）：
 *   - 存储形态就是 Tiptap table 节点，不引入私有格式；
 *   - 转换失败一律降级为纯文本段落，**宁可不转，不可转坏**；
 *   - 双向自检：sheetTextToTableDoc 内部先转换再序列化回 CSV 比对，
 *     行列数与原文不一致则放弃表格化。
 */

import type { JSONContent } from '@tiptap/react';

// ==================== 常量 ====================

/** sheet 标题行格式（与服务端 document-parser.ts 的 `Sheet: xxx` 对齐，渲染为 heading） */
const SHEET_HEADING_RE = /^#{0,4}\s*Sheet\s*[:：]\s*(.+)$/;

/**
 * 表格化判定阈值（对应方案"大表性能"保险丝）：
 * - 超过 SOFT_LIMIT 行仅提示性能警告，完全可编辑；
 * - 超过 HARD_LIMIT 行放弃表格化降级纯文本（防编辑器卡死）。
 */
export const TABLE_SOFT_ROW_LIMIT = 500;
export const TABLE_HARD_ROW_LIMIT = 2000;

// ==================== CSV 解析（RFC 4180 子集） ====================

/**
 * 解析单行 CSV 为单元格数组（处理引号包裹、引号转义 ""）
 * 注意：多行引号单元格（引号内含换行）在此简化解析中会被按行拆开——
 * Excel 解析产物来自 sheet_to_csv，多行单元格极罕见，M1 接受该边界。
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // 双引号转义：""
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** CSV 单元格转义：含逗号/引号/换行的值用引号包裹 */
function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ==================== 判定：是否为 Excel 解析产物 ====================

/**
 * 判定文本是否为 sheet 结构化文本（xlsx 来源）。
 * 规则：至少出现 2 个 `Sheet: x` 标题，或 1 个标题 + 标题后存在含逗号的行
 * （单 sheet 纯标题无表格内容时不表格化，避免把普通文本误判）。
 * 识别不了返回 false → 上层维持纯文本渲染，不强制。
 */
export function isSheetStructuredText(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let headingCount = 0;
  let hasCsvBody = false;
  for (const line of lines) {
    if (SHEET_HEADING_RE.test(line.trim())) {
      headingCount++;
    } else if (headingCount > 0 && line.includes(',') && line.trim()) {
      hasCsvBody = true;
    }
  }
  if (headingCount >= 2) return true;
  if (headingCount === 1 && hasCsvBody) return true;
  return false;
}

// ==================== 文本 → 表格节点 ====================

/** 单个 sheet 的解析产物 */
interface SheetBlock {
  /** sheet 名称（heading 展示用）；空串表示标题前的普通文本块 */
  name: string;
  /** 原始行（未过滤空行，降级时需原样保留） */
  rows: string[];
}

/** 把完整文本拆成 sheet 块序列（非 sheet 区域归为 name='' 的普通段落块） */
function splitSheetBlocks(text: string): SheetBlock[] {
  const blocks: SheetBlock[] = [];
  let current: SheetBlock | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(SHEET_HEADING_RE);
    if (m) {
      current = { name: m[1].trim(), rows: [] };
      blocks.push(current);
    } else if (current) {
      current.rows.push(line);
    } else if (line.trim()) {
      // 标题前的普通文本（首个 Sheet 标题之前），保留为独立块
      blocks.push({ name: '', rows: [line] });
    }
    // current 内的空行保留（空 CSV 行 = 表格空行，解析时跳过）
  }
  return blocks;
}

/** CSV 行数组 → table 节点（首行为 headerRow）。空表返回 null */
function rowsToTableNode(rows: string[]): JSONContent | null {
  const parsed = rows
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => parseCsvLine(r));
  if (parsed.length === 0) return null;

  // 列数取全表最大值，短行补空单元格（CSV 行列参差时保证表格矩形完整）
  const colCount = Math.max(...parsed.map((r) => r.length));
  const tableRows: JSONContent[] = parsed.map((cells, rowIdx) => {
    const padded = [...cells];
    while (padded.length < colCount) padded.push('');
    const cellType = rowIdx === 0 ? 'tableHeader' : 'tableCell';
    return {
      type: 'tableRow',
      content: padded.map((cellText) => ({
        type: cellType,
        content:
          cellText === ''
            ? []
            : [{ type: 'paragraph', content: [{ type: 'text', text: cellText }] }],
      })),
    };
  });

  return { type: 'table', content: tableRows };
}

/**
 * sheet 结构化文本 → Tiptap doc（heading + table）。
 *
 * 双向自检：转换后立即用 tableDocToSheetText 序列化回文本，与原文逐块比对
 * 行数/列数；不一致则该块降级为纯文本段落（**宁可不转，不可转坏**）。
 *
 * @returns { doc, degraded } degraded=true 表示至少一个块发生了降级
 */
export function sheetTextToTableDoc(text: string): {
  doc: JSONContent;
  degraded: boolean;
} {
  const blocks = splitSheetBlocks(text);
  const content: JSONContent[] = [];
  let degraded = false;

  for (const block of blocks) {
    // 无名称块 = 标题前的普通文本，原样保留为段落
    if (!block.name) {
      content.push({
        type: 'paragraph',
        content: block.rows
          .filter((r) => r.trim())
          .flatMap((r) => [{ type: 'text', text: r }, { type: 'hardBreak' }])
          .slice(0, -1),
      });
      continue;
    }

    // sheet 名称保留为 heading（导出时按它拆回 sheet）
    content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: block.name }] });

    const csvRows = block.rows.filter((r) => r.trim().length > 0);
    const hardLimitExceeded = csvRows.length > TABLE_HARD_ROW_LIMIT;

    if (hardLimitExceeded || csvRows.length === 0) {
      // 保险丝：超硬限行数或空表 → 降级为纯文本段落（保留数据，放弃网格）
      degraded = true;
      for (const row of block.rows) {
        if (row.trim()) {
          content.push({
            type: 'paragraph',
            content: [{ type: 'text', text: row }],
          });
        }
      }
      continue;
    }

    const tableNode = rowsToTableNode(block.rows);
    if (!tableNode) continue;

    // 双向自检：序列化回 CSV 与原文比对。
    // 注意 rowsToTableNode 会给短行补空单元格（矩形化），round-trip 的列数
    // 比的是"补齐后 vs 原始解析列数"——补齐是确定性操作不算转坏，所以
    // 自检只验证：行数一致 + 原始列数 ≤ 补齐列数 + 原始单元格内容未被改写
    const roundTrip = tableNodeToCsvRows(tableNode);
    const original = block.rows.filter((r) => r.trim().length > 0);
    const shapeMatched =
      roundTrip.length === original.length &&
      roundTrip.every((cells, i) => {
        const origCells = parseCsvLine(original[i]);
        if (cells.length < origCells.length) return false;
        // 原始单元格内容必须逐格一致（补齐列允许是新增的空格）
        return origCells.every((v, j) => cells[j] === v);
      });

    if (shapeMatched) {
      content.push(tableNode);
    } else {
      // 自检失败 → 降级纯文本（数据不丢，只是没有网格）
      degraded = true;
      for (const row of block.rows) {
        if (row.trim()) {
          content.push({
            type: 'paragraph',
            content: [{ type: 'text', text: row }],
          });
        }
      }
    }
  }

  // 文档以 table 结尾时，Tiptap 中光标无法点击到表格下方（经典光标陷阱：
  // 表格后没有可放置光标的节点）。补一个空段落兜底；反向序列化会跳过
  // 空段落（text.trim() 为假），不影响 contentText 与 xlsx 导出
  if (content[content.length - 1]?.type === 'table') {
    content.push({ type: 'paragraph' });
  }

  return {
    doc: { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] },
    degraded,
  };
}

// ==================== 表格节点 → 文本 ====================

/** 从 table 节点提取 CSV 行数组（单元格文本拼接，paragraph 内 text 顺序连接） */
function tableNodeToCsvRows(table: JSONContent): string[][] {
  const rows: string[][] = [];
  for (const row of table.content ?? []) {
    if (row.type !== 'tableRow') continue;
    const cells = (row.content ?? []).map((cell) => {
      const parts: string[] = [];
      const walk = (node: JSONContent): void => {
        if (node.type === 'text' && node.text !== undefined) {
          parts.push(node.text);
        }
        for (const child of node.content ?? []) walk(child);
      };
      for (const child of cell.content ?? []) walk(child);
      return parts.join('');
    });
    rows.push(cells);
  }
  return rows;
}

/**
 * 序列化单个 table 节点为 CSV 文本（xlsx 导出与自检共用）。
 * header 行与数据行不做区分（CSV 无表头概念，首行即表头）。
 */
export function tableNodeToCsv(table: JSONContent): string {
  return tableNodeToCsvRows(table)
    .map((cells) => cells.map(escapeCsvCell).join(','))
    .join('\n');
}

// ==================== doc 文本提取（表格化前置） ====================

/** 块级节点类型：提取文本后补换行，恢复源文本的行结构 */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'table',
]);

/**
 * 递归提取 doc 内全部文本，并恢复原始换行结构：
 *   - 块级节点（段落/标题等）之间补 '\n'——后端 textToTiptapJson 按空行分段、
 *     段内保留 '\n'，若直接 join('') 会吞掉段边界换行，导致上一个 sheet 的
 *     末行与下一个 `Sheet:` 标题粘连（实测 bug：单元格出现 "4398Sheet: 汇总"）；
 *   - hardBreak 还原为 '\n'（覆盖段落内以硬换行分行的内容形态）。
 *
 * 多产生的空行无害：isSheetStructuredText / splitSheetBlocks 均按行处理并跳过空行。
 * 注意：本函数只应作用于"无表格"的 doc（表格化前置提取），表格文档由上层提前短路。
 */
export function flattenDocText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const joined = (node.content ?? []).map(flattenDocText).join('');
  return BLOCK_TYPES.has(node.type ?? '') ? `${joined}\n` : joined;
}

// ==================== 统计（性能警告用） ====================

/** 统计 doc 中最大单表行数（性能警告判定） */
export function maxTableRowCount(doc: JSONContent): number {
  let max = 0;
  for (const node of doc.content ?? []) {
    if (node.type === 'table') {
      const rows = (node.content ?? []).filter((r) => r.type === 'tableRow').length;
      if (rows > max) max = rows;
    }
  }
  return max;
}

// ==================== doc 内表格定位（自检/测试用） ====================

/** 取 doc 中第一个 table 节点（测试断言用；doc 无表返回 undefined） */
export function firstTableOf(doc: JSONContent): JSONContent | undefined {
  return doc.content?.find((n) => n.type === 'table');
}

/**
 * doc 顶层是否存在 table 节点。
 * 用作两个信号：contentText 序列化策略切换（有表走 sheet 文本）、
 * 编辑器下载 Excel 入口的显隐。只看顶层——表格不会嵌套在块内。
 */
export function docContainsTable(doc: JSONContent): boolean {
  return (doc.content ?? []).some((n) => n.type === 'table');
}

/** 递归提取节点内全部文本（不含块级换行，供表格单元格取纯文本） */
function flattenNodeText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(flattenNodeText).join('');
}

/**
 * Tiptap doc → sheet 结构化文本（sheetTextToTableDoc 的逆向序列化）。
 *
 * 与 tableDocToSheets（xlsx 工作簿导出，丢弃段落）不同，本函数面向
 * contentText 持久化，数据无损：
 *   - h3 heading → `Sheet: 名称`（sheet 边界，服务端导出时据此拆分）
 *   - table → CSV（含引号转义，与解析器对齐）
 *   - 其余块级节点（段落/其他级别标题/列表等）→ 纯文本行
 *
 * 触发条件由调用方控制：doc 含 table 才调用（手动插表的普通文档也适用，
 * 其内容文本从"单元格文字粘连"变为逗号分隔行，对 RAG 更友好）。
 *
 * @returns sheet 结构化文本；doc 无任何 table 或序列化结果为空时返回 null
 *         （调用方回退 extractText 原路径，保证不丢内容）
 */
export function tableDocToSheetText(doc: JSONContent): string | null {
  if (!docContainsTable(doc)) return null;

  const lines: string[] = [];
  for (const node of doc.content ?? []) {
    if (node.type === 'heading') {
      const text = flattenNodeText(node).trim();
      // h3 及以下视为 sheet 边界（与 sheetTextToTableDoc 的正向产物对齐）；
      // 其余级别标题原样保留为文本行
      if ((node.attrs?.level ?? 0) <= 3) {
        lines.push(`Sheet: ${text || 'Sheet1'}`);
      } else if (text) {
        lines.push(text);
      }
    } else if (node.type === 'table') {
      lines.push(tableNodeToCsv(node));
    } else {
      const text = flattenNodeText(node);
      if (text.trim()) lines.push(text);
    }
  }

  const result = lines.join('\n');
  return result.length > 0 ? result : null;
}

/**
 * 从 Tiptap doc 提取 sheet 序列（供导出 xlsx 用）。
 * 遍历顶层节点：heading（h3）开新 sheet，其后紧邻的 table 归入该 sheet；
 * 无 heading 的散表归入"Sheet1"；paragraph 文本作为 sheet 内容前的注释行丢弃
 * （xlsx 不承载富文本段落，M1 导出只保表格数据）。
 *
 * @returns sheet 数组；doc 中无任何 table 时返回 null（调用方走 Markdown 导出）
 */
export function tableDocToSheets(
  doc: JSONContent,
): Array<{ name: string; csv: string }> | null {
  const sheets: Array<{ name: string; csv: string; hasTable: boolean }> = [];
  let current: { name: string; lines: string[]; hasTable: boolean } | null = null;

  const flushCurrent = (): void => {
    if (current) {
      sheets.push({
        name: current.name,
        csv: current.lines.filter((l) => l.length > 0).join('\n'),
        hasTable: current.hasTable,
      });
      current = null;
    }
  };

  for (const node of doc.content ?? []) {
    if (node.type === 'heading' && (node.attrs?.level ?? 0) <= 3) {
      flushCurrent();
      current = {
        name: (node.content ?? [])
          .map((t) => t.text ?? '')
          .join('')
          .trim() || 'Sheet1',
        lines: [],
        hasTable: false,
      };
    } else if (node.type === 'table') {
      if (!current) {
        current = { name: 'Sheet1', lines: [], hasTable: false };
      }
      current.lines.push(tableNodeToCsv(node));
      current.hasTable = true;
    }
  }
  flushCurrent();

  const withTables = sheets.filter((s) => s.hasTable && s.csv.length > 0);
  if (withTables.length === 0) return null;
  return withTables.map(({ name, csv }) => ({ name, csv }));
}
