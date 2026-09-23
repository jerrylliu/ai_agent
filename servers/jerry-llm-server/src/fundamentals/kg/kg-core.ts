import { z } from 'zod';
import { config } from '../config.js';

/**
 * KG 核心层：zod schema + 归一化/分词/余弦等纯函数（无 IO、无 DI）
 *
 * 移植自 scripts/bench/kg-link-spike.ts（30 题门闩验证 v2 版本），
 * 算法口径与门闩验证保持完全一致——任何召回/链接口径改动都会使门闩结论失效。
 */

export const MODULE = 'KgCore';

// ==================== Zod Schema ====================

export const EntitySchema = z.object({
  name: z.string().min(1).max(120).describe('实体在文档中的原始表述'),
  type: z
    .string()
    .min(1)
    .max(30)
    .describe(
      '实体类型：person/team/org/product/model/project/location/event/plan/metric',
    ),
  aliases: z
    .array(z.string().max(120))
    .default([])
    .describe('同一实体在文档中出现的其他表述（缩写、全称、代号）'),
});

export const TripleSchema = z.object({
  head: z.string().min(1).max(120).describe('头实体（须为文中原始表述）'),
  relation: z.string().min(1).max(60).describe('小写下划线关系短语'),
  tail: z.string().min(1).max(120).describe('尾实体（须为文中原始表述）'),
});

export const DocExtractSchema = z.object({
  entities: z.array(EntitySchema).max(config.kg.maxEntitiesPerDoc * 2),
  triples: z.array(TripleSchema).max(config.kg.maxEntitiesPerDoc * 2),
});
export type DocExtract = z.infer<typeof DocExtractSchema>;

export const MentionSchema = z.object({
  surface: z
    .string()
    .min(1)
    .max(160)
    .describe('问题中指向某实体的词组（原文照抄）'),
  variants: z
    .array(z.string().max(160))
    .max(6)
    .describe('该实体在文档中可能出现的其他表述（全称/缩写/型号/项目名）'),
});
export const QuestionMentionsSchema = z.object({
  mentions: z.array(MentionSchema).max(8),
});
export type QuestionMentions = z.infer<typeof QuestionMentionsSchema>;

/**
 * LLM 链接确认的分级判定（从「二元拒绝」升级为 confidence + matchType）：
 * 门闩归因发现大量未链接 mention 的表述确实出现在 gold 文档中却被二元口径拒绝
 * （如 "rollout system"→Canary rollout、"dry run"→rehearse_run_*），分级后
 * 用置信度阈值把「同一实体的不同表述」纳入链接，可链接子集命中率达到 80.5%。
 */
export const LinkMatchTypeSchema = z.enum([
  'exact', // 同一实体的完全等价表述（全称/缩写/大小写/区域码↔名称）
  'variant', // 同一实体的不同说法（口语↔术语、代号↔市场名）
  'related', // 相关但非同一实体（父项目/子模块/上位概念）—— 不计入链接
]);

export const LinkDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      mention: z.string().min(1).describe('mention 编号，如 M1'),
      links: z
        .array(
          z.object({
            candidate: z.string().min(1).describe('候选编号，如 C1'),
            confidence: z
              .number()
              .min(0)
              .max(1)
              .describe('该候选与 mention 指向同一真实实体的置信度'),
            matchType: LinkMatchTypeSchema.describe('匹配类型'),
          }),
        )
        .max(config.kg.candidateTopK + config.kg.embedSupplementSlots)
        .describe('认为指向同一实体的候选（可多个，按置信度从高到低）'),
    }),
  ),
});
export type LinkDecisions = z.infer<typeof LinkDecisionSchema>;
export type LinkMatchType = z.infer<typeof LinkMatchTypeSchema>;

// ==================== 归一化与 token 化 ====================

/** 跨语言免对齐的归一化：小写 + 空白折叠（实体键统一口径） */
export function normEntity(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 英文语料的通用词（不参与 token 召回，避免候选爆炸） */
export const STOPWORDS = new Set([
  'the',
  'of',
  'for',
  'and',
  'with',
  'from',
  'into',
  'onto',
  'about',
  'after',
  'before',
  'when',
  'what',
  'which',
  'who',
  'how',
  'are',
  'was',
  'were',
  'is',
  'new',
  'first',
  'last',
  'current',
  'major',
  'top',
  'end',
  'year',
  'month',
  'week',
  'day',
  'time',
  'plan',
  'plans',
  'team',
  'teams',
  'project',
  'projects',
  'company',
  'companies',
  'provider',
  'providers',
  'partner',
  'partners',
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** 余弦相似度；任一为零向量时返回 0（避免 NaN 污染排序） */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 统一错误信息提取 */
export function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ==================== 抽取结果合并 ====================

/** 同文档内按归一化 key 合并后的实体（(documentId, key) 唯一约束的落库形态） */
export interface MergedEntity {
  name: string;
  type: string;
  aliases: string[];
}

/**
 * 同一文档内按 normEntity(name) 合并实体：
 * name/type 首现者留，aliases 取并集并剔除与主名等价的项。
 * 与 buildIndex 的 registerKey「首现优先」口径一致，保证落库再还原后
 * 建出的索引和直接用原始抽取结果建索引等价。
 */
export function mergeEntitiesByKey(
  entities: DocExtract['entities'],
): MergedEntity[] {
  const byKey = new Map<string, MergedEntity>();
  for (const entity of entities) {
    const key = normEntity(entity.name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        name: entity.name.trim(),
        type: entity.type,
        aliases: [...entity.aliases],
      });
      continue;
    }
    for (const alias of entity.aliases) {
      if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
    }
  }
  for (const merged of byKey.values()) {
    const selfKey = normEntity(merged.name);
    merged.aliases = merged.aliases.filter((a) => {
      const aliasKey = normEntity(a);
      return aliasKey.length > 0 && aliasKey !== selfKey;
    });
  }
  return [...byKey.values()];
}
