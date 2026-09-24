/**
 * 引用解析模块（可验证生成）
 *
 * 职责：把模型在回答中输出的（【文档 X】）来源标注，解析为可定位的引用条目
 * （文档 id + 标题 + 片段预览），供前端角标 chip 与"参考来源"卡片展示。
 *
 * 与 rag-service.buildContextWithSources 的契约：
 * sources 的 index 与上下文中的【文档 N】编号严格同源（同一分组循环产出），
 * 因此解析只需按编号查表；模型幻觉出的编号（参考资料中不存在）查不到表，
 * 归入 invalidRefs 剔除并记日志，绝不静默丢弃（工作区规范：zod 失败不吞错）。
 */

import { z } from 'zod';
import { logger } from './logger.js';

// ==================== Zod Schema ====================

/**
 * 单次回答引用列表上限。
 * schema 的 max 与 resolveCitations 的截断必须同源（同一常量）：
 * resolveCitations 先截断到上限，sendCitations 出口的校验才不会因数量超限失败
 * （失败即整批引用被丢弃，前端只剩静态角标、无来源卡片）。
 * FC 路径的 fcDocSources 跨工具轮次累计无上限，21+ 条完全可达，截断不可省。
 */
export const MAX_CITATIONS = 20;

/** 单条引用（SSE citations 事件与前端 Message.citations 的元素结构） */
export const CitationItemSchema = z.object({
  /** 与上下文中的【文档 N】编号一致（1 起），前端角标显示用 */
  ref: z
    .number()
    .int()
    .min(1)
    .describe('引用的文档编号，对应上下文中的【文档 N】'),
  /** 文档唯一 id（引用定位主键） */
  documentId: z.string().min(1).describe('来源文档唯一标识'),
  /** 文档展示标题（documentTitle 优先，退化文件名） */
  title: z.string().min(1).describe('来源文档标题'),
  /** 来源文档首块内容预览（约 120 字符），来源卡片展示用 */
  snippet: z.string().describe('来源内容片段预览'),
});

export type CitationItem = z.infer<typeof CitationItemSchema>;

/** citations 事件的完整载荷 schema（sendCitations 出口校验用） */
export const CitationsEventSchema = z.object({
  citations: z
    .array(CitationItemSchema)
    .max(MAX_CITATIONS)
    .describe('本次回答的引用列表，按标注出现顺序'),
});

/** buildContextWithSources 产出的来源映射条目（结构化子集，避免循环依赖 rag-service） */
export interface DocSourceEntry {
  index: number;
  documentId: string;
  title: string;
  snippet: string;
}

// ==================== 标注提取 ====================

/**
 * 从模型回答中提取（【文档 X】）标注的编号（按出现顺序去重）。
 *
 * 兼容两种形态：全角括号包裹的（【文档 X】）与裸【文档 X】（模型输出存在变体）；
 * 同一编号多次出现只保留首次（引用列表按文档去重，出现顺序即首次标注顺序）。
 * 【图片 N】不会被匹配（仅匹配"文档"字样）。
 */
export function extractCitationRefs(text: string): number[] {
  const refs: number[] = [];
  const seen = new Set<number>();
  const pattern = /【文档\s*(\d+)】/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const n = Number.parseInt(m[1], 10);
    if (!seen.has(n)) {
      seen.add(n);
      refs.push(n);
    }
  }
  return refs;
}

// ==================== 引用解析 ====================

/**
 * 把回答中的标注编号解析为引用条目。
 *
 * - 命中 sources 的编号 → CitationItem（title/snippet 取自检索元数据）；
 * - 未命中的编号 → invalidRefs（模型幻觉，调用方记日志后丢弃）；
 * - answers 全文无任何标注 → citations 为空数组（调用方不发 citations 事件）；
 * - 命中数超过 MAX_CITATIONS 时按出现顺序截断前 MAX_CITATIONS 条——
 *   下游 sendCitations 出口的 zod max 校验会因超量失败，整批引用被丢弃；
 * - 单条命中但结构非法（如元数据缺 documentId/title）时记 warn 日志并跳过，
 *   其余引用照常返回。**本函数不抛错**：调用点的 res.end() 在其之后，
 *   抛错会阻断 SSE 关闭（前端流挂死 + 本轮消息不落库）。
 */
export function resolveCitations(
  text: string,
  sources: DocSourceEntry[],
): { citations: CitationItem[]; invalidRefs: number[] } {
  const byIndex = new Map<number, DocSourceEntry>();
  for (const s of sources) byIndex.set(s.index, s);

  const citations: CitationItem[] = [];
  const invalidRefs: number[] = [];
  for (const ref of extractCitationRefs(text)) {
    const src = byIndex.get(ref);
    if (!src) {
      invalidRefs.push(ref);
      continue;
    }
    // 用 safeParse 而非 parse：parse 抛错会冒泡到调用点（prompt.ts）跳过 res.end()，
    // 导致 SSE 流不关闭（前端流挂死 + 消息不落库），且一条脏数据会炸掉整批引用。
    // 这里降级为"单条失败记日志并跳过"，其余引用照常推送；不吞错，issues 全量留痕。
    const parsed = CitationItemSchema.safeParse({
      ref,
      documentId: src.documentId,
      title: src.title,
      snippet: src.snippet,
    });
    if (!parsed.success) {
      logger.warn('引用条目结构非法，已跳过该条（其余引用照常推送）', {
        module: 'CitationsResolver',
        ref,
        documentId: src.documentId,
        title: src.title,
        issues: parsed.error.issues.map(
          (i) => `${i.path.join('.')}: ${i.message}`,
        ),
      });
      continue;
    }
    citations.push(parsed.data);
  }
  return { citations: citations.slice(0, MAX_CITATIONS), invalidRefs };
}
