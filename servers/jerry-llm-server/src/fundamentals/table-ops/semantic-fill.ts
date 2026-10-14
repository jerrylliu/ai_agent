/**
 * fundamentals/table-ops/semantic-fill.ts
 *
 * 语义填充（功能 4）纯函数层：空缺统计、映射应用、分批切分、批结果校验。
 *
 * 三级路径（方案定稿，AI 自主选择、用户只说目标）：
 *   1. 去重映射：空缺行的依据列取值去重 ≤100 个 → LLM 只推断去重值 →
 *      代码映射刷全表（行数无上限、一次 LLM 调用；逐值校验，缺失即整体拒绝）；
 *   2. 分批处理：值太杂 → 每批 100 行走任务模式（发起 → 任务 ID → 进度 →
 *      完成出报告），批级校验（批内缺一值则该批整体失败，不影响已完成批次）；
 *   3. 规则建议：填充规律稳定时 LLM 可提议把依据列取值白名单存入规则器
 *      （持久化资产，必须用户确认才入库）。
 *
 * 本文件不做任何 LLM/网络调用——LLM 调用在 semantic-fill-llm.ts，
 * 编排与服务在 services/semantic-fill.service.ts。
 */

import { z } from 'zod';
import { TableOpsError, findColumn, type SheetData } from './executor.js';

// ==================== Zod Schema（LLM 输出校验） ====================

/** 映射路径 LLM 输出：依据值 → 填充值 */
export const FillMappingOutputSchema = z.object({
  mapping: z
    .array(
      z.object({
        from: z.string().min(1).max(200).describe('依据列的原值（逐字来自输入清单）'),
        to: z.string().min(1).max(200).describe('推断出的填充值（不能为空）'),
      }),
    )
    .min(1)
    .max(200),
});
export type FillMappingOutput = z.infer<typeof FillMappingOutputSchema>;

/** 分批路径单批 LLM 输出：批内每行的填充值 */
export const BatchFillOutputSchema = z.object({
  fills: z
    .array(
      z.object({
        row: z.number().int().positive().describe('数据行号（1 起，不含表头）'),
        value: z.string().min(1).max(500).describe('该行目标列的填充值（不能为空）'),
      }),
    )
    .min(1)
    .max(200),
});
export type BatchFillOutput = z.infer<typeof BatchFillOutputSchema>;

/** 规则建议（可选）：填充规律稳定时提议把依据列取值白名单存入规则器 */
export const FillRuleSuggestionSchema = z.object({
  name: z.string().min(1).max(200),
  column: z.string().min(1).max(200),
  values: z.array(z.string().min(1).max(200)).min(1).max(50),
  // 服务层在返回前会把本次填充的目标工作表名回填到这里（多 sheet 文档规则才能查对表）
  targetSheet: z.string().min(1).max(200).optional(),
});
export type FillRuleSuggestion = z.infer<typeof FillRuleSuggestionSchema>;

// ==================== 空缺统计 ====================

/** 语义填充的空缺统计结果 */
export interface FillGapStats {
  /** 目标列名 */
  targetColumn: string;
  /** 实际使用的依据列（hintColumns 为空时取前 3 个非目标列） */
  hintColumns: string[];
  /** 目标列为空的数据行号（1 起，不含表头） */
  emptyRowIndexes: number[];
  /** 空缺行依据列取值的去重清单（≤ 200 个，超出截断） */
  distinctBasisValues: string[];
  /** 空缺行依据列取值的去重总数（真实总数，distinctBasisValues 可能被截断） */
  distinctCount: number;
  /** 依据值 → 一行样本上下文（供 LLM 推断，每值取第一行） */
  rowSamples: Map<string, string>;
}

/** 依据值去重上限：超过则映射路径不适用（走分批），清单截断防 prompt 爆炸 */
export const MAX_DISTINCT_FOR_MAPPING = 100;
/** LLM 输出映射的条目上限（略大于去重上限，容错） */
export const MAX_MAPPING_ENTRIES = 200;
/** 单行样本单元格截断长度 */
const SAMPLE_CELL_MAX = 60;

/**
 * 统计目标列空缺情况（纯只读）。
 *
 * @param sheet        已解析的工作表
 * @param targetColumn 目标列名（要填充的列）
 * @param hintColumns  依据列名（用于推断的列）；为空时自动取前 3 个非目标列
 */
export function analyzeFillGaps(
  sheet: SheetData,
  targetColumn: string,
  hintColumns: string[],
): FillGapStats {
  const targetIdx = findColumn(sheet, targetColumn);

  // 依据列：hintColumns 逐个校验存在性（不存在的列名说明 LLM/用户记错，直接报错）
  let basisCols: number[];
  let basisNames: string[];
  if (hintColumns.length > 0) {
    basisCols = hintColumns.map((name) => findColumn(sheet, name));
    basisNames = hintColumns;
  } else {
    // 兜底：取前 3 个非目标列作为推断依据（给 LLM 尽量多的行内上下文）
    basisCols = [];
    basisNames = [];
    for (let c = 0; c < sheet.headers.length && basisCols.length < 3; c++) {
      if (c === targetIdx) continue;
      basisCols.push(c);
      basisNames.push(sheet.headers[c]?.trim() || `第${c + 1}列`);
    }
    if (basisCols.length === 0) {
      throw new TableOpsError(`表中只有「${targetColumn}」一列，没有可用于推断的依据列`);
    }
  }

  // 空缺行扫描：目标列为空的行；依据值 = 依据列值拼接（单依据列直接用值，多列用 "a | b"）
  // 汇总行是声明式排除（totalRowIndexes），不再靠首格文字猜测——聚合结果行不是
  // 明细数据，即使目标列为空也不填充（补数值应走 aggregateUpdateCell 重算）
  const totalSet = new Set(sheet.totalRowIndexes);
  const emptyRowIndexes: number[] = [];
  const distinct = new Set<string>();
  const rowSamples = new Map<string, string>();
  for (let i = 0; i < sheet.rows.length; i++) {
    if (totalSet.has(i)) continue;
    const row = sheet.rows[i];
    const targetCell = (row[targetIdx] ?? '').trim();
    if (targetCell !== '') continue;
    const rowIndex = i + 1;
    emptyRowIndexes.push(rowIndex);

    const basisParts = basisCols.map((idx) => (row[idx] ?? '').trim());
    const basisKey = basisParts.join(' | ');
    // 依据值全空的行没有推断依据，不进入去重清单（映射/分批都推不出来）
    if (basisParts.every((p) => p === '')) continue;
    if (!distinct.has(basisKey)) {
      distinct.add(basisKey);
      // 一行样本：依据列=值 对，供 LLM 看上下文
      const sample = basisNames
        .map((name, k) => `${name}=${basisParts[k].slice(0, SAMPLE_CELL_MAX)}`)
        .join('，');
      rowSamples.set(basisKey, sample);
    }
  }

  return {
    targetColumn,
    hintColumns: basisNames,
    emptyRowIndexes,
    distinctBasisValues: [...distinct].slice(0, MAX_MAPPING_ENTRIES),
    distinctCount: distinct.size,
    rowSamples,
  };
}

// ==================== 映射应用（路径 1） ====================

/**
 * 把映射刷到目标列全部空缺行（纯函数，返回应用行数）。
 *
 * 校验规则（方案："逐值校验，缺失即整体拒绝"）由调用方完成——本函数只做应用：
 *   - 目标列为空 且 依据值在映射中 → 写入映射值；
 *   - 依据值不在映射中 → 由调用方在应用前统一校验（fillMappingMissing 返回缺失清单）。
 */
export function fillMappingMissing(
  stats: FillGapStats,
  mapping: FillMappingOutput['mapping'],
): string[] {
  const mapped = new Set(mapping.map((m) => m.from));
  return stats.distinctBasisValues.filter((v) => !mapped.has(v));
}

/** 应用映射：返回成功填充的行数；修改传入的 sheet（调用方持有副本） */
export function applyFillMapping(
  sheet: SheetData,
  targetColumn: string,
  hintColumns: string[],
  mapping: Map<string, string>,
): number {
  const targetIdx = findColumn(sheet, targetColumn);
  const basisCols = hintColumns.map((name) => findColumn(sheet, name));
  // 汇总行声明式跳过：空缺统计虽然已排除，但总行的依据值可能与数据行巧合同值，
  // 应用阶段二次拦截（声明优于推断，两道闸都用同一份声明）
  const totalSet = new Set(sheet.totalRowIndexes);
  let applied = 0;
  for (let i = 0; i < sheet.rows.length; i++) {
    if (totalSet.has(i)) continue;
    const row = sheet.rows[i];
    const targetCell = (row[targetIdx] ?? '').trim();
    if (targetCell !== '') continue;
    const basisKey = basisCols.map((idx) => (row[idx] ?? '').trim()).join(' | ');
    if (!basisKey) continue;
    const value = mapping.get(basisKey);
    if (value === undefined || value.trim() === '') continue;
    row[targetIdx] = value.trim();
    applied += 1;
  }
  return applied;
}

// ==================== 跨表参照（"按 B 表内容补 A 表"） ====================

/** 对照样本行数上限（防参照表巨大时 prompt 爆炸） */
const MAX_CROSS_REF_LINES = 40;

/**
 * 生成跨表对照文本：对目标表依据列的每个取值，到参照表的同名列找匹配行，
 * 收集该行其他列的取值作为对照样本（如 产品=冰箱 → 类型=家电，单价=1200）。
 *
 * 依据列在目标表或参照表中不存在同名列时该列跳过（不中断——可能只有部分
 * 依据列能跨表对照）；一条对照都产不出返回 undefined（无参照价值）。
 * 供 LLM 填充提示词注入，让"按照销售明细表补汇总表"这类跨表意图有数据依据。
 */
export function buildCrossSheetReference(
  sheet: SheetData,
  referenceSheet: SheetData,
  hintColumns: string[],
  maxLines: number = MAX_CROSS_REF_LINES,
): string | undefined {
  const pairs: Array<{ name: string; sheetIdx: number; refIdx: number }> = [];
  for (const name of hintColumns) {
    try {
      pairs.push({
        name,
        sheetIdx: findColumn(sheet, name),
        refIdx: findColumn(referenceSheet, name),
      });
    } catch {
      // 目标表或参照表缺该列：该列无法跨表对照，跳过
    }
  }
  if (pairs.length === 0) return undefined;

  const lines: string[] = [];
  const seen = new Set<string>();
  // 汇总行声明式跳过：聚合结果行不作为跨表参照样本（它不是明细数据）
  const totalSet = new Set(sheet.totalRowIndexes);
  for (const pair of pairs) {
    for (let i = 0; i < sheet.rows.length && lines.length < maxLines; i++) {
      if (totalSet.has(i)) continue;
      const row = sheet.rows[i];
      const value = (row[pair.sheetIdx] ?? '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      // 参照表中该值的行 → 其他列取值样本（≤4 列，单元格截断 30 字符）
      const refRow = referenceSheet.rows.find((r) => (r[pair.refIdx] ?? '').trim() === value);
      if (!refRow) continue;
      const samples: string[] = [];
      for (let c = 0; c < referenceSheet.headers.length && samples.length < 4; c++) {
        if (c === pair.refIdx) continue;
        const v = (refRow[c] ?? '').trim();
        if (v) samples.push(`${referenceSheet.headers[c]?.trim() || `第${c + 1}列`}=${v.slice(0, 30)}`);
      }
      if (samples.length > 0) {
        lines.push(`${pair.name}=${value} → ${samples.join('，')}`);
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

// ==================== 分批（路径 2） ====================

/** 每批行数（方案定稿：每批 100 行） */
export const BATCH_ROWS = 100;

/** 把空缺行号切成批（顺序切分，批内行号升序） */
export function splitBatches(rowIndexes: number[], batchRows: number = BATCH_ROWS): number[][] {
  const batches: number[][] = [];
  for (let i = 0; i < rowIndexes.length; i += batchRows) {
    batches.push(rowIndexes.slice(i, i + batchRows));
  }
  return batches;
}

/** 分批报价文案用的批数计算 */
export function countBatches(rowCount: number, batchRows: number = BATCH_ROWS): number {
  return Math.max(1, Math.ceil(rowCount / batchRows));
}

/**
 * 构造单批的 LLM 输入行文本：每行 "第 N 行：依据列=值，..."（N 为数据行号）。
 * 只给依据列与目标列名，不给全表——省 token 且聚焦推断任务。
 */
export function buildBatchRowsText(
  sheet: SheetData,
  rowIndexes: number[],
  targetColumn: string,
  hintColumns: string[],
): string {
  const targetIdx = findColumn(sheet, targetColumn);
  const basisCols = hintColumns.map((name) => findColumn(sheet, name));
  const basisNames = hintColumns;
  return rowIndexes
    .map((rowIndex) => {
      const row = sheet.rows[rowIndex - 1];
      if (!row) return `第 ${rowIndex} 行：（行不存在）`;
      const parts = basisCols.map((idx, k) => `${basisNames[k]}=${(row[idx] ?? '').trim().slice(0, SAMPLE_CELL_MAX)}`);
      return `第 ${rowIndex} 行：${parts.join('，')}（${targetColumn}为空）`;
    })
    .join('\n');
}

/** 批级校验（方案："批内缺一值则该批整体失败"）：返回缺失的行号清单（空数组 = 通过） */
export function batchFillMissingRows(rowIndexes: number[], output: BatchFillOutput): number[] {
  const filledRows = new Set(output.fills.map((f) => f.row));
  return rowIndexes.filter((r) => !filledRows.has(r));
}

/**
 * 应用单批填充结果到 sheet：返回应用行数。
 * 行号越界（表被并发改动）→ 抛 TableOpsError，由任务编排层把该批判为失败。
 */
export function applyBatchFills(
  sheet: SheetData,
  targetColumn: string,
  fills: BatchFillOutput['fills'],
): number {
  const targetIdx = findColumn(sheet, targetColumn);
  let applied = 0;
  for (const fill of fills) {
    const row = sheet.rows[fill.row - 1];
    if (!row) {
      throw new TableOpsError(`第 ${fill.row} 行不存在（表格可能在任务执行期间被修改）`);
    }
    const value = fill.value.trim();
    if (!value) continue;
    row[targetIdx] = value;
    applied += 1;
  }
  return applied;
}
