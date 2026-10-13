/**
 * controllers/semantic-fill.controller.ts
 *
 * 语义填充（功能 4）分批任务 API。
 *
 * 路由：
 *   POST /documents/table-ops/semantic-fill/start    创建分批填充任务（立即后台执行）
 *   GET  /documents/table-ops/semantic-fill/status/:taskId  查询任务进度/结果
 *   POST /documents/table-ops/semantic-fill/cancel/:taskId  请求取消任务（协作式，当前批完成后停止）
 *
 * 说明：语义填充的"意图解析 + 路径决策（映射/分批）"走既有
 * POST /documents/table-ops（TableOpsService 分流，见 f4c）；
 * 只有判定为分批路径、用户确认报价后才调本控制器的 start。
 */

import { Controller, Get, Post, Param, Body, UseGuards, HttpException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { ZodValidationPipe } from '../fundamentals/zod-validation.pipe';
import { logger } from '../fundamentals/logger';
import {
  SemanticFillService,
  type SemanticFillStartResult,
  type SemanticFillTaskStatus,
} from '../services/semantic-fill.service.js';

// ==================== 限流（与 document.controller 写操作同款策略） ====================

/** 写操作限流：10 次/分钟（start/cancel 属重操作防刷；status 走类级读限流） */
const WRITE_THROTTLE = { default: { ttl: 60000, limit: 10 } };

// ==================== Zod Schema ====================

/** start 入参：与 preview 同形（sheetText 取编辑器当前文本，targetSheet 定位工作表） */
const StartSemanticFillSchema = z.object({
  /** 用户原始指令（LLM 推断填充值时的意图上下文；可为空串） */
  instruction: z.string().max(2000).default(''),
  /** 编辑器当前 sheet 结构化文本（含未保存编辑） */
  sheetText: z.string().min(1).max(3_000_000),
  /** 要填充的目标列名 */
  targetColumn: z.string().min(1).max(200),
  /** 依据列名清单（空数组 = 自动取前 3 个非目标列） */
  hintColumns: z.array(z.string().min(1).max(200)).max(10).default([]),
  /** 目标工作表名（多 sheet 场景；省略时用第一个） */
  targetSheet: z.string().min(1).max(200).optional(),
  /** 已保存文档传入后，任务结果过该文档的表格规则门禁（功能 5） */
  documentId: z.number().int().positive().optional(),
});
type StartSemanticFillDto = z.infer<typeof StartSemanticFillSchema>;

/** 路径参数 taskId（randomUUID 产物，放宽为长度约束避免版本升级误伤） */
const TaskIdParamSchema = z.object({
  taskId: z.string().min(8).max(64),
});

/** status 响应：任务不存在时 found:false（前端提示重跑，不用 404 抛错打断轮询） */
interface TaskStatusResponse {
  found: boolean;
  task?: SemanticFillTaskStatus;
}

/** cancel 响应 */
interface CancelResponse {
  cancelled: boolean;
  message: string;
}

@Controller('documents/table-ops/semantic-fill')
// 类级读限流：60 次/分钟，覆盖任务进度轮询场景（与 document.controller 对齐）
@Throttle({ default: { ttl: 60000, limit: 60 } })
@UseGuards(OptionalAuthGuard)
export class SemanticFillController {
  constructor(private readonly semanticFillService: SemanticFillService) {}

  /**
   * POST /documents/table-ops/semantic-fill/start
   * 创建分批填充任务：服务端按传入的最新表格文本重新统计空缺并切批，
   * 立即开始后台执行，返回 taskId 供轮询。
   */
  @Post('start')
  @Throttle(WRITE_THROTTLE)
  startTask(
    @Body(new ZodValidationPipe(StartSemanticFillSchema, { label: 'StartSemanticFill' }))
    body: StartSemanticFillDto,
  ): SemanticFillStartResult {
    logger.info('收到语义填充分批任务创建请求', {
      module: 'SemanticFillController',
      documentId: body.documentId,
      targetColumn: body.targetColumn,
      sheetTextLength: body.sheetText.length,
    });
    try {
      return this.semanticFillService.startBatchTask({
        instruction: body.instruction,
        sheetText: body.sheetText,
        targetColumn: body.targetColumn,
        hintColumns: body.hintColumns,
        ...(body.targetSheet !== undefined ? { targetSheet: body.targetSheet } : {}),
        ...(body.documentId !== undefined ? { documentId: body.documentId } : {}),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('创建语义填充任务失败', {
        module: 'SemanticFillController',
        error: message,
      });
      throw new HttpException(message || '创建填充任务失败', 400);
    }
  }

  /**
   * GET /documents/table-ops/semantic-fill/status/:taskId
   * 查询任务进度与结果。终态任务的 filledText 为可应用结果
   * （failed/cancelled 时也可能是已完成批次的部分结果）。
   */
  @Get('status/:taskId')
  getTaskStatus(
    @Param(new ZodValidationPipe(TaskIdParamSchema, { label: 'SemanticFillTaskId' }))
    params: { taskId: string },
  ): TaskStatusResponse {
    const task = this.semanticFillService.getTaskStatus(params.taskId);
    if (!task) {
      return { found: false };
    }
    return { found: true, task };
  }

  /**
   * POST /documents/table-ops/semantic-fill/cancel/:taskId
   * 请求取消任务：协作式取消，当前批完成后停止，已完成批次结果保留可应用。
   */
  @Post('cancel/:taskId')
  @Throttle(WRITE_THROTTLE)
  cancelTask(
    @Param(new ZodValidationPipe(TaskIdParamSchema, { label: 'SemanticFillTaskId' }))
    params: { taskId: string },
  ): CancelResponse {
    const result = this.semanticFillService.cancelTask(params.taskId);
    if (!result.cancelled) {
      logger.info('语义填充任务取消请求未受理', {
        module: 'SemanticFillController',
        taskId: params.taskId,
        reason: result.message,
      });
    }
    return result;
  }
}
