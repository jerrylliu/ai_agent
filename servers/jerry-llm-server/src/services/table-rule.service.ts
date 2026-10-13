/**
 * services/table-rule.service.ts
 *
 * 表格规则器服务（功能 5"表格的 ESLint"）：
 *   - 规则 CRUD（存储 op 模板：名称 + 类型 + 参数 JSON + 启停 + 来源 + 可选修复动作）；
 *   - 检查：对编辑器当前文本干跑规则引擎，产出违规行清单（纯只读无副作用）；
 *   - 修复：用户在面板确认后按修复动作批量应用（服务端以最新检查结果为基准
 *     校验行号，防止前端回传过期/伪造清单改错行）；
 *   - AI 提议：看列级统计提议候选规则（不落库），用户确认后批量入库（source='ai'）。
 *
 * 规则存数据库（table_rules 实体），不塞表格 contentText（防污染 RAG）。
 * 检查/修复引擎是纯函数（fundamentals/table-ops/rules.ts），本服务只做
 * 编排与持久化，不含 HTTP 概念。
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TableRule } from '../entities/table-rule.entity.js';
import { logger } from '../fundamentals/logger.js';
import {
  TableRuleSchema,
  applyRuleFixes,
  buildColumnStats,
  checkRules,
  parseTableRuleJson,
} from '../fundamentals/table-ops/rules.js';
import type {
  RuleCheckResult,
  RuleFixReportItem,
  RuleViolation,
  SheetColumnStats,
  TableRuleInput,
  TableRuleRuntime,
} from '../fundamentals/table-ops/rules.js';
import { suggestRulesFromStats } from '../fundamentals/table-ops/rules-suggest.js';

// ==================== DTO / 内部类型 ====================

/** 规则序列化输出（HTTP 响应体） */
export interface TableRuleDto {
  id: number;
  documentId: number;
  name: string;
  type: TableRuleInput['type'];
  params: TableRuleInput['params'];
  fixAction?: TableRuleInput['fixAction'];
  enabled: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** 修复入参条目：前端从检查结果回传的违规定位（只认 ruleId + rowIndex） */
export interface RuleFixItem {
  ruleId: number;
  rowIndex: number;
}

@Injectable()
export class TableRuleService {
  constructor(
    @InjectRepository(TableRule)
    private readonly ruleRepo: Repository<TableRule>,
  ) {}

  // ==================== 规则 CRUD ====================

  /**
   * 拉取文档的全部规则（含停用与失效的，面板完整展示）
   */
  async listRules(documentId: number): Promise<TableRuleDto[]> {
    const rows = await this.ruleRepo.find({
      where: { documentId },
      order: { id: 'ASC' },
    });
    return rows.map((row) => this.serializeRule(row));
  }

  /**
   * 新增一条规则（手动或 AI 确认入库）
   * @param source 来源标记：manual 用户手写 / ai AI 提议（用户确认后）
   */
  async createRule(
    documentId: number,
    input: TableRuleInput,
    source: 'manual' | 'ai' = 'manual',
  ): Promise<TableRuleDto> {
    const row = await this.ruleRepo.save({
      documentId,
      name: input.name,
      type: input.type,
      // schema 已通过 ZodValidationPipe 校验，这里序列化落库
      paramsJson: JSON.stringify(input.params),
      fixActionJson: input.fixAction ? JSON.stringify(input.fixAction) : null,
      enabled: true,
      source,
    });
    logger.info('新增表格规则', {
      module: 'TableRuleService',
      ruleId: row.id,
      documentId,
      ruleType: input.type,
      source,
    });
    return this.serializeRule(row);
  }

  /**
   * 批量新增（AI 提议确认入库用）；单条失败不影响其他条，返回逐条结果
   */
  async createRules(
    documentId: number,
    inputs: TableRuleInput[],
    source: 'manual' | 'ai' = 'ai',
  ): Promise<{ created: TableRuleDto[]; failed: { name: string; reason: string }[] }> {
    const created: TableRuleDto[] = [];
    const failed: { name: string; reason: string }[] = [];
    for (const input of inputs) {
      try {
        created.push(await this.createRule(documentId, input, source));
      } catch (err) {
        failed.push({
          name: input.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { created, failed };
  }

  /**
   * 更新规则（改名 / 改参数 / 改修复动作 / 启停）。
   * params 变更后整体重新走 zod 校验（类型+参数联动），不过就拒绝。
   */
  async updateRule(
    ruleId: number,
    patch: { name?: string; enabled?: boolean; params?: unknown; fixAction?: unknown },
  ): Promise<TableRuleDto> {
    const row = await this.ruleRepo.findOne({ where: { id: ruleId } });
    if (!row) throw new Error(`规则不存在（id=${ruleId}）`);

    const name = patch.name?.trim() || row.name;
    // params/fixAction 未传时沿用库里的旧值；fixAction 显式传 null = 清除修复动作；
    // 整体重新校验防止 type/params 错配
    const candidate = TableRuleSchema.safeParse({
      name,
      type: row.type,
      params: patch.params !== undefined ? patch.params : JSON.parse(row.paramsJson),
      ...(patch.fixAction !== undefined && patch.fixAction !== null
        ? { fixAction: patch.fixAction }
        : patch.fixAction === null
          ? {}
          : row.fixActionJson
            ? { fixAction: JSON.parse(row.fixActionJson) }
            : {}),
    });
    if (!candidate.success) {
      throw new Error(
        `规则参数不合法：${candidate.error.issues[0]?.message ?? '校验失败'}`,
      );
    }

    row.name = name;
    row.enabled = patch.enabled ?? row.enabled;
    row.paramsJson = JSON.stringify(candidate.data.params);
    row.fixActionJson = candidate.data.fixAction
      ? JSON.stringify(candidate.data.fixAction)
      : null;
    await this.ruleRepo.save(row);
    logger.info('更新表格规则', {
      module: 'TableRuleService',
      ruleId,
      documentId: row.documentId,
      enabled: row.enabled,
    });
    return this.serializeRule(row);
  }

  /**
   * 删除单条规则
   */
  async deleteRule(ruleId: number): Promise<void> {
    const result = await this.ruleRepo.delete(ruleId);
    if (!result.affected) throw new Error(`规则不存在（id=${ruleId}）`);
    logger.info('删除表格规则', { module: 'TableRuleService', ruleId });
  }

  /**
   * 删除文档的全部规则（级联删除钩子，DocumentService.deleteDocument 调用）。
   * 失败只记日志不抛——删除文档是主操作，不能因规则清理失败而回滚。
   */
  async deleteByDocument(documentId: number): Promise<number> {
    const result = await this.ruleRepo.delete({ documentId });
    const count = result.affected ?? 0;
    if (count > 0) {
      logger.info('级联删除文档表格规则', { module: 'TableRuleService', documentId, count });
    }
    return count;
  }

  // ==================== 检查 / 修复 ====================

  /**
   * 加载文档的启用规则（AI 指令执行前校验 + 检查/修复共用）。
   * 脏数据（JSON 解析失败）跳过并记日志，绝不抛错中断检查。
   */
  async getEnabledRules(documentId: number): Promise<TableRuleRuntime[]> {
    const rows = await this.ruleRepo.find({
      where: { documentId, enabled: true },
      order: { id: 'ASC' },
    });
    const rules: TableRuleRuntime[] = [];
    for (const row of rows) {
      const parsed = parseTableRuleJson(
        row.id,
        row.name,
        row.type,
        row.paramsJson,
        row.fixActionJson,
      );
      if (parsed) {
        rules.push(parsed);
      } else {
        logger.warn('表格规则数据损坏，已跳过（请在面板中修复或删除）', {
          module: 'TableRuleService',
          ruleId: row.id,
          ruleName: row.name,
          ruleType: row.type,
        });
      }
    }
    return rules;
  }

  /**
   * 对编辑器当前文本做规则检查（干跑，无副作用）。
   * 前端把"检查"按钮的违规清单展示给用户，确认后调 fix。
   */
  async checkRulesForText(documentId: number, sheetText: string): Promise<RuleCheckResult> {
    const rules = await this.getEnabledRules(documentId);
    const result = checkRules(sheetText, rules);
    logger.info('表格规则检查完成', {
      module: 'TableRuleService',
      documentId,
      enabledRules: rules.length,
      checkedRules: result.checkedRules,
      violations: result.violations.length,
      invalidRules: result.invalidRules.length,
      truncated: result.truncated,
    });
    return result;
  }

  /**
   * 按违规清单应用修复动作（用户在面板确认后才调用）。
   *
   * 行号防篡改：服务端以"当前文本重新检查"的结果为基准，只应用
   * 前端回传清单与新检查结果的交集——文本在检查后又被编辑过的行
   * 自动跳过，绝不按过期行号改错数据。
   */
  async fixRulesForText(
    documentId: number,
    sheetText: string,
    items: RuleFixItem[],
  ): Promise<{ sheetText: string; report: RuleFixReportItem[]; skippedStale: number }> {
    const rules = await this.getEnabledRules(documentId);
    const fresh = checkRules(sheetText, rules);
    // 新检查结果索引：ruleId:rowIndex → 完整违规记录
    const freshMap = new Map<string, RuleViolation>();
    for (const v of fresh.violations) {
      freshMap.set(`${v.ruleId}:${v.rowIndex}`, v);
    }

    const matched: RuleViolation[] = [];
    const seen = new Set<string>();
    let skippedStale = 0;
    for (const item of items) {
      const key = `${item.ruleId}:${item.rowIndex}`;
      if (seen.has(key)) continue; // 去重
      const v = freshMap.get(key);
      if (v) {
        matched.push(v);
        seen.add(key);
      } else {
        skippedStale += 1;
      }
    }

    if (matched.length === 0) {
      return {
        sheetText,
        report: [
          {
            ruleId: 0,
            ruleName: '(全部)',
            message: skippedStale > 0
              ? `没有可修复的违规：${skippedStale} 项已失效（表格可能已被修改），请重新检查`
              : '没有可修复的违规',
          },
        ],
        skippedStale,
      };
    }

    const fixResult = applyRuleFixes(sheetText, rules, matched);
    logger.info('表格规则修复完成', {
      module: 'TableRuleService',
      documentId,
      applied: matched.length,
      skippedStale,
    });
    return { sheetText: fixResult.sheetText, report: fixResult.report, skippedStale };
  }

  // ==================== AI 提议 ====================

  /**
   * 列级统计（纯只读）：面板展示 + AI 提议规则的原料
   */
  buildStats(sheetText: string): SheetColumnStats[] {
    return buildColumnStats(sheetText);
  }

  /**
   * AI 看列级统计提议规则候选（不落库，面板展示给用户确认）
   */
  async suggestRules(sheetText: string): Promise<{
    stats: SheetColumnStats[];
    candidates: TableRuleInput[];
  }> {
    const stats = buildColumnStats(sheetText);
    const candidates = await suggestRulesFromStats(stats);
    logger.info('AI 规则提议完成', {
      module: 'TableRuleService',
      candidateCount: candidates.length,
    });
    return { stats, candidates };
  }

  // ==================== 内部工具 ====================

  /** DB 行 → DTO（JSON 字段已在写入侧 zod 校验，读取侧 parseTableRuleJson 兜底） */
  private serializeRule(row: TableRule): TableRuleDto {
    const runtime = parseTableRuleJson(
      row.id,
      row.name,
      row.type,
      row.paramsJson,
      row.fixActionJson,
    );
    // 历史脏数据兜底：解析失败时回显原始 JSON（面板可看到该条规则并手动修复/删除）
    let rawParams: unknown = {};
    try {
      rawParams = JSON.parse(row.paramsJson || '{}');
    } catch {
      /* JSON 本身损坏，回显空对象 */
    }
    return {
      id: row.id,
      documentId: row.documentId,
      name: row.name,
      type: runtime?.type ?? (row.type as TableRuleInput['type']),
      params: (runtime?.params ?? rawParams) as TableRuleInput['params'],
      fixAction: runtime?.fixAction,
      enabled: row.enabled,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
