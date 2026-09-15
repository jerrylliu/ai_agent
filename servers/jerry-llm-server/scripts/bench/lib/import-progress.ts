/**
 * ERB 入库断点续传 checkpoint（benchmark-only，方案 §4.3 / S2.4）
 *
 * 职责：progress.json 的 zod schema 定义 + 原子读写。
 *
 * 🔴 一致性设计（S2.4 核心决策）：
 *    游标（docsConsumed）仅在批次边界（每 BATCH_SIZE 篇）与 saveBM25Index()
 *    锁步推进 —— 保证「progress.json 记录的游标」永远不超前于「BM25 已落盘态」。
 *    若游标细于 BM25 提交，硬中断后会出现「Chroma 有、BM25 落盘态缺」的大面积
 *    残缺（正是方案 §4.3 警示的"末尾索引残缺"陷阱）。
 *
 * 设计原则：
 *   1. 纯数据模块：不 import config / vector-store，便于单测；
 *   2. zod 校验读写两侧（红线：禁止裸 JSON.parse 后直接消费）；
 *   3. 原子写：先写 .tmp 再 rename，防止写 checkpoint 途中被 kill 产生半截文件。
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

// ==================== Zod Schema ====================

/** 运行指纹：续传前校验，防止用不同参数续同一份 checkpoint 造成语料错位 */
export const RunFingerprintSchema = z.object({
  /** 限定的 source_type；null 表示遍历全部 9 类 */
  sourceType: z.string().nullable().describe('限定单一 source_type，null=全部'),
  /** 文档数上限；null 表示不限 */
  limit: z.number().int().positive().nullable().describe('文档数上限，null=不限'),
});

/** 入库统计（与脚本内 Stats 接口同构，含续传修复计数） */
export const ProgressStatsSchema = z.object({
  docsImported: z.number().int().nonnegative(),
  docsSkipped: z.number().int().nonnegative(),
  docsFailed: z.number().int().nonnegative(),
  /** 续传修复通道：Chroma 已存在、仅补写 BM25 的文档数 */
  docsRepaired: z.number().int().nonnegative(),
  chunksAdded: z.number().int().nonnegative(),
  /** 已消耗嵌入 HTTP 调用次数（跨运行累计，预算不被续传重置） */
  embedCalls: z.number().int().nonnegative(),
});

/** progress.json 完整结构 */
export const ImportProgressSchema = z.object({
  /** schema 版本，便于将来演进时做兼容判断 */
  version: z.literal(1),
  /** 运行指纹（sourceType / limit） */
  runFingerprint: RunFingerprintSchema,
  /**
   * BM25 引擎类型（'minisearch' | 'tantivy'）。
   * 🔴 续传前必须与当前 config.bm25Engine 一致 —— 红线 #10 禁同进程混用、
   *    红线 #11 分数不可跨引擎对比，跨引擎续传会产生不可比对的混合索引。
   */
  bm25Engine: z.enum(['minisearch', 'tantivy']),
  /** 已从迭代器消费（处理完成）的文档数 = 续传时跳过的文档数 */
  docsConsumed: z.number().int().nonnegative(),
  /** 已完成并落盘的批次数（每批 BATCH_SIZE 篇） */
  batchesCompleted: z.number().int().nonnegative(),
  /** 累计统计 */
  stats: ProgressStatsSchema,
  /** 运行状态：in_progress=批次间快照；completed=语料耗尽；aborted=熔断/中断 */
  status: z.enum(['in_progress', 'completed', 'aborted']),
  /** 最后更新时间（ISO 8601） */
  updatedAt: z.string(),
});

export type ImportProgress = z.infer<typeof ImportProgressSchema>;
export type ProgressStats = z.infer<typeof ProgressStatsSchema>;
export type RunFingerprint = z.infer<typeof RunFingerprintSchema>;

// ==================== 读写 ====================

/**
 * 读取 checkpoint。
 *
 * @returns 解析并校验后的进度对象；文件不存在返回 null
 * @throws 文件存在但 JSON 损坏 / 不符合 schema 时抛错（fail-fast，不静默吞掉）
 */
export function readImportProgress(filePath: string): ImportProgress | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error: any) {
    throw new Error(`读取 checkpoint 失败（${filePath}）: ${error?.message ?? error}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error: any) {
    throw new Error(
      `checkpoint 不是合法 JSON（${filePath}），可能上次写入被中断；` +
        `请删除该文件后重新导入。原始错误: ${error?.message ?? error}`,
    );
  }

  const parsed = ImportProgressSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `checkpoint 结构校验失败（${filePath}）: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * 原子写 checkpoint：先写同目录 .tmp 再 rename 覆盖，
 * 防止写入途中进程被 kill 产生半截 JSON（rename 在同分区内是原子的）。
 */
export function writeImportProgress(filePath: string, progress: ImportProgress): void {
  const validated = ImportProgressSchema.parse(progress);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(validated, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}
