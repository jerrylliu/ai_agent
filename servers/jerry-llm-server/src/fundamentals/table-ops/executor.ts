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

/** 聚合方式 */
type AggregateFn = 'sum' | 'avg' | 'count' | 'min' | 'max';

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
function findColumn(sheet: SheetData, name: string): number {
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
      // 追加行的列名必须能定位（避免 LLM 编造列名静默丢数据）
      for (const key of Object.keys(op.cells)) {
        findColumn(target, key);
      }
      break;
    case 'aggregateAppendRow': {
      const source = op.sourceSheet ? findSheet(sheets, op.sourceSheet) : target;
      findColumn(source, op.column);
      if (op.where) findColumn(source, op.where.column);
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
        if (op.where) findColumn(source, op.where.column);
      }
      break;
    }
    case 'updateCells':
      findColumn(target, op.targetColumn);
      if (op.where) findColumn(target, op.where.column);
      break;
    case 'deleteRows':
      findColumn(target, op.where.column);
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
      const srcColIdx = findColumn(source, op.column);
      let pool = source.rows.map((r) => padRow(r, source.headers.length));
      let matchedDesc = `全部 ${pool.length} 行`;
      const where = op.where;
      if (where) {
        const wIdx = findColumn(source, where.column);
        pool = pool.filter((r) => matchCondition(r, wIdx, where.op, where.value));
        if (pool.length === 0) {
          throw new TableOpsError(
            `「${source.name || '未命名'}」中没有满足条件（${where.column} ${where.op} ${where.value || ''}）的行`,
          );
        }
        matchedDesc = `匹配 ${pool.length} 行`;
      }
      const result = computeAggregate(
        pool.map((r) => r[srcColIdx] ?? ''),
        op.fn,
        op.column,
      );
      const labelColIdx = op.labelColumn ? findColumn(sheet, op.labelColumn) : 0;
      const valueColIdx = op.valueColumn ? findColumn(sheet, op.valueColumn) : findColumn(sheet, op.column);
      // 幂等守卫：目标表中已存在同标签行（精确匹配）→ 就地更新数值，不重复插入。
      // 否则用户重复执行同一条聚合指令会插出多行同名合计，且后续"重算总计"
      // 会把旧合计行也累计进去，数值静默翻倍
      const exactRows = sheet.rows.map((r) => padRow(r, sheet.headers.length));
      const existIdx = exactRows.findIndex((r) => (r[labelColIdx] ?? '').trim() === op.label.trim());
      if (existIdx !== -1) {
        sheet.rows[existIdx] = exactRows[existIdx];
        sheet.rows[existIdx][valueColIdx] = formatAggregate(result);
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
        // 指定来源表：从其他表聚合（可带 where 过滤）
        const source = findSheet(sheets, op.sourceSheet);
        const srcColName = op.sourceColumn ?? op.column;
        const srcColIdx = findColumn(source, srcColName);
        let pool = source.rows.map((r) => padRow(r, source.headers.length));
        const where = op.where;
        if (where) {
          const wIdx = findColumn(source, where.column);
          pool = pool.filter((r) => matchCondition(r, wIdx, where.op, where.value));
        }
        if (pool.length === 0) {
          throw new TableOpsError(`来源「${source.name || '未命名'}」中没有满足条件的行`);
        }
        result = computeAggregate(pool.map((r) => r[srcColIdx] ?? ''), op.fn, srcColName);
        sourceDesc = `「${source.name || '未命名'}」列「${srcColName}」`;
      } else {
        // 重算语义：同列、目标行上方的所有行（标题/文本行会被数字过滤自然跳过）
        result = computeAggregate(
          paddedRows.slice(0, rowIdx).map((r) => r[writeIdx] ?? ''),
          op.fn,
          op.column,
        );
        sourceDesc = `同列上方 ${rowIdx} 行`;
      }
      sheet.rows[rowIdx] = paddedRows[rowIdx];
      sheet.rows[rowIdx][writeIdx] = formatAggregate(result);
      return `已将「${sheet.name}」第 ${rowIdx + 1} 行（${lbl}）的「${op.column}」更新为 ${formatAggregate(result)}（${op.fn}，来源：${sourceDesc}）`;
    }

    case 'updateCells': {
      const targetIdx = findColumn(sheet, op.targetColumn);
      // 条件列定位提到循环外（大表逐行 findColumn 是纯浪费）
      const where = op.where;
      const whereIdx = where ? findColumn(sheet, where.column) : -1;
      let affected = 0;
      for (const row of sheet.rows) {
        const padded = padRow(row, sheet.headers.length);
        const matched = where
          ? matchCondition(padded, whereIdx, where.op, where.value)
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
      const colIdx = findColumn(sheet, op.where.column);
      const before = sheet.rows.length;
      sheet.rows = sheet.rows.filter(
        (row) => !matchCondition(padRow(row, sheet.headers.length), colIdx, op.where.op, op.where.value),
      );
      return `已删除 ${before - sheet.rows.length} 行（条件：${op.where.column} ${op.where.op} ${op.where.value || ''}）`;
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
      const colIdx = findColumn(sheet, op.from);
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
      const message = executeOp(op, target, sheets);
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
 * 生成给 LLM 的表格概览：表头 + 每列前 2 个样本行 + 每列去重取值示例（≤5 个）。
 * 取值示例帮助 LLM 选对 where 条件值（如备注列的"重点客户"可能不在前 2 行里）；
 * 不输出全表数据——省 token，且计算本来就不归 LLM 管。
 * 供 parse.ts 构造提示词用。
 */
export function buildSheetOverview(text: string): string {
  const sheets = parseSheetData(text);
  return sheets
    .map((sheet) => {
      const name = sheet.name || '(未命名)';
      const sampleRows = sheet.rows.slice(0, 2);
      const lines = [
        `工作表「${name}」共 ${sheet.rows.length} 行，表头：${sheet.headers.join('、')}`,
        ...sampleRows.map((r) => `  样例行：${sheet.headers.map((h, i) => `${h}=${r[i] ?? ''}`).join('，')}`),
      ];
      // 每列去重取值（≤5 个、每个截断 20 字符）：条件过滤/定位行时值必须逐字匹配
      const colCount = Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length), 0);
      const distinctLines: string[] = [];
      for (let c = 0; c < colCount; c++) {
        const colName = sheet.headers[c]?.trim() || `第${c + 1}列`;
        const seen: string[] = [];
        for (const r of sheet.rows) {
          const v = (r[c] ?? '').trim().slice(0, 20);
          if (!v || seen.includes(v)) continue;
          seen.push(v);
          if (seen.length >= 5) break;
        }
        if (seen.length > 0) distinctLines.push(`${colName}={${seen.join('|')}}`);
      }
      if (distinctLines.length > 0) lines.push(`  取值示例：${distinctLines.join(' ')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
