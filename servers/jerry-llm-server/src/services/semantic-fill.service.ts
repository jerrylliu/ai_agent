/**
 * services/semantic-fill.service.ts
 *
 * 语义填充（功能 4）编排服务：三级路径的调度与任务管理。
 *
 * 职责分工：
 *   - 纯函数层（fundamentals/table-ops/semantic-fill.ts）：空缺统计/映射应用/分批切分/批校验；
 *   - LLM 层（fundamentals/table-ops/semantic-fill-llm.ts）：映射推断/单批逐行推断；
 *   - 本文件：路径决策（映射 or 分批）+ 规则门禁 + 分批任务的内存调度。
 *
 * 路径决策（方案定稿"AI 自主选择、用户只说目标"）：
 *   - 空缺行依据值去重 ≤ 100 → 映射路径：一次 LLM 调用推断去重值，代码刷全表，同步返回；
 *   - 去重 > 100 → 分批报价：不执行，前端确认报价后调 start 创建任务、轮询进度。
 *
 * 任务边界（方案定稿）：任务状态存服务端内存 Map——服务重启任务作废
 * （前端拿到 found:false 提示重跑）；终态任务保留 10 分钟供前端拉取结果，
 * 超时自动清理防内存泄漏。
 *
 * 规则门禁（功能 5）：语义填充产出同样必须过文档规则——
 *   - 映射路径：填充完成后统一全查，违规整体拒绝（带违规明细）；
 *   - 分批路径：任务终态时对最终文本统一全查。
 *   不做批间中途检查：目标列未填满的中间态本身就违反 notEmpty 类规则，
 *   中途检查必然误报——与 table-ops.service"先跑出最终态再统一过规则"同理。
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { logger } from '../fundamentals/logger.js';
import {
  analyzeFillGaps,
  fillMappingMissing,
  applyFillMapping,
  splitBatches,
  countBatches,
  buildBatchRowsText,
  batchFillMissingRows,
  applyBatchFills,
  buildCrossSheetReference,
  MAX_DISTINCT_FOR_MAPPING,
  BATCH_ROWS,
  type FillGapStats,
  type FillMappingOutput,
  type FillRuleSuggestion,
} from '../fundamentals/table-ops/semantic-fill.js';
import {
  inferFillMapping,
  inferBatchFill,
} from '../fundamentals/table-ops/semantic-fill-llm.js';
import {
  parseSheetData,
  serializeSheetData,
  findSheet,
  TableOpsError,
  type SheetData,
} from '../fundamentals/table-ops/executor.js';
import {
  checkRules,
  diffViolations,
  formatViolationsByRule,
} from '../fundamentals/table-ops/rules.js';
import type { RuleCheckResult, TableRuleRuntime } from '../fundamentals/table-ops/rules.js';
import { TableRuleService } from './table-rule.service.js';

// ==================== 结果类型（controller / table-ops 分流共用） ====================

/** 路径 1 结果：映射填充已完成（filledText 已过规则门禁） */
export interface SemanticFillMappingResult {
  path: 'mapping';
  /** 与门禁拒绝结果（ok:false）区分，供调用方窄化 */
  ok: true;
  targetColumn: string;
  /** 实际使用的依据列 */
  hintColumns: string[];
  /** 目标列空缺行数 */
  emptyCount: number;
  /** 依据值去重数 */
  distinctCount: number;
  /** 填充后的完整 sheet 结构化文本 */
  filledText: string;
  /** LLM 推断的去重值映射（前端展示用） */
  mapping: FillMappingOutput['mapping'];
  /** 实际填充的单元格数 */
  appliedRows: number;
  /** 规则提议（AI 建议把依据列取值白名单存为规则，用户确认后才入库） */
  suggestRule?: FillRuleSuggestion;
}

/** 路径 2 报价：去重值太杂，需分批任务处理（未执行，等前端确认） */
export interface SemanticFillBatchQuote {
  path: 'batch';
  /** 与映射结果/门禁拒绝区分，供调用方窄化 */
  ok: true;
  targetColumn: string;
  hintColumns: string[];
  emptyCount: number;
  distinctCount: number;
  /** 需要的批次数 */
  batchCount: number;
  /** 每批行数（前端报价展示用） */
  batchRows: number;
  /** 目标工作表名（前端 start 时原样回传；省略 = 第一个工作表） */
  targetSheet?: string;
  /** 参照工作表名（跨表填充时前端 start 时原样回传） */
  referenceSheet?: string;
}

/** 映射路径被规则门禁拒绝（前端展示违规明细） */
export interface SemanticFillGateRejected {
  ok: false;
  message: string;
  ruleViolations: RuleCheckResult;
}

/**
 * preview 的返回：映射结果 / 分批报价 / 门禁拒绝。
 * 分流约定（TableOpsService.run）：拿到 batch 报价原样放进 semanticFill 字段；
 * 拿到映射结果填 sheetText + semanticFill；拿到门禁拒绝转 ok:false。
 */
export type SemanticFillPreview =
  | SemanticFillMappingResult
  | SemanticFillBatchQuote
  | SemanticFillGateRejected;

/** start 创建任务后的回执 */
export interface SemanticFillStartResult {
  taskId: string;
  targetColumn: string;
  hintColumns: string[];
  /** 空缺行数（start 时按最新数据重新统计） */
  emptyCount: number;
  batchCount: number;
  batchRows: number;
}

/** 任务状态（GET status 响应体） */
export interface SemanticFillTaskStatus {
  taskId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  targetColumn: string;
  hintColumns: string[];
  emptyCount: number;
  batchCount: number;
  completedBatches: number;
  /** 进度 0~1（completedBatches / batchCount） */
  progress: number;
  /** 已填充的单元格数 */
  appliedRows: number;
  /** 用户已请求取消、当前批完成后停止（前端显示"取消中"） */
  cancelRequested: boolean;
  /** 终态且有已填充内容时的部分/完整结果（failed/cancelled 时也可能有——已完成批次保留） */
  filledText?: string;
  /** failed 原因（含规则门禁拒绝说明） */
  error?: string;
  /** failed 时失败的第几批（1 起）；规则门禁拒绝时不设（全部批已成功） */
  failedBatch?: number;
}

// ==================== 服务 ====================

/** 内存任务的内部结构（status 之外的执行态字段） */
interface SemanticFillTask {
  id: string;
  status: SemanticFillTaskStatus['status'];
  targetColumn: string;
  hintColumns: string[];
  emptyCount: number;
  batchCount: number;
  completedBatches: number;
  appliedRows: number;
  cancelRequested: boolean;
  documentId?: number;
  filledText?: string;
  error?: string;
  failedBatch?: number;
  createdAt: number;
  finishedAt?: number;
}

/** 同时运行的分批任务上限（防连点打爆 LLM 限流配额） */
const MAX_RUNNING_TASKS = 3;
/** 终态任务保留时长：前端轮询 + 刷新重连的窗口期 */
const TASK_TTL_MS = 10 * 60 * 1000;
/** start 时惰性清扫的兜底线（任务终态超过该时长必定已过 setTimeout 清理） */
const TASK_SWEEP_MS = 30 * 60 * 1000;

/** 语义填充入参（preview / start 共用字段形状，controller 侧 zod 校验） */
export interface SemanticFillParams {
  instruction: string;
  sheetText: string;
  targetColumn: string;
  hintColumns: string[];
  targetSheet?: string;
  /** 参照工作表名（跨表填充："按 B 表内容补 A 表"时 B 表） */
  referenceSheet?: string;
  documentId?: number;
}

@Injectable()
export class SemanticFillService {
  /** 内存任务表：taskId → 任务（方案定稿：不持久化，服务重启作废可接受） */
  private readonly tasks = new Map<string, SemanticFillTask>();

  constructor(private readonly tableRuleService: TableRuleService) {}

  // ==================== 路径决策与映射执行（table-ops 分流调用） ====================

  /**
   * 语义填充预览：统计空缺 → 决策路径。
   *   - 映射路径在此同步执行完（LLM 一次调用），填充结果已过规则门禁；
   *   - 分批路径只出报价，不执行——确认与执行权在用户（方案"持久化/大动作必须确认"）。
   *
   * @throws TableOpsError 列不存在 / 没有空缺行 / 没有依据列等业务错误
   * @throws Error        LLM 调用失败（上层转结构化错误响应）
   */
  async preview(params: SemanticFillParams): Promise<SemanticFillPreview> {
    const { sheets, sheet } = this.resolveSheet(params.sheetText, params.targetSheet);
    const stats = analyzeFillGaps(sheet, params.targetColumn, params.hintColumns);
    if (stats.emptyRowIndexes.length === 0) {
      throw new TableOpsError(`「${params.targetColumn}」列没有空缺单元格，无需填充`);
    }

    // 去重值少 → 映射路径：一次 LLM 调用推断全部去重值，代码刷全表
    if (stats.distinctCount <= MAX_DISTINCT_FOR_MAPPING) {
      const constraints = await this.buildFillConstraints(params.documentId, params.targetColumn);
      return this.runMappingPath(sheets, sheet, stats, params, constraints);
    }

    // 去重值太杂 → 分批报价（distinctCount > 上限时 distinctBasisValues 已截断，
    // 逐值校验无法覆盖全部 → 映射路径不可用）；targetSheet/referenceSheet 回传，
    // 前端确认报价后 start 时原样带回（否则多 sheet 会落到第一张表）
    const quote: SemanticFillBatchQuote = {
      path: 'batch',
      ok: true,
      targetColumn: params.targetColumn,
      hintColumns: stats.hintColumns,
      emptyCount: stats.emptyRowIndexes.length,
      distinctCount: stats.distinctCount,
      batchCount: countBatches(stats.emptyRowIndexes.length),
      batchRows: BATCH_ROWS,
      ...(params.targetSheet !== undefined ? { targetSheet: params.targetSheet } : {}),
      ...(params.referenceSheet !== undefined ? { referenceSheet: params.referenceSheet } : {}),
    };
    logger.info('语义填充判定为分批路径', {
      module: 'SemanticFillService',
      targetColumn: params.targetColumn,
      emptyCount: quote.emptyCount,
      distinctCount: quote.distinctCount,
      batchCount: quote.batchCount,
    });
    return quote;
  }

  /** 映射路径：推断 → 逐值校验（缺失整体拒绝）→ 应用 → 规则门禁 → 序列化 */
  private async runMappingPath(
    sheets: SheetData[],
    sheet: SheetData,
    stats: FillGapStats,
    params: SemanticFillParams,
    constraints: string | undefined,
  ): Promise<SemanticFillPreview> {
    const crossReference = this.resolveCrossReference(sheets, sheet, stats, params.referenceSheet);
    const inferred = await inferFillMapping(stats, params.instruction, constraints, crossReference);

    // 逐值校验（方案："逐值校验，缺失即整体拒绝"）：LLM 漏掉任何一个去重值都不可信，
    // 静默跳过会让部分行永远填不上且用户无感知
    const missing = fillMappingMissing(stats, inferred.mapping);
    if (missing.length > 0) {
      throw new TableOpsError(
        `AI 未给出全部依据值的填充结果（缺少 ${missing.length} 种，如：${missing.slice(0, 5).join('、')}），` +
          '已整体拒绝。请重试或改用更明确的说法',
      );
    }

    const mapping = new Map(inferred.mapping.map((m) => [m.from, m.to]));
    // 基线文本必须在应用填充前截取（applyFillMapping 会原地改写 sheet）
    const baselineText = serializeSheetData(sheets);
    const appliedRows = applyFillMapping(sheet, params.targetColumn, stats.hintColumns, mapping);
    const filledText = serializeSheetData(sheets);

    // 规则门禁（功能 5，根治语义）：只拒绝本次填充**新增**的违规——文档既有
    // 违规不拦截与它无关的填充（填 A 列不该被 B 列的历史脏数据连坐）
    const gate = await this.ruleGate(params.documentId, filledText, baselineText);
    if (!gate.passed) {
      logger.info('语义填充（映射路径）被规则门禁整体拒绝（新增违规）', {
        module: 'SemanticFillService',
        documentId: params.documentId,
        freshViolations: gate.freshCheck.violations.length,
        preExistingViolations: gate.preExistingCount,
      });
      return {
        ok: false,
        message:
          `本次填充会新增违反表格规则的内容（${gate.freshCheck.violations.length} 处）：` +
          `${formatViolationsByRule(gate.freshCheck)}，已整体拒绝。请调整指令，或在规则面板处理这些规则` +
          (gate.preExistingCount > 0
            ? `（文档另有 ${gate.preExistingCount} 处既有违规与本次填充无关，未被拦截）`
            : '') +
          '。',
        ruleViolations: gate.freshCheck,
      };
    }

    logger.info('语义填充（映射路径）完成', {
      module: 'SemanticFillService',
      documentId: params.documentId,
      targetColumn: params.targetColumn,
      hintColumns: stats.hintColumns.join(','),
      emptyCount: stats.emptyRowIndexes.length,
      distinctCount: stats.distinctCount,
      appliedRows,
      hasSuggestRule: Boolean(inferred.suggestRule),
    });

    return {
      path: 'mapping',
      ok: true,
      targetColumn: params.targetColumn,
      hintColumns: stats.hintColumns,
      emptyCount: stats.emptyRowIndexes.length,
      distinctCount: stats.distinctCount,
      filledText,
      mapping: inferred.mapping,
      appliedRows,
      // 提议的规则绑定到本次填充的目标工作表——多 sheet 文档里列可能在第二个
      // sheet，不绑定的话规则一入库检查就"找不到列"而失效
      ...(inferred.suggestRule
        ? {
            suggestRule: {
              ...inferred.suggestRule,
              ...(sheet.name ? { targetSheet: sheet.name } : {}),
            },
          }
        : {}),
    };
  }

  // ==================== 分批任务（start / status / cancel） ====================

  /**
   * 创建分批填充任务并立即开始后台执行。
   *
   * 与 preview 的报价独立：start 时按**最新传入的表格文本**重新统计空缺
   * （报价到确认之间用户可能改过表），批数以此时为准。
   *
   * @throws TableOpsError 并发任务超限 / 列不存在 / 没有空缺行
   */
  startBatchTask(params: SemanticFillParams): SemanticFillStartResult {
    const running = [...this.tasks.values()].filter((t) => t.status === 'running').length;
    if (running >= MAX_RUNNING_TASKS) {
      throw new TableOpsError(
        `已有 ${running} 个填充任务在进行中，请等待完成或取消后再发起新任务`,
      );
    }
    this.sweepStaleTasks();

    const { sheets, sheet } = this.resolveSheet(params.sheetText, params.targetSheet);
    const stats = analyzeFillGaps(sheet, params.targetColumn, params.hintColumns);
    if (stats.emptyRowIndexes.length === 0) {
      throw new TableOpsError(`「${params.targetColumn}」列没有空缺单元格，无需填充`);
    }
    // start 不复检 distinctCount ≤ 100：报价到确认之间数据可能变化，
    // 去重值变少时走分批任务只是多批几次调用，结果等价、流程统一

    const batches = splitBatches(stats.emptyRowIndexes);
    const task: SemanticFillTask = {
      id: randomUUID(),
      status: 'running',
      targetColumn: params.targetColumn,
      hintColumns: stats.hintColumns,
      emptyCount: stats.emptyRowIndexes.length,
      batchCount: batches.length,
      completedBatches: 0,
      appliedRows: 0,
      cancelRequested: false,
      ...(params.documentId !== undefined ? { documentId: params.documentId } : {}),
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);

    logger.info('语义填充分批任务已创建', {
      module: 'SemanticFillService',
      taskId: task.id,
      documentId: params.documentId,
      targetColumn: task.targetColumn,
      emptyCount: task.emptyCount,
      batchCount: task.batchCount,
    });

    // 后台执行（不 await）：错误在 runTask 内部消化为任务终态，
    // 这里再挂 catch 兜底防未处理 Promise 拒绝；
    // finalizeTask 无条件调用——即使 runTask 内部 finalizeWithGate 意外抛错，
    // 也保证清理定时器被挂上（正常路径重复调用只是多挂一个幂等的 setTimeout）
    const crossReference = this.resolveCrossReference(sheets, sheet, stats, params.referenceSheet);
    void this.runTask(
      task,
      sheets,
      sheet,
      stats,
      batches,
      params.instruction,
      params.sheetText,
      crossReference,
    ).catch(
      (err: unknown) => {
        logger.error('语义填充任务执行循环出现未捕获异常', {
          module: 'SemanticFillService',
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        if (task.status === 'running') {
          task.status = 'failed';
          task.error = '任务执行出现意外错误，已填充的部分结果仍可应用';
        }
        this.finalizeTask(task);
      },
    );

    return {
      taskId: task.id,
      targetColumn: task.targetColumn,
      hintColumns: task.hintColumns,
      emptyCount: task.emptyCount,
      batchCount: task.batchCount,
      batchRows: BATCH_ROWS,
    };
  }

  /**
   * 查询任务状态。任务不存在（从未创建/已被清理/服务重启）返回 null，
   * controller 转为 found:false 让前端提示重跑，而不是 404 抛错。
   */
  getTaskStatus(taskId: string): SemanticFillTaskStatus | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      taskId: task.id,
      status: task.status,
      targetColumn: task.targetColumn,
      hintColumns: task.hintColumns,
      emptyCount: task.emptyCount,
      batchCount: task.batchCount,
      completedBatches: task.completedBatches,
      progress: task.batchCount > 0 ? task.completedBatches / task.batchCount : 0,
      appliedRows: task.appliedRows,
      cancelRequested: task.cancelRequested,
      ...(task.filledText !== undefined ? { filledText: task.filledText } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
      ...(task.failedBatch !== undefined ? { failedBatch: task.failedBatch } : {}),
    };
  }

  /**
   * 请求取消任务。协作式取消：不中断当前批的 LLM 调用（中断会造成半批写入），
   * 执行循环在下一批开始前检测到标记后停止。
   *
   * @returns false = 任务不存在或已是终态（无需取消）
   */
  cancelTask(taskId: string): { cancelled: boolean; message: string } {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { cancelled: false, message: '任务不存在或已过期' };
    }
    if (task.status !== 'running') {
      return { cancelled: false, message: `任务已是终态（${task.status}），无需取消` };
    }
    task.cancelRequested = true;
    logger.info('收到语义填充任务取消请求', {
      module: 'SemanticFillService',
      taskId,
      completedBatches: task.completedBatches,
    });
    return { cancelled: true, message: '取消请求已受理，当前批完成后停止' };
  }

  // ==================== 内部：执行循环与收尾 ====================

  /** 单批失败即整任务失败，但**已应用批次的结果保留**（方案明确要求）——
   * 终态时把当前部分结果序列化挂到任务上，前端可选择只应用已完成部分 */
  private async runTask(
    task: SemanticFillTask,
    sheets: SheetData[],
    sheet: SheetData,
    stats: FillGapStats,
    batches: number[][],
    instruction: string,
    baselineText: string,
    crossReference: string | undefined,
  ): Promise<void> {
    try {
      // 生成期规则约束（根治语义的"事前遵守"半边）：白名单/数值范围/公式
      // 约束注入提示词，让 LLM 在源头按规则取值，而不是只靠终态门禁拦截
      const constraints = await this.buildFillConstraints(task.documentId, task.targetColumn);
      for (let bi = 0; bi < batches.length; bi++) {
        // 协作式取消：当前批完整落表后、下一批开始前停止
        if (task.cancelRequested) {
          task.status = 'cancelled';
          logger.info('语义填充任务已取消', {
            module: 'SemanticFillService',
            taskId: task.id,
            completedBatches: task.completedBatches,
            appliedRows: task.appliedRows,
          });
          await this.finalizeWithGate(task, sheets, baselineText);
          this.finalizeTask(task);
          return;
        }

        try {
          const rowsText = buildBatchRowsText(
            sheet,
            batches[bi],
            task.targetColumn,
            task.hintColumns,
          );
          const output = await inferBatchFill(
            rowsText,
            task.targetColumn,
            batches[bi].length,
            instruction,
            constraints,
            crossReference,
          );
          // 批级校验（方案："批内缺一值则该批整体失败"）：
          // 缺行说明 LLM 输出不完整，静默跳过会留下永远填不上的行
          const missingRows = batchFillMissingRows(batches[bi], output);
          if (missingRows.length > 0) {
            throw new TableOpsError(
              `AI 未给出本批全部行的填充值（缺少 ${missingRows.length} 行，` +
                `如第 ${missingRows.slice(0, 5).join('、')} 行），本批整体失败`,
            );
          }
          const applied = applyBatchFills(sheet, task.targetColumn, output.fills);
          task.appliedRows += applied;
          task.completedBatches = bi + 1;
          logger.info('语义填充批次完成', {
            module: 'SemanticFillService',
            taskId: task.id,
            batch: bi + 1,
            totalBatches: batches.length,
            applied,
          });
        } catch (err) {
          // 批失败 → 整任务 failed，已完成批次保留（finalizeWithGate 挂部分结果）
          task.status = 'failed';
          task.failedBatch = bi + 1;
          task.error = err instanceof Error ? err.message : String(err);
          logger.warn('语义填充批次失败，任务终止', {
            module: 'SemanticFillService',
            taskId: task.id,
            failedBatch: bi + 1,
            completedBatches: task.completedBatches,
            error: task.error,
          });
          await this.finalizeWithGate(task, sheets, baselineText);
          this.finalizeTask(task);
          return;
        }
      }

      // 全部批次成功 → 终态门禁（见类注释：不做批间中途检查的理由）；
      // finalizeWithGate 拒绝时内部已把任务置 failed 并写明原因
      const passed = await this.finalizeWithGate(task, sheets, baselineText);
      if (!passed) {
        this.finalizeTask(task);
        return;
      }
      task.status = 'done';
      logger.info('语义填充任务完成', {
        module: 'SemanticFillService',
        taskId: task.id,
        batchCount: task.batchCount,
        appliedRows: task.appliedRows,
      });
      this.finalizeTask(task);
    } finally {
      // 无论哪条路径退出，任务都应已置终态；兜底防"running 僵尸任务"
      if (task.status === 'running') {
        task.status = 'failed';
        task.error = task.error ?? '任务异常终止';
        this.finalizeTask(task);
      }
    }
  }

  /**
   * 任务终态统一收尾：若已有填充内容，过规则门禁后把文本挂到任务上。
   *
   * @param baselineText 任务开始时的表格文本——门禁用它做基线对比，
   *                     只拒绝本次填充**新增**的违规（既有违规不连坐）
   * @returns true = 门禁通过（或无门禁/无内容），任务可按原计划置 done；
   *          false = 门禁拒绝，内部已把任务置 failed 并写明原因
   */
  private async finalizeWithGate(
    task: SemanticFillTask,
    sheets: SheetData[],
    baselineText: string,
  ): Promise<boolean> {
    if (task.appliedRows <= 0) return true; // 没填任何内容，无需门禁也无需挂结果
    const text = serializeSheetData(sheets);
    const gate = await this.ruleGate(task.documentId, text, baselineText);
    if (!gate.passed) {
      task.status = 'failed';
      const violationMsg =
        `已填充部分新增违反表格规则内容（${gate.freshCheck.violations.length} 处：` +
        `${formatViolationsByRule(gate.freshCheck)}），结果已整体拒绝` +
        (gate.preExistingCount > 0
          ? `；文档另有 ${gate.preExistingCount} 处既有违规与本次填充无关，未被拦截`
          : '');
      task.error = task.error ? `${task.error}；${violationMsg}` : violationMsg;
      // 违规结果绝不挂给前端（与 table-ops 门禁同一不变量：违规数据不进编辑器）
      return false;
    }
    task.filledText = text;
    return true;
  }

  /**
   * 规则门禁（映射路径 / 分批终态共用）：加载文档启用规则做检查。
   *
   * 根治语义：只拒绝**新增**违规——传入 baselineText（执行前文本）时，
   * 以多重集差集算出本次真正引入的违规作为判定依据；文档既有违规不拦截
   * 与它无关的填充（填 A 列不该被 B 列的历史脏数据连坐），只在文案里提示数量。
   * 规则加载失败只记日志放行——规则器是增强护栏，不拖垮填充主链路
   * （与 table-ops.service 的门禁容错语义一致）。
   */
  private async ruleGate(
    documentId: number | undefined,
    text: string,
    baselineText?: string,
  ): Promise<{
    passed: boolean;
    check: RuleCheckResult;
    /** 仅含"相对基线新增"的违规（无基线时即全量） */
    freshCheck: RuleCheckResult;
    /** 文档既有违规数（基线里就有、非本次填充造成） */
    preExistingCount: number;
  }> {
    const emptyCheck: RuleCheckResult = {
      checkedRules: 0,
      violations: [],
      invalidRules: [],
      truncated: false,
    };
    if (documentId === undefined) {
      return { passed: true, check: emptyCheck, freshCheck: emptyCheck, preExistingCount: 0 };
    }

    let rules: TableRuleRuntime[] = [];
    try {
      rules = await this.tableRuleService.getEnabledRules(documentId);
    } catch (err) {
      logger.error('加载表格规则失败，本次语义填充跳过规则校验', {
        module: 'SemanticFillService',
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { passed: true, check: emptyCheck, freshCheck: emptyCheck, preExistingCount: 0 };
    }
    if (rules.length === 0) {
      return { passed: true, check: emptyCheck, freshCheck: emptyCheck, preExistingCount: 0 };
    }

    const check = checkRules(text, rules);
    if (baselineText === undefined) {
      return {
        passed: check.violations.length === 0,
        check,
        freshCheck: check,
        preExistingCount: 0,
      };
    }
    const baselineCheck = checkRules(baselineText, rules);
    const fresh = diffViolations(baselineCheck.violations, check.violations);
    return {
      passed: fresh.length === 0,
      check,
      freshCheck: { ...check, violations: fresh },
      preExistingCount: check.violations.length - fresh.length,
    };
  }

  /**
   * 解析参照工作表并生成跨表对照文本（"按 B 表内容补 A 表"）。
   * 未指定参照表返回 undefined；指定的表不存在抛 TableOpsError（用户明确要求
   * 参照，静默忽略会变成凭空编造——这正是要根治的行为）。
   */
  private resolveCrossReference(
    sheets: SheetData[],
    sheet: SheetData,
    stats: FillGapStats,
    referenceSheetName?: string,
  ): string | undefined {
    if (referenceSheetName === undefined) return undefined;
    const ref = sheets.find((s) => s.name === referenceSheetName);
    if (!ref) {
      throw new TableOpsError(`找不到参照工作表「${referenceSheetName}」`);
    }
    return buildCrossSheetReference(sheet, ref, stats.hintColumns);
  }

  /**
   * 生成期规则约束：从文档启用规则中提取与目标列相关的约束，注入填充提示词。
   *
   * 根治语义的"事前遵守"半边：白名单/数值范围/公式约束让 LLM 在源头就按规则
   * 取值（如白名单列只能填白名单值），把门禁从"事后拦截"前移为"事前遵守"，
   * 大幅减少填充被整体拒绝的概率。规则加载失败返回 undefined（与门禁同款容错：
   * 规则器不拖垮填充主链路）。
   */
  private async buildFillConstraints(
    documentId: number | undefined,
    targetColumn: string,
  ): Promise<string | undefined> {
    if (documentId === undefined) return undefined;
    let rules: TableRuleRuntime[] = [];
    try {
      rules = await this.tableRuleService.getEnabledRules(documentId);
    } catch (err) {
      logger.warn('加载表格规则失败，本次填充不带规则约束', {
        module: 'SemanticFillService',
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }

    const parts: string[] = [];
    for (const rule of rules) {
      if (rule.type === 'allowedValues' && rule.params.column === targetColumn) {
        parts.push(`「${targetColumn}」只能填这些值之一：${rule.params.values.join('、')}`);
      } else if (rule.type === 'numericRange' && rule.params.column === targetColumn) {
        const { min, max } = rule.params;
        const desc =
          min !== undefined && max !== undefined
            ? `${min} ~ ${max} 之间`
            : min !== undefined
              ? `≥ ${min}`
              : max !== undefined
                ? `≤ ${max}`
                : '数字';
        parts.push(`「${targetColumn}」必须填数字且在 ${desc}`);
      } else if (rule.type === 'formula' && rule.params.targetColumn === targetColumn) {
        parts.push(
          `「${targetColumn}」应等于表达式 ${rule.params.expression} 的计算结果（按每行的数值精确计算）`,
        );
      }
    }
    return parts.length > 0 ? `填充值必须满足以下规则约束：${parts.join('；')}。` : undefined;
  }

  /** 任务置终态后的统一动作：记录完成时间 + 延迟清理内存（防泄漏） */
  private finalizeTask(task: SemanticFillTask): void {
    if (task.status === 'running') return; // 防御：只对终态任务生效
    task.finishedAt = Date.now();
    setTimeout(() => {
      this.tasks.delete(task.id);
      logger.debug('语义填充终态任务已清理', {
        module: 'SemanticFillService',
        taskId: task.id,
      });
    }, TASK_TTL_MS);
  }

  /** start 时的惰性清扫（双保险：setTimeout 之外的兜底，防极端情况下内存滞留） */
  private sweepStaleTasks(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running' && task.finishedAt !== undefined) {
        if (now - task.finishedAt > TASK_SWEEP_MS) {
          this.tasks.delete(id);
        }
      }
    }
  }

  // ==================== 内部工具 ====================

  /** 解析表格文本并定位目标工作表（语义填充只操作单张工作表） */
  private resolveSheet(
    sheetText: string,
    targetSheet: string | undefined,
  ): { sheets: SheetData[]; sheet: SheetData } {
    const sheets = parseSheetData(sheetText);
    const sheet = findSheet(sheets, targetSheet);
    return { sheets, sheet };
  }
}
