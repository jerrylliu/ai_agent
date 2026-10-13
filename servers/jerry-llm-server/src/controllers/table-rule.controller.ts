/**
 * controllers/table-rule.controller.ts
 *
 * 表格规则器 API（功能 5"表格的 ESLint"）。
 *
 * 路由挂 /documents/:documentId/table-rules（集合）与 /table-rules/:ruleId（单条）。
 * 全部走既有鉴权（OptionalAuthGuard）与限流（读 60 次/分、写 10 次/分，与
 * document.controller 对齐）。Controller 只做参数校验与转发，业务在 TableRuleService。
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { ZodValidationPipe } from '../fundamentals/zod-validation.pipe';
import { logger } from '../fundamentals/logger';
import { TableRuleSchema } from '../fundamentals/table-ops/rules.js';
import type { TableRuleInput } from '../fundamentals/table-ops/rules.js';
import {
  TableRuleService,
  type RuleFixItem,
  type TableRuleDto,
} from '../services/table-rule.service';

// ==================== 限流策略（与 document.controller 对齐） ====================

/** 写操作限流：10 次/分钟（增删改/检查/修复/AI 提议都涉及 LLM 或写库） */
const WRITE_THROTTLE = { default: { ttl: 60000, limit: 10 } };

// ==================== Zod Schema ====================

/** sheet 结构化文本（编辑器序列化产物），上限与 table-ops 对齐 */
const SheetTextSchema = z.object({
  sheetText: z.string().min(1).max(3_000_000).describe('编辑器当前的 sheet 结构化文本'),
});

/** 修复入参：前端从检查结果回传的违规定位清单 */
const FixRulesSchema = z.object({
  sheetText: SheetTextSchema.shape.sheetText,
  items: z
    .array(
      z.object({
        ruleId: z.number().int().positive(),
        rowIndex: z.number().int().positive().describe('数据行号（1 起，不含表头）'),
      }),
    )
    .min(1)
    .max(2000),
});
type FixRulesDto = z.infer<typeof FixRulesSchema>;

/** 批量入库（AI 提议确认后）：1~10 条规则 */
const BatchCreateRulesSchema = z.object({
  rules: z.array(TableRuleSchema).min(1).max(10),
});
type BatchCreateRulesDto = z.infer<typeof BatchCreateRulesSchema>;

/** 规则更新入参：params 需为对象；fixAction 传 null 表示清除修复动作 */
const UpdateRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  fixAction: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
});
type UpdateRuleDto = z.infer<typeof UpdateRuleSchema>;

type CreateRuleDto = TableRuleInput;
type SheetTextDto = z.infer<typeof SheetTextSchema>;

// ==================== Controller ====================

// 类级读限流：60 次/分钟（规则列表轮询场景），写操作单独收紧
@Throttle({ default: { ttl: 60000, limit: 60 } })
@UseGuards(OptionalAuthGuard)
@Controller()
export class TableRuleController {
  constructor(private readonly tableRuleService: TableRuleService) {}

  // ==================== 规则 CRUD ====================

  /**
   * GET /documents/:documentId/table-rules
   * 拉取文档的全部规则（含停用）
   */
  @Get('documents/:documentId/table-rules')
  async listRules(@Param('documentId', ParseIntPipe) documentId: number): Promise<TableRuleDto[]> {
    return this.tableRuleService.listRules(documentId);
  }

  /**
   * POST /documents/:documentId/table-rules
   * 新增一条规则（手动创建）
   */
  @Post('documents/:documentId/table-rules')
  @Throttle(WRITE_THROTTLE)
  async createRule(
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(TableRuleSchema, { label: 'CreateTableRule' }))
    body: CreateRuleDto,
  ): Promise<TableRuleDto> {
    try {
      return await this.tableRuleService.createRule(documentId, body, 'manual');
    } catch (error: any) {
      logger.warn('新增表格规则失败', {
        module: 'TableRuleController',
        documentId,
        error: error.message,
      });
      throw new HttpException(error.message ?? '新增规则失败', 400);
    }
  }

  /**
   * POST /documents/:documentId/table-rules/batch
   * 批量入库（AI 提议确认后），source 标记为 ai
   */
  @Post('documents/:documentId/table-rules/batch')
  @Throttle(WRITE_THROTTLE)
  async batchCreateRules(
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(BatchCreateRulesSchema, { label: 'BatchCreateTableRules' }))
    body: BatchCreateRulesDto,
  ): Promise<{ created: TableRuleDto[]; failed: { name: string; reason: string }[] }> {
    try {
      return await this.tableRuleService.createRules(documentId, body.rules, 'ai');
    } catch (error: any) {
      logger.warn('批量入库表格规则失败', {
        module: 'TableRuleController',
        documentId,
        error: error.message,
      });
      throw new HttpException(error.message ?? '批量入库失败', 400);
    }
  }

  /**
   * PUT /table-rules/:ruleId
   * 更新规则（改名 / 改参数 / 改修复动作 / 启停；fixAction 传 null 清除）
   */
  @Put('table-rules/:ruleId')
  @Throttle(WRITE_THROTTLE)
  async updateRule(
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(UpdateRuleSchema, { label: 'UpdateTableRule' }))
    body: UpdateRuleDto,
  ): Promise<TableRuleDto> {
    try {
      return await this.tableRuleService.updateRule(ruleId, body);
    } catch (error: any) {
      logger.warn('更新表格规则失败', {
        module: 'TableRuleController',
        ruleId,
        error: error.message,
      });
      throw new HttpException(error.message ?? '更新规则失败', 400);
    }
  }

  /**
   * DELETE /table-rules/:ruleId
   * 删除单条规则
   */
  @Delete('table-rules/:ruleId')
  @Throttle(WRITE_THROTTLE)
  async deleteRule(@Param('ruleId', ParseIntPipe) ruleId: number): Promise<{ success: boolean }> {
    try {
      await this.tableRuleService.deleteRule(ruleId);
      return { success: true };
    } catch (error: any) {
      logger.warn('删除表格规则失败', {
        module: 'TableRuleController',
        ruleId,
        error: error.message,
      });
      throw new HttpException(error.message ?? '删除规则失败', 400);
    }
  }

  // ==================== 检查 / 修复 / 统计 / 提议 ====================

  /**
   * POST /documents/:documentId/table-rules/check
   * 规则检查（干跑，无副作用）：违规行清单 + 失效规则
   */
  @Post('documents/:documentId/table-rules/check')
  @Throttle(WRITE_THROTTLE)
  async checkRules(
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(SheetTextSchema, { label: 'CheckTableRules' }))
    body: SheetTextDto,
  ) {
    return this.tableRuleService.checkRulesForText(documentId, body.sheetText);
  }

  /**
   * POST /documents/:documentId/table-rules/fix
   * 应用修复（用户确认后调用）：服务端以最新检查结果校验行号，过期行自动跳过
   */
  @Post('documents/:documentId/table-rules/fix')
  @Throttle(WRITE_THROTTLE)
  async fixRules(
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(FixRulesSchema, { label: 'FixTableRules' }))
    body: FixRulesDto,
  ) {
    try {
      return await this.tableRuleService.fixRulesForText(
        documentId,
        body.sheetText,
        body.items as RuleFixItem[],
      );
    } catch (error: any) {
      logger.error('表格规则修复失败', {
        module: 'TableRuleController',
        documentId,
        error: error.message,
        stack: error.stack,
      });
      throw new HttpException(error.message ?? '修复失败', 500);
    }
  }

  /**
   * POST /documents/:documentId/table-rules/stats
   * 列级统计（面板展示 + AI 提议依据，纯只读）
   */
  @Post('documents/:documentId/table-rules/stats')
  @Throttle(WRITE_THROTTLE)
  async columnStats(
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(SheetTextSchema, { label: 'TableRuleStats' }))
    body: SheetTextDto,
  ) {
    return this.tableRuleService.buildStats(body.sheetText);
  }

  /**
   * POST /documents/:documentId/table-rules/suggest
   * AI 看列级统计提议规则候选（不落库，面板展示给用户确认）
   */
  @Post('documents/:documentId/table-rules/suggest')
  @Throttle(WRITE_THROTTLE)
  async suggestRules(
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(SheetTextSchema, { label: 'SuggestTableRules' }))
    body: SheetTextDto,
  ) {
    try {
      return await this.tableRuleService.suggestRules(body.sheetText);
    } catch (error: any) {
      logger.warn('AI 规则提议失败', {
        module: 'TableRuleController',
        documentId,
        error: error.message,
      });
      throw new HttpException(error.message ?? 'AI 提议失败，请重试', 502);
    }
  }
}
