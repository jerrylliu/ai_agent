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
import type { OpReport, TableOp } from '../fundamentals/table-ops/schema.js';

/** 表格指令执行结果（HTTP 响应体） */
export interface TableOpsRunResult {
  /** 是否成功（false 时 message 说明原因，sheetText/report 为空） */
  ok: boolean;
  /** 执行后的完整 sheet 结构化文本（前端转回表格节点） */
  sheetText?: string;
  /** 逐操作执行报告 */
  report?: OpReport[];
  /** 解析出的操作序列（调试/前端展示用） */
  ops?: TableOp[];
  /** 失败原因（ok=false 时必有） */
  message?: string;
}

/** 指令长度上限（字符） */
const MAX_INSTRUCTION_LENGTH = 2000;
/** 表格文本长度上限（字符）——2 万行 × 平均 80 字符/行 再放大一倍，足够宽裕 */
const MAX_SHEET_TEXT_LENGTH = 3_000_000;

@Injectable()
export class TableOpsService {
  /**
   * 执行一条 AI 表格指令
   *
   * @param instruction 自然语言指令
   * @param sheetText   编辑器当前的 sheet 结构化文本（含未保存编辑，与用户所见一致）
   */
  async run(instruction: string, sheetText: string): Promise<TableOpsRunResult> {
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

      // 2. 执行器精确执行（引用校验失败 / 护栏拦截 → TableOpsError）
      const { sheetText: nextText, report } = executeTableOps(sheetText, ops);

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
}
