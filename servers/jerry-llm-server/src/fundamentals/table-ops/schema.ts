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
export const RowConditionSchema = z
  .object({
    /** 条件列的表头名称，必须与表头逐字一致（可从表头清单中选择） */
    column: z.string().describe('条件列的表头名称，必须与表头完全一致'),
    /**
     * 比较方式。数字感知：比较值与单元格都能解析为数字时按数值比较，
     * 否则按字符串比较（gt/lt 对中文按字典序，慎用）
     */
    op: z
      .enum(['eq', 'ne', 'contains', 'gt', 'lt', 'gte', 'lte', 'empty', 'notEmpty'])
      .describe(
        '比较方式：eq 等于 / ne 不等于 / contains 包含 / gt 大于 / lt 小于 / gte 大于等于 / lte 小于等于 / empty 为空 / notEmpty 不为空。empty 与 notEmpty 时省略 value',
      ),
    /** 比较值（比较类 op 必填；empty/notEmpty 省略。数字列请给纯数字字符串，如 "5000"） */
    value: z
      .string()
      .optional()
      .describe('比较值（eq/ne/contains/gt/lt/gte/lte 必填；empty/notEmpty 省略本字段）'),
  })
  .superRefine((cond, ctx) => {
    // 比较类条件必须带比较值——机器强制（empty/notEmpty 不需要）。
    // 之前 value 无条件必填，与描述"empty/notEmpty 时忽略 value"自相矛盾，
    // LLM 照描述省略 value 反而整体校验失败；现在语义与类型一致
    if (
      cond.op !== 'empty' &&
      cond.op !== 'notEmpty' &&
      (cond.value === undefined || cond.value.trim() === '')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `比较方式 ${cond.op} 必须提供 value`,
      });
    }
  });

/**
 * 条件组合（多条件 AND/OR）：功能 3。
 * deleteRows / updateCells / aggregate 系的 where 字段既可给单个条件（RowConditionSchema，
 * 向后兼容），也可给一个组合（conditions 数组 + mode 组合方式）。
 */
export const ConditionGroupSchema = z.object({
  /** 组合方式：and 全部满足 / or 满足其一 */
  mode: z.enum(['and', 'or']).describe('组合方式：and 所有条件都满足 / or 任一条件满足'),
  /** 条件列表（1~5 个），每个条件结构与单条件相同 */
  conditions: z
    .array(RowConditionSchema)
    .min(1)
    .max(5)
    .describe('条件列表，每项为 {column, op, value}'),
});

/** where 子句：单条件或多条件组合的二选一（zod union，按字段形状区分） */
export const WhereClauseSchema = z.union([RowConditionSchema, ConditionGroupSchema]);
export type RowCondition = z.infer<typeof RowConditionSchema>;
export type ConditionGroup = z.infer<typeof ConditionGroupSchema>;
export type WhereClause = z.infer<typeof WhereClauseSchema>;

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
  /** 聚合前对来源行做条件过滤（单条件或多条件 and/or 组合） */
  where: WhereClauseSchema.optional().describe(
    '聚合前的行过滤条件（如只统计某类客户）；省略时统计全部行',
  ),
  /** 插入位置锚点：新行插到目标表中 labelColumn 列（省略时第一列）文字等于该值的行之前（如"总计"）；省略时追加到末尾 */
  beforeRow: z
    .string()
    .optional()
    .describe('插入位置：目标工作表中某行（labelColumn 列，省略时第一列）的文字（如"总计"），新行插到该行之前；省略时追加到表末尾'),
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
  /** 聚合前对来源行做条件过滤（仅指定 sourceSheet 时有效；单条件或多条件组合） */
  where: WhereClauseSchema.optional().describe('聚合前的行过滤条件，仅指定 sourceSheet 时有效'),
  /** 聚合方式：sum 求和 / avg 平均 / count 计数 / min 最小 / max 最大 */
  fn: z.enum(['sum', 'avg', 'count', 'min', 'max']).describe('聚合方式'),
}).extend(TargetSheetField);

/** 条件更新单元格：匹配到的行的目标列改为新值 */
export const UpdateCellsOpSchema = z.object({
  type: z.literal('updateCells'),
  /** 要改写的目标列表头名称 */
  targetColumn: z.string().describe('要改写的目标列的表头名称'),
  /** 行匹配条件（单条件或多条件 and/or 组合）；省略时更新全部行 */
  where: WhereClauseSchema.optional().describe('行匹配条件，省略时更新全部行'),
  /** 新值（覆盖写入） */
  newValue: z.string().describe('写入的新值'),
}).extend(TargetSheetField);

/** 条件删行 */
export const DeleteRowsOpSchema = z.object({
  type: z.literal('deleteRows'),
  /** 满足条件的行删除（单条件或多条件 and/or 组合） */
  where: WhereClauseSchema.describe('删除条件'),
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

/**
 * 分组建表（功能 1）：按某列分组统计另一列，结果生成一张新工作表。
 * 如"把所有销售员的销售额按人统计，做成一张新表"。
 */
export const GroupCreateSheetOpSchema = z.object({
  type: z.literal('groupCreateSheet'),
  /** 数据来源工作表（省略时用第一个工作表） */
  sourceSheet: z
    .string()
    .optional()
    .describe('数据来源的工作表名称；省略时用第一个工作表'),
  /** 分组列（位于来源工作表），每个不同取值生成结果表的一行 */
  groupBy: z.string().describe('分组依据列的表头名称（位于来源工作表）'),
  /** 要统计的数字列（位于来源工作表） */
  valueColumn: z.string().describe('要统计的数字列的表头名称（位于来源工作表）'),
  /** 聚合方式：sum 求和 / avg 平均 / count 计数 / min 最小 / max 最大 */
  fn: z.enum(['sum', 'avg', 'count', 'min', 'max']).describe('聚合方式'),
  /** 结果表中数值列的列名（如"销售额合计"）；省略时用统计列原名 */
  resultLabel: z
    .string()
    .optional()
    .describe('结果表中数值列的列名（如"销售额合计"），省略时用统计列原名'),
  /** 新建工作表的名称（不可与现有工作表重名，重名则整表重建） */
  newSheetName: z.string().describe('新建工作表的名称'),
  /** 统计前对来源行做条件过滤（单条件或多条件组合）；省略时统计全部行 */
  where: WhereClauseSchema.optional().describe('统计前的行过滤条件，省略时统计全部行'),
});

/**
 * 公式补数（功能 2）：用表达式逐行计算写入目标列。
 * 如"销售额为空的行按 数量×单价 补上"→ expression="[数量]*[单价]"，where 限定销售额为空。
 */
export const DeriveColumnOpSchema = z.object({
  type: z.literal('deriveColumn'),
  /** 结果写入列：列已存在时只覆写满足条件的行（其余行保留原值），不存在时先新增该列 */
  targetColumn: z.string().describe('计算结果写入的列；列已存在时只覆写匹配行，不存在时新增该列'),
  /** 计算表达式：用 [列名] 引用列，支持 + - * / ( ) 和数字，如 "[数量]*[单价]+[运费]" */
  expression: z
    .string()
    .describe(
      '计算表达式：用 [列名] 引用其他列，支持数字和 + - * / ( ) 运算，例如 "[数量]*[单价]"',
    ),
  /** 只计算满足条件的行（单条件或多条件组合）；省略时计算全部行 */
  where: WhereClauseSchema.optional().describe('只计算满足条件的行，省略时计算全部行'),
}).extend(TargetSheetField);

/**
 * 跨表关联填充：按关联键从源表精确查值，填充目标列空格。
 * VLOOKUP 语义的确定性执行：键精确匹配（trim 后相等）、未命中留空、不覆盖非空格、
 * 跳过已声明汇总行——绝不发明值。
 * 两个来源：① clarify 协议确认后的 cross-sheet-lookup 策略编译产物；
 * ② ReAct 中 LLM 直接输出（完备性闸门会校验关联键——键缺失或重合率过低时
 * 自动转用户确认，不会瞎填，因此 LLM 可以放心给出最有把握的键）。
 */
export const LookupFillOpSchema = z.object({
  type: z.literal('lookupFill'),
  /** 要填充的目标列表头名称（该列存在空缺；不存在时先由 addColumn 创建） */
  targetColumn: z.string().describe('要填充的目标列的表头名称'),
  /** 关联数据来源工作表名称 */
  sourceSheet: z.string().describe('关联数据来源的工作表名称'),
  /** 来源表中作为关联键的列（复合键 keyMappings 给出时可省略；两者都缺时执行器报缺关联键） */
  sourceKeyColumn: z.string().optional().describe('来源表中作为关联键的列的表头名称'),
  /** 来源表中要取值填充的列 */
  sourceValueColumn: z.string().describe('来源表中要取值的列的表头名称'),
  /** 目标表中作为关联键的列（单键场景省略时由编译器按同名/候选确定） */
  targetKeyColumn: z.string().optional().describe('目标表中作为关联键的列的表头名称'),
  /** 复合键（v1 UI 手动多选场景）：给出时覆盖单键参数 */
  keyMappings: z
    .array(
      z.object({
        targetKeyColumn: z.string().describe('目标表键列'),
        sourceKeyColumn: z.string().describe('来源表键列'),
      }),
    )
    .max(5)
    .optional()
    .describe('复合键映射列表（目标表键列 ↔ 来源表键列），单键场景省略'),
}).extend(TargetSheetField);

/**
 * 常量填充（clarify 协议配套 op）：只填目标列的空格（明细行），跳过声明汇总行、
 * 不覆盖非空格。独立于 updateCells——updateCells 是显式条件语义（可命中汇总行），
 * 本操作是填充语义（与 semanticFill/lookupFill 同契约），两者严格分离勿合并。
 */
export const FillConstantOpSchema = z.object({
  type: z.literal('fillConstant'),
  /** 要填充的目标列表头名称 */
  targetColumn: z.string().describe('要填充的目标列的表头名称'),
  /** 填充的固定值（trim 后为空的格子才写入） */
  value: z.string().describe('填充的固定值'),
}).extend(TargetSheetField);

/**
 * 语义填充（功能 4）：目标列的空缺单元格按依据列取值的语义规律推断填充。
 *
 * 特殊性：这是 LLM 推断型操作（要真正调用模型产出填充值），不进
 * executeTableOps 的纯函数执行器——由 TableOpsService 检测到该类型后
 * 分流给 SemanticFillService（映射路径同步完成 / 分批路径出报价走任务）。
 * executor 入口对混入本类型的计划显式拒绝（防御纵深）。
 */
export const SemanticFillOpSchema = z.object({
  type: z.literal('semanticFill'),
  /** 要填充的目标列（该列存在空缺单元格）。强调"列名"：模型曾把工作表名误塞进来 */
  targetColumn: z.string().describe('要填充的目标列的表头名称（填列名，不是工作表名；该列在目标表中存在空缺）'),
  /** 推断依据列：如"根据城市和门店补全区域"给 ["城市","门店"]；省略时自动取前 3 个非目标列 */
  hintColumns: z
    .array(z.string().min(1).max(200))
    .max(10)
    .optional()
    .describe('用于推断的依据列表头名称清单（1~10 个，从表头中逐字选取）；省略时自动选取'),
  /** 参照工作表："按 B 表内容补 A 表"时 B 表的名字（对照关系交给填充推断） */
  referenceSheet: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('参照工作表名（跨表填充用）：要从哪张表查找依据列的对照关系，如"把汇总表的空缺按销售明细表补上"填 销售明细；同一张表内推断时省略'),
}).extend(TargetSheetField);

/**
 * 设置表头行（报表式表格根治）：把指定行设为表头，该行上方内容归为说明行
 * （标题/日期范围等，不再当数据参与填充/条件/规则）。
 * 行号 N 按用户在表格中看到的完整行序（含说明行、表头）从 1 数起；
 * N=1 表示恢复默认（第一行为表头）。不丢数据——原表头与上方行只降级为说明行。
 */
export const SetHeaderRowOpSchema = z.object({
  type: z.literal('setHeaderRow'),
  headerRow: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .describe('设为表头的行号（从 1 开始，按含标题/说明行的完整行序数）；1 = 恢复第一行为表头'),
}).extend(TargetSheetField);

/** 汇总行标记：声明哪些行是聚合结果行（总计/合计/小计），汇总行不参与填充/规则/条件/排序 */
export const SetTotalRowsOpSchema = z.object({
  type: z.literal('setTotalRows'),
  rows: z
    .array(z.number().int().min(1).max(100000))
    .max(200)
    .describe(
      '要标记为汇总行的行号列表（从 1 开始，按含标题/说明行的完整行序数，与 setHeaderRow 同口径）；空数组 = 清除全部汇总行标记',
    ),
}).extend(TargetSheetField);

/** 无操作：模型确认表格已满足要求时不做事、只说明原因（契约出口，防止"必须输出操作"与
 * "不该修改"两头挤压——典型场景：报表式布局中标题/日期/汇总行旁的刻意留白） */
export const NoopOpSchema = z.object({
  type: z.literal('noop'),
  reason: z
    .string()
    .min(2)
    .max(500)
    .describe('判断依据：为什么无需执行（如"唯一的空缺是日期范围行旁的刻意留白，属于报表式布局"）'),
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
  GroupCreateSheetOpSchema,
  DeriveColumnOpSchema,
  LookupFillOpSchema,
  FillConstantOpSchema,
  SemanticFillOpSchema,
  SetHeaderRowOpSchema,
  SetTotalRowsOpSchema,
  NoopOpSchema,
]);
export type TableOp = z.infer<typeof TableOpSchema>;

/**
 * clarify 场景类型枚举（schema 层定义：parse 计划、clarify 模块、react 决策
 * 三处共用同一枚举，防漂移）。
 */
export const ClarifyKindSchema = z.enum([
  'fill-source',
  'join-key',
  'condition',
  'aggregate-scope',
  'formula-preview',
  'destructive-preview',
]);
export type ClarifyKind = z.infer<typeof ClarifyKindSchema>;

/**
 * LLM 自报的"参数不明需反问"提示。
 * 意图层只给场景与措辞——选项内容由决策层（clarify.ts 分析器）确定性产出，
 * 绝不让 LLM 提供选项（防选项幻觉）。
 */
export const ClarifyHintSchema = z.object({
  kind: ClarifyKindSchema.describe(
    '反问场景：fill-source 填充来源 / join-key 跨表关联键 / condition 更新条件 / aggregate-scope 聚合范围 / formula-preview 公式影响面 / destructive-preview 删除范围',
  ),
  question: z
    .string()
    .min(2)
    .max(500)
    .describe('一句中文向用户说明缺什么信息、需要确认什么（不要附带选项内容，选项由系统生成）'),
});
export type ClarifyHint = z.infer<typeof ClarifyHintSchema>;

/**
 * LLM 产出的完整计划：一次指令可包含多个顺序执行的操作。
 *
 * 契约（根治设计，勿回退）：解析器是"纯映射器"——只负责把指令映射为操作序列，
 * 不负责判断"是否需要执行"。所有操作都是幂等的（同名 sheet 重建、已有列覆盖），
 * 重复执行零副作用，"已经做过了"不构成返回空的理由。裸的空 ops 不是合法解析
 * 结果（superRefine 机器强制），模型空手而归一律视为解析失败 → parse.ts 统一走纠正重问。
 * 唯一的合法"不做事"出口是 noop 操作（必须带 reason，报告告知用户）——用于
 * "表格确实无需修改"的场景（如报表式布局的刻意留白），与"没看清就偷懒"区分开。
 * needsClarify 是"参数不明需反问"的合法出口（ops 为空）：模糊意图/数据依赖
 * 不明时 LLM 只报场景与问题，选项由 clarify 协议的确定性分析器产出。
 */
export const TableOpsPlanSchema = z
  .object({
    ops: z
      .array(TableOpSchema)
      .max(10)
      .describe('按执行顺序排列的操作列表；一条指令拆解为 1~10 个操作'),
    needsClarify: ClarifyHintSchema.optional().describe(
      '指令的关键参数存在数据依赖不明（填充来源、关联键、更新条件等）时填写；此时输出空 ops 数组，系统会向用户反问确认后再执行',
    ),
  })
  .superRefine((plan, ctx) => {
    if (!plan.needsClarify && plan.ops.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ops'],
        message:
          '必须至少输出一个操作（参数不明需反问时用 needsClarify；表格确实无需修改时输出 noop）',
      });
    }
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
