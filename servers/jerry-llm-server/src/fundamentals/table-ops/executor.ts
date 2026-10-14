/**
 * fundamentals/table-ops/executor.ts
 *
 * 表格 AI 指令的**代码级精确执行器**（纯函数，无 IO、无 LLM）。
 *
 * 与 LLM 的分工（M2 指令下推的核心安全设计）：
 *   - LLM 只产出 schema.ts 定义的操作序列（理解意图）；
 *   - 本模块在 sheet 结构化文本上做确定性执行（数字计算零误差）。
 *
 * 数据流：sheetText → parseSheetData → 逐 op 执行 → serializeSheetData → sheetText。
 *
 * 兜底原则（对应工程规范"必须有兜底"）：
 *   - **先校验后执行**：所有 op 的 sheet 引用 / 列引用在执行前统一静态校验，
 *     任一引用不存在 → 抛 TableOpsError，整体不执行（绝不留"执行一半"的状态）；
 *   - 输入护栏：总数据行数超 MAX_DATA_ROWS 直接拒绝（防滥用 + 防 OOM）；
 *   - 全函数无副作用，异常时调用方持有的原文本天然完好。
 */

import {
  HEADER_ROW_RE,
  LOOKUP_FILL_RE,
  TOTAL_ROW_RE,
  parseCsvLine,
  SHEET_HEADING_RE,
} from '../document-parser.js';
import type {
  OpReport,
  RowCondition,
  TableOp,
  WhereClause,
} from './schema.js';

// ==================== 常量 ====================

/** 执行器护栏：单次指令允许操作的最大数据行数（约等于 2 万行，远超编辑器渲染上限） */
export const MAX_DATA_ROWS = 20000;

// ==================== 数据结构 ====================

/**
 * 跨表关联填充溯源声明（LookupFill: 指令的结构化形态）。
 * 指令格式：`LookupFill: 目标列|目标键列|源表|源键列|源值列`（5 段竖线分隔）。
 * 仅单键场景落指令（复合键的溯源导出公式复杂，宁可不声明不可声明错）。
 */
export interface LookupFillDirective {
  targetColumn: string;
  targetKeyColumn: string;
  sourceSheet: string;
  sourceKeyColumn: string;
  sourceValueColumn: string;
}

/**
 * 解析后的单个 sheet：headers 为表头数组，rows 为数据行（不含表头与说明行）。
 * Sheet 解析中间结构（供同模块族的 rules.ts 复用，不对外泄露到模块族之外）
 */
export interface SheetData {
  name: string;
  /**
   * 表头行号（1 起，按含说明行的完整内容行序数）。
   * 1 = 第一内容行是表头（默认，旧格式）；>1 = 上方有说明行（报表式表格，
   * 由 HeaderRow: N 指令或 setHeaderRow 操作锚定）。
   */
  headerRowIndex: number;
  /** 表头行上方的说明行（标题/日期范围等），每行为原始 CSV 解析出的单元格 */
  preambleRows: string[][];
  /**
   * 汇总行（总计/合计/小计等聚合结果行）的下标列表（0 起，相对 rows 数组，
   * 升序去重）。声明式结构标记：由 TotalRow: N 指令 / setTotalRows 操作 /
   * 聚合类操作自动标记产生。汇总行不是明细数据——语义填充、规则校验、
   * 条件匹配、派生列都必须跳过它（排序时保持原位不参与）。
   */
  totalRowIndexes: number[];
  /**
   * 跨表关联填充溯源声明（LookupFill: 指令解析产物）：记录某列最近一次由哪张表
   * 按哪个键关联填充。导出 xlsx（withFormulas）时据此改写为真实 Excel 公式供验证；
   * 目标列被其他操作改写时声明自动失效删除（invalidateLookupFills）。
   */
  lookupFills: LookupFillDirective[];
  headers: string[];
  rows: string[][];
}

/** 执行结果 */
export interface ExecuteResult {
  /** 执行后的完整 sheet 结构化文本（可直接回写编辑器/版本链） */
  sheetText: string;
  /** 逐操作执行报告（前端确认 UI 用） */
  report: OpReport[];
}

/** 执行失败：引用不存在 / 护栏拦截等可预期业务错误（message 面向用户） */
export class TableOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableOpsError';
  }
}

// ==================== 解析：sheetText → SheetData[] ====================

/**
 * sheet 结构化文本 → SheetData 数组。
 * 解析规则与 parseExcelFile 产物 / 前端 table-convert 对齐：
 *   - `Sheet: 名称` 行开新 sheet；标题前散行归入 name='' 的无名块；
 *   - 块首的非空行若为结构指令（`HeaderRow: N` / `TotalRow: a,b`，顺序不限、
 *     各至多一条）则消费掉作为结构锚定，不进内容；
 *   - 表头锚定：指令后第 1..N-1 个非空行为说明行（preambleRows，不当数据），
 *     第 N 个为表头，其余为数据行；空行跳过；
 *   - 汇总行锚定：TotalRow 的行号按内容行序数（与 HeaderRow 同口径），
 *     换算为 rows 下标存储；越界/落在说明行或表头上的标记丢弃（防脏数据）；
 *   - 指令 N 超界时收敛到 [1, 内容行数]（防脏数据，绝不丢行）。
 */
export function parseSheetData(text: string): SheetData[] {
  interface Block {
    name: string;
    lines: string[];
  }
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(SHEET_HEADING_RE);
    if (m) {
      current = { name: m[1].trim(), lines: [] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      blocks.push({ name: '', lines: [line] });
    }
  }

  const sheets: SheetData[] = [];
  for (const block of blocks) {
    const nonEmpty = block.lines.map((l) => l.trim()).filter((l) => l.length > 0);
    if (nonEmpty.length === 0) continue;
    // 结构指令：只认块首连续的非空行（位置约束，避免把数据行误当指令）；
    // HeaderRow / TotalRow 各至多消费一条，顺序不限
    let headerRowIndex = 1;
    let headerDirectiveSeen = false;
    let totalDirective: number[] | null = null;
    const lookupFills: LookupFillDirective[] = [];
    let cursor = 0;
    while (cursor < nonEmpty.length) {
      const line = nonEmpty[cursor];
      const headerMatch = !headerDirectiveSeen && line.match(HEADER_ROW_RE);
      if (headerMatch) {
        const n = Number.parseInt(headerMatch[1], 10);
        // 收敛到合法区间：N 至少 1（表头必须是真实存在的一行，区间下界在
        // 消费完 TotalRow 指令、确定内容行数后再统一收敛）
        headerRowIndex = n;
        headerDirectiveSeen = true;
        cursor += 1;
        continue;
      }
      const totalMatch = totalDirective === null && line.match(TOTAL_ROW_RE);
      if (totalMatch) {
        totalDirective = totalMatch[1]
          .split(/[,，]/)
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n >= 1);
        cursor += 1;
        continue;
      }
      // LookupFill 溯源指令：块首可多条；段数不对/含空段的脏标记整体丢弃
      //（宁可不声明，不可声明错——它决定导出公式的正确性）
      const lookupMatch = line.match(LOOKUP_FILL_RE);
      if (lookupMatch) {
        const parts = lookupMatch[1].split('|').map((s) => s.trim());
        if (parts.length === 5 && parts.every((p) => p.length > 0)) {
          lookupFills.push({
            targetColumn: parts[0],
            targetKeyColumn: parts[1],
            sourceSheet: parts[2],
            sourceKeyColumn: parts[3],
            sourceValueColumn: parts[4],
          });
        }
        cursor += 1;
        continue;
      }
      break; // 第一个非指令行：结构区结束
    }
    const content = nonEmpty.slice(cursor);
    if (content.length === 0) continue;
    headerRowIndex = Math.min(Math.max(headerRowIndex, 1), content.length);
    // 汇总行标记：内容行序数 → rows 下标；必须落在数据行区（表头之后）
    const totalRowIndexes: number[] = [];
    if (totalDirective) {
      const seen = new Set<number>();
      for (const n of totalDirective) {
        const dataIdx = n - headerRowIndex - 1;
        if (dataIdx >= 0 && dataIdx < content.length - headerRowIndex && !seen.has(dataIdx)) {
          seen.add(dataIdx);
          totalRowIndexes.push(dataIdx);
        }
      }
      totalRowIndexes.sort((a, b) => a - b);
    }
    const preambleRows = content.slice(0, headerRowIndex - 1).map((l) => parseCsvLine(l));
    const headers = parseCsvLine(content[headerRowIndex - 1]);
    const rows = content.slice(headerRowIndex).map((l) => parseCsvLine(l));
    sheets.push({ name: block.name, headerRowIndex, totalRowIndexes, lookupFills, preambleRows, headers, rows });
  }
  return sheets;
}

// ==================== 序列化：SheetData[] → sheetText ====================

/** CSV 单元格转义：含逗号/引号/换行的值用引号包裹（与前端 escapeCsvCell 一致） */
function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sheetToText(sheet: SheetData): string {
  const lines: string[] = [];
  // 结构指令紧跟 Sheet 标题行（与 parseSheetData 的解析位置约束对齐）：
  // HeaderRow 在前、TotalRow 在后；行号按内容行序数（rows 下标 → 内容行号）
  if (sheet.headerRowIndex > 1) lines.push(`HeaderRow: ${sheet.headerRowIndex}`);
  if (sheet.totalRowIndexes.length > 0) {
    const contentNums = sheet.totalRowIndexes.map((i) => sheet.headerRowIndex + i + 1);
    lines.push(`TotalRow: ${contentNums.join(',')}`);
  }
  // LookupFill 溯源指令回写：含竖线/空段的不落档（声明出错比不声明更糟）
  for (const lf of sheet.lookupFills) {
    const parts = [
      lf.targetColumn,
      lf.targetKeyColumn,
      lf.sourceSheet,
      lf.sourceKeyColumn,
      lf.sourceValueColumn,
    ];
    if (parts.every((p) => p.trim().length > 0 && !p.includes('|'))) {
      lines.push(`LookupFill: ${parts.map((p) => p.trim()).join('|')}`);
    }
  }
  for (const preamble of sheet.preambleRows) {
    const line = preamble.map(escapeCsvCell).join(',');
    if (line.length > 0) lines.push(line);
  }
  lines.push(sheet.headers.map(escapeCsvCell).join(','));
  for (const row of sheet.rows) {
    // 行短于表头补空、长于表头保留（序列化不丢数据）
    const padded = [...row];
    while (padded.length < sheet.headers.length) padded.push('');
    lines.push(padded.map(escapeCsvCell).join(','));
  }
  // 无名块（标题前的散行）只输出行本身，不产生 Sheet 标题
  const body = lines.filter((l) => l.length > 0).join('\n');
  return sheet.name ? `Sheet: ${sheet.name}\n${body}` : body;
}

export function serializeSheetData(sheets: SheetData[]): string {
  return sheets.map(sheetToText).join('\n\n');
}

// ==================== 基础工具 ====================

/** 宽松数字解析：去逗号/货币符号/空格后 parseFloat；失败返回 null（rules.ts 复用） */
export function parseLooseNumber(value: string): number | null {
  const cleaned = value.replace(/[,¥$￥\s]/g, '');
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 聚合结果格式化：整数不带小数，小数最多保留 2 位（去尾零） */
function formatAggregate(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

/** 聚合方式 */
type AggregateFn = 'sum' | 'avg' | 'count' | 'min' | 'max';

/** 聚合方式人可读名称（执行报告用） */
const AGGREGATE_FN_TEXT: Record<AggregateFn, string> = {
  sum: '求和',
  avg: '平均',
  count: '计数',
  min: '最小',
  max: '最大',
};

/**
 * 新建 sheet 名清洗：替换 Excel 非法字符与换行、截断 28 字符、空名兜底。
 * 与导出层 dedupeSheetName 的清洗规则保持一致（那边是私有函数，这里本地实现）；
 * 重名场景由 groupCreateSheet 的"同名重建"语义处理，这里不做去重后缀。
 */
const SHEET_NAME_INVALID_RE = /[:\\/?*[\]\r\n]/g;
function sanitizeSheetName(raw: string): string {
  const cleaned = raw.replace(SHEET_NAME_INVALID_RE, '_').trim();
  return (cleaned || '统计结果').slice(0, 28);
}

/**
 * 对一列的原始值做聚合。
 * count 统计非空格数；其余方式过滤出可解析为数字的值参与计算，
 * 一个数字都没有 → 抛 TableOpsError（避免把空列静默算成 0 误导用户）。
 */
function computeAggregate(values: string[], fn: AggregateFn, colName: string): number {
  const nonEmpty = values.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  if (fn === 'count') return nonEmpty.length;
  const nums = nonEmpty
    .map(parseLooseNumber)
    .filter((n): n is number => n !== null);
  if (nums.length === 0) {
    throw new TableOpsError(`列「${colName}」没有可计算的数字`);
  }
  switch (fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
  }
}

/**
 * 列名定位（两级查找）：
 *   1. 表头精确匹配——常规 sheet；
 *   2. 数据行单元格扫描——兼容合并单元格标题表（如"汇总"sheet 顶部的
 *      "销售汇总报告"标题行占据了表头位，真实表头"产品类别,金额小计"
 *      落在数据行里），扫描各行找到首个等于列名的单元格位置。
 * 两级都未命中 → 抛 TableOpsError（消息带当前表头与提示）。
 */
export function findColumn(sheet: SheetData, name: string): number {
  const target = name.trim();
  const idx = sheet.headers.findIndex((h) => h.trim() === target);
  if (idx !== -1) return idx;
  for (const row of sheet.rows) {
    const cIdx = row.findIndex((c) => (c ?? '').trim() === target);
    if (cIdx !== -1) return cIdx;
  }
  const headerText = sheet.headers.filter((h) => h.trim()).join('、') || '(空)';
  throw new TableOpsError(
    `找不到列「${name}」，当前表头：${headerText}` +
      (sheet.headers.some((h) => !h.trim())
        ? '。该表可能含合并单元格标题行，请使用表格中实际表头行的列名'
        : ''),
  );
}

/** 按 sheet 名取目标 sheet（精确匹配优先；单 sheet 时任意名都可命中，容忍 LLM 记错名） */
export function findSheet(sheets: SheetData[], targetSheet: string | undefined): SheetData {
  if (sheets.length === 0) {
    throw new TableOpsError('表格内容为空，无可执行的操作');
  }
  if (!targetSheet) return sheets[0];
  const exact = sheets.find((s) => s.name === targetSheet.trim());
  if (exact) return exact;
  // 单 sheet 容错：LLM 可能复述错 sheet 名
  if (sheets.length === 1) return sheets[0];
  throw new TableOpsError(
    `找不到工作表「${targetSheet}」，当前工作表：${sheets.map((s) => s.name || '(未命名)').join('、')}`,
  );
}

/** 行条件比较（数字感知） */
function matchCondition(row: string[], colIdx: number, op: string, value: string | undefined): boolean {
  const cell = (row[colIdx] ?? '').trim();
  switch (op) {
    case 'empty':
      return cell === '';
    case 'notEmpty':
      return cell !== '';
    case 'contains':
      return value !== undefined && cell.includes(value);
  }
  // 比较类条件没有 value（zod superRefine 会拦，这里防御运行时直调）→ 不匹配
  if (value === undefined) return false;
  // 数值优先比较：两侧都能解析为数字时用数值，避免 "10" > "9" 的字典序坑
  const cellNum = parseLooseNumber(cell);
  const valNum = parseLooseNumber(value);
  if (cellNum !== null && valNum !== null) {
    switch (op) {
      case 'eq':
        return cellNum === valNum;
      case 'ne':
        return cellNum !== valNum;
      case 'gt':
        return cellNum > valNum;
      case 'lt':
        return cellNum < valNum;
      case 'gte':
        return cellNum >= valNum;
      case 'lte':
        return cellNum <= valNum;
    }
  }
  // 字符串比较（eq 精确、ne 反向；gt/lt 等对字符串按字典序兜底）
  switch (op) {
    case 'eq':
      return cell === value;
    case 'ne':
      return cell !== value;
    case 'gt':
      return cell > value;
    case 'lt':
      return cell < value;
    case 'gte':
      return cell >= value;
    case 'lte':
      return cell <= value;
  }
  return false;
}

// ==================== where 子句（功能 3：多条件 AND/OR） ====================

/** 比较方式的人可读符号（报告/错误消息用） */
const CONDITION_OP_TEXT: Record<string, string> = {
  eq: '=',
  ne: '≠',
  contains: '包含',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  empty: '为空',
  notEmpty: '不为空',
};

/** 单条件人可读描述（如"销售额 < 1000"） */
function describeCondition(c: RowCondition): string {
  const opText = CONDITION_OP_TEXT[c.op] ?? c.op;
  const valueText = c.op === 'empty' || c.op === 'notEmpty' ? '' : ` ${c.value}`;
  return `${c.column} ${opText}${valueText}`.trim();
}

/** where 子句人可读描述：单条件直接描述，组合条件用 且/或 连接 */
function describeWhere(where: WhereClause): string {
  if ('conditions' in where) {
    return where.conditions
      .map(describeCondition)
      .join(where.mode === 'and' ? ' 且 ' : ' 或 ');
  }
  return describeCondition(where);
}

/**
 * where 子句行匹配：单条件直接比较；组合条件按 and（全满足）/ or（任一满足）聚合。
 * resolveColumn 由调用方注入（带缓存的列定位器），避免逐行重复 findColumn。
 * 导出给 clarify.ts 复用（删除影响面预览必须与执行期同一套匹配语义，勿双实现漂移）。
 */
export function matchWhere(
  row: string[],
  where: WhereClause,
  resolveColumn: (name: string) => number,
): boolean {
  if ('conditions' in where) {
    const results = where.conditions.map((c) =>
      matchCondition(row, resolveColumn(c.column), c.op, c.value),
    );
    return where.mode === 'and' ? results.every(Boolean) : results.some(Boolean);
  }
  return matchCondition(row, resolveColumn(where.column), where.op, where.value);
}

/** 校验 where 子句引用的全部条件列存在（不存在抛 TableOpsError） */
function validateWhereColumns(where: WhereClause, sheet: SheetData): void {
  const conditions = 'conditions' in where ? where.conditions : [where];
  for (const c of conditions) {
    findColumn(sheet, c.column);
  }
}

/**
 * op 内列定位缓存器：同一列只 findColumn 一次。
 * 大表逐行 findColumn 是 O(n²) 纯浪费；校验阶段已保证列存在，
 * 执行期缓存未命中再查一次也必然命中。
 */
function makeColumnResolver(sheet: SheetData): (name: string) => number {
  const cache = new Map<string, number>();
  return (name: string) => {
    const key = name.trim();
    let idx = cache.get(key);
    if (idx === undefined) {
      idx = findColumn(sheet, key);
      cache.set(key, idx);
    }
    return idx;
  };
}

// ==================== 表达式求值器（功能 2：公式补数，绝不 eval） ====================

/**
 * 自制迷你表达式引擎：只支持数字、[列名] 引用、+ - * / ( ) 和一元负号。
 * 安全性 = 9 类操作同级：语法是我们定义的白名单，任何注入内容都会在
 * 词法阶段抛错，不存在执行任意代码的可能。
 */

/** 表达式 AST 节点 */
type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'col'; name: string }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: ExprNode; right: ExprNode }
  | { kind: 'neg'; operand: ExprNode };

/** 词法单元 */
type ExprToken = { t: 'num'; v: number } | { t: 'col'; v: string } | { t: 'op'; v: string };

/** 词法分析：非法字符一律抛 TableOpsError（注入内容进不了 AST） */
function tokenizeExpression(expr: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '[') {
      // 列引用：[列名]，列名内不允许出现 ]（闭合即止）
      const close = expr.indexOf(']', i);
      if (close === -1) {
        throw new TableOpsError(`表达式「${expr}」中的 [缺少对应的 ]`);
      }
      const name = expr.slice(i + 1, close).trim();
      if (!name) {
        throw new TableOpsError('表达式中的列引用不能为空，应写为 [列名]（如 [数量]）');
      }
      tokens.push({ t: 'col', v: name });
      i = close + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^\d+(\.\d+)?|\.\d+/.exec(expr.slice(i));
      if (!m) {
        throw new TableOpsError(`表达式中的「${ch}」不是合法数字`);
      }
      tokens.push({ t: 'num', v: Number.parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    throw new TableOpsError(
      `表达式含不支持的内容「${ch}」：只支持数字、[列名] 引用和 + - * / ( ) 运算`,
    );
  }
  if (tokens.length === 0) {
    throw new TableOpsError('表达式不能为空');
  }
  return tokens;
}

/** 语法分析（递归下降）：expr := term (('+'|'-') term)* ；term := factor (('*'|'/') factor)* */
function parseExpressionTokens(tokens: ExprToken[]): ExprNode {
  let pos = 0;
  /** 预看下一个运算符（非运算符返回 null，不消费） */
  const peekOp = (): string | null => {
    const tok = tokens[pos];
    return tok && tok.t === 'op' ? tok.v : null;
  };
  const parseExpr = (): ExprNode => {
    let left = parseTerm();
    let op = peekOp();
    while (op === '+' || op === '-') {
      pos++;
      left = { kind: 'bin', op, left, right: parseTerm() };
      op = peekOp();
    }
    return left;
  };
  const parseTerm = (): ExprNode => {
    let left = parseFactor();
    let op = peekOp();
    while (op === '*' || op === '/') {
      pos++;
      left = { kind: 'bin', op, left, right: parseFactor() };
      op = peekOp();
    }
    return left;
  };
  const parseFactor = (): ExprNode => {
    const tok = tokens[pos];
    if (!tok) {
      throw new TableOpsError('表达式不完整（意外结尾），请检查运算符两侧的操作数');
    }
    if (tok.t === 'num') {
      pos++;
      return { kind: 'num', value: tok.v };
    }
    if (tok.t === 'col') {
      pos++;
      return { kind: 'col', name: tok.v };
    }
    if (tok.v === '(') {
      pos++;
      const inner = parseExpr();
      if (peekOp() !== ')') {
        throw new TableOpsError('表达式括号不匹配');
      }
      pos++;
      return inner;
    }
    if (tok.v === '-') {
      pos++;
      return { kind: 'neg', operand: parseFactor() };
    }
    if (tok.v === '+') {
      pos++;
      return parseFactor();
    }
    throw new TableOpsError(`表达式在「${tok.v}」处无法解析`);
  };
  const node = parseExpr();
  if (pos !== tokens.length) {
    throw new TableOpsError('表达式有多余内容，无法解析（例如缺少运算符）');
  }
  return node;
}

/** 编译表达式 → AST（语法错误抛 TableOpsError，消息面向用户） */
function compileExpression(expr: string): ExprNode {
  return parseExpressionTokens(tokenizeExpression(expr));
}

/** 收集 AST 中全部列引用（去重、保序） */
function collectColumnRefs(node: ExprNode): string[] {
  const refs: string[] = [];
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'col':
        if (!refs.includes(n.name)) refs.push(n.name);
        break;
      case 'bin':
        walk(n.left);
        walk(n.right);
        break;
      case 'neg':
        walk(n.operand);
        break;
      case 'num':
        break;
    }
  };
  walk(node);
  return refs;
}

/**
 * 求值：任一引用列的值无法解析为数字 / 除零 → 返回 null，
 * 由调用方决定跳过该行（数据不丢、不填错值）。
 */
function evalExprNode(
  node: ExprNode,
  resolveColValue: (name: string) => number | null,
): number | null {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'col':
      return resolveColValue(node.name);
    case 'neg': {
      const v = evalExprNode(node.operand, resolveColValue);
      return v === null ? null : -v;
    }
    case 'bin': {
      const l = evalExprNode(node.left, resolveColValue);
      if (l === null) return null;
      const r = evalExprNode(node.right, resolveColValue);
      if (r === null) return null;
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return r === 0 ? null : l / r;
      }
    }
  }
}

// ==================== 静态校验（先校验后执行） ====================

/** 校验单个 op 的所有列/sheet 引用；引用不存在抛 TableOpsError */
function validateOp(op: TableOp, sheets: SheetData[]): void {
  // 分组建表不作用于已有工作表（读取来源表 → 新建结果表），走独立校验分支
  if (op.type === 'groupCreateSheet') {
    // 来源表/分组列/统计列必须存在；新表名允许与现有表重名（幂等重建语义）
    const source = op.sourceSheet ? findSheet(sheets, op.sourceSheet) : sheets[0];
    findColumn(source, op.groupBy);
    findColumn(source, op.valueColumn);
    if (op.where) validateWhereColumns(op.where, source);
    return;
  }

  const target = findSheet(sheets, op.targetSheet);

  switch (op.type) {
    case 'noop':
      // 无操作：无业务校验（targetSheet 存在性已在上方 findSheet 统一检查）
      break;
    case 'setHeaderRow': {
      // 行号必须落在内容行范围内（说明行 + 表头 + 数据行）；目标行必须非空
      const totalLines = target.preambleRows.length + 1 + target.rows.length;
      if (op.headerRow > totalLines) {
        throw new TableOpsError(
          `第 ${op.headerRow} 行不存在（「${target.name || '未命名'}」共 ${totalLines} 行，含说明行与表头）`,
        );
      }
      const cells =
        op.headerRow <= target.preambleRows.length
          ? target.preambleRows[op.headerRow - 1]
          : op.headerRow === target.headerRowIndex
            ? target.headers
            : target.rows[op.headerRow - target.headerRowIndex - 1];
      if (!cells || !cells.some((c) => (c ?? '').trim() !== '')) {
        throw new TableOpsError(`第 ${op.headerRow} 行是空行，不能设为表头`);
      }
      break;
    }
    case 'setTotalRows': {
      // 每个行号必须存在、非空，且不能是表头行本身（汇总行是数据行区的聚合行）
      const totalLines = target.preambleRows.length + 1 + target.rows.length;
      for (const n of op.rows) {
        if (n > totalLines) {
          throw new TableOpsError(
            `第 ${n} 行不存在（「${target.name || '未命名'}」共 ${totalLines} 行，含说明行与表头）`,
          );
        }
        if (n === target.headerRowIndex) {
          throw new TableOpsError(`第 ${n} 行是表头行，不能标记为汇总行`);
        }
        if (n < target.headerRowIndex) {
          // 与 parse 侧口径一致：说明行不是数据，更不是聚合结果行（否则标记换算出负下标）
          throw new TableOpsError(`第 ${n} 行是说明行，不能标记为汇总行`);
        }
        const cells = target.rows[n - target.headerRowIndex - 1];
        if (!cells || !cells.some((c) => (c ?? '').trim() !== '')) {
          throw new TableOpsError(`第 ${n} 行是空行，不能标记为汇总行`);
        }
      }
      break;
    }
    case 'appendRow':
      // 追加行的列名必须能定位（避免 LLM 编造列名静默丢数据）
      for (const key of Object.keys(op.cells)) {
        findColumn(target, key);
      }
      break;
    case 'aggregateAppendRow': {
      const source = op.sourceSheet ? findSheet(sheets, op.sourceSheet) : target;
      findColumn(source, op.column);
      if (op.where) validateWhereColumns(op.where, source);
      if (op.labelColumn) findColumn(target, op.labelColumn);
      if (op.valueColumn) findColumn(target, op.valueColumn);
      break;
    }
    case 'aggregateUpdateCell': {
      findColumn(target, op.column);
      if (op.labelColumn) findColumn(target, op.labelColumn);
      if (op.sourceSheet) {
        const source = findSheet(sheets, op.sourceSheet);
        findColumn(source, op.sourceColumn ?? op.column);
        if (op.where) validateWhereColumns(op.where, source);
      }
      break;
    }
    case 'updateCells':
      findColumn(target, op.targetColumn);
      if (op.where) validateWhereColumns(op.where, target);
      break;
    case 'deleteRows':
      validateWhereColumns(op.where, target);
      break;
    case 'deleteColumn':
      findColumn(target, op.column);
      if (target.headers.length <= 1) {
        throw new TableOpsError('至少要保留一列，不能删除最后一列');
      }
      break;
    case 'addColumn':
      // 新列名与现有表头重复没有意义，报错让 LLM/用户改指令
      if (target.headers.some((h) => h.trim() === op.header.trim())) {
        throw new TableOpsError(`列「${op.header}」已存在，无需新增`);
      }
      break;
    case 'sortRows':
      findColumn(target, op.column);
      break;
    case 'renameColumn':
      findColumn(target, op.from);
      if (op.from.trim() !== op.to.trim() && target.headers.some((h) => h.trim() === op.to.trim())) {
        throw new TableOpsError(`新列名「${op.to}」与现有列重名`);
      }
      break;
    case 'deriveColumn': {
      // 表达式语法错误/引用列不存在在这里统一暴露（执行期不再抛）
      const ast = compileExpression(op.expression);
      const resolve = makeColumnResolver(target);
      for (const ref of collectColumnRefs(ast)) {
        resolve(ref);
      }
      if (op.where) validateWhereColumns(op.where, target);
      break;
    }
    case 'lookupFill': {
      // 目标列必须已存在（不存在时应先 addColumn，避免静默建列）
      findColumn(target, op.targetColumn);
      const source = op.sourceSheet ? findSheet(sheets, op.sourceSheet) : target;
      findColumn(source, op.sourceValueColumn);
      // 关联键：复合键或单键必须给一个，且涉及的键列全部必须存在
      // 注意：sourceKeyColumn 只在单键分支校验——复合键场景该字段可省略，
      // 无条件 findColumn 会把"缺键"误报成"找不到列 undefined"
      if (op.keyMappings && op.keyMappings.length > 0) {
        for (const m of op.keyMappings) {
          findColumn(target, m.targetKeyColumn);
          findColumn(source, m.sourceKeyColumn);
        }
      } else if (op.sourceKeyColumn) {
        if (op.targetKeyColumn) findColumn(target, op.targetKeyColumn);
        findColumn(source, op.sourceKeyColumn);
      } else {
        throw new TableOpsError('缺少关联键：请指明目标表与来源表各按哪一列关联');
      }
      break;
    }
    case 'fillConstant':
      findColumn(target, op.targetColumn);
      break;
  }
}

// ==================== 单 op 执行 ====================

/** 保证行至少有 headers.length 个单元格（短行补空，方便按下标写） */
function padRow(row: string[], width: number): string[] {
  const padded = [...row];
  while (padded.length < width) padded.push('');
  return padded;
}

function executeOp(op: TableOp, sheet: SheetData, sheets: SheetData[]): string {
  switch (op.type) {
    case 'noop':
      // 不改表格任何内容，原因作为报告消息告知用户（确认卡可见、可放弃）
      return op.reason;

    case 'setHeaderRow': {
      // 完整内容行序（说明行 + 表头 + 数据行）在第 N 行重新切分表头锚点。
      // 只重划边界不丢数据：原表头与上方行降级为说明行，下方行升为数据行
      const contentCells = [...sheet.preambleRows, sheet.headers, ...sheet.rows];
      const n = op.headerRow;
      const next: SheetData = {
        ...sheet,
        headerRowIndex: n,
        preambleRows: contentCells.slice(0, n - 1),
        headers: contentCells[n - 1],
        rows: contentCells.slice(n),
      };
      // 汇总行标记跟物理行走：内容行号不变，重算 rows 下标；
      // 重锚后落入说明行区的标记丢弃（说明行不是数据，更不是汇总行）
      next.totalRowIndexes = sheet.totalRowIndexes
        .map((idx) => sheet.headerRowIndex + idx + 1 - n - 1)
        .filter((idx) => idx >= 0);
      const changed =
        next.headerRowIndex !== sheet.headerRowIndex ||
        next.headers.some((h, i) => h !== sheet.headers[i]) ||
        next.headers.length !== sheet.headers.length;
      Object.assign(sheet, next);
      if (!changed) {
        return `第 ${n} 行已是表头行，表格未变化`;
      }
      const preambleDesc =
        next.preambleRows.length > 0
          ? `上方 ${next.preambleRows.length} 行归为说明行`
          : '无说明行';
      return `已将「${sheet.name || '未命名'}」的第 ${n} 行设为表头（${preambleDesc}），数据 ${next.rows.length} 行`;
    }

    case 'setTotalRows': {
      // 行号（内容行序数）→ rows 下标；校验已保证存在/非空/非表头
      const dataIdxs = [...new Set(op.rows.map((n) => n - sheet.headerRowIndex - 1))].sort(
        (a, b) => a - b,
      );
      const sameSet =
        dataIdxs.length === sheet.totalRowIndexes.length &&
        dataIdxs.every((v, i) => v === sheet.totalRowIndexes[i]);
      if (sameSet) {
        return op.rows.length > 0
          ? `第 ${op.rows.join('、')} 行已是汇总行，表格未变化`
          : '该表没有汇总行标记，表格未变化';
      }
      sheet.totalRowIndexes = dataIdxs;
      if (dataIdxs.length === 0) {
        return `已清除「${sheet.name || '未命名'}」的全部汇总行标记`;
      }
      const labelDesc = dataIdxs
        .map((idx) => {
          const first = sheet.rows[idx]?.find((c) => (c ?? '').trim() !== '');
          return `第 ${sheet.headerRowIndex + idx + 1} 行${first ? `（${first.trim()}）` : ''}`;
        })
        .join('、');
      return `已将「${sheet.name || '未命名'}」的 ${labelDesc} 标记为汇总行（聚合结果行不参与填充/规则/条件）`;
    }

    case 'appendRow': {
      // 逐个单元格用 findColumn 定位（两级查找）——合并单元格标题表的列名
      // 在数据行里而非表头里，按 headers.map 取值会静默丢数据（校验能过、执行全空）
      const row = padRow([], sheet.headers.length);
      for (const [key, value] of Object.entries(op.cells)) {
        row[findColumn(sheet, key)] = value;
      }
      sheet.rows.push(row);
      return `已追加 1 行（${Object.keys(op.cells).length} 个单元格有值）`;
    }

    case 'aggregateAppendRow': {
      // 聚合来源：sourceSheet 跨表聚合，否则聚合目标表自身
      const source = op.sourceSheet ? findSheet(sheets, op.sourceSheet) : sheet;
      const resolveSource = makeColumnResolver(source);
      const srcColIdx = resolveSource(op.column);
      // 已声明的汇总行不进聚合池：聚合结果行不是明细数据，混入会双重计数
      const srcTotalSet = new Set(source.totalRowIndexes);
      let pool = source.rows
        .filter((_, idx) => !srcTotalSet.has(idx))
        .map((r) => padRow(r, source.headers.length));
      let matchedDesc = `全部 ${pool.length} 行`;
      const where = op.where;
      if (where) {
        pool = pool.filter((r) => matchWhere(r, where, resolveSource));
        if (pool.length === 0) {
          throw new TableOpsError(
            `「${source.name || '未命名'}」中没有满足条件（${describeWhere(where)}）的行`,
          );
        }
        matchedDesc = `匹配 ${pool.length} 行`;
      }
      const result = computeAggregate(
        pool.map((r) => r[srcColIdx] ?? ''),
        op.fn,
        op.column,
      );
      const resolveTarget = makeColumnResolver(sheet);
      const labelColIdx = op.labelColumn ? resolveTarget(op.labelColumn) : 0;
      const valueColIdx = op.valueColumn ? resolveTarget(op.valueColumn) : resolveTarget(op.column);
      // 幂等守卫：目标表中已存在同标签行（精确匹配）→ 就地更新数值，不重复插入。
      // 否则用户重复执行同一条聚合指令会插出多行同名合计，且后续"重算总计"
      // 会把旧合计行也累计进去，数值静默翻倍
      const exactRows = sheet.rows.map((r) => padRow(r, sheet.headers.length));
      const existIdx = exactRows.findIndex((r) => (r[labelColIdx] ?? '').trim() === op.label.trim());
      if (existIdx !== -1) {
        sheet.rows[existIdx] = exactRows[existIdx];
        sheet.rows[existIdx][valueColIdx] = formatAggregate(result);
        // 就地更新的行也是聚合结果行：未声明时补标记（旧文档的合计行由此纳入契约）
        if (!sheet.totalRowIndexes.includes(existIdx)) {
          sheet.totalRowIndexes = [...sheet.totalRowIndexes, existIdx].sort((a, b) => a - b);
        }
        return `已存在标签为「${op.label}」的行，就地更新其数值为 ${formatAggregate(result)}（${op.fn}，${matchedDesc}）`;
      }
      const row = padRow([], sheet.headers.length);
      row[labelColIdx] = op.label;
      row[valueColIdx] = formatAggregate(result);
      // 插入位置：beforeRow 锚点行之前（如插到"总计"行上方），否则追加到末尾
      let insertIdx = sheet.rows.length;
      if (op.beforeRow) {
        const lbl = op.beforeRow.trim();
        const paddedRows = sheet.rows.map((r) => padRow(r, sheet.headers.length));
        let bi = paddedRows.findIndex((r) => (r[labelColIdx] ?? '').trim() === lbl);
        if (bi === -1) bi = paddedRows.findIndex((r) => (r[labelColIdx] ?? '').includes(lbl));
        if (bi === -1) {
          throw new TableOpsError(`「${sheet.name}」中找不到标签为「${op.beforeRow}」的行`);
        }
        insertIdx = bi;
      }
      sheet.rows.splice(insertIdx, 0, row);
      // 本行是聚合结果行：自动标记为汇总行；插入点之后的既有汇总行下标 +1
      sheet.totalRowIndexes = sheet.totalRowIndexes
        .map((idx) => (idx >= insertIdx ? idx + 1 : idx))
        .concat(insertIdx)
        .sort((a, b) => a - b);
      return `已聚合「${source.name || '未命名'}」列「${op.column}」（${op.fn}，${matchedDesc}），结果 ${formatAggregate(result)} 写入「${sheet.name}」第 ${insertIdx + 1} 行`;
    }

    case 'aggregateUpdateCell': {
      const labelColIdx = op.labelColumn ? findColumn(sheet, op.labelColumn) : 0;
      const writeIdx = findColumn(sheet, op.column);
      const paddedRows = sheet.rows.map((r) => padRow(r, sheet.headers.length));
      const lbl = op.rowLabel.trim();
      // 行定位：先精确匹配，再包含匹配（容忍"总计"/"合计"类近似写法）
      let rowIdx = paddedRows.findIndex((r) => (r[labelColIdx] ?? '').trim() === lbl);
      if (rowIdx === -1) rowIdx = paddedRows.findIndex((r) => (r[labelColIdx] ?? '').includes(lbl));
      if (rowIdx === -1) {
        throw new TableOpsError(`「${sheet.name}」中找不到标签含「${op.rowLabel}」的行`);
      }
      let result: number;
      let sourceDesc: string;
      if (op.sourceSheet) {
        // 指定来源表：从其他表聚合（可带 where 过滤）；已声明的汇总行不进池
        const source = findSheet(sheets, op.sourceSheet);
        const srcColName = op.sourceColumn ?? op.column;
        const srcColIdx = findColumn(source, srcColName);
        const resolveSource = makeColumnResolver(source);
        const srcTotalSet = new Set(source.totalRowIndexes);
        let pool = source.rows
          .filter((_, idx) => !srcTotalSet.has(idx))
          .map((r) => padRow(r, source.headers.length));
        const where = op.where;
        if (where) {
          pool = pool.filter((r) => matchWhere(r, where, resolveSource));
        }
        if (pool.length === 0) {
          throw new TableOpsError(`来源「${source.name || '未命名'}」中没有满足条件的行`);
        }
        result = computeAggregate(pool.map((r) => r[srcColIdx] ?? ''), op.fn, srcColName);
        sourceDesc = `「${source.name || '未命名'}」列「${srcColName}」`;
      } else {
        // 重算语义：同列、目标行上方的**所有行**求和（标题/文本行被数字过滤自然跳过）。
        // 注意：这里刻意**不排除**其他汇总行——既定契约是"重算 = 上方全部行求和"，
        // 例如先插入"重点客户合计"再重算"总计"，总计应包含它（见 executor.spec 端到端场景）；
        // 列求和/跨表/分组池才排除汇总行（防止双重计数），两类操作语义不同
        const aboveRows = paddedRows.slice(0, rowIdx);
        result = computeAggregate(
          aboveRows.map((r) => r[writeIdx] ?? ''),
          op.fn,
          op.column,
        );
        sourceDesc = `同列上方 ${aboveRows.length} 行`;
      }
      sheet.rows[rowIdx] = paddedRows[rowIdx];
      sheet.rows[rowIdx][writeIdx] = formatAggregate(result);
      return `已将「${sheet.name}」第 ${rowIdx + 1} 行（${lbl}）的「${op.column}」更新为 ${formatAggregate(result)}（${op.fn}，来源：${sourceDesc}）`;
    }

    case 'updateCells': {
      const resolve = makeColumnResolver(sheet);
      const targetIdx = resolve(op.targetColumn);
      const where = op.where;
      let affected = 0;
      for (const row of sheet.rows) {
        const padded = padRow(row, sheet.headers.length);
        const matched = where ? matchWhere(padded, where, resolve) : true;
        if (matched) {
          padded[targetIdx] = op.newValue;
          affected++;
        }
        row.length = 0;
        row.push(...padded);
      }
      return `已更新 ${affected} 行的列「${op.targetColumn}」`;
    }

    case 'deleteRows': {
      const resolve = makeColumnResolver(sheet);
      const before = sheet.rows.length;
      // 记录被删行的下标：汇总行标记随行删除同步收缩/前移（否则标记错位到别的行）
      const removedIdx: number[] = [];
      sheet.rows = sheet.rows.filter((row, idx) => {
        const matched = matchWhere(padRow(row, sheet.headers.length), op.where, resolve);
        if (matched) removedIdx.push(idx);
        return !matched;
      });
      if (removedIdx.length > 0) {
        const removedSet = new Set(removedIdx);
        sheet.totalRowIndexes = sheet.totalRowIndexes
          .filter((idx) => !removedSet.has(idx))
          .map((idx) => idx - removedIdx.filter((r) => r < idx).length);
      }
      return `已删除 ${before - sheet.rows.length} 行（条件：${describeWhere(op.where)}）`;
    }

    case 'deleteColumn': {
      const colIdx = findColumn(sheet, op.column);
      sheet.headers.splice(colIdx, 1);
      for (const row of sheet.rows) {
        if (colIdx < row.length) row.splice(colIdx, 1);
      }
      return `已删除列「${op.column}」`;
    }

    case 'addColumn': {
      sheet.headers.push(op.header);
      for (const row of sheet.rows) {
        row.length = sheet.headers.length - 1;
        row.push(op.value ?? '');
      }
      return `已新增列「${op.header}」${op.value !== undefined ? `（固定值：${op.value}）` : ''}`;
    }

    case 'sortRows': {
      const colIdx = findColumn(sheet, op.column);
      // 汇总行不参与排序（聚合结果被排进明细中间会被用户当成脏数据）：
      // 槽位保持——非汇总行排序后填回它们原来的槽位，汇总行原地不动
      const isTotal = new Set(sheet.totalRowIndexes);
      const totalSlots: number[] = [];
      const sortable: Array<{ idx: number; row: string[] }> = [];
      sheet.rows.forEach((row, idx) => {
        if (isTotal.has(idx)) totalSlots.push(idx);
        else sortable.push({ idx, row });
      });
      const allNumeric =
        sortable.length > 0 &&
        sortable.every(
          (s) =>
            (s.row[colIdx] ?? '').trim() === '' || parseLooseNumber(s.row[colIdx]) !== null,
        );
      const dir = op.order === 'asc' ? 1 : -1;
      sortable.sort((a, b) => {
        const av = (a.row[colIdx] ?? '').trim();
        const bv = (b.row[colIdx] ?? '').trim();
        if (av === '' && bv === '') return 0;
        if (av === '') return 1; // 空值沉底
        if (bv === '') return -1;
        if (allNumeric) {
          return ((parseLooseNumber(av) ?? 0) - (parseLooseNumber(bv) ?? 0)) * dir;
        }
        return av.localeCompare(bv, 'zh-CN') * dir;
      });
      // 排序后的非汇总行按原非汇总槽位顺序回填（槽位数不变，标记无需调整）
      const sortedRows = sortable.map((s) => s.row);
      sheet.rows = sheet.rows.map((_, slot) => {
        const sortableSlot = slot - totalSlots.filter((t) => t < slot).length;
        return totalSlots.includes(slot) ? sheet.rows[slot] : sortedRows[sortableSlot];
      });
      return `已按列「${op.column}」${op.order === 'asc' ? '升序' : '降序'}排序（${allNumeric ? '数值' : '文本'}）${totalSlots.length > 0 ? `，${totalSlots.length} 个汇总行保持原位` : ''}`;
    }

    case 'renameColumn': {
      const colIdx = findColumn(sheet, op.from);
      sheet.headers[colIdx] = op.to;
      return `已将列「${op.from}」重命名为「${op.to}」`;
    }

    case 'groupCreateSheet': {
      // 本操作不作用于传入的 sheet，而是读取来源表 → 新建/重建结果表
      const source = op.sourceSheet ? findSheet(sheets, op.sourceSheet) : sheets[0];
      const resolveSource = makeColumnResolver(source);
      const groupIdx = resolveSource(op.groupBy);
      const valueIdx = resolveSource(op.valueColumn);
      // 聚合池排除已声明的汇总行（与 aggregateAppendRow/aggregateUpdateCell 同口径）：
      // 来源表自身的总行混进分组池会双重计数；未声明时 totalRowIndexes 为空、过滤无操作
      const srcTotalSet = new Set(source.totalRowIndexes);
      let pool = source.rows
        .filter((_, idx) => !srcTotalSet.has(idx))
        .map((r) => padRow(r, source.headers.length));
      const where = op.where;
      if (where) {
        pool = pool.filter((r) => matchWhere(r, where, resolveSource));
        if (pool.length === 0) {
          throw new TableOpsError(
            `「${source.name || '未命名'}」中没有满足条件（${describeWhere(where)}）的行`,
          );
        }
      }
      // 分组：保持首次出现顺序（结果可预期）；分组键为空归"(空)"组
      const groups = new Map<string, string[]>();
      for (const r of pool) {
        const key = (r[groupIdx] ?? '').trim() || '(空)';
        const bucket = groups.get(key);
        if (bucket) bucket.push(r[valueIdx] ?? '');
        else groups.set(key, [r[valueIdx] ?? '']);
      }
      // 逐组聚合：个别组无可计算数字 → 跳过该组并在报告中说明（不算整体失败）
      const resultRows: string[][] = [];
      const skippedGroups: string[] = [];
      for (const [key, values] of groups) {
        try {
          resultRows.push([key, formatAggregate(computeAggregate(values, op.fn, op.valueColumn))]);
        } catch (err) {
          if (err instanceof TableOpsError) {
            skippedGroups.push(key);
          } else {
            throw err;
          }
        }
      }
      if (resultRows.length === 0) {
        throw new TableOpsError(`列「${op.valueColumn}」没有可计算的数字，无法分组统计`);
      }
      // 总计行：对全池（过滤后）统计
      const total = computeAggregate(
        pool.map((r) => r[valueIdx] ?? ''),
        op.fn,
        op.valueColumn,
      );
      const label = op.resultLabel?.trim() || op.valueColumn;
      const name = sanitizeSheetName(op.newSheetName);
      const newSheet: SheetData = {
        name,
        headerRowIndex: 1,
        preambleRows: [],
        // 末行"总计"是聚合结果行：创建即声明（声明优于推断）
        totalRowIndexes: [resultRows.length],
        headers: [op.groupBy, label],
        rows: [...resultRows, ['总计', formatAggregate(total)]],
        lookupFills: [],
      };
      // 幂等守卫：同名 sheet 已存在 → 整表重建（就地更新），避免重复执行插出多张同名表
      const existIdx = sheets.findIndex((s) => s.name === name);
      let action: string;
      if (existIdx !== -1) {
        sheets[existIdx] = newSheet;
        action = `已重建工作表「${name}」`;
      } else {
        sheets.push(newSheet);
        action = `已新建工作表「${name}」`;
      }
      const skipText =
        skippedGroups.length > 0
          ? `，${skippedGroups.length} 组无可计算数字已跳过（${skippedGroups.slice(0, 3).join('、')}）`
          : '';
      return `${action}：按「${op.groupBy}」分组${AGGREGATE_FN_TEXT[op.fn]}「${op.valueColumn}」，共 ${resultRows.length} 组，总计 ${formatAggregate(total)}${skipText}`;
    }

    case 'deriveColumn': {
      // 校验阶段已确认语法与引用列存在，这里直接取 AST 执行
      const ast = compileExpression(op.expression);
      const resolve = makeColumnResolver(sheet);
      const refIdx = new Map<string, number>();
      for (const ref of collectColumnRefs(ast)) {
        refIdx.set(ref, resolve(ref));
      }
      // 目标列：表头精确匹配；不存在则新增该列
      const targetName = op.targetColumn.trim();
      let targetIdx = sheet.headers.findIndex((h) => h.trim() === targetName);
      const isNewColumn = targetIdx === -1;
      if (isNewColumn) {
        sheet.headers.push(op.targetColumn);
        targetIdx = sheet.headers.length - 1;
      }
      const where = op.where;
      let ok = 0;
      let skipped = 0;
      const totalSet = new Set(sheet.totalRowIndexes);
      for (let rowIdx = 0; rowIdx < sheet.rows.length; rowIdx++) {
        // 汇总行是聚合结果行：表达式（如 数量×单价）对它无意义，跳过不计算
        if (totalSet.has(rowIdx)) continue;
        const row = sheet.rows[rowIdx];
        const padded = padRow(row, sheet.headers.length);
        const matched = where ? matchWhere(padded, where, resolve) : true;
        if (matched) {
          const value = evalExprNode(ast, (colName) => {
            const idx = refIdx.get(colName);
            return idx === undefined ? null : parseLooseNumber(padded[idx] ?? '');
          });
          if (value === null) {
            // 无法计算的行：新列留空 / 已有列保留原值——不中断、不填错值
            skipped++;
          } else {
            padded[targetIdx] = formatAggregate(value);
            ok++;
          }
        }
        row.length = 0;
        row.push(...padded);
      }
      const condText = where ? `（条件：${describeWhere(where)}）` : '';
      const skipText =
        skipped > 0 ? `，跳过 ${skipped} 行（引用列含非数字/空值或除零，已保留原值）` : '';
      return `${isNewColumn ? `已新增列「${op.targetColumn}」并` : ''}按表达式 ${op.expression} 计算写入 ${ok} 行${condText}${skipText}`;
    }

    case 'semanticFill': {
      // 正常流程到不了这里：executeTableOps 入口已整体拦截语义填充（服务层分流）。
      // 保留 case 是为了维持穷尽性检查——未来新增 op 类型时编译器会继续强制各 switch 处理
      throw new TableOpsError('语义填充不能由表格执行器处理，请单独发起填充指令');
    }
    case 'lookupFill': {
      const targetIdx = findColumn(sheet, op.targetColumn);
      const source = op.sourceSheet ? findSheet(sheets, op.sourceSheet) : sheet;
      const srcValIdx = findColumn(source, op.sourceValueColumn);
      // 键映射：复合键优先，缺省单键（validateOp 已保证至少一种且列存在，
      // 空 mappings 分支运行期不可达，仅为类型完备）
      const mappings = (op.keyMappings && op.keyMappings.length > 0
        ? op.keyMappings.map((m) => ({
            t: findColumn(sheet, m.targetKeyColumn),
            s: findColumn(source, m.sourceKeyColumn),
          }))
        : op.sourceKeyColumn
          ? [
              {
                t: findColumn(sheet, op.targetKeyColumn ?? op.targetColumn),
                s: findColumn(source, op.sourceKeyColumn),
              },
            ]
          : []);
      // 建键值映射：来源表跳过其已声明汇总行（总行不是明细数据，"总计→5800"入池
      // 会把聚合值当业务值传染）；键全空行跳过；重复键取首个并计数
      const srcTotalSet = new Set(source.totalRowIndexes);
      const map = new Map<string, string>();
      let duplicateKeys = 0;
      for (let i = 0; i < source.rows.length; i++) {
        if (srcTotalSet.has(i)) continue;
        const row = padRow(source.rows[i], source.headers.length);
        const key = mappings.map((m) => (row[m.s] ?? '').trim()).join('\u0001');
        if (!key) continue;
        if (!map.has(key)) {
          map.set(key, (row[srcValIdx] ?? '').trim());
        } else {
          duplicateKeys += 1;
        }
      }
      // 填充：只写明细行（跳过目标表已声明汇总行）的空格，未命中留空绝不发明
      const tgtTotalSet = new Set(sheet.totalRowIndexes);
      let filled = 0;
      let missCount = 0;
      const missSamples: string[] = [];
      for (let i = 0; i < sheet.rows.length; i++) {
        if (tgtTotalSet.has(i)) continue;
        const row = padRow(sheet.rows[i], sheet.headers.length);
        if ((row[targetIdx] ?? '').trim() !== '') continue; // 不覆盖非空格
        const key = mappings.map((m) => (row[m.t] ?? '').trim()).join('\u0001');
        const value = map.get(key);
        if (value === undefined || value === '') {
          missCount += 1;
          if (missSamples.length < 5 && key) missSamples.push(key.replaceAll('\u0001', '+'));
          continue;
        }
        row[targetIdx] = value;
        sheet.rows[i] = row;
        filled += 1;
      }
      // 溯源声明（仅单键）：目标列旧声明替换为本次（最后一次填充是权威溯源）
      if (!op.keyMappings?.length && op.targetKeyColumn && op.sourceKeyColumn) {
        const parts = [
          op.targetColumn,
          op.targetKeyColumn,
          source.name,
          op.sourceKeyColumn,
          op.sourceValueColumn,
        ];
        if (parts.every((p) => p.trim().length > 0 && !p.includes('|'))) {
          sheet.lookupFills = [
            ...sheet.lookupFills.filter((lf) => lf.targetColumn.trim() !== op.targetColumn.trim()),
            {
              targetColumn: op.targetColumn.trim(),
              targetKeyColumn: op.targetKeyColumn.trim(),
              sourceSheet: source.name.trim(),
              sourceKeyColumn: op.sourceKeyColumn.trim(),
              sourceValueColumn: op.sourceValueColumn.trim(),
            },
          ];
        }
      }
      let message = `已按「${source.name || '未命名'}」关联填充「${sheet.name || '未命名'}」的「${op.targetColumn}」共 ${filled} 格`;
      if (missCount > 0) {
        const samples = missSamples.join('、');
        message += `；${missCount} 个键未在来源表命中（保持留空）${samples ? `，如：${samples}` : ''}`;
      }
      if (duplicateKeys > 0) message += `；来源表 ${duplicateKeys} 个重复键取首个值`;
      return message;
    }
    case 'fillConstant': {
      // 填充语义：只写明细行（跳过已声明汇总行）的空格，不覆盖非空格——
      // 与 updateCells（显式条件语义、可命中汇总行）严格分离
      const targetIdx = findColumn(sheet, op.targetColumn);
      const totalSet = new Set(sheet.totalRowIndexes);
      let filled = 0;
      for (let i = 0; i < sheet.rows.length; i++) {
        if (totalSet.has(i)) continue;
        const row = padRow(sheet.rows[i], sheet.headers.length);
        if ((row[targetIdx] ?? '').trim() !== '') continue;
        row[targetIdx] = op.value;
        sheet.rows[i] = row;
        filled += 1;
      }
      return `已在「${sheet.name || '未命名'}」的「${op.targetColumn}」填充固定值「${op.value}」共 ${filled} 格（仅明细行空格）`;
    }
  }
}

// ==================== LookupFill 溯源失效 ====================

/**
 * 返回某 op 在目标表写入了哪些列（用于 LookupFill 溯源失效判定）。
 * 覆盖：条件更新/常量填充/派生列/聚合回填写值，追加行按 cells 键写值，
 * 改名/删列改结构。排序与删行不失效——行内键值对随行整体移动/移除，
 * 按键导出公式（INDEX/MATCH）逐格计算仍与存储值一致。
 */
function lookupWrittenColumns(op: TableOp): string[] {
  switch (op.type) {
    case 'updateCells':
      return [op.targetColumn];
    case 'fillConstant':
      return [op.targetColumn];
    case 'deriveColumn':
      return [op.targetColumn];
    case 'aggregateUpdateCell':
      return [op.column];
    case 'appendRow':
      return Object.keys(op.cells);
    case 'renameColumn':
      return [op.from];
    case 'deleteColumn':
      return [op.column];
    default:
      return [];
  }
}

/** 删除指向指定列的 LookupFill 溯源声明（列值被改写后声明过期，防导出公式与实际值不符） */
function invalidateLookupFills(sheet: SheetData, columns: string[]): void {
  if (sheet.lookupFills.length === 0) return;
  const names = new Set(columns.map((c) => c.trim()).filter((c) => c.length > 0));
  if (names.size === 0) return;
  sheet.lookupFills = sheet.lookupFills.filter((lf) => !names.has(lf.targetColumn.trim()));
}

// ==================== 入口 ====================

/**
 * 在 sheet 结构化文本上执行操作序列。
 *
 * @param text      当前 sheet 结构化文本（编辑器序列化产物或版本文本）
 * @param ops       LLM 解析出的操作序列（≤10 个，schema 已限）
 * @returns 新文本 + 逐操作报告
 * @throws TableOpsError 任何引用不存在 / 护栏拦截 → 整体不执行
 */
export function executeTableOps(text: string, ops: TableOp[]): ExecuteResult {
  // 防御纵深：semanticFill 是 LLM 推断型操作，只能由 TableOpsService 分流给
  // SemanticFillService 单独执行；若混入执行器（解析分流被绕过）在这里显式拒绝，
  // 而不是让 switch 静默跳过造成"指令成功但什么都没发生"
  if (ops.some((o) => o.type === 'semanticFill')) {
    throw new TableOpsError(
      '语义填充需单独执行（请在指令中只描述填充需求），不能与其他表格操作混用',
    );
  }
  const sheets = parseSheetData(text);
  if (sheets.length === 0) {
    throw new TableOpsError('表格内容为空，无可执行的操作');
  }
  const totalRows = sheets.reduce((acc, s) => acc + s.rows.length, 0);
  if (totalRows > MAX_DATA_ROWS) {
    throw new TableOpsError(`表格共 ${totalRows} 行，超过单次指令处理上限 ${MAX_DATA_ROWS} 行`);
  }

  // 顺序校验 + 执行：op 之间允许依赖前序 op 的结果（如"删除备注列再新增备注列"），
  // 所以每个 op 在执行前针对"当前（已被前序 op 变更过）"的状态校验。
  // 原子性保证：任何一步失败直接抛错，函数不返回文本——调用方持有原文本，
  // 天然不会出现"执行一半"的落盘状态；错误带步骤编号便于定位是哪条指令没被满足
  const report: OpReport[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      validateOp(op, sheets);
      // groupCreateSheet 不作用于已有工作表（产出为新表），报告以清洗后的新表名为目标
      const target =
        op.type === 'groupCreateSheet' ? sheets[0] : findSheet(sheets, op.targetSheet);
      const message = executeOp(op, target, sheets);
      // 漏洞 7 防护：目标列被改写后其 LookupFill 溯源声明过期，自动失效删除；
      // lookupFill 自身写声明（替换旧声明），跳过避免刚写入就被误删
      if (op.type !== 'lookupFill') {
        const written = lookupWrittenColumns(op);
        if (written.length > 0) invalidateLookupFills(target, written);
      }
      report.push({
        type: op.type,
        targetSheet:
          op.type === 'groupCreateSheet' ? sanitizeSheetName(op.newSheetName) : target.name,
        message,
      });
    } catch (err) {
      if (err instanceof TableOpsError) {
        throw new TableOpsError(`第 ${i + 1} 步失败：${err.message}`);
      }
      throw err;
    }
  }

  return { sheetText: serializeSheetData(sheets), report };
}

/** 单元格最大显示宽度（超出截断加省略号，防超宽值把框撑爆） */
const OVERVIEW_CELL_MAX_WIDTH = 20;

/** 字符显示宽度：CJK 全角算 2、其余算 1（框线对齐按显示宽度算，不是字符数） */
function charDisplayWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首/标点/日文假名
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x4e00 && code <= 0x9fff) // CJK 统一表意
  ) {
    return 2;
  }
  return 1;
}

/** 字符串显示宽度（逐码点累加） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charDisplayWidth(ch);
  return w;
}

/** 按显示宽度截断（保留尾部省略号） */
function truncateToWidth(s: string, maxWidth: number): string {
  if (displayWidth(s) <= maxWidth) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charDisplayWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 单元格内容渲染：转义框线分隔符 + 截断；空单元格渲染为 ∅（显式可读，防误判为空列） */
function renderCell(value: string, width: number): string {
  const v = value.replace(/│/g, '｜');
  const clipped = truncateToWidth(v, width);
  const shown = clipped === '' ? '∅' : clipped;
  return shown + ' '.repeat(Math.max(0, width - displayWidth(shown)));
}

/**
 * 生成给 LLM 的表格概览：框线表格（终端数据库风格：表头 + 前 2 行样本）+
 * 每列去重取值示例（≤5 个）+ 每列空缺单元格统计。
 *
 * 框线格式的健壮性收益：单元格值含 "，" "=" "|" 等分隔符时，键值对格式
 * （列=值，列=值）的边界会模糊，框线每格独立无歧义；该格式也是 LLM
 * 训练语料中极常见的终端表输出，解析可靠。
 * 取值示例帮助 LLM 选对 where 条件值；空缺统计帮助 LLM 判断"补空/填充"
 * 类意图是否可执行（不给空缺信息模型会误判"没有空的值"而拒绝执行）。
 * 不输出全表数据——省 token，且计算本来就不归 LLM 管。
 * 供 parse.ts 构造提示词用。
 */
export function buildSheetOverview(text: string): string {
  const sheets = parseSheetData(text);
  return sheets
    .map((sheet) => {
      const name = sheet.name || '(未命名)';
      // 报表式表格：开头注明表头锚点与说明行内容——说明行不是数据，
      // 不参与填充/条件/规则；其旁的空缺也不计入下方空缺统计
      let firstLine: string;
      if (sheet.headerRowIndex > 1) {
        const preambleDesc = sheet.preambleRows
          .map((r) => r.filter((c) => c.trim()).join(' '))
          .filter((s) => s.length > 0)
          .map((s) => truncateToWidth(s, 40))
          .join('；');
        firstLine =
          `工作表「${name}」表头在第 ${sheet.headerRowIndex} 行` +
          (preambleDesc ? `，上方为说明行：${preambleDesc}` : '，上方为说明行') +
          `（说明行不是数据），数据共 ${sheet.rows.length} 行`;
      } else {
        firstLine = `工作表「${name}」共 ${sheet.rows.length} 行`;
      }
      const lines = [firstLine];
      const colCount = Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length), 0);
      const headers = Array.from({ length: colCount }, (_, c) => {
        const h = sheet.headers[c]?.trim();
        return h && h !== '' ? h : `第${c + 1}列`;
      });
      const sampleRows = sheet.rows.slice(0, 2).map((r) =>
        Array.from({ length: colCount }, (_, c) => (r[c] ?? '').trim()),
      );

      // 列宽 = 表头与样本单元格显示宽度的最大值（截到上限）
      const widths = headers.map((h, c) => {
        let w = displayWidth(h);
        for (const row of sampleRows) w = Math.max(w, displayWidth(row[c]));
        return Math.min(w, OVERVIEW_CELL_MAX_WIDTH);
      });
      const edge = (left: string, mid: string, right: string): string =>
        left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
      const renderRow = (row: string[]): string =>
        `│ ${row.map((v, c) => renderCell(v, widths[c])).join(' │ ')} │`;

      lines.push(edge('┌', '┬', '┐'));
      lines.push(renderRow(headers));
      lines.push(edge('├', '┼', '┤'));
      for (const row of sampleRows) lines.push(renderRow(row));
      lines.push(edge('└', '┴', '┘'));

      // 每列去重取值（≤5 个、每个截断 20 字符）：条件过滤/定位行时值必须逐字匹配
      const distinctLines: string[] = [];
      const emptyLines: string[] = [];
      const totalSet = new Set(sheet.totalRowIndexes);
      for (let c = 0; c < colCount; c++) {
        const seen: string[] = [];
        const emptyRowLabels: string[] = [];
        for (let ri = 0; ri < sheet.rows.length; ri++) {
          // 汇总行是聚合结果行：不进取值示例（不是过滤目标）、不进空缺统计
          // （它的空缺不是数据缺失，该不该算由"汇总行"声明行告知 LLM）
          if (totalSet.has(ri)) continue;
          const r = sheet.rows[ri];
          const v = (r[c] ?? '').trim();
          if (!v) {
            // 空缺位置用"该行第一个非空单元格"标注（如 日期行文本）：
            // 只给格数时，说明行刻意留白与数据行真实缺失会混成一个数字，
            // LLM 无法区分"该填"与"不该填"（实测：总计行空值被误判为留白而 noop）
            const label =
              r.find((cell) => (cell ?? '').trim())?.trim().slice(0, 20) ||
              `第${ri + 1}行`;
            emptyRowLabels.push(label);
            continue;
          }
          const clipped = v.slice(0, 20);
          if (seen.includes(clipped)) continue;
          seen.push(clipped);
        }
        if (seen.length > 0) distinctLines.push(`${headers[c]}={${seen.slice(0, 5).join('|')}}`);
        if (emptyRowLabels.length > 0) {
          const shown = emptyRowLabels.slice(0, 5).join('、');
          const more = emptyRowLabels.length > 5 ? ` 等${emptyRowLabels.length}行` : '';
          emptyLines.push(`${headers[c]}=${emptyRowLabels.length}格（位于行：${shown}${more}）`);
        }
      }
      // 已声明的汇总行：明确告知 LLM 这些行是聚合结果行（声明优于标签猜测）
      if (sheet.totalRowIndexes.length > 0) {
        const desc = sheet.totalRowIndexes
          .map((idx) => {
            const first = sheet.rows[idx]?.find((c2) => (c2 ?? '').trim() !== '');
            return `第 ${sheet.headerRowIndex + idx + 1} 行${first ? `（${first.trim()}）` : ''}`;
          })
          .join('、');
        lines.push(
          `  汇总行：${desc}——聚合结果行不是明细数据，填充/条件/规则自动跳过；补全其数值用 aggregateUpdateCell 重算`,
        );
      }
      if (distinctLines.length > 0) lines.push(`  取值示例：${distinctLines.join(' ')}`);
      // 空缺统计（只列有空缺的列）：填充类意图的关键依据
      if (emptyLines.length > 0) lines.push(`  空缺单元格：${emptyLines.join('、')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ==================== 表达式求值对外包装（rules.ts 规则器复用） ====================

/**
 * 求值一条表达式（功能 5 规则器复用功能 2 求值器）。
 * 语法错误抛 TableOpsError（消息面向用户）；引用列无法解析为数字/除零返回 null，
 * 由调用方决定跳过该行。
 */
export function evaluateSheetExpression(
  expr: string,
  resolveColValue: (name: string) => number | null,
): number | null {
  return evalExprNode(compileExpression(expr), resolveColValue);
}

/** 收集表达式引用的全部列名（去重、保序），供规则器提前校验列存在性 */
export function collectExpressionColumnRefs(expr: string): string[] {
  return collectColumnRefs(compileExpression(expr));
}

/** 表达式结果的展示格式化（整数不带小数，小数最多 2 位去尾零） */
export const formatExpressionNumber = formatAggregate;
