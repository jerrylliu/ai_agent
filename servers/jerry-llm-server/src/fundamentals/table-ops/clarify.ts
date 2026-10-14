/**
 * fundamentals/table-ops/clarify.ts
 *
 * 模糊意图 + 数据依赖的**确定性决策层**（clarify 反问确认协议）。
 *
 * 三层分工（幻觉根治设计，勿回退）：
 *   - 意图层（LLM）：只判意图与缺参（needsClarify），最多措辞问题，绝不提供选项内容；
 *   - 决策层（本模块，纯代码）：**完备性闸门**是权威兜底（LLM 漏报也会被拦），
 *     分析器用确定性统计产出策略选项（空缺统计/键重合率/值分布/试算预览），
 *     编译器把用户确认的策略翻译成 executor ops——确认后全程无 LLM；
 *   - 执行层（executor.ts）：确定性执行，未命中留空、绝不发明值。
 *
 * 无状态两请求模型：
 *   请求 1 POST /documents/table-ops → 闸门/needsClarify → SSE clarify 事件（本模块 payload）
 *   请求 2 POST /documents/table-ops/confirm → hash 校验 → 策略编译 → executeTableOps
 *
 * TOCTOU 防护：confirm 校验 sha1（clarify 时的文本 hash）——卡片停留期间表格被改
 * 则拒绝执行，提示重新发指令（防基于过期文本错误执行）。
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  TableOpSchema,
  type TableOp,
  type WhereClause,
  ClarifyKindSchema,
  type ClarifyKind,
} from './schema.js';
import {
  findColumn,
  matchWhere,
  parseLooseNumber,
  parseSheetData,
  type SheetData,
} from './executor.js';
import {
  evaluateSheetExpression,
  formatExpressionNumber,
} from './executor.js';

/** clarify 场景类型枚举（定义在 schema.ts，此处转出口供 react 决策等处共用） */
export { ClarifyKindSchema, type ClarifyKind };

// ==================== Zod Schema ====================

/** 复合键映射（目标表键列 ↔ 来源表键列） */
export const KeyMappingSchema = z.object({
  targetKeyColumn: z.string().describe('目标表键列'),
  sourceKeyColumn: z.string().describe('来源表键列'),
});
export type KeyMapping = z.infer<typeof KeyMappingSchema>;

/**
 * 用户确认的填充/执行策略（discriminatedUnion）。
 * cross-sheet-lookup / fill-constant 由编译器翻译为确定性 ops；
 * ai-mapping-preview 由服务层转 SemanticFillService 出映射预览（二次确认才应用）；
 * confirm-pending 仅用于删除类预览确认（原样回传 pendingOps 执行）。
 */
export const StrategySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cross-sheet-lookup'),
    targetSheet: z.string().optional(),
    targetColumn: z.string().describe('要填充的目标列'),
    targetKeyColumn: z.string().describe('目标表关联键列'),
    sourceSheet: z.string().describe('来源工作表名'),
    sourceKeyColumn: z.string().describe('来源表关联键列'),
    sourceValueColumn: z.string().describe('来源表取值列'),
    keyMappings: z.array(KeyMappingSchema).max(5).optional().describe('复合键（给出时覆盖单键）'),
  }),
  z.object({
    type: z.literal('ai-mapping-preview'),
    targetSheet: z.string().optional(),
    targetColumn: z.string().describe('要填充的目标列'),
    basisColumns: z.array(z.string()).max(10).default([]).describe('推断依据列（空 = 自动选取）'),
  }),
  z.object({
    type: z.literal('fill-constant'),
    targetSheet: z.string().optional(),
    targetColumn: z.string().describe('要填充的目标列'),
    value: z.string().describe('填充的固定值'),
  }),
  z.object({ type: z.literal('keep-empty') }),
  z.object({ type: z.literal('condition-op'), op: TableOpSchema }),
  z.object({ type: z.literal('aggregate-op'), op: TableOpSchema }),
  z.object({ type: z.literal('formula-confirm'), op: TableOpSchema }),
  /** 删除类预览确认：内嵌被确认的原 op（confirm 时原样编译执行） */
  z.object({ type: z.literal('confirm-pending'), op: TableOpSchema.optional() }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

/** 选项（选项内容由分析器确定性产出，LLM 不参与） */
export const StrategyOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  strategy: StrategySchema,
});
export type StrategyOption = z.infer<typeof StrategyOptionSchema>;

/**
 * clarify 载荷（SSE clarify 事件的 data，前端卡片渲染 + confirm 回传）。
 * baseSheetText 仅 ReAct 中途 clarify 时出现（已执行前缀 op 的结果文本）：
 * 前端不应用它（编辑器保持干净），confirm 以它为执行基底，最终一次性应用。
 */
export const ClarifyPayloadSchema = z.object({
  kind: ClarifyKindSchema,
  question: z.string().describe('反问文案（LLM 措辞，闸门触发时用确定性默认文案）'),
  /** fill-source：按列分组的候选（每列独立选策略，多列空缺场景） */
  columns: z
    .array(
      z.object({
        column: z.string(),
        gapCount: z.number().int(),
        candidates: z.array(StrategyOptionSchema).min(1),
      }),
    )
    .optional(),
  /** 单列/非填充场景的顶层选项 */
  options: z.array(StrategyOptionSchema).optional(),
  /** join-key：候选键对（附重合率，降序） */
  keyCandidates: z
    .array(
      z.object({
        label: z.string(),
        targetKeyColumn: z.string(),
        sourceKeyColumn: z.string(),
        overlapRate: z.number(),
      }),
    )
    .optional(),
  /** condition：目标列值分布（值 + 行数） */
  valueDistribution: z
    .array(z.object({ value: z.string(), count: z.number().int() }))
    .optional(),
  /** formula-preview / destructive-preview：确定性预览 */
  previewHeaders: z.array(z.string()).optional(),
  previewRows: z.array(z.array(z.string())).optional(),
  /** destructive-preview / formula-preview：预计影响行数/覆盖格数 */
  affectedCount: z.number().int().optional(),
  /** ReAct 中途 clarify：已执行前缀的结果文本与其 hash（confirm 的执行基底） */
  baseSheetText: z.string().optional(),
  baseSheetTextHash: z.string().optional(),
  /**
   * 发起指令时原文的 sha1（仅 ReAct 中途 clarify 且已执行前缀时与
   * baseSheetTextHash 不同）。confirm 时配合请求的 liveSheetText 校验
   * "编辑器实时文本未变"——baseSheetText 是中间态（编辑器里没有），
   * 对它做 hash 校验恒真，防不住用户在卡片停留期间编辑表格。
   */
  originSheetTextHash: z.string().optional(),
  /** legacy 计划中被 clarify op 切分的前/后段（confirm 时拼回完整计划） */
  baseOps: z.array(TableOpSchema).optional(),
  pendingOps: z.array(TableOpSchema).optional(),
});
export type ClarifyPayload = z.infer<typeof ClarifyPayloadSchema>;

/** confirm 请求体（服务层二次校验，防前端篡改注入任意 op） */
export const ConfirmRequestSchema = z.object({
  sheetText: z.string().min(1).describe('执行基底文本（无前缀 op = 编辑器实时文本；有前缀 op = baseSheetText）'),
  sheetTextHash: z.string().describe('clarify 响应携带的文本 sha1（TOCTOU 校验）'),
  /**
   * confirm 时编辑器的实时序列化文本（可选）：clarify 载荷带 originSheetTextHash
   * 时（ReAct 中途 clarify）必须提供，服务端据此校验原文未变。
   */
  liveSheetText: z.string().optional(),
  clarify: ClarifyPayloadSchema,
  strategies: z.array(StrategySchema).min(1).max(20),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

// ==================== 常量 ====================

/** 关联键重合率闸门阈值：低于此值疑似键选错，强制 clarify */
export const KEY_OVERLAP_THRESHOLD = 0.6;
/** 删除影响面闸门：超过 max(20, 30% 总行数) 强制预览确认 */
const DESTRUCTIVE_MIN_ROWS = 20;
const DESTRUCTIVE_RATE = 0.3;
/** 候选键对上限（防 N×M 配对爆炸，列名匹配优先） */
const MAX_KEY_CANDIDATES = 10;

// ==================== 工具 ====================

/** sheet 结构化文本 sha1（TOCTOU 校验用） */
export function hashSheetText(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 目标 sheet 解析：指定名精确匹配，否则第一个（单表场景与执行器容错口径一致） */
function resolveTarget(sheets: SheetData[], name?: string): SheetData {
  if (name) {
    const hit = sheets.find((s) => s.name === name.trim());
    if (hit) return hit;
  }
  return sheets[0];
}

/** 带缓存的列定位器（matchWhere/表达式求值共用，避免逐行 findColumn） */
function makeResolver(sheet: SheetData): (name: string) => number {
  const cache = new Map<string, number>();
  return (name: string): number => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const idx = findColumn(sheet, name);
    cache.set(name, idx);
    return idx;
  };
}

/** 行补齐到表头宽度（短行读格不越界） */
function padRow(row: string[], width: number): string[] {
  const padded = [...row];
  while (padded.length < width) padded.push('');
  return padded;
}

/** 列的去重非空值集合（明细行，跳过声明汇总行——总行标签不是业务键值） */
function columnDistinctValues(sheet: SheetData, colName: string): Set<string> {
  const idx = findColumn(sheet, colName);
  const totalSet = new Set(sheet.totalRowIndexes);
  const set = new Set<string>();
  for (let i = 0; i < sheet.rows.length; i++) {
    if (totalSet.has(i)) continue;
    const v = (sheet.rows[i][idx] ?? '').trim();
    if (v) set.add(v);
  }
  return set;
}

/**
 * 键列重合率：|目标键去重值 ∩ 来源键去重值| / |目标键去重值|。
 * 目标侧是"要被填充的一方"，它的键值能被来源覆盖的比例决定关联可行性。
 * 列不存在抛 TableOpsError（调用方决定放行给 validateOp 报错还是跳过）。
 */
export function keyOverlapRate(
  target: SheetData,
  targetKey: string,
  source: SheetData,
  sourceKey: string,
): number {
  const t = columnDistinctValues(target, targetKey);
  if (t.size === 0) return 0;
  const s = columnDistinctValues(source, sourceKey);
  let hit = 0;
  for (const v of t) if (s.has(v)) hit += 1;
  return hit / t.size;
}

/** 条件匹配行数（与执行期同一套 matchWhere 语义） */
function countMatches(sheet: SheetData, where: WhereClause): number {
  try {
    const resolve = makeResolver(sheet);
    let count = 0;
    for (const row of sheet.rows) {
      if (matchWhere(padRow(row, sheet.headers.length), where, resolve)) count += 1;
    }
    return count;
  } catch {
    return 0; // 列不存在等 → validateOp 会报可读错误，闸门放行
  }
}

/** deriveColumn 试算将覆盖的非空格数（空格不算覆盖；列不存在=新增列，无覆盖） */
function countDeriveOverwrites(sheet: SheetData, op: Extract<TableOp, { type: 'deriveColumn' }>): number {
  let targetIdx: number;
  try {
    targetIdx = findColumn(sheet, op.targetColumn);
  } catch {
    return 0; // 列不存在 → 执行器新增列，不可能覆盖
  }
  const totalSet = new Set(sheet.totalRowIndexes);
  try {
    const resolve = makeResolver(sheet);
    let count = 0;
    for (let i = 0; i < sheet.rows.length; i++) {
      if (totalSet.has(i)) continue;
      const padded = padRow(sheet.rows[i], sheet.headers.length);
      if (op.where && !matchWhere(padded, op.where, resolve)) continue;
      if ((padded[targetIdx] ?? '').trim() === '') continue;
      const v = evaluateSheetExpression(op.expression, (col) =>
        parseLooseNumber(padded[resolve(col)] ?? ''),
      );
      if (v === null) continue; // 执行期会跳过该行，不算覆盖
      count += 1;
    }
    return count;
  } catch {
    return 0; // 表达式语法/引用列错误 → validateOp 报错，闸门放行
  }
}

/** deriveColumn 逐行试算（formula-preview 用）：返回 [行标识, 当前值, 计算结果] */
function derivePreviewRows(
  sheet: SheetData,
  op: Extract<TableOp, { type: 'deriveColumn' }>,
  limit: number,
): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let total = 0;
  try {
    const targetIdx = findColumn(sheet, op.targetColumn);
    const totalSet = new Set(sheet.totalRowIndexes);
    const resolve = makeResolver(sheet);
    for (let i = 0; i < sheet.rows.length; i++) {
      if (totalSet.has(i)) continue;
      const padded = padRow(sheet.rows[i], sheet.headers.length);
      if (op.where && !matchWhere(padded, op.where, resolve)) continue;
      if ((padded[targetIdx] ?? '').trim() === '') continue; // 预览只列覆盖面
      const v = evaluateSheetExpression(op.expression, (col) =>
        parseLooseNumber(padded[resolve(col)] ?? ''),
      );
      if (v === null) continue;
      total += 1;
      if (rows.length < limit) {
        rows.push([
          (padded[0] ?? '').trim(),
          (padded[targetIdx] ?? '').trim(),
          formatExpressionNumber(v),
        ]);
      }
    }
  } catch {
    // 表达式错误 → 空预览，validateOp 报错
  }
  return { rows, total };
}

// ==================== 完备性闸门（权威兜底，纯代码） ====================

export type GateResult =
  | { action: 'clarify'; kind: ClarifyKind; opIndex: number; reason: string }
  | { action: 'reject'; reason: string }
  | null;

/**
 * 确定性完备性闸门：对解析出的 ops 逐个静态检查数据依赖完备性与影响面。
 * LLM 自报 needsClarify 只是快捷路径——这里才是权威（漏洞 1 双保险）：
 * 任一 op 不过 → 整体转 clarify（legacy）或停止循环（ReAct）；
 * deleteRows 无条件 → 直接拒绝（整表删除不可确认后执行）。
 * 解析失败/空表返回 null（交给执行器报可读错误）。
 */
export function checkOpsCompleteness(text: string, ops: TableOp[]): GateResult {
  let sheets: SheetData[];
  try {
    sheets = parseSheetData(text);
  } catch {
    return null;
  }
  if (sheets.length === 0) return null;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    switch (op.type) {
      // 契约：语义填充永不静默执行（决策 3）——一律转 clarify，
      // 由用户在"AI 映射预览/跨表关联/固定值/保留空缺"中选择
      case 'semanticFill':
        return {
          action: 'clarify',
          kind: 'fill-source',
          opIndex: i,
          reason: '填充需要先确认数据来源策略',
        };
      case 'lookupFill': {
        const target = resolveTarget(sheets, op.targetSheet);
        const source = op.sourceSheet ? resolveTarget(sheets, op.sourceSheet) : target;
        const mappings =
          op.keyMappings && op.keyMappings.length > 0
            ? op.keyMappings
            : op.targetKeyColumn && op.sourceKeyColumn
              ? [
                  {
                    targetKeyColumn: op.targetKeyColumn,
                    sourceKeyColumn: op.sourceKeyColumn,
                  },
                ]
              : [];
        if (mappings.length === 0) {
          return {
            action: 'clarify',
            kind: 'join-key',
            opIndex: i,
            reason: '跨表关联需要确认按哪一列关联',
          };
        }
        // 键重合率过低 → 疑似键选错，强制确认（列不存在时放行给 validateOp 报错）
        let minRate = 1;
        try {
          for (const m of mappings) {
            minRate = Math.min(
              minRate,
              keyOverlapRate(target, m.targetKeyColumn, source, m.sourceKeyColumn),
            );
          }
        } catch {
          break;
        }
        if (minRate < KEY_OVERLAP_THRESHOLD) {
          return {
            action: 'clarify',
            kind: 'join-key',
            opIndex: i,
            reason: `关联键两列取值重合率仅 ${Math.round(minRate * 100)}%，疑似关联键选错`,
          };
        }
        break;
      }
      case 'updateCells':
        if (!op.where) {
          // 目标列不存在时放行——validateOp 会报可读错误并回喂模型纠正，
          // 闸门不该用"确认更新范围"的反问掩盖"列不存在"的真实错误
          try {
            findColumn(resolveTarget(sheets, op.targetSheet), op.targetColumn);
          } catch {
            break;
          }
          return {
            action: 'clarify',
            kind: 'condition',
            opIndex: i,
            reason: '全列更新影响所有行，请确认要更新哪些行',
          };
        }
        break;
      case 'deleteRows': {
        if (!op.where) {
          return {
            action: 'reject',
            reason: '删除操作必须指明条件（哪一列满足什么值的行要删除），不能整表删除',
          };
        }
        const target = resolveTarget(sheets, op.targetSheet);
        const count = countMatches(target, op.where);
        if (
          count > 0 &&
          count > Math.max(DESTRUCTIVE_MIN_ROWS, Math.ceil(target.rows.length * DESTRUCTIVE_RATE))
        ) {
          return {
            action: 'clarify',
            kind: 'destructive-preview',
            opIndex: i,
            reason: `该条件将删除 ${count} 行（共 ${target.rows.length} 行），请确认`,
          };
        }
        break;
      }
      case 'deriveColumn': {
        const target = resolveTarget(sheets, op.targetSheet);
        const overwrite = countDeriveOverwrites(target, op);
        if (overwrite > 0) {
          return {
            action: 'clarify',
            kind: 'formula-preview',
            opIndex: i,
            reason: `计算将覆盖 ${overwrite} 个已有值，请确认`,
          };
        }
        break;
      }
      case 'aggregateAppendRow':
      case 'aggregateUpdateCell': {
        // 同表重算是"上方全部行求和"的既定契约，不拦；其余场景聚合列无数字 → 提前反问
        const isCross =
          op.type === 'aggregateAppendRow' ? Boolean(op.sourceSheet) : Boolean(op.sourceSheet);
        if (!isCross) break;
        const source = resolveTarget(sheets, op.sourceSheet);
        const colName =
          op.type === 'aggregateAppendRow'
            ? op.column
            : (op.sourceColumn ?? op.column);
        try {
          const idx = findColumn(source, colName);
          const totalSet = new Set(source.totalRowIndexes);
          let numeric = 0;
          for (let r = 0; r < source.rows.length; r++) {
            if (totalSet.has(r)) continue;
            if (parseLooseNumber((source.rows[r][idx] ?? '').trim()) !== null) numeric += 1;
          }
          if (numeric === 0) {
            return {
              action: 'clarify',
              kind: 'aggregate-scope',
              opIndex: i,
              reason: `列「${colName}」没有可计算的数字，请确认要聚合的列`,
            };
          }
        } catch {
          // 列不存在 → validateOp 报可读错误，闸门放行
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}

// ==================== 分析器（确定性选项产出） ====================

/** 跨表键候选：目标表各列 × 来源表各列按重合率排序（列名相同优先），上限 10 */
function findKeyCandidates(
  target: SheetData,
  source: SheetData,
  sourceValueColumn: string,
): Array<{ label: string; targetKeyColumn: string; sourceKeyColumn: string; overlapRate: number }> {
  const candidates: Array<{
    label: string;
    targetKeyColumn: string;
    sourceKeyColumn: string;
    overlapRate: number;
  }> = [];
  for (const tHead of target.headers) {
    const tKey = tHead.trim();
    if (!tKey || tKey === sourceValueColumn) continue;
    for (const sHead of source.headers) {
      const sKey = sHead.trim();
      if (!sKey) continue;
      let rate: number;
      try {
        rate = keyOverlapRate(target, tKey, source, sKey);
      } catch {
        continue;
      }
      if (rate < 0.2) continue; // 噪音过滤
      candidates.push({
        label: `按「${tKey}」↔「${sKey}」关联（重合率 ${Math.round(rate * 100)}%）`,
        targetKeyColumn: tKey,
        sourceKeyColumn: sKey,
        overlapRate: rate,
      });
    }
  }
  // 列名相同的键对置顶（同名列大概率就是关联键），其余按重合率降序
  candidates.sort((a, b) => {
    const aSame = a.targetKeyColumn === a.sourceKeyColumn ? 1 : 0;
    const bSame = b.targetKeyColumn === b.sourceKeyColumn ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame;
    return b.overlapRate - a.overlapRate;
  });
  return candidates.slice(0, MAX_KEY_CANDIDATES);
}

/** fill-source：每列空缺统计 + 跨表候选 + 兜底三件套（AI 映射/固定值/保留空缺） */
function buildFillSourcePayload(
  text: string,
  targetSheetName: string | undefined,
  hintColumns: string[],
  question: string,
): ClarifyPayload {
  const sheets = parseSheetData(text);
  const target = resolveTarget(sheets, targetSheetName);
  const totalSet = new Set(target.totalRowIndexes);
  const columns: Array<{
    column: string;
    gapCount: number;
    candidates: Array<{ id: string; label: string; description?: string; strategy: Strategy }>;
  }> = [];
  for (let c = 0; c < target.headers.length; c++) {
    const colName = target.headers[c]?.trim();
    if (!colName) continue;
    let gapCount = 0;
    for (let i = 0; i < target.rows.length; i++) {
      if (totalSet.has(i)) continue;
      if ((target.rows[i][c] ?? '').trim() === '') gapCount += 1;
    }
    if (gapCount === 0) continue;
    const candidates: StrategyOption[] = [];
    // 跨表候选：其他表与目标列同名的列做取值列，重合率最高的键对做关联键
    for (const src of sheets) {
      if (src === target) continue;
      try {
        findColumn(src, colName);
      } catch {
        continue; // 该表没有同名列 → 不硬凑候选（不确定的取值列宁可不提供）
      }
      const keys = findKeyCandidates(target, src, colName);
      const best = keys[0];
      if (best && best.overlapRate >= KEY_OVERLAP_THRESHOLD) {
        candidates.push({
          id: `lookup:${src.name}:${colName}`,
          label: `从「${src.name}」关联填充（键：${best.targetKeyColumn} ↔ ${best.sourceKeyColumn}，重合率 ${Math.round(best.overlapRate * 100)}%）`,
          description: `按关联键从「${src.name}」的「${colName}」列精确取值，未命中留空`,
          strategy: {
            type: 'cross-sheet-lookup',
            targetSheet: target.name || undefined,
            targetColumn: colName,
            targetKeyColumn: best.targetKeyColumn,
            sourceSheet: src.name,
            sourceKeyColumn: best.sourceKeyColumn,
            sourceValueColumn: colName,
          },
        });
      }
    }
    candidates.push({
      id: `ai:${colName}`,
      label: 'AI 智能映射（先预览再确认）',
      description: '按依据列取值规律推断映射表，预览确认后才写入',
      strategy: {
        type: 'ai-mapping-preview',
        targetSheet: target.name || undefined,
        targetColumn: colName,
        basisColumns: hintColumns,
      },
    });
    candidates.push({
      id: `const:${colName}`,
      label: '填入固定值',
      description: '把指定的同一个值填入该列全部空格（仅明细行）',
      strategy: {
        type: 'fill-constant',
        targetSheet: target.name || undefined,
        targetColumn: colName,
        value: '',
      },
    });
    candidates.push({
      id: `skip:${colName}`,
      label: '保留空缺',
      description: '该列暂不填充',
      strategy: { type: 'keep-empty' },
    });
    columns.push({ column: colName, gapCount, candidates });
  }
  return { kind: 'fill-source', question, columns };
}

/** join-key：候选键对 + 对应的 cross-sheet-lookup 选项（值列沿用 op 声明） */
function buildJoinKeyPayload(
  text: string,
  op: Extract<TableOp, { type: 'lookupFill' }>,
  question: string,
): ClarifyPayload {
  const sheets = parseSheetData(text);
  const target = resolveTarget(sheets, op.targetSheet);
  const source = op.sourceSheet ? resolveTarget(sheets, op.sourceSheet) : target;
  const keyCandidates = findKeyCandidates(target, source, op.sourceValueColumn);
  const options: StrategyOption[] = keyCandidates.map((k, idx) => ({
    id: `key:${idx}`,
    label: k.label,
    description: `从「${source.name || '未命名'}」的「${op.sourceValueColumn}」取值填充「${op.targetColumn}」`,
    strategy: {
      type: 'cross-sheet-lookup',
      targetSheet: op.targetSheet,
      targetColumn: op.targetColumn,
      targetKeyColumn: k.targetKeyColumn,
      sourceSheet: op.sourceSheet,
      sourceKeyColumn: k.sourceKeyColumn,
      sourceValueColumn: op.sourceValueColumn,
    },
  }));
  return { kind: 'join-key', question, keyCandidates, options };
}

/** condition：目标列值分布 + 逐值条件选项 + 空格 + 全列更新兜底 */
function buildConditionPayload(
  text: string,
  op: Extract<TableOp, { type: 'updateCells' }>,
  question: string,
): ClarifyPayload {
  const sheets = parseSheetData(text);
  const target = resolveTarget(sheets, op.targetSheet);
  const idx = findColumn(target, op.targetColumn);
  const totalSet = new Set(target.totalRowIndexes);
  const dist = new Map<string, number>();
  let emptyCount = 0;
  for (let i = 0; i < target.rows.length; i++) {
    if (totalSet.has(i)) continue;
    const v = (target.rows[i][idx] ?? '').trim();
    if (!v) {
      emptyCount += 1;
      continue;
    }
    dist.set(v, (dist.get(v) ?? 0) + 1);
  }
  const valueDistribution = [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([value, count]) => ({ value, count }));
  const options: StrategyOption[] = valueDistribution.slice(0, 8).map((d, i) => ({
    id: `cond:${i}`,
    label: `仅更新「${op.targetColumn}」= ${d.value} 的 ${d.count} 行`,
    strategy: {
      type: 'condition-op',
      op: {
        type: 'updateCells',
        targetSheet: op.targetSheet,
        targetColumn: op.targetColumn,
        where: { column: op.targetColumn, op: 'eq', value: d.value },
        newValue: op.newValue,
      },
    },
  }));
  if (emptyCount > 0) {
    options.push({
      id: 'cond:empty',
      label: `仅更新空格（${emptyCount} 行）`,
      strategy: {
        type: 'condition-op',
        op: {
          type: 'updateCells',
          targetSheet: op.targetSheet,
          targetColumn: op.targetColumn,
          where: { column: op.targetColumn, op: 'empty' },
          newValue: op.newValue,
        },
      },
    });
  }
  options.push({
    id: 'cond:all',
    label: `更新全部明细行（${target.rows.length - totalSet.size} 行）`,
    description: '确认无条件更新整列',
    strategy: { type: 'condition-op', op },
  });
  return { kind: 'condition', question, valueDistribution, options };
}

/** aggregate-scope：来源表数值列清单 + 逐列聚合选项 */
function buildAggregateScopePayload(
  text: string,
  op: Extract<TableOp, { type: 'aggregateAppendRow' } | { type: 'aggregateUpdateCell' }>,
  question: string,
): ClarifyPayload {
  const sheets = parseSheetData(text);
  const source = resolveTarget(sheets, op.sourceSheet);
  const totalSet = new Set(source.totalRowIndexes);
  // 数值列统计（列名定位失败的头/尾列跳过）
  const numericCols: Array<{ column: string; numericCount: number; min: number; max: number }> = [];
  for (let c = 0; c < source.headers.length; c++) {
    const colName = source.headers[c]?.trim();
    if (!colName) continue;
    let numericCount = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < source.rows.length; i++) {
      if (totalSet.has(i)) continue;
      const n = parseLooseNumber((source.rows[i][c] ?? '').trim());
      if (n === null) continue;
      numericCount += 1;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (numericCount > 0) numericCols.push({ column: colName, numericCount, min, max });
  }
  const previewHeaders = ['列名', '数字格数', '最小值', '最大值'];
  const previewRows = numericCols
    .slice(0, 10)
    .map((s) => [s.column, String(s.numericCount), String(s.min), String(s.max)]);
  // 逐列聚合选项：克隆原 op 换目标列（op 形状在分支内已收窄）
  const options: StrategyOption[] = numericCols.slice(0, 8).map((s, i) => ({
    id: `agg:${i}`,
    label: `聚合「${s.column}」（${s.numericCount} 个数字）`,
    strategy: {
      type: 'aggregate-op',
      op:
        op.type === 'aggregateAppendRow'
          ? { ...op, column: s.column }
          : { ...op, sourceColumn: s.column },
    },
  }));
  return { kind: 'aggregate-scope', question, previewHeaders, previewRows, options };
}

/** formula-preview：确定性试算预览 + 覆盖确认/只补空格选项 */
function buildFormulaPreviewPayload(
  text: string,
  op: Extract<TableOp, { type: 'deriveColumn' }>,
  question: string,
): ClarifyPayload {
  const sheets = parseSheetData(text);
  const target = resolveTarget(sheets, op.targetSheet);
  const { rows, total } = derivePreviewRows(target, op, 5);
  const options: StrategyOption[] = [
    {
      id: 'formula:confirm',
      label: `确认覆盖（${total} 个已有值将被改写）`,
      strategy: { type: 'formula-confirm', op },
    },
  ];
  if (!op.where) {
    options.push({
      id: 'formula:only-empty',
      label: '只写入空缺格（不覆盖已有值）',
      description: '已有值的行保持原样',
      strategy: {
        type: 'condition-op',
        op: { ...op, where: { column: op.targetColumn, op: 'empty' } },
      },
    });
  }
  options.push({
    id: 'formula:cancel',
    label: '取消，不改这一列',
    strategy: { type: 'keep-empty' },
  });
  return {
    kind: 'formula-preview',
    question,
    previewHeaders: ['首列值', '当前值', '试算结果'],
    previewRows: rows,
    affectedCount: total,
    options,
  };
}

/** destructive-preview：待删行预览 + 确认/取消 */
function buildDestructivePreviewPayload(
  text: string,
  op: Extract<TableOp, { type: 'deleteRows' }>,
  question: string,
): ClarifyPayload {
  const sheets = parseSheetData(text);
  const target = resolveTarget(sheets, op.targetSheet);
  const resolve = makeResolver(target);
  const rows: string[][] = [];
  let total = 0;
  for (const row of target.rows) {
    const padded = padRow(row, target.headers.length);
    if (!matchWhere(padded, op.where, resolve)) continue;
    total += 1;
    if (rows.length < 10) rows.push(padded.map((c) => (c ?? '').trim()));
  }
  return {
    kind: 'destructive-preview',
    question,
    previewHeaders: target.headers,
    previewRows: rows,
    affectedCount: total,
    options: [
      {
        id: 'del:confirm',
        label: `确认删除 ${total} 行`,
        strategy: { type: 'confirm-pending', op },
      },
      {
        id: 'del:cancel',
        label: '取消，不删除',
        strategy: { type: 'keep-empty' },
      },
    ],
  };
}

/**
 * 闸门结果 → clarify 载荷（确定性分析器分发）。
 * @param text      当前 sheet 结构化文本
 * @param gate      闸门返回的 clarify 决策
 * @param ops       op 计划（legacy 按 opIndex 切分 baseOps/pendingOps，confirm 拼回）；
 *                  ReAct 自报 needsClarify 时为空数组（无成形 op，按场景类型做通用分析）
 * @param question  LLM 措辞的问题（闸门触发时省略，用 reason 作默认文案）
 */
export function buildClarifyPayload(
  text: string,
  gate: Extract<GateResult, { action: 'clarify' }>,
  ops: TableOp[],
  question?: string,
): ClarifyPayload {
  const op: TableOp | undefined = ops[gate.opIndex];
  const q = question && question.trim().length > 0 ? question : gate.reason;
  let payload: ClarifyPayload;
  switch (gate.kind) {
    case 'fill-source':
      payload =
        op?.type === 'semanticFill'
          ? buildFillSourcePayload(text, op.targetSheet, op.hintColumns ?? [], q)
          : buildFillSourcePayload(text, undefined, [], q);
      break;
    case 'join-key':
      payload =
        op?.type === 'lookupFill'
          ? buildJoinKeyPayload(text, op, q)
          : { kind: 'join-key', question: q, keyCandidates: [], options: [] };
      break;
    case 'condition':
      payload =
        op?.type === 'updateCells'
          ? buildConditionPayload(text, op, q)
          : { kind: 'condition', question: q, options: [] };
      break;
    case 'aggregate-scope':
      payload =
        op?.type === 'aggregateAppendRow' || op?.type === 'aggregateUpdateCell'
          ? buildAggregateScopePayload(text, op, q)
          : { kind: 'aggregate-scope', question: q, options: [] };
      break;
    case 'formula-preview':
      payload =
        op?.type === 'deriveColumn'
          ? buildFormulaPreviewPayload(text, op, q)
          : { kind: 'formula-preview', question: q, options: [] };
      break;
    case 'destructive-preview':
      payload =
        op?.type === 'deleteRows'
          ? buildDestructivePreviewPayload(text, op, q)
          : { kind: 'destructive-preview', question: q, options: [] };
      break;
  }
  // 多 op 计划的切分（legacy 一次性解析场景）：确认后按"确定性前缀 → 策略编译
  // 出的操作 → 后缀"拼回完整计划。ReAct 单 op 场景切分结果为空数组，无影响
  if (op !== undefined) {
    payload.baseOps = ops.slice(0, gate.opIndex);
    payload.pendingOps = ops.slice(gate.opIndex + 1);
  }
  return payload;
}

// ==================== 策略编译器（确认后 → 确定性 ops，无 LLM） ====================

/**
 * 用户确认的策略 → executor ops。
 * - cross-sheet-lookup：目标列不存在时前置 addColumn（"表二新加一列 a1"场景）；
 * - confirm-pending：先执行内嵌的原 op（删除确认），再拼接 pendingOps；
 * - keep-empty：空（用户选择放弃该列）。
 * pendingOps 由服务层先行 schema 校验（ConfirmRequestSchema 已含 TableOpSchema 校验）。
 */
export function compileStrategies(
  text: string,
  strategies: Strategy[],
  pendingOps: TableOp[],
): TableOp[] {
  let sheets: SheetData[] = [];
  try {
    sheets = parseSheetData(text);
  } catch {
    // 文本问题交给执行器报错；这里只影响 addColumn 前置判断
  }
  const ops: TableOp[] = [];
  for (const s of strategies) {
    switch (s.type) {
      case 'cross-sheet-lookup': {
        const target = resolveTarget(sheets, s.targetSheet);
        const exists =
          sheets.length > 0 &&
          (() => {
            try {
              findColumn(target, s.targetColumn);
              return true;
            } catch {
              return false;
            }
          })();
        if (!exists) {
          // "表二新加一列 a1 再关联填充"：目标列尚未创建，先建列
          ops.push({
            type: 'addColumn',
            targetSheet: s.targetSheet,
            header: s.targetColumn,
          });
        }
        ops.push({
          type: 'lookupFill',
          targetSheet: s.targetSheet,
          targetColumn: s.targetColumn,
          targetKeyColumn: s.targetKeyColumn,
          sourceSheet: s.sourceSheet,
          sourceKeyColumn: s.sourceKeyColumn,
          sourceValueColumn: s.sourceValueColumn,
          keyMappings: s.keyMappings,
        });
        break;
      }
      case 'fill-constant':
        ops.push({
          type: 'fillConstant',
          targetSheet: s.targetSheet,
          targetColumn: s.targetColumn,
          value: s.value,
        });
        break;
      case 'condition-op':
      case 'aggregate-op':
      case 'formula-confirm':
        ops.push(s.op);
        break;
      case 'confirm-pending':
        if (s.op) ops.push(s.op);
        ops.push(...pendingOps);
        break;
      case 'keep-empty':
      case 'ai-mapping-preview':
        // keep-empty：放弃；ai-mapping 不在此编译（服务层先出预览）
        break;
    }
  }
  return ops;
}
