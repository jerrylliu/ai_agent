/**
 * fundamentals/table-ops/rules.ts
 *
 * 表格规则引擎（功能 5"表格的 ESLint"）：schema 定义 + 检查 + 修复 + 列级统计。
 *
 * 设计约束（对应方案）：
 *   - 5 类规则全部"精确可执行"：非空 / 取值白名单 / 数值范围 / 唯一性 / 跨列公式；
 *   - 检查 = 纯函数干跑（不改文本），产出违规行清单；修复 = 用户确认后按
 *     修复动作（固定值 / 公式 / 删除该行）批量应用，未配修复动作的规则只标记；
 *   - 规则绑列名：列被改头/删列后该规则判"失效"（invalidRules），面板标红处理，
 *     绝不静默失灵；
 *   - 跨列公式复用功能 2 的表达式求值器（executor.ts），浮点比较带 0.01 容差；
 *   - AI 指令接入：执行计划先跑出最终态 → 规则统一全查（不在中间态逐操作查，
 *     避免临时违规误报）→ 全过才应用，违规整体拒绝。
 *
 * 复用 executor.ts 内部解析工具（parseSheetData 等）——同模块族内共享，
 * 在 executor.ts 中显式导出，避免复制解析逻辑造成双轨漂移。
 */

import { z } from 'zod';
import {
  TableOpsError,
  collectExpressionColumnRefs,
  evaluateSheetExpression,
  findColumn,
  formatExpressionNumber,
  parseLooseNumber,
  parseSheetData,
  serializeSheetData,
  type SheetData,
} from './executor.js';

// ==================== Zod Schema（规则定义） ====================

/** 非空：校验列内空单元格 */
export const NotEmptyParamsSchema = z.object({
  column: z.string().min(1).max(200).describe('不能留空的列名'),
});

/** 取值白名单：空值跳过（空值归"非空"规则管），不在白名单内即违规 */
export const AllowedValuesParamsSchema = z.object({
  column: z.string().min(1).max(200).describe('受约束的列名'),
  values: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(50)
    .describe('允许的取值列表'),
});

/** 数值范围：空值跳过；非数字或越界即违规（数字感知，与执行器同一解析口径） */
export const NumericRangeParamsSchema = z.object({
  column: z.string().min(1).max(200).describe('受约束的数字列名'),
  min: z.number().optional().describe('允许的最小值（含）；省略不设下限'),
  max: z.number().optional().describe('允许的最大值（含）；省略不设上限'),
});

/** 唯一性：列内去重比对，重复出现（首次除外）即违规 */
export const UniqueParamsSchema = z.object({
  column: z.string().min(1).max(200).describe('不能重复的列名'),
});

/** 跨列公式：目标列应等于表达式结果（复用功能 2 求值器，统计成立率） */
export const FormulaParamsSchema = z.object({
  targetColumn: z.string().min(1).max(200).describe('结果列名（如"销售额"）'),
  expression: z
    .string()
    .min(1)
    .max(500)
    .describe('表达式：用 [列名] 引用其他列，支持数字和 + - * / ( )，如 "[数量]*[单价]"'),
});

/** 修复动作：违规行的处理方式；未配置 = 只标记不修复 */
export const FixActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixedValue'),
    value: z.string().max(500).describe('违规单元格统一改写为该固定值'),
  }),
  z.object({
    kind: z.literal('formula'),
    expression: z
      .string()
      .min(1)
      .max(500)
      .describe('按表达式逐行重算违规单元格，如 "[数量]*[单价]"；无法计算的行跳过'),
  }),
  z.object({
    kind: z.literal('deleteRow').describe('删除违规行'),
  }),
]);

/** 单条规则（type + params 联动校验；API 入参与 AI 提议输出共用） */
export const NotEmptyRuleSchema = z.object({
  name: z.string().min(1).max(200).describe('规则名（如"区域不能留空"）'),
  type: z.literal('notEmpty'),
  params: NotEmptyParamsSchema,
  fixAction: FixActionSchema.optional().describe('可选修复动作；省略则只标记不修复'),
});
export const AllowedValuesRuleSchema = z.object({
  name: z.string().min(1).max(200).describe('规则名'),
  type: z.literal('allowedValues'),
  params: AllowedValuesParamsSchema,
  fixAction: FixActionSchema.optional().describe('可选修复动作；省略则只标记不修复'),
});
export const NumericRangeRuleSchema = z.object({
  name: z.string().min(1).max(200).describe('规则名'),
  type: z.literal('numericRange'),
  params: NumericRangeParamsSchema,
  fixAction: FixActionSchema.optional().describe('可选修复动作；省略则只标记不修复'),
});
export const UniqueRuleSchema = z.object({
  name: z.string().min(1).max(200).describe('规则名'),
  type: z.literal('unique'),
  params: UniqueParamsSchema,
  fixAction: FixActionSchema.optional().describe('可选修复动作；省略则只标记不修复'),
});
export const FormulaRuleSchema = z.object({
  name: z.string().min(1).max(200).describe('规则名'),
  type: z.literal('formula'),
  params: FormulaParamsSchema,
  fixAction: FixActionSchema.optional().describe('可选修复动作；省略则只标记不修复'),
});

/** 规则定义总 schema（discriminatedUnion：按 type 分发校验 params 形状） */
export const TableRuleSchema = z.discriminatedUnion('type', [
  NotEmptyRuleSchema,
  AllowedValuesRuleSchema,
  NumericRangeRuleSchema,
  UniqueRuleSchema,
  FormulaRuleSchema,
]);
export type TableRuleInput = z.infer<typeof TableRuleSchema>;
export type FixAction = z.infer<typeof FixActionSchema>;

/**
 * 运行时规则（从数据库加载并解析后的形态，带稳定 id 供报告引用）。
 * 直接复用 TableRuleInput（discriminatedUnion）：switch(rule.type) 才能正确
 * 窄化 params / fixAction 的具体形状，拆开字段会丢失类型关联。
 */
export type TableRuleRuntime = TableRuleInput & { id: number };

// ==================== 检查引擎 ====================

/** 单条违规记录（前端违规清单 + 修复入参共用） */
export interface RuleViolation {
  /** 违反的规则 ID */
  ruleId: number;
  ruleName: string;
  ruleType: TableRuleInput['type'];
  /** 数据行号（1 起，不含表头行），与编辑器"第 N 行"展示口径一致 */
  rowIndex: number;
  /** 违规列名 */
  column: string;
  /** 当前单元格内容（截断展示） */
  currentValue: string;
  /** 期望说明（如"应为 重点客户/普通客户 之一"） */
  expectation: string;
  /** 该规则是否配置了修复动作 */
  fixable: boolean;
}

/** 失效规则：绑定的列/表达式引用列在表中不存在（面板标红提示处理） */
export interface InvalidRuleInfo {
  ruleId: number;
  ruleName: string;
  reason: string;
}

/** 检查结果（干跑，纯只读） */
export interface RuleCheckResult {
  /** 实际完成检查的规则数（失效规则不计入） */
  checkedRules: number;
  violations: RuleViolation[];
  invalidRules: InvalidRuleInfo[];
  /** 违规清单是否因超出展示上限被截断 */
  truncated: boolean;
}

/** 违规展示上限：万级大表可能整列违规，防报告/前端列表爆炸 */
const MAX_VIOLATIONS = 1000;

/** 浮点比较容差（"销售额 = 数量×单价"这类公式校验用） */
const FORMULA_TOLERANCE = 0.01;

/** 单列在当前表中的定位结果：存在 → 列号；不存在 → 抛 TableOpsError（转失效） */
function resolveColumnOrInvalid(sheet: SheetData, column: string): number {
  return findColumn(sheet, column);
}

/** 数值范围的期望文案 */
function numericRangeExpectation(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) return `应为 ${min} ~ ${max} 之间的数字`;
  if (min !== undefined) return `应为 ≥ ${min} 的数字`;
  if (max !== undefined) return `应为 ≤ ${max} 的数字`;
  return '应为数字';
}

/**
 * 对 sheet 文本执行全部规则检查（干跑，不改文本）。
 *
 * 规则绑列失效（列不存在/公式引用列不存在/表达式语法错误）时不中断整体检查，
 * 归入 invalidRules 交给面板标红处理——这正是方案要求的"改表头/删列后规则
 * 状态机转为失效，标红提示处理，不静默失灵"。
 */
export function checkRules(text: string, rules: TableRuleRuntime[]): RuleCheckResult {
  const sheets = parseSheetData(text);
  const violations: RuleViolation[] = [];
  const invalidRules: InvalidRuleInfo[] = [];
  let checkedRules = 0;
  let truncated = false;

  for (const rule of rules) {
    if (violations.length >= MAX_VIOLATIONS) {
      truncated = true;
      break;
    }
    // 规则作用于哪张表：规则定义当前不绑 sheet 名，作用于第一个工作表
    // （多 sheet 绑定留待后续扩展；编辑器场景主表即第一个 sheet）
    const sheet = sheets[0];
    if (!sheet) break;

    try {
      const res = checkSingleRule(sheet, rule, violations);
      checkedRules += 1;
      // 有违规被丢弃 = 清单不完整，必须标记截断（用户不得误以为清单完整）
      if (res.dropped > 0) truncated = true;
    } catch (err) {
      // 列不存在 / 表达式语法错误 / 引用列缺失 → 规则失效（不静默跳过）
      invalidRules.push({
        ruleId: rule.id,
        ruleName: rule.name,
        reason: err instanceof TableOpsError ? err.message : String(err),
      });
    }
  }

  return { checkedRules, violations, invalidRules, truncated };
}

/** 单条规则检查：向 violations 追加违规记录；列定位失败抛 TableOpsError（调用方转失效）。
 * 返回 count（实际记录的违规数）与 dropped（因达到展示上限被丢弃的违规数，>0 即截断） */
function checkSingleRule(
  sheet: SheetData,
  rule: TableRuleRuntime,
  violations: RuleViolation[],
): { count: number; dropped: number } {
  let count = 0;
  let dropped = 0;
  const push = (rowIndex: number, colIdx: number, expectation: string): void => {
    if (violations.length >= MAX_VIOLATIONS) {
      dropped += 1;
      return;
    }
    violations.push({
      ruleId: rule.id,
      ruleName: rule.name,
      ruleType: rule.type,
      rowIndex,
      column: sheet.headers[colIdx]?.trim() || `第${colIdx + 1}列`,
      currentValue: (sheet.rows[rowIndex - 1]?.[colIdx] ?? '').slice(0, 100),
      expectation,
      fixable: rule.fixAction !== undefined,
    });
    count += 1;
  };

  switch (rule.type) {
    case 'notEmpty': {
      const colIdx = resolveColumnOrInvalid(sheet, rule.params.column);
      sheet.rows.forEach((row, i) => {
        if ((row[colIdx] ?? '').trim() === '') push(i + 1, colIdx, '不能留空');
      });
      break;
    }
    case 'allowedValues': {
      const colIdx = resolveColumnOrInvalid(sheet, rule.params.column);
      const allowed = rule.params.values;
      sheet.rows.forEach((row, i) => {
        const cell = (row[colIdx] ?? '').trim();
        // 空值跳过：空值是否允许由"非空"规则独立管理，避免一条规则两头管
        if (!cell) return;
        if (!allowed.includes(cell)) {
          push(i + 1, colIdx, `应为 ${allowed.slice(0, 5).join('/')}${allowed.length > 5 ? ' 等' : ''} 之一`);
        }
      });
      break;
    }
    case 'numericRange': {
      const colIdx = resolveColumnOrInvalid(sheet, rule.params.column);
      const { min, max } = rule.params;
      sheet.rows.forEach((row, i) => {
        const cell = (row[colIdx] ?? '').trim();
        if (!cell) return; // 空值跳过（归非空规则管）
        const n = parseLooseNumber(cell);
        if (n === null) {
          push(i + 1, colIdx, `${numericRangeExpectation(min, max)}（当前" ${cell} "不是数字）`);
          return;
        }
        if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
          push(i + 1, colIdx, `${numericRangeExpectation(min, max)}（当前 ${n}）`);
        }
      });
      break;
    }
    case 'unique': {
      const colIdx = resolveColumnOrInvalid(sheet, rule.params.column);
      const firstSeen = new Map<string, number>();
      sheet.rows.forEach((row, i) => {
        const cell = (row[colIdx] ?? '').trim();
        if (!cell) return; // 空值不参与唯一性比对（空不等于重复）
        const first = firstSeen.get(cell);
        if (first === undefined) {
          firstSeen.set(cell, i + 1);
        } else {
          push(i + 1, colIdx, `与第 ${first} 行重复，应唯一`);
        }
      });
      break;
    }
    case 'formula': {
      const targetColIdx = resolveColumnOrInvalid(sheet, rule.params.targetColumn);
      // 表达式编译 + 引用列定位提前到检查期：语法错误/引用缺失在这里转失效
      const refs = collectExpressionColumnRefs(rule.params.expression);
      const refColIdx = refs.map((name) => resolveColumnOrInvalid(sheet, name));
      sheet.rows.forEach((row, i) => {
        const expected = evaluateSheetExpression(rule.params.expression, (name) => {
          const idx = refColIdx[refs.indexOf(name)] ?? -1;
          return idx >= 0 ? parseLooseNumber(row[idx] ?? '') : null;
        });
        // 表达式无法计算（引用列非数字/除零）→ 跳过该行，不误报
        if (expected === null) return;
        const actualCell = (row[targetColIdx] ?? '').trim();
        const actual = parseLooseNumber(actualCell);
        if (actual === null) {
          push(i + 1, targetColIdx, `应满足 ${rule.params.targetColumn} = ${rule.params.expression}（约为 ${formatExpressionNumber(expected)}），当前"${actualCell}"不是数字`);
          return;
        }
        if (Math.abs(actual - expected) > FORMULA_TOLERANCE) {
          push(i + 1, targetColIdx, `应满足 ${rule.params.targetColumn} = ${rule.params.expression}（本行应约为 ${formatExpressionNumber(expected)}，当前 ${formatExpressionNumber(actual)}）`);
        }
      });
      break;
    }
  }
  return { count, dropped };
}

// ==================== 修复引擎 ====================

/** 单条规则的修复报告 */
export interface RuleFixReportItem {
  ruleId: number;
  ruleName: string;
  message: string;
}

export interface RuleFixResult {
  /** 修复后的完整 sheet 文本 */
  sheetText: string;
  report: RuleFixReportItem[];
}

/**
 * 按违规清单批量应用修复动作（用户在面板确认后才调用）。
 *
 * 行号安全设计：
 *   - 单元格改写类修复（固定值/公式）不改变行数，可按检查时的行号直接改；
 *   - 删行类修复统一放最后，按行号从大到小删除，避免前面的删除使后面失效。
 *   - 多条规则的违规清单都来自同一次检查快照，行号基准一致。
 */
export function applyRuleFixes(
  text: string,
  rules: TableRuleRuntime[],
  violations: RuleViolation[],
): RuleFixResult {
  const sheets = parseSheetData(text);
  const sheet = sheets[0];
  if (!sheet) {
    return { sheetText: text, report: [] };
  }
  const report: RuleFixReportItem[] = [];
  const deleteRowIndexes = new Set<number>();

  // 按规则分组违规（保持规则顺序）
  const byRule = new Map<number, RuleViolation[]>();
  for (const v of violations) {
    const list = byRule.get(v.ruleId) ?? [];
    list.push(v);
    byRule.set(v.ruleId, list);
  }

  for (const rule of rules) {
    const ruleViolations = byRule.get(rule.id);
    if (!ruleViolations || ruleViolations.length === 0) continue;
    if (!rule.fixAction) {
      report.push({ ruleId: rule.id, ruleName: rule.name, message: '未配置修复动作，已跳过（只标记）' });
      continue;
    }
    try {
      if (rule.fixAction.kind === 'deleteRow') {
        for (const v of ruleViolations) deleteRowIndexes.add(v.rowIndex);
        report.push({
          ruleId: rule.id,
          ruleName: rule.name,
          message: `将删除 ${ruleViolations.length} 行`,
        });
        continue;
      }

      // 改写类修复的目标列：notEmpty/allowedValues/numericRange/unique → params.column；
      // formula → params.targetColumn
      const targetColumnName =
        rule.type === 'formula' ? rule.params.targetColumn : rule.params.column;
      const colIdx = findColumn(sheet, targetColumnName);

      if (rule.fixAction.kind === 'fixedValue') {
        for (const v of ruleViolations) {
          const row = sheet.rows[v.rowIndex - 1];
          if (!row) continue;
          while (row.length <= colIdx) row.push('');
          row[colIdx] = rule.fixAction.value;
        }
        report.push({
          ruleId: rule.id,
          ruleName: rule.name,
          message: `已将 ${ruleViolations.length} 个违规单元格改为固定值"${rule.fixAction.value}"`,
        });
      } else {
        // formula 修复：逐行重算，无法计算的行跳过（数据不丢、不填错值）
        const refs = collectExpressionColumnRefs(rule.fixAction.expression);
        const refColIdx = refs.map((name) => findColumn(sheet, name));
        let applied = 0;
        let skipped = 0;
        for (const v of ruleViolations) {
          const row = sheet.rows[v.rowIndex - 1];
          if (!row) continue;
          const result = evaluateSheetExpression(rule.fixAction.expression, (name) => {
            const idx = refColIdx[refs.indexOf(name)] ?? -1;
            return idx >= 0 ? parseLooseNumber(row[idx] ?? '') : null;
          });
          if (result === null) {
            skipped += 1;
            continue;
          }
          while (row.length <= colIdx) row.push('');
          row[colIdx] = formatExpressionNumber(result);
          applied += 1;
        }
        report.push({
          ruleId: rule.id,
          ruleName: rule.name,
          message: skipped > 0
            ? `已按表达式重算 ${applied} 行（${skipped} 行无法计算已跳过）`
            : `已按表达式重算 ${applied} 行`,
        });
      }
    } catch (err) {
      // 修复期列定位失败（检查后表又被改了）：报告原因，不中断其他规则
      report.push({
        ruleId: rule.id,
        ruleName: rule.name,
        message: `修复失败：${err instanceof TableOpsError ? err.message : String(err)}`,
      });
    }
  }

  // 删行类修复统一最后执行：行号从大到小删除，避免索引位移
  if (deleteRowIndexes.size > 0) {
    const sorted = [...deleteRowIndexes].sort((a, b) => b - a);
    for (const rowIndex of sorted) {
      sheet.rows.splice(rowIndex - 1, 1);
    }
  }

  return { sheetText: serializeSheetData(sheets), report };
}

// ==================== 列级统计（AI 提议规则的原料） ====================

/** 单列统计（提议规则的依据：空值率、去重值、数值分布） */
export interface ColumnStats {
  column: string;
  /** 数据行数（不含表头） */
  totalRows: number;
  emptyCount: number;
  /** 去重值样本（≤10 个，每个截断 30 字符） */
  distinctValues: string[];
  /** 全表去重总数（distinctValues 只是样本） */
  distinctCount: number;
  /** 可解析为数字的单元格数 */
  numericCount: number;
  numericMin?: number;
  numericMax?: number;
}

/** 单工作表统计 */
export interface SheetColumnStats {
  sheetName: string;
  columns: ColumnStats[];
}

/**
 * 构建列级统计（纯只读）。AI 提议规则前先看统计——
 * "空值率高 → 提议非空规则 / 去重值少 → 提议白名单 / 数值分布 → 提议范围 / 列间强相关 → 提议公式"。
 */
export function buildColumnStats(text: string): SheetColumnStats[] {
  const sheets = parseSheetData(text);
  return sheets.map((sheet) => {
    const colCount = Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length), 0);
    const columns: ColumnStats[] = [];
    for (let c = 0; c < colCount; c++) {
      const column = sheet.headers[c]?.trim() || `第${c + 1}列`;
      const seen = new Map<string, number>();
      let emptyCount = 0;
      let numericCount = 0;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const row of sheet.rows) {
        const raw = (row[c] ?? '').trim();
        if (!raw) {
          emptyCount += 1;
          continue;
        }
        seen.set(raw, (seen.get(raw) ?? 0) + 1);
        const n = parseLooseNumber(raw);
        if (n !== null) {
          numericCount += 1;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
      const distinctValues = [...seen.keys()]
        .sort((a, b) => (seen.get(b) ?? 0) - (seen.get(a) ?? 0))
        .slice(0, 10)
        .map((v) => v.slice(0, 30));
      columns.push({
        column,
        totalRows: sheet.rows.length,
        emptyCount,
        distinctValues,
        distinctCount: seen.size,
        numericCount,
        numericMin: numericCount > 0 ? min : undefined,
        numericMax: numericCount > 0 ? max : undefined,
      });
    }
    return { sheetName: sheet.name || '(未命名)', columns };
  });
}

/** 供 suggest 层把统计转成紧凑文本（省 token） */
export function columnStatsToOverview(stats: SheetColumnStats[]): string {
  return stats
    .map((sheet) => {
      const lines = [`工作表「${sheet.sheetName}」：`];
      for (const col of sheet.columns) {
        const parts = [`共 ${col.totalRows} 行`, `空 ${col.emptyCount}`, `去重 ${col.distinctCount}`];
        if (col.numericCount > 0) {
          parts.push(`数字 ${col.numericCount} 个（${formatExpressionNumber(col.numericMin ?? 0)} ~ ${formatExpressionNumber(col.numericMax ?? 0)}）`);
        }
        lines.push(`- ${col.column}：${parts.join('，')}${col.distinctValues.length > 0 && col.distinctCount <= 20 ? `；取值：${col.distinctValues.join('/')}` : ''}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * 规则门禁拒绝时的违规聚合文案（按规则分组：规则名 + 违规数 + 前 3 个行号样本）。
 * 表格指令门禁（table-ops.service）与语义填充任务门禁（semantic-fill.service）共用，
 * 保证两处对用户的说法一致。
 */
export function formatViolationsByRule(check: RuleCheckResult): string {
  const byRule = new Map<number, { name: string; rows: number[] }>();
  for (const v of check.violations) {
    const entry = byRule.get(v.ruleId) ?? { name: v.ruleName, rows: [] };
    if (entry.rows.length < 3) entry.rows.push(v.rowIndex);
    byRule.set(v.ruleId, entry);
  }
  return [...byRule.values()]
    .map((e) => `「${e.name}」${e.rows.length} 处（如第 ${e.rows.join('、')} 行）`)
    .join('；');
}

/**
 * 把数据库行解析为运行时规则。
 *
 * 读取侧兜底：paramsJson / fixActionJson 解析失败或 zod 校验不过（历史脏数据、
 * schema 演进）返回 null，调用方跳过该条并计入"失效规则"，绝不抛错中断检查。
 */
export function parseTableRuleJson(
  id: number,
  name: string,
  type: string,
  paramsJson: string,
  fixActionJson: string | null,
): TableRuleRuntime | null {
  try {
    const parsed = TableRuleSchema.safeParse({
      name,
      type,
      params: paramsJson ? JSON.parse(paramsJson) : {},
      ...(fixActionJson ? { fixAction: JSON.parse(fixActionJson) } : {}),
    });
    if (!parsed.success) return null;
    return { id, ...parsed.data };
  } catch {
    return null;
  }
}
