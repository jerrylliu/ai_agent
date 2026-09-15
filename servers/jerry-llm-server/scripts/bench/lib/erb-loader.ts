/**
 * EnterpriseRAG-Bench (ERB) 本地数据加载器
 *
 * 数据事实（已实测，D:\ragatest）：
 *   - 511,962 篇 .txt 文档，按 9 类 source_type 组织，且为「嵌套子目录」结构
 *     （如 confluence/applied-ml-and-evals/eval-harness/dsid_xxx__slug.txt），
 *     因此必须【递归遍历】，不能读平铺的 source_type/*.txt。
 *   - 文件名格式固定：dsid_<32位hex>__<slug>.txt
 *   - questions.jsonl：500 行，每行一个 JSON 对象。
 *   - 正文为纯文本 / markdown，无 frontmatter、无 JSON 包裹，
 *     所有 metadata 均来自「路径 + 文件名」，不解析正文。
 *
 * 🔴 dsid 提取铁律：documentId = filename.split('__')[0]，且【必须保留 dsid_ 前缀】。
 *    gold 的 expected_doc_ids 形如 "dsid_ae068ee4aa9640159427cd941bef0238"，
 *    若用正则去掉前缀，documentId 与 gold 永远对不上，Document Recall 恒为 0。
 *
 * 设计原则：
 *   1. 纯 fs，无任何第三方 zip/parquet 依赖（数据已解压）。
 *   2. 递归遍历用「惰性生成器」，避免一次性把 51 万条元数据载入内存。
 *   3. 抽样用「蓄水池抽样 + 固定种子 PRNG」，单遍、确定性、O(n) 内存。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { z } from 'zod';
import type { EvalSample } from '../../../src/fundamentals/eval/metrics.js';

// ==================== 常量与配置 ====================

/**
 * ERB 数据根目录。
 * 优先读环境变量 ERB_DATA_DIR，缺省回落到本机实测路径 D:\ragatest。
 * （数据路径非密钥，允许作为缺省值硬编码；换机时用 env 覆盖即可。）
 */
export const ERB_DATA_DIR: string = process.env.ERB_DATA_DIR ?? 'D:\\ragatest';

/** ERB 的 9 类 source_type（与数据目录、questions.source_types 取值一致） */
export const ERB_SOURCE_TYPES = [
  'confluence',
  'fireflies',
  'github',
  'gmail',
  'google_drive',
  'hubspot',
  'jira',
  'linear',
  'slack',
] as const;

/** source_type 联合类型 */
export type ErbSourceType = (typeof ERB_SOURCE_TYPES)[number];

/** documentId 合法格式：dsid_ + 32 位小写 hex（用于验证提取正确性） */
const DSID_PATTERN = /^dsid_[0-9a-f]{32}$/;

// ==================== 类型定义 ====================

/** 一篇 ERB 文档的元数据（不含正文，正文按需 readDocContent 读取） */
export interface ErbDoc {
  /** 文档唯一标识 = filename.split('__')[0]，保留 dsid_ 前缀 */
  documentId: string;
  /** 所属 source_type（顶层目录名） */
  sourceType: ErbSourceType;
  /** 文件绝对路径 */
  filePath: string;
  /** 文件名中 dsid 之后的可读 slug（去掉 .txt 后缀） */
  slug: string;
}

/** 递归遍历选项 */
export interface WalkOptions {
  /** 限定单一 source_type；缺省遍历全部 9 类 */
  sourceType?: ErbSourceType;
  /** 最多产出多少篇（用于压测取样，避免遍历 51 万） */
  limit?: number;
}

// ==================== Zod Schema（questions.jsonl 边界校验） ====================

/**
 * questions.jsonl 单行 schema。
 * 真实字段（已实测）：question_id / question_type / source_types /
 * question / expected_doc_ids / gold_answer / answer_facts。
 */
export const ErbQuestionSchema = z.object({
  question_id: z.string(),
  question_type: z.string(),
  source_types: z.array(z.string()),
  question: z.string(),
  expected_doc_ids: z.array(z.string()),
  gold_answer: z.string(),
  answer_facts: z.array(z.string()),
});

/** questions.jsonl 单条记录类型（由 zod 推导，禁止另写 interface） */
export type ErbQuestion = z.infer<typeof ErbQuestionSchema>;

// ==================== 文件名解析（纯函数） ====================

/**
 * 从文件名提取 documentId。
 *
 * 🔴 必须保留 dsid_ 前缀：直接取 split('__')[0]，不做任何去前缀处理。
 * 例：dsid_00019f542a8240739395dde5fec41708__company-atelier.txt
 *     → dsid_00019f542a8240739395dde5fec41708
 *
 * @param filename 文件名或完整路径均可（内部取 basename）
 */
export function extractDocumentId(filename: string): string {
  return basename(filename).split('__')[0];
}

/**
 * 从文件名提取可读 slug（dsid 之后、.txt 之前的部分）。
 *
 * 用 slice 而非 split('__')[1]，避免 slug 内部含 '__' 时被截断。
 * 例：dsid_xxx__company-atelier-classroom-ai.txt → company-atelier-classroom-ai
 *
 * @param filename 文件名或完整路径均可
 */
export function extractSlug(filename: string): string {
  const base = basename(filename);
  const id = base.split('__')[0];
  // base 形如 "<id>__<slug>.txt"，去掉 id 与分隔符 '__'
  const rest = base.slice(id.length);
  const slug = rest.startsWith('__') ? rest.slice(2) : rest;
  return slug.replace(/\.txt$/i, '');
}

/**
 * 校验 documentId 是否为合法的 ERB dsid 格式。
 * @param documentId 待校验的 documentId
 */
export function isValidDocumentId(documentId: string): boolean {
  return DSID_PATTERN.test(documentId);
}

// ==================== 递归遍历（惰性生成器） ====================

/**
 * 递归遍历单个目录，产出其中的 .txt 文档元数据。
 * 内部生成器：遇到子目录深入，遇到 .txt 产出 ErbDoc。
 *
 * @param dir 当前目录绝对路径
 * @param sourceType 该目录所属的顶层 source_type
 */
function* walkDir(dir: string, sourceType: ErbSourceType): Generator<ErbDoc> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 嵌套子目录（如 confluence/applied-ml-and-evals/eval-harness/）继续深入
      yield* walkDir(full, sourceType);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
      yield {
        documentId: extractDocumentId(entry.name),
        sourceType,
        filePath: full,
        slug: extractSlug(entry.name),
      };
    }
  }
}

/**
 * 遍历 ERB 数据集，惰性产出文档元数据。
 *
 * - 不传 sourceType：按 ERB_SOURCE_TYPES 顺序遍历全部 9 类。
 * - 传 limit：累计产出达到上限即停止（压测取样用，避免遍历 51 万）。
 *
 * @param options 遍历选项
 */
export function* walkDocs(options: WalkOptions = {}): Generator<ErbDoc> {
  const roots: string[] = options.sourceType
    ? [join(ERB_DATA_DIR, options.sourceType)]
    : ERB_SOURCE_TYPES.map((t) => join(ERB_DATA_DIR, t));

  let emitted = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // 顶层目录名即 source_type
    const sourceType = basename(root) as ErbSourceType;
    for (const doc of walkDir(root, sourceType)) {
      yield doc;
      emitted++;
      if (options.limit !== undefined && emitted >= options.limit) return;
    }
  }
}

/**
 * 读取文档正文（UTF-8）。
 * @param doc ErbDoc 对象或文件绝对路径
 */
export function readDocContent(doc: ErbDoc | string): string {
  const filePath = typeof doc === 'string' ? doc : doc.filePath;
  return readFileSync(filePath, 'utf-8');
}

// ==================== questions.jsonl 加载与映射 ====================

/**
 * 加载并校验 questions.jsonl。
 *
 * 逐行 JSON.parse 后经 zod 校验，任一行结构异常立即抛错（边界 fail-fast），
 * 避免把脏数据带进评测。空行跳过。
 *
 * @param dataDir 数据根目录，缺省 ERB_DATA_DIR
 */
export function loadQuestions(dataDir: string = ERB_DATA_DIR): ErbQuestion[] {
  const qPath = join(dataDir, 'questions.jsonl');
  const raw = readFileSync(qPath, 'utf-8');
  const questions: ErbQuestion[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = ErbQuestionSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(
        `questions.jsonl 第 ${i + 1} 行校验失败: ${parsed.error.message}`,
      );
    }
    questions.push(parsed.data);
  }
  return questions;
}

/**
 * 将 ERB questions 映射为项目现有评测体系的 EvalSample。
 *
 * 字段映射（复用 src/fundamentals/eval/metrics.ts 的聚合能力）：
 *   question_id      → id
 *   question         → query
 *   expected_doc_ids → expectedDocIds（gold，含 dsid_ 前缀）
 *   question_type    → category（复用 aggregateResults 的 byCategory 分组）
 *   source_types     → note（逗号拼接，便于排查跨源题）
 *
 * @param questions ERB 问题列表
 */
export function toEvalSamples(questions: ErbQuestion[]): EvalSample[] {
  return questions.map((q) => ({
    id: q.question_id,
    query: q.question,
    expectedDocIds: q.expected_doc_ids,
    category: q.question_type,
    note: q.source_types.join(','),
  }));
}

// ==================== 抽样（蓄水池 + 确定性 PRNG） ====================

/**
 * mulberry32：32 位确定性伪随机数生成器。
 * 用于让抽样结果可复现（同种子同结果），不依赖任何第三方随机库。
 *
 * @param seed 随机种子
 * @returns 返回 [0,1) 随机数的函数
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 蓄水池抽样：从（可能极大的）可迭代对象中等概率抽取 k 个，单遍、O(k) 内存。
 *
 * 为什么用它：slack 有 28.5 万篇，若先 collect 再抽会占用大量内存；
 * 蓄水池抽样只需一遍生成器 + k 个槽位，且配合固定种子可复现。
 *
 * @param items 源可迭代对象
 * @param k 抽样数量（k >= 源总量时返回全部）
 * @param seed 随机种子，缺省 42
 */
export function reservoirSample<T>(
  items: Iterable<T>,
  k: number,
  seed = 42,
): T[] {
  const rand = mulberry32(seed);
  const reservoir: T[] = [];
  let i = 0;
  for (const item of items) {
    if (i < k) {
      reservoir.push(item);
    } else {
      const j = Math.floor(rand() * (i + 1));
      if (j < k) reservoir[j] = item;
    }
    i++;
  }
  return reservoir;
}

/**
 * 从单一 source_type 抽样 n 篇（P0 压测用：单类目录抽样/堆量）。
 *
 * @param sourceType 目标 source_type
 * @param n 抽样数量
 * @param seed 随机种子，缺省 42
 */
export function sampleSingleType(
  sourceType: ErbSourceType,
  n: number,
  seed = 42,
): ErbDoc[] {
  return reservoirSample(walkDocs({ sourceType }), n, seed);
}

/**
 * 按 source_type 分层抽样：每类各抽 perType 篇（P1 召回评测的代表性子集）。
 *
 * 注意：这是「等量分层」，非「按总量比例分层」。若需比例分层，
 * 可先用 countDocsByType() 拿总量再按比例计算每类配额。
 *
 * @param perType 每类抽样数量
 * @param seed 随机种子，缺省 42
 * @returns source_type → 抽中文档列表 的 Map
 */
export function stratifiedSample(
  perType: number,
  seed = 42,
): Map<ErbSourceType, ErbDoc[]> {
  const result = new Map<ErbSourceType, ErbDoc[]>();
  for (const t of ERB_SOURCE_TYPES) {
    result.set(t, sampleSingleType(t, perType, seed));
  }
  return result;
}

/**
 * 统计每个 source_type 的文档总数（需完整遍历，slack 28.5 万会稍慢）。
 * 仅用于报告/比例分层配额计算，不在压测关键路径调用。
 *
 * @returns source_type → 文档数 的 Map
 */
export function countDocsByType(): Map<ErbSourceType, number> {
  const counts = new Map<ErbSourceType, number>();
  for (const t of ERB_SOURCE_TYPES) {
    let c = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _doc of walkDocs({ sourceType: t })) c++;
    counts.set(t, c);
  }
  return counts;
}
