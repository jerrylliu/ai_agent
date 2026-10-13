/**
 * services/table-ops.service.ts
 *
 * AI 表格指令编排服务（M2 指令下推）。
 *
 * 流程：指令 + 表格文本 → LLM 解析操作序列（parse.ts）→
 *       执行器精确执行（executor.ts）→ 新文本 + 执行报告。
 *
 * 结果不直接写库/写版本：返回给前端后，用户在编辑器里确认应用、
 * 手动保存 → 走既有版本链落新版本。确认 UX 由前端负责，
 * 服务端保持"纯计算、无副作用"。
 */

import { Injectable } from '@nestjs/common';
import { logger } from '../fundamentals/logger.js';
import { parseTableOpsInstruction } from '../fundamentals/table-ops/parse.js';
import {
  buildSheetOverview,
  executeTableOps,
  TableOpsError,
} from '../fundamentals/table-ops/executor.js';
import {
  checkRules,
  formatViolationsByRule,
} from '../fundamentals/table-ops/rules.js';
import type { RuleCheckResult, TableRuleRuntime } from '../fundamentals/table-ops/rules.js';
import { TableRuleService } from './table-rule.service.js';
import {
  SemanticFillService,
  type SemanticFillMappingResult,
  type SemanticFillBatchQuote,
} from './semantic-fill.service.js';
import type { OpReport, TableOp } from '../fundamentals/table-ops/schema.js';

/** 语义填充结果字段（TableOpsRunResult.semanticFill）：
 *  path='mapping' 映射路径已完成（sheetText 同步给出，前端展示映射明细+规则提议）；
 *  path='batch'   分批报价（无 sheetText，前端确认后调 semantic-fill/start 建任务） */
export type SemanticFillInfo = SemanticFillMappingResult | SemanticFillBatchQuote;

/** 表格指令执行结果（HTTP 响应体） */
export interface TableOpsRunResult {
  /** 是否成功（false 时 message 说明原因，sheetText/report 为空） */
  ok: boolean;
  /** 执行后的完整 sheet 结构化文本（前端转回表格节点）；分批报价时省略 */
  sheetText?: string;
  /** 逐操作执行报告 */
  report?: OpReport[];
  /** 解析出的操作序列（调试/前端展示用） */
  ops?: TableOp[];
  /** 失败原因（ok=false 时必有） */
  message?: string;
  /**
   * 规则校验结果（功能 5）：整体拒绝时携带，前端可展开违规明细；
   * 通过时省略
   */
  ruleViolations?: RuleCheckResult;
  /** 语义填充（功能 4）：命中 semanticFill 意图时携带映射结果或分批报价 */
  semanticFill?: SemanticFillInfo;
}

/** 指令长度上限（字符） */
const MAX_INSTRUCTION_LENGTH = 2000;
/** 表格文本长度上限（字符）——2 万行 × 平均 80 字符/行 再放大一倍，足够宽裕 */
const MAX_SHEET_TEXT_LENGTH = 3_000_000;

@Injectable()
export class TableOpsService {
  constructor(
    private readonly tableRuleService: TableRuleService,
    private readonly semanticFillService: SemanticFillService,
  ) {}

  /**
   * 执行一条 AI 表格指令
   *
   * @param instruction 自然语言指令
   * @param sheetText   编辑器当前的 sheet 结构化文本（含未保存编辑，与用户所见一致）
   * @param documentId  文档 ID（可选）：已保存文档传入后，执行结果先过该文档的
   *                    启用规则（功能 5"AI 所有表格指令执行前过规则"）——
   *                    整个计划先跑出最终态，规则统一全查（不在中间态逐操作查，
   *                    避免临时违规误报），违规整体拒绝并指出违反哪条
   */
  async run(
    instruction: string,
    sheetText: string,
    documentId?: number,
  ): Promise<TableOpsRunResult> {
    // 入参护栏（controller 的 zod 只校验类型/长度，这里做业务级校验）
    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction) {
      return { ok: false, message: '指令不能为空' };
    }
    if (trimmedInstruction.length > MAX_INSTRUCTION_LENGTH) {
      return { ok: false, message: `指令过长（上限 ${MAX_INSTRUCTION_LENGTH} 字）` };
    }
    if (!sheetText.trim()) {
      return { ok: false, message: '表格内容为空' };
    }
    if (sheetText.length > MAX_SHEET_TEXT_LENGTH) {
      return { ok: false, message: '表格数据过大，请先拆分工作表' };
    }

    const overview = buildSheetOverview(sheetText);

    try {
      // 1. LLM 解析（意图 → 操作序列）
      const ops = await parseTableOpsInstruction(trimmedInstruction, overview);
      if (ops.length === 0) {
        logger.info('表格指令无法解析出操作', {
          module: 'TableOpsService',
          instruction: trimmedInstruction.slice(0, 200),
        });
        return {
          ok: false,
          message: 'AI 未能理解该指令，请明确写出列名和操作方式后重试',
        };
      }

      // 1.5 语义填充分流（功能 4）：semanticFill 是 LLM 推断型操作，
      //     不进纯函数执行器——检测到后整体转交 SemanticFillService
      const semanticFillOp = ops.find(
        (o): o is TableOp & { type: 'semanticFill' } => o.type === 'semanticFill',
      );
      if (semanticFillOp) {
        if (ops.length > 1) {
          return {
            ok: false,
            message: '语义填充不能与其他表格操作混在一条指令里，请分开执行',
          };
        }
        return this.runSemanticFill(trimmedInstruction, sheetText, semanticFillOp, documentId);
      }

      // 2. 执行器精确执行（引用校验失败 / 护栏拦截 → TableOpsError）。
      //    执行是纯函数不改入参——先跑出最终态再统一过规则，等价于"干跑→全查→
      //    全过才应用"，且只执行一次（大表省一半计算）
      const { sheetText: nextText, report } = executeTableOps(sheetText, ops);

      // 3. 规则门禁（功能 5）：文档已保存且配置了启用规则时，对最终态统一全查，
      //    违规整体拒绝并指出违反哪条。规则加载失败只记日志放行——规则器是
      //    增强护栏，不因自身故障拖垮表格指令主链路
      if (documentId !== undefined) {
        let rules: TableRuleRuntime[] = [];
        try {
          rules = await this.tableRuleService.getEnabledRules(documentId);
        } catch (err) {
          logger.error('加载表格规则失败，本次指令跳过规则校验', {
            module: 'TableOpsService',
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
          rules = [];
        }
        if (rules.length > 0) {
          const check = checkRules(nextText, rules);
          if (check.violations.length > 0) {
            // 按规则聚合文案：规则名 + 违规数 + 前 3 个行号样本（与语义填充门禁共用）
            const detail = formatViolationsByRule(check);
            logger.info('表格指令被规则门禁整体拒绝', {
              module: 'TableOpsService',
              documentId,
              violationCount: check.violations.length,
            });
            return {
              ok: false,
              message: `该指令执行后的结果会违反表格规则，已整体拒绝（${check.violations.length} 处违规）：${detail}。请调整指令，或先在规则面板处理这些规则。`,
              ruleViolations: check,
            };
          }
        }
      }

      logger.info('表格指令执行成功', {
        module: 'TableOpsService',
        opCount: ops.length,
        opTypes: ops.map((o) => o.type).join(','),
        textLength: nextText.length,
      });

      return { ok: true, sheetText: nextText, report, ops };
    } catch (err) {
      // TableOpsError 是可预期业务错误（列不存在/护栏等），面向用户返回原因
      if (err instanceof TableOpsError) {
        logger.warn('表格指令执行被拒绝', {
          module: 'TableOpsService',
          reason: err.message,
        });
        return { ok: false, message: err.message };
      }

      // LLM 解析失败（parse.ts 抛出）或其他未知异常
      const message = err instanceof Error ? err.message : String(err);
      logger.error('表格指令执行失败', {
        module: 'TableOpsService',
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { ok: false, message };
    }
  }

  // ==================== 语义填充分流（功能 4） ====================

  /**
   * 语义填充路径：转交 SemanticFillService 做路径决策与执行。
   *
   *   - 映射路径：preview 内同步完成 LLM 推断 + 应用 + 规则门禁，
   *     返回 sheetText + report + semanticFill（映射明细/规则提议给前端展示）；
   *   - 分批报价：不执行，semanticFill.path='batch' 原样返回，
   *     前端向用户确认报价后再调 semantic-fill/start 创建任务；
   *   - 门禁拒绝：转 ok:false + 违规明细（与普通指令门禁同一响应形状）。
   */
  private async runSemanticFill(
    instruction: string,
    sheetText: string,
    op: TableOp & { type: 'semanticFill' },
    documentId?: number,
  ): Promise<TableOpsRunResult> {
    try {
      const preview = await this.semanticFillService.preview({
        instruction,
        sheetText,
        targetColumn: op.targetColumn,
        hintColumns: op.hintColumns ?? [],
        ...(op.targetSheet !== undefined ? { targetSheet: op.targetSheet } : {}),
        ...(documentId !== undefined ? { documentId } : {}),
      });

      // 门禁拒绝最先判（ok 是布尔判别字段，判 false 后剩余联合只剩映射结果/分批报价）
      if (preview.ok === false) {
        return { ok: false, message: preview.message, ruleViolations: preview.ruleViolations };
      }

      // 分批报价：无副作用，前端确认后才真正开始
      if (preview.path === 'batch') {
        return { ok: true, semanticFill: preview };
      }

      // 映射路径成功
      const report: OpReport[] = [
        {
          type: 'semanticFill',
          targetSheet: op.targetSheet ?? '',
          message: `已按 ${preview.hintColumns.join('、')} 推断并填充「${preview.targetColumn}」列 ${preview.appliedRows} 个空缺单元格`,
        },
      ];
      return {
        ok: true,
        sheetText: preview.filledText,
        report,
        ops: [op],
        semanticFill: preview,
      };
    } catch (err) {
      // 列不存在 / 没有空缺 / LLM 失败等——TableOpsError 面向用户，其余记完整日志
      if (err instanceof TableOpsError) {
        logger.warn('语义填充被拒绝', {
          module: 'TableOpsService',
          reason: err.message,
        });
        return { ok: false, message: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('语义填充执行失败', {
        module: 'TableOpsService',
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { ok: false, message };
    }
  }
}
