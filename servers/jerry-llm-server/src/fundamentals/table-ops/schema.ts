/**
 * fundamentals/table-ops/schema.ts
 *
 * 表格 AI 指令的结构化操作定义（zod）。
 *
 * 分层职责（对应 EXCEL_GRID_EDITOR_PLAN.md M2 第 1 条"AI 表格指令下推"）：
 *   - LLM 只负责把自然语言指令解析为本文件定义的操作序列（不理解数字、不做计算）；
 *   - executor.ts 按操作序列在表格数据上做**代码级精确执行**。
 *
 * 设计约束：
 *   - 每个字段必须 .describe() 中文说明——文案会作为 function calling 的
 *     参数描述直接喂给 LLM，直接影响解析准确率（工程规范 7.1）；
 *   - schema 与类型同源：调用方一律 z.infer 推导，禁止重复 interface；
 *   - 所有写操作都是"值操作"（字符串进、字符串出），不做公式/样式（M1/M2 边界）。
 */

import { z } from 'zod';

/** 行条件比较：deleteRows / updateCells 共用 */
export const RowConditionSchema = z.object({
  /** 条件列的表头名称，必须与表头逐字一致（可从表头清单中选择） */
  column: z.string().describe('条件列的表头名称，必须与表头完全一致'),
  /**
   * 比较方式。数字感知：比较值与单元格都能解析为数字时按数值比较，
   * 否则按字符串比较（gt/lt 对中文按字典序，慎用）
   */
  op: z
    .enum(['eq', 'ne', 'contains', 'gt', 'lt', 'gte', 'lte', 'empty', 'notEmpty'])
    .describe(
      '比较方式：eq 等于 / ne 不等于 / contains 包含 / gt 大于 / lt 小于 / gte 大于等于 / lte 小于等于 / empty 为空 / notEmpty 不为空。empty 与 notEmpty 时忽略 value',
    ),
  /** 比较值（数字列请给纯数字字符串，如 "5000"；empty/notEmpty 时忽略） */
  value: z.string().describe('比较值'),
});

/** 全部操作共有的可选字段：目标工作表（多 sheet 场景指定操作哪张表） */
const TargetSheetField = {
  targetSheet: z
    .string()
    .optional()
    .describe('要操作的工作表名称（从表格概览中选取）；只有一个工作表或未指明时省略'),
};

/** 追加一行：按"列名 → 单元格值"给值（比按列序数组稳，列序可能记错） */
export const AppendRowOpSchema = z.object({
  type: z.literal('appendRow'),
  /** 键为该表已有表头名称，值为单元格内容；未给出的列留空 */
  cells: z.record(z.string(), z.string()).describe('键为表头名称，值为该列单元格内容'),
}).extend(TargetSheetField);

/**
 * 聚合后写入一行（求和/平均/计数/最值）。
 * 支持跨表：从 sourceSheet 聚合，把结果行写入 targetSheet（省略 sourceSheet 时同表）。
 */
export const AggregateAppendRowOpSchema = z.object({
  type: z.literal('aggregateAppendRow'),
  /** 聚合哪一列（数字列，位于来源工作表） */
  column: z.string().describe('要聚合的数字列的表头名称（位于来源工作表）'),
  /** 聚合方式：sum 求和 / avg 平均 / count 计数（非空格数）/ min 最小 / max 最大 */
  fn: z.enum(['sum', 'avg', 'count', 'min', 'max']).describe('聚合方式'),
  /** 结果行的标签文字（如 "重点客户合计"） */
  label: z.string().describe('结果行的标签文字'),
  /** 标签写入哪一列（位于目标工作表，省略时写入第一列） */
  labelColumn: z.string().optional().describe('标签写入的列（位于目标工作表），省略时写入第一列'),
  /** 数值写入哪一列（位于目标工作表；省略时写入与 column 同名的列，找不到则需指定） */
  valueColumn: z
    .string()
    .optional()
    .describe('数值写入的列（位于目标工作表）；省略时写入与 column 同名的列'),
  /** 聚合来源工作表（省略时聚合目标工作表自身） */
  sourceSheet: z
    .string()
    .optional()
    .describe('聚合数据来源的工作表名称；跨表聚合时必填，省略时聚合目标工作表自身'),
  /** 聚合前对来源行做条件过滤 */
  where: RowConditionSchema.optional().describe(
    '聚合前的行过滤条件（如只统计某类客户）；省略时统计全部行',
  ),
  /** 插入位置锚点：新行插到目标表中第一列文字等于该值的行之前（如"总计"）；省略时追加到末尾 */
  beforeRow: z
    .string()
    .optional()
    .describe('插入位置：目标工作表中某行第一列的文字（如"总计"），新行插到该行之前；省略时追加到表末尾'),
}).extend(TargetSheetField);

/**
 * 聚合结果写入已有单元格（用于"重算总计/合计"行）。
 * 省略 sourceSheet 时聚合同表目标行上方的所有行（典型重算语义）；指定时从其他表聚合。
 */
export const AggregateUpdateCellOpSchema = z.object({
  type: z.literal('aggregateUpdateCell'),
  /** 要更新的行：目标表中某行第一列（或标签列）文字等于/包含该值，如"总计" */
  rowLabel: z
    .string()
    .describe('要更新的行的标签文字（如"总计"），按第一列文字匹配该行'),
  /** 标签所在列（省略时用第一列） */
  labelColumn: z.string().optional().describe('行标签所在的列，省略时用第一列'),
  /** 写入聚合结果的列（位于目标工作表） */
  column: z.string().describe('要写入聚合结果的列的表头名称（位于目标工作表）'),
  /** 聚合来源工作表（省略时聚合同表目标行上方的所有行） */
  sourceSheet: z
    .string()
    .optional()
    .describe('聚合数据来源的工作表；重算同表合计时省略（聚合同列上方所有行）'),
  /** 来源工作表中要聚合的列（省略时使用与 column 同名的列） */
  sourceColumn: z.string().optional().describe('来源工作表中要聚合的列，省略时与 column 同名'),
  /** 聚合前对来源行做条件过滤（仅指定 sourceSheet 时有效） */
  where: RowConditionSchema.optional().describe('聚合前的行过滤条件，仅指定 sourceSheet 时有效'),
  /** 聚合方式：sum 求和 / avg 平均 / count 计数 / min 最小 / max 最大 */
  fn: z.enum(['sum', 'avg', 'count', 'min', 'max']).describe('聚合方式'),
}).extend(TargetSheetField);

/** 条件更新单元格：匹配到的行的目标列改为新值 */
export const UpdateCellsOpSchema = z.object({
  type: z.literal('updateCells'),
  /** 要改写的目标列表头名称 */
  targetColumn: z.string().describe('要改写的目标列的表头名称'),
  /** 行匹配条件；省略时更新全部行 */
  where: RowConditionSchema.optional().describe('行匹配条件，省略时更新全部行'),
  /** 新值（覆盖写入） */
  newValue: z.string().describe('写入的新值'),
}).extend(TargetSheetField);

/** 条件删行 */
export const DeleteRowsOpSchema = z.object({
  type: z.literal('deleteRows'),
  /** 满足条件的行删除 */
  where: RowConditionSchema.describe('删除条件'),
}).extend(TargetSheetField);

/** 删除整列 */
export const DeleteColumnOpSchema = z.object({
  type: z.literal('deleteColumn'),
  /** 要删除的列的表头名称 */
  column: z.string().describe('要删除的列的表头名称'),
}).extend(TargetSheetField);

/** 新增列（可全列填固定值） */
export const AddColumnOpSchema = z.object({
  type: z.literal('addColumn'),
  /** 新列的表头名称 */
  header: z.string().describe('新列的表头名称'),
  /** 全列统一填充的固定值；省略则数据行留空 */
  value: z.string().optional().describe('全列统一填充的固定值，省略则留空'),
}).extend(TargetSheetField);

/** 排序（数字感知：整列可解析为数字时按数值排，否则按字符串排） */
export const SortRowsOpSchema = z.object({
  type: z.literal('sortRows'),
  /** 排序列的表头名称 */
  column: z.string().describe('排序依据列的表头名称'),
  /** asc 升序 / desc 降序 */
  order: z.enum(['asc', 'desc']).describe('asc 升序 / desc 降序'),
}).extend(TargetSheetField);

/** 表头重命名 */
export const RenameColumnOpSchema = z.object({
  type: z.literal('renameColumn'),
  /** 原表头名称 */
  from: z.string().describe('原表头名称'),
  /** 新表头名称 */
  to: z.string().describe('新表头名称'),
}).extend(TargetSheetField);

/** 全部支持的操作（discriminatedUnion：按 type 字段分发校验） */
export const TableOpSchema = z.discriminatedUnion('type', [
  AppendRowOpSchema,
  AggregateAppendRowOpSchema,
  AggregateUpdateCellOpSchema,
  UpdateCellsOpSchema,
  DeleteRowsOpSchema,
  DeleteColumnOpSchema,
  AddColumnOpSchema,
  SortRowsOpSchema,
  RenameColumnOpSchema,
]);
export type TableOp = z.infer<typeof TableOpSchema>;

/** LLM 产出的完整计划：一次指令可包含多个顺序执行的操作 */
export const TableOpsPlanSchema = z.object({
  ops: z
    .array(TableOpSchema)
    .max(10)
    .describe('按执行顺序排列的操作列表；一条指令拆解为 1~10 个操作，无法理解时给空数组'),
});
export type TableOpsPlan = z.infer<typeof TableOpsPlanSchema>;

/** 单个操作的执行报告（前端展示给用户确认用） */
export interface OpReport {
  type: TableOp['type'];
  /** 操作的目标 sheet 名称 */
  targetSheet: string;
  /** 中文执行结果说明（如"已删除 12 行""求和结果 41400 已追加到第 8 行"） */
  message: string;
}

// ==================== Zod Schema ====================
// （本文件整体即 schema 定义区，类型与 schema 同源导出）
