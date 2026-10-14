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
import { parseTableOpsInstruction, isStructuredOutputUnavailable } from '../fundamentals/table-ops/parse.js';
import {
  buildModelConfig,
  createRateLimitedLLM,
  getCurrentModelId,
  getModelCapabilities,
} from '../fundamentals/model-provider.js';
import {
  buildSheetOverview,
  executeTableOps,
  TableOpsError,
} from '../fundamentals/table-ops/executor.js';
import {
  describeOpPending,
  runReactiveOps,
  type TableOpsProgressEvent,
} from '../fundamentals/table-ops/react.js';
import {
  checkRules,
  diffViolations,
  formatViolationsByRule,
} from '../fundamentals/table-ops/rules.js';
import type { RuleCheckResult, TableRuleRuntime } from '../fundamentals/table-ops/rules.js';
import {
  buildClarifyPayload,
  checkOpsCompleteness,
  compileStrategies,
  hashSheetText,
  type ClarifyPayload,
  type Strategy,
} from '../fundamentals/table-ops/clarify.js';
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
  /**
   * ReAct 循环的整体结果总结（模型 done 时产出，面向用户的一句话总结）；
   * 降级旧路径时省略。前端展示在执行报告顶部
   */
  summary?: string;
  /**
   * clarify 反问载荷（两阶段交互第一阶段的结果）：指令存在数据依赖不明
   * （填充来源/关联键/更新条件/公式影响面/删除范围）时携带。ok=true 表示
   * 请求本身成功处理——但**未执行任何数据修改**，前端渲染确认卡，
   * 用户选定策略后调 confirm 端点完成第二阶段
   */
  clarify?: ClarifyPayload;
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
   * 加载文档的启用规则（失败只记日志返回空数组——规则器是增强护栏，
   * 不因自身故障拖垮表格指令主链路）。run / confirm 两条链路共用。
   */
  private async loadRulesSafe(documentId?: number): Promise<TableRuleRuntime[]> {
    if (documentId === undefined) return [];
    try {
      return await this.tableRuleService.getEnabledRules(documentId);
    } catch (err) {
      logger.error('加载表格规则失败，本次指令跳过规则校验', {
        module: 'TableOpsService',
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 执行一条 AI 表格指令（ReAct 工具循环主路径 + 一次性解析降级路径）
   *
   * 主路径：模型逐轮决策"本轮选哪个操作"，执行器执行后把结果作为观察回喂
   * 模型自我纠正；每轮通过 onProgress 实时推送进度事件（SSE）。
   * 降级路径：模型不支持结构化输出 / 决策连续失败时，走旧的一次性解析 + 批量执行。
   *
   * @param instruction 自然语言指令
   * @param sheetText   编辑器当前的 sheet 结构化文本（含未保存编辑，与用户所见一致）
   * @param documentId  文档 ID（可选）：传入后每个操作执行后过该文档的启用规则
   *                    （功能 5，基线差集语义——只拒新增违规，违规即回滚该步）
   * @param onProgress  进度事件监听（SSE 推送；省略时无实时进度）
   */
  async run(
    instruction: string,
    sheetText: string,
    documentId?: number,
    onProgress?: (event: TableOpsProgressEvent) => void,
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

    // 规则加载提前（ReAct 逐 op 门禁、旧路径整体门禁与 confirm 执行门禁共用；
    // 加载失败只记日志放行——规则器是增强护栏，不因自身故障拖垮表格指令主链路）
    const rules = await this.loadRulesSafe(documentId);

    try {
      // ReAct 主路径：静态能力标注 + 进程级记忆都不命中才走（thinking 模型等
      // 不支持 tool_choice 的端点走旧路径，避免每次指令白打 400）
      const modelId = getCurrentModelId();
      if (
        getModelCapabilities(modelId).supportsToolChoice &&
        !isStructuredOutputUnavailable(modelId)
      ) {
        const modelConfig = buildModelConfig(modelId);
        // 逐轮决策要稳定，温度 0 减少发散（与旧路径解析一致）
        modelConfig.temperature = 0;
        const llm = createRateLimitedLLM(modelConfig, 'fast');
        const outcome = await runReactiveOps({
          instruction: trimmedInstruction,
          sheetText,
          overview,
          llm,
          modelId,
          rules,
          onProgress,
        });
        if (outcome.kind === 'semanticFill') {
          // 仅当闸门无法解析文本（clarify.ts gate === null）时可达——文本可解析时
          // semanticFill 已被闸门转为 fill-source clarify（推断型填充永不静默执行）。
          // 用循环中间态文本——前几轮已执行的操作结果要延续，不能回退到原始文本
          return this.runSemanticFill(
            trimmedInstruction,
            outcome.sheetText,
            outcome.op,
            documentId,
          );
        }
        if (outcome.kind === 'clarify') {
          // 两阶段交互第一阶段完成：反问载荷回传前端，数据修改等待用户确认
          logger.info('表格指令触发 clarify 反问', {
            module: 'TableOpsService',
            kind: outcome.payload.kind,
            question: outcome.payload.question.slice(0, 100),
          });
          return { ok: true, clarify: outcome.payload };
        }
        if (outcome.kind === 'done') {
          logger.info('表格指令执行成功（ReAct）', {
            module: 'TableOpsService',
            opCount: outcome.report.length,
            opTypes: outcome.report.map((r) => r.type).join(','),
            textLength: outcome.sheetText.length,
          });
          return {
            ok: true,
            sheetText: outcome.sheetText,
            report: outcome.report,
            summary: outcome.summary,
          };
        }
        logger.warn('ReAct 循环降级为一次性解析路径', {
          module: 'TableOpsService',
          reason: outcome.reason,
        });
      }

      // 降级路径：一次性解析 + 批量执行 + 整体门禁（历史主路径，行为不变）
      return await this.runLegacy(
        trimmedInstruction,
        sheetText,
        overview,
        rules,
        documentId,
        onProgress,
      );
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

  // ==================== 降级路径（一次性解析 + 批量执行，历史行为） ====================

  /**
   * 旧主路径（现为降级出口）：一次解析全部 ops → 批量执行 → 整体门禁。
   * 行为与 ReAct 主路径上线前完全一致——降级不能引入行为差异。
   *
   * 进度推送下沉：旧路径虽无逐轮决策，但解析出 ops 后要做什么、执行结果如何
   * 都是已知信息——照发 thought/action/observation 事件（seq 独立计数，单指令
   * 只走一条路径，与 ReAct 内部计数不冲突）。thinking 模型等永远走本路径的
   * 用户也能实时看到"正在做什么、做成了什么"，不再黑盒。
   */
  private async runLegacy(
    instruction: string,
    sheetText: string,
    overview: string,
    rules: TableRuleRuntime[],
    documentId?: number,
    onProgress?: (event: TableOpsProgressEvent) => void,
  ): Promise<TableOpsRunResult> {
    // 进度发射器：seq 从 1 递增（与 react.ts 的事件结构一致）
    let seq = 0;
    const emit = (phase: TableOpsProgressEvent['phase'], text: string): void => {
      onProgress?.({ seq: ++seq, phase, text });
    };
    try {
      // 1. LLM 解析（意图 → 操作序列；参数不明 → needsClarify 反问请求）
      const { ops, needsClarify } = await parseTableOpsInstruction(instruction, overview);

      // 1.2 LLM 自报反问（参数不明）：措辞用模型的 question，选项内容仍由
      //     确定性分析器产出——绝不让 LLM 提供选项（防选项幻觉）
      if (needsClarify) {
        const syntheticGate = {
          action: 'clarify' as const,
          kind: needsClarify.kind,
          opIndex: 0,
          reason: needsClarify.question,
        };
        const payload = buildClarifyPayload(sheetText, syntheticGate, [], needsClarify.question);
        payload.baseSheetText = sheetText;
        payload.baseSheetTextHash = hashSheetText(sheetText);
        // 发起时原文 hash：confirm 校验编辑器实时文本（卡片停留期间的编辑检测）
        payload.originSheetTextHash = hashSheetText(sheetText);
        emit('action', `需要向你确认：${needsClarify.question}`);
        return { ok: true, clarify: payload };
      }

      if (ops.length === 0) {
        logger.info('表格指令两轮解析均为空操作（含自动重试）', {
          module: 'TableOpsService',
          instruction: instruction.slice(0, 200),
        });
        return {
          ok: false,
          message: 'AI 认为该指令无需执行任何操作（可能表格已满足要求），请换一种说法重试',
        };
      }

      // 1.4 完备性闸门（权威兜底，先于语义填充分流）：数据依赖参数不全的操作
      //     转用户确认（clarify），无条件删除直接拒绝（本路径无回喂模型机制）
      const gate = checkOpsCompleteness(sheetText, ops);
      if (gate) {
        if (gate.action === 'reject') {
          emit('observation', `操作被拒绝：${gate.reason}`);
          return { ok: false, message: gate.reason };
        }
        const payload = buildClarifyPayload(sheetText, gate, ops);
        payload.baseSheetText = sheetText;
        payload.baseSheetTextHash = hashSheetText(sheetText);
        // 发起时原文 hash：confirm 校验编辑器实时文本（卡片停留期间的编辑检测）
        payload.originSheetTextHash = hashSheetText(sheetText);
        emit('action', `需要向你确认：${payload.question}`);
        logger.info('表格指令触发 clarify 反问（降级路径）', {
          module: 'TableOpsService',
          kind: payload.kind,
          question: payload.question.slice(0, 100),
        });
        return { ok: true, clarify: payload };
      }

      // 1.5 语义填充分流（功能 4）：仅当闸门无法解析文本（gate === null）时可达——
      //     文本可解析时 semanticFill 已被闸门转为 fill-source clarify
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
        emit('action', describeOpPending(semanticFillOp));
        return this.runSemanticFill(instruction, sheetText, semanticFillOp, documentId);
      }

      // 解析成功：先报计划（模型"想"了什么这里没有逐轮记录，用确定的操作数代替）
      emit(
        'thought',
        `已从指令解析出 ${ops.length} 个操作：${ops.map((o) => o.type).join('、')}，开始执行`,
      );

      // 2. 执行器精确执行（引用校验失败 / 护栏拦截 → TableOpsError）。
      //    执行是纯函数不改入参——先跑出最终态再统一过规则，等价于"干跑→全查→
      //    全过才应用"，且只执行一次（大表省一半计算）
      //    事件顺序与真实发生顺序一致：批量执行前逐个报"正在做什么"，
      //    执行完成后逐个报结果
      for (const op of ops) {
        emit('action', describeOpPending(op));
      }
      const { sheetText: nextText, report } = executeTableOps(sheetText, ops);
      for (const r of report) {
        emit('observation', r.message);
      }

      // 3. 规则门禁（功能 5，根治语义）：只拒绝本次操作**新增**的违规——
      //    对比执行前基线（多重集差集），文档既有违规不拦截与它无关的指令
      //    （否则任何指令在脏数据文档上都会被永远卡死），只在文案提示数量
      if (rules.length > 0) {
        const check = checkRules(nextText, rules);
        const baselineCheck = checkRules(sheetText, rules);
        const fresh = diffViolations(baselineCheck.violations, check.violations);
        if (fresh.length > 0) {
          const freshCheck: RuleCheckResult = { ...check, violations: fresh };
          // 按规则聚合文案：规则名 + 违规数 + 前 3 个行号样本（与语义填充门禁共用）
          const detail = formatViolationsByRule(freshCheck);
          const preExisting = check.violations.length - fresh.length;
          logger.info('表格指令被规则门禁整体拒绝（新增违规）', {
            module: 'TableOpsService',
            freshViolations: fresh.length,
            preExistingViolations: preExisting,
          });
          emit('observation', `执行被规则门禁拦截（新增 ${fresh.length} 处违规），已整体撤销`);
          return {
            ok: false,
            message:
              `该指令执行后的结果会新增违反表格规则的内容（${fresh.length} 处）：${detail}，` +
              '已整体拒绝。请调整指令，或在规则面板处理这些规则' +
              (preExisting > 0
                ? `（文档另有 ${preExisting} 处既有违规与本次操作无关，未被拦截）`
                : '') +
              '。',
            ruleViolations: freshCheck,
          };
        }
      }

      logger.info('表格指令执行成功（降级路径）', {
        module: 'TableOpsService',
        opCount: ops.length,
        opTypes: ops.map((o) => o.type).join(','),
        textLength: nextText.length,
      });

      return { ok: true, sheetText: nextText, report, ops };
    } catch (err) {
      // TableOpsError 是可预期业务错误（列不存在/护栏等），面向用户返回原因
      if (err instanceof TableOpsError) {
        // 执行已开始（action 已发出）才需要失败观察；解析期抛错时进度还是空的
        if (seq > 0) emit('observation', `执行失败：${err.message}`);
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
        ...(op.referenceSheet !== undefined ? { referenceSheet: op.referenceSheet } : {}),
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
          message: `已按 ${preview.hintColumns.join('、')} 推断并填充「${preview.targetColumn}」列 ${preview.appliedRows} 个空缺单元格${op.referenceSheet ? `（参照「${op.referenceSheet}」）` : ''}`,
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

  // ==================== clarify 确认（两阶段交互的第二阶段，无 LLM） ====================

  /**
   * 执行用户确认后的 clarify 策略（confirm 端点的业务入口）。
   *
   * 全程无 LLM：策略 → compileStrategies 编译为确定性 ops → 执行器精确执行
   * → 规则门禁。执行基底是 clarify 载荷回传的 baseSheetText（ReAct 中途
   * clarify 时为已执行前缀的结果文本），并做 hash 校验，防止"反问后表格被
   * 编辑过，确认却在旧数据上执行"（TOCTOU）。
   *
   * @param params.sheetText    执行基底文本（= clarify.baseSheetText，前端原样回传）
   * @param params.sheetTextHash 基底文本的 sha1（clarify 载荷携带，前端原样回传）
   * @param params.clarify      clarify 载荷（含 baseOps/pendingOps 切分）
   * @param params.strategies   用户选定的策略（前端单选；数组形式防御性兼容）
   * @param params.instruction  原始指令（AI 映射策略转语义填充时作映射提示）
   * @param params.documentId   规则门禁用
   * @param params.onProgress   进度事件监听（SSE）
   */
  async confirm(params: {
    sheetText: string;
    sheetTextHash: string;
    /** confirm 时编辑器实时文本（originSheetTextHash 存在时必传，见下） */
    liveSheetText?: string;
    clarify: ClarifyPayload;
    strategies: Strategy[];
    instruction?: string;
    documentId?: number;
    onProgress?: (event: TableOpsProgressEvent) => void;
  }): Promise<TableOpsRunResult> {
    const { sheetText, sheetTextHash, liveSheetText, clarify, strategies, documentId, onProgress } = params;
    let seq = 0;
    const emit = (phase: TableOpsProgressEvent['phase'], text: string): void => {
      onProgress?.({ seq: ++seq, phase, text });
    };

    // TOCTOU 防护：执行基底必须与反问时一致（用户中途编辑过表格则拒绝）
    if (!sheetText.trim()) return { ok: false, message: '表格内容为空' };
    if (clarify.baseSheetText !== undefined && clarify.baseSheetText !== sheetText) {
      return { ok: false, message: '确认数据与发起反问时不一致，请重新发起指令' };
    }
    if (hashSheetText(sheetText) !== sheetTextHash) {
      return { ok: false, message: '表格内容已发生变化，请重新发起指令后再确认' };
    }
    // 编辑器实时文本校验：ReAct 中途 clarify 的执行基底是中间态（baseSheetText，
    // 编辑器里没有），对它校验恒真、防不住卡片停留期间的用户编辑——
    // 由前端随请求附带实时序列化文本，凭 originSheetTextHash 校验原文未变
    if (clarify.originSheetTextHash !== undefined) {
      const live = liveSheetText ?? sheetText;
      if (hashSheetText(live) !== clarify.originSheetTextHash) {
        return { ok: false, message: '表格内容已发生变化，请重新发起指令后再确认' };
      }
    }

    try {
      const rules = await this.loadRulesSafe(documentId);

      // AI 映射策略：不在编译器处理——转语义填充预览（决策 3：LLM 映射降级为
      // 预览选项，mapping 路径永不静默自动应用）
      const aiMapping = strategies.find(
        (s): s is Extract<Strategy, { type: 'ai-mapping-preview' }> =>
          s.type === 'ai-mapping-preview',
      );
      if (aiMapping) {
        const op: TableOp & { type: 'semanticFill' } = {
          type: 'semanticFill',
          targetColumn: aiMapping.targetColumn,
          ...(aiMapping.targetSheet !== undefined ? { targetSheet: aiMapping.targetSheet } : {}),
          ...(aiMapping.basisColumns.length > 0 ? { hintColumns: aiMapping.basisColumns } : {}),
        };
        emit('action', describeOpPending(op));
        return this.runSemanticFill(
          params.instruction?.trim() || clarify.question,
          sheetText,
          op,
          documentId,
        );
      }

      // 策略 → 确定性 ops（用户确认后无 LLM 参与）：确定性前缀 + 编译产物
      const compiled = compileStrategies(sheetText, strategies, clarify.pendingOps ?? []);
      const ops: TableOp[] = [...(clarify.baseOps ?? []), ...compiled];
      if (ops.length === 0) {
        // keep-empty 等"放弃"策略：表格保持不变
        return {
          ok: true,
          sheetText,
          report: [],
          message: '已按你的选择跳过本次操作，表格保持不变',
        };
      }

      emit('thought', `已按你的确认生成 ${ops.length} 个确定性操作，开始执行`);
      for (const op of ops) emit('action', describeOpPending(op));
      const { sheetText: nextText, report } = executeTableOps(sheetText, ops);
      for (const r of report) emit('observation', r.message);

      // 规则门禁（基线差集语义，与主路径一致）：确认的策略也可能产生新违规
      if (rules.length > 0) {
        const check = checkRules(nextText, rules);
        const baselineCheck = checkRules(sheetText, rules);
        const fresh = diffViolations(baselineCheck.violations, check.violations);
        if (fresh.length > 0) {
          const freshCheck: RuleCheckResult = { ...check, violations: fresh };
          const detail = formatViolationsByRule(freshCheck);
          logger.info('confirm 执行被规则门禁拒绝（新增违规）', {
            module: 'TableOpsService',
            freshViolations: fresh.length,
          });
          emit('observation', `执行被规则门禁拦截（新增 ${fresh.length} 处违规），已整体撤销`);
          return {
            ok: false,
            message: `确认后的操作会新增违反表格规则的内容（${fresh.length} 处）：${detail}，已整体拒绝。`,
            ruleViolations: freshCheck,
          };
        }
      }

      logger.info('clarify 确认执行成功', {
        module: 'TableOpsService',
        strategyTypes: strategies.map((s) => s.type).join(','),
        opCount: ops.length,
        opTypes: ops.map((o) => o.type).join(','),
        textLength: nextText.length,
      });
      return { ok: true, sheetText: nextText, report, ops };
    } catch (err) {
      if (err instanceof TableOpsError) {
        if (seq > 0) emit('observation', `执行失败：${err.message}`);
        logger.warn('clarify 确认执行被拒绝', {
          module: 'TableOpsService',
          reason: err.message,
        });
        return { ok: false, message: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('clarify 确认执行失败', {
        module: 'TableOpsService',
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { ok: false, message };
    }
  }
}
