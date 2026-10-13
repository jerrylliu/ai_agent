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

import { parseCsvLine, SHEET_HEADING_RE } from '../document-parser.js';
import type { OpReport, TableOp } from './schema.js';

// ==================== 常量 ====================

/** 执行器护栏：单次指令允许操作的最大数据行数（约等于 2 万行，远超编辑器渲染上限） */
export const MAX_DATA_ROWS = 20000;

// ==================== 数据结构 ====================

/** 解析后的单个 sheet：headers 为表头数组，rows 为数据行（不含表头） */
interface SheetData {
  name: string;
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
 *   - 每块首个非空行为表头，其余为数据行；空行跳过。
 */
function parseSheetData(text: string): SheetData[] {
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
    const headers = parseCsvLine(nonEmpty[0]);
    const rows = nonEmpty.slice(1).map((l) => parseCsvLine(l));
    sheets.push({ name: block.name, headers, rows });
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
  const lines = [
    sheet.headers.map(escapeCsvCell).join(','),
    ...sheet.rows.map((row) => {
      // 行短于表头补空、长于表头保留（序列化不丢数据）
      const padded = [...row];
      while (padded.length < sheet.headers.length) padded.push('');
      return padded.map(escapeCsvCell).join(',');
    }),
  ];
  // 无名块（标题前的散行）只输出行本身，不产生 Sheet 标题
  const body = lines.filter((l) => l.length > 0).join('\n');
  return sheet.name ? `Sheet: ${sheet.name}\n${body}` : body;
}

function serializeSheetData(sheets: SheetData[]): string {
  return sheets.map(sheetToText).join('\n\n');
}

// ==================== 基础工具 ====================

/** 宽松数字解析：去逗号/货币符号/空格后 parseFloat；失败返回 null */
function parseLooseNumber(value: string): number | null {
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

/** 归一化列名匹配（trim 后精确比对） */
function findColumn(headers: string[], name: string): number {
  const idx = headers.findIndex((h) => h.trim() === name.trim());
  if (idx === -1) {
    throw new TableOpsError(
      `找不到列「${name}」，当前表头：${headers.join('、')}`,
    );
  }
  return idx;
}

/** 按 sheet 名取目标 sheet（精确匹配优先；单 sheet 时任意名都可命中，容忍 LLM 记错名） */
function findSheet(sheets: SheetData[], targetSheet: string | undefined): SheetData {
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
function matchCondition(row: string[], colIdx: number, op: string, value: string): boolean {
  const cell = (row[colIdx] ?? '').trim();
  switch (op) {
    case 'empty':
      return cell === '';
    case 'notEmpty':
      return cell !== '';
    case 'contains':
      return cell.includes(value);
  }
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

// ==================== 静态校验（先校验后执行） ====================

/** 校验单个 op 的所有列/sheet 引用；引用不存在抛 TableOpsError */
function validateOp(op: TableOp, sheets: SheetData[]): void {
  const target = findSheet(sheets, op.targetSheet);

  switch (op.type) {
    case 'appendRow':
      // 追加行的列名必须在表头中（避免 LLM 编造列名静默丢数据）
      for (const key of Object.keys(op.cells)) {
        findColumn(target.headers, key);
      }
      break;
    case 'aggregateAppendRow': {
      findColumn(target.headers, op.column);
      if (op.labelColumn) findColumn(target.headers, op.labelColumn);
      break;
    }
    case 'updateCells':
      findColumn(target.headers, op.targetColumn);
      if (op.where) findColumn(target.headers, op.where.column);
      break;
    case 'deleteRows':
      findColumn(target.headers, op.where.column);
      break;
    case 'deleteColumn':
      findColumn(target.headers, op.column);
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
      findColumn(target.headers, op.column);
      break;
    case 'renameColumn':
      findColumn(target.headers, op.from);
      if (op.from.trim() !== op.to.trim() && target.headers.some((h) => h.trim() === op.to.trim())) {
        throw new TableOpsError(`新列名「${op.to}」与现有列重名`);
      }
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

function executeOp(op: TableOp, sheet: SheetData): string {
  switch (op.type) {
    case 'appendRow': {
      const row = sheet.headers.map((h) => op.cells[h] ?? '');
      sheet.rows.push(row);
      return `已追加 1 行（${Object.keys(op.cells).length} 个单元格有值）`;
    }

    case 'aggregateAppendRow': {
      const colIdx = findColumn(sheet.headers, op.column);
      const values = sheet.rows
        .map((r) => (r[colIdx] ?? '').trim())
        .filter((v) => v !== '');
      let result: number;
      switch (op.fn) {
        case 'sum':
          result = values.reduce((acc, v) => acc + (parseLooseNumber(v) ?? 0), 0);
          break;
        case 'avg':
          result =
            values.length === 0
              ? 0
              : values.reduce((acc, v) => acc + (parseLooseNumber(v) ?? 0), 0) /
                values.length;
          break;
        case 'count':
          result = values.length;
          break;
        case 'min': {
          const nums = values.map(parseLooseNumber).filter((n): n is number => n !== null);
          if (nums.length === 0) throw new TableOpsError(`列「${op.column}」没有可计算的数字`);
          result = Math.min(...nums);
          break;
        }
        case 'max': {
          const nums = values.map(parseLooseNumber).filter((n): n is number => n !== null);
          if (nums.length === 0) throw new TableOpsError(`列「${op.column}」没有可计算的数字`);
          result = Math.max(...nums);
          break;
        }
      }
      const labelColIdx = op.labelColumn ? findColumn(sheet.headers, op.labelColumn) : 0;
      const row = padRow([], sheet.headers.length);
      row[labelColIdx] = op.label;
      row[colIdx] = formatAggregate(result);
      sheet.rows.push(row);
      return `已聚合列「${op.column}」（${op.fn}），结果 ${formatAggregate(result)} 追加为第 ${sheet.rows.length} 行`;
    }

    case 'updateCells': {
      const targetIdx = findColumn(sheet.headers, op.targetColumn);
      let affected = 0;
      for (const row of sheet.rows) {
        const padded = padRow(row, sheet.headers.length);
        const matched = op.where
          ? matchCondition(padded, findColumn(sheet.headers, op.where.column), op.where.op, op.where.value)
          : true;
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
      const colIdx = findColumn(sheet.headers, op.where.column);
      const before = sheet.rows.length;
      sheet.rows = sheet.rows.filter(
        (row) => !matchCondition(padRow(row, sheet.headers.length), colIdx, op.where.op, op.where.value),
      );
      return `已删除 ${before - sheet.rows.length} 行（条件：${op.where.column} ${op.where.op} ${op.where.value || ''}）`;
    }

    case 'deleteColumn': {
      const colIdx = findColumn(sheet.headers, op.column);
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
      const colIdx = findColumn(sheet.headers, op.column);
      const allNumeric =
        sheet.rows.length > 0 &&
        sheet.rows.every((r) => (r[colIdx] ?? '').trim() === '' || parseLooseNumber(r[colIdx]) !== null);
      const dir = op.order === 'asc' ? 1 : -1;
      sheet.rows.sort((a, b) => {
        const av = (a[colIdx] ?? '').trim();
        const bv = (b[colIdx] ?? '').trim();
        if (av === '' && bv === '') return 0;
        if (av === '') return 1; // 空值沉底
        if (bv === '') return -1;
        if (allNumeric) {
          return ((parseLooseNumber(av) ?? 0) - (parseLooseNumber(bv) ?? 0)) * dir;
        }
        return av.localeCompare(bv, 'zh-CN') * dir;
      });
      return `已按列「${op.column}」${op.order === 'asc' ? '升序' : '降序'}排序（${allNumeric ? '数值' : '文本'}）`;
    }

    case 'renameColumn': {
      const colIdx = findColumn(sheet.headers, op.from);
      sheet.headers[colIdx] = op.to;
      return `已将列「${op.from}」重命名为「${op.to}」`;
    }
  }
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
      const target = findSheet(sheets, op.targetSheet);
      const message = executeOp(op, target);
      report.push({ type: op.type, targetSheet: target.name, message });
    } catch (err) {
      if (err instanceof TableOpsError) {
        throw new TableOpsError(`第 ${i + 1} 步失败：${err.message}`);
      }
      throw err;
    }
  }

  return { sheetText: serializeSheetData(sheets), report };
}

/**
 * 生成给 LLM 的表格概览（表头 + 每列前 2 个样本值），控制 token 且不泄漏全表数据。
 * 供 parse.ts 构造提示词用。
 */
export function buildSheetOverview(text: string): string {
  const sheets = parseSheetData(text);
  return sheets
    .map((sheet) => {
      const name = sheet.name || '(未命名)';
      const sampleRows = sheet.rows.slice(0, 2);
      const lines = [
        `工作表「${name}」表头：${sheet.headers.join('、')}`,
        ...sampleRows.map((r) => `  样例行：${sheet.headers.map((h, i) => `${h}=${r[i] ?? ''}`).join('，')}`),
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}
