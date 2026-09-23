import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseLlmJson } from '../llm-json-parser.js';
import { createRateLimitedLLM } from '../model-provider.js';
import {
  getEmbeddings,
  hybridSearchKnowledgeBase,
} from '../vector-store/index.js';
import {
  errMsg,
  LinkDecisionSchema,
  normEntity,
  QuestionMentionsSchema,
} from './kg-core.js';
import type { LinkMatchType } from './kg-core.js';
import {
  expandFromLinkedKeys,
  getKgIndexSnapshot,
  recallCandidates,
} from './kg-index.js';
import type {
  CandidateSource,
  EntityIndex,
  GraphDoc,
  RecalledCandidate,
} from './kg-index.js';

/**
 * KG 在线链路：查询实体链接（A 分级降级）+ 图补充位融合
 *
 * 移植自 scripts/bench/kg-link-spike.ts（30 题门闩验证 v2 版本）。
 * ⚠️ MENTION_PROMPT / 链接确认提示词 / 决策映射 / 融合公式均为门闩验证口径，
 * 任何改动都会使「提升 6/12、回退 0、可链接子集命中率 80.5%」的结论失效。
 *
 * 硬约束：**基线优先，图只做补充位**——图扩展文档只能占用末尾 supplementSlots
 * 个槽位，禁止用图分数重排或覆盖基线检索结果。
 *
 * 降级策略：KG 关闭 / 索引未加载 / LLM 超时 / 输出校验失败 / 检索异常，
 * 一律静默降级为纯基线（返回空补充），不向调用方抛错。
 */

const MODULE = 'KgLink';

// ==================== 提示词（spike v2 原样移植，勿改口径） ====================

const MENTION_PROMPT = `You are doing entity linking for a retrieval system over an enterprise corpus.

The question below is a PARAPHRASE: it usually avoids the exact proper names used in the documents. List the mentions that point at specific named entities in the corpus (products, hardware models/SKUs, organizations, teams, people, projects, programs, locations/regions, events, plans/policies).

For each mention output:
- "surface": the exact phrase copied from the question
- "variants": up to 6 plausible surface forms the SAME entity could take inside the documents (full name, abbreviation, model/SKU code, product family, formal program or region code). Guess conservatively from the wording; do not invent unrelated entities.

At most 8 mentions, ordered by how central they are to answering the question.
Output ONLY a JSON object, no markdown fences:
{"mentions":[{"surface":"...","variants":["..."]}]}

Question:
`;

// ==================== 类型 ====================

/** 单 mention 的链接上下文（候选召回 + LLM 判定），口径与 spike MentionLink 一致 */
interface MentionLink {
  mentionId: string;
  surface: string;
  variants: string[];
  /** 确定性精确归一化命中的实体键（诊断用，不参与链接判定） */
  exactKeys: string[];
  candidates: RecalledCandidate[];
  /** LLM 确认且 confidence ≥ linkConfThreshold 的实体键 */
  linkedKeys: string[];
  /** LLM 返回的全部判定（未按阈值过滤），供归因与阈值复算 */
  linkDetails: Array<{
    key: string;
    confidence: number;
    matchType: LinkMatchType;
    source: CandidateSource;
  }>;
}

export interface QueryLinkResult {
  /** 链接命中的实体键（已按阈值过滤、跨 mention 去重） */
  linkedKeys: string[];
  /** 图扩展出的候选文档（按图权重降序） */
  graphDocs: GraphDoc[];
  /** true = 走免 LLM 精确通道（成本归因用） */
  exactOnly: boolean;
  /** 参与链接的 mention 数（exactOnly 时为 0） */
  mentionCount: number;
}

/**
 * 图补充块：补充文档定向检索得到的 chunk（形态对齐混合检索返回项，可直接并入基线数组）。
 * 刻意不带 vectorScore——RAG 主对话会过滤 vectorScore < 0.45 的块，
 * 而图补充块的 score 口径是图扩展权重，透传向量分会被误杀。
 */
export interface GraphSupplementChunk {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  /** 来源图扩展文档 id（字符串形态，与索引 keyToDocs 对齐） */
  documentId: string;
  /** 贡献来源（链接实体 label / 1 跳邻居 label），诊断可读性用 */
  via: string[];
}

// ==================== 免 LLM 精确通道 ====================

/** 纯精确归一化匹配（不依赖 LLM 的链接能力下限，spike exactMatchKeys 原样移植） */
export function exactMatchKeys(
  mention: { surface: string; variants: string[] },
  index: EntityIndex,
): string[] {
  const keys: string[] = [];
  for (const surface of [mention.surface, ...mention.variants]) {
    const norm = normEntity(surface);
    if (norm && index.keyToDocs.has(norm) && !keys.includes(norm))
      keys.push(norm);
  }
  return keys;
}

// ==================== LLM 调用 ====================

/**
 * 单次 KG 在线 LLM 调用（超时真正取消在途请求 + zod 校验输出）。
 * 校验失败返回 null 由调用方降级，不抛错——在线链路的 LLM 失败不得影响基线检索。
 *
 * ⚠️ 超时值 linkTimeoutMs 必须大于所用模型的实测时延：在线复验实测单题全程 42~170s，
 * 超时即整链路降级为纯基线（等效 KG 不生效），排查"补充位一直为空"时优先看这里。
 */
async function invokeKgLlm<T>(
  llm: BaseChatModel,
  prompt: string,
  schema: ZodType<T>,
  label: string,
): Promise<T | null> {
  const rawResult = await llm.invoke([new HumanMessage(prompt)], {
    signal: AbortSignal.timeout(config.kg.linkTimeoutMs),
  });
  const message =
    typeof rawResult.content === 'string' ? rawResult.content : '';
  const parsed = parseLlmJson(message, schema, { module: MODULE, label });
  if (!parsed.success) {
    logger.warn('KG 在线链接 LLM 输出校验失败，该环节降级', {
      module: MODULE,
      label,
      reason: parsed.reason,
    });
    return null;
  }
  return parsed.data;
}

/**
 * 合并式链接确认提示词（spike v2 逐行移植）：一次调用批量确认全部 mention，
 * 输出带 confidence + matchType 的分级判定，由 linkConfThreshold 在主口径上把关。
 */
export function buildLinkPrompt(
  question: string,
  linkable: MentionLink[],
): string {
  const promptLines: string[] = [
    'You are doing entity linking: decide which candidate knowledge-graph entities each question mention refers to.',
    '',
    `Question: ${question}`,
    '',
    'Candidates were retrieved by string overlap and/or embedding similarity, so they MAY be wrong.',
    'For each mention, output every candidate you believe denotes the SAME real-world entity, with:',
    '- "confidence": 0..1, how sure you are that mention and candidate are the SAME entity',
    '- "matchType": "exact" (equivalent forms: abbreviation, full name, region code vs name, SKU vs family),',
    '                "variant" (same entity described differently: colloquial vs technical term, code name vs market name),',
    '                "related" (associated but NOT the same entity: parent project, sub-module, broader concept)',
    '',
    'Calibration: 0.9+ = clearly the same entity; 0.6-0.85 = same entity expressed differently, wording not identical;',
    '0.3-0.6 = plausible but unverified; below 0.3 or "related" = do not link.',
    'Prefer emitting a low-confidence link over omitting it — a downstream threshold decides.',
    'If no candidate matches, return an empty "links" list for that mention.',
    '',
  ];
  for (const link of linkable) {
    promptLines.push(
      `${link.mentionId} surface: "${link.surface}"` +
        (link.variants.length > 0
          ? ` (variants: ${link.variants.join(', ')})`
          : ''),
    );
    for (const c of link.candidates) {
      const provenance =
        c.source === 'semantic'
          ? `semantic sim=${c.sim?.toFixed(2) ?? '-'}`
          : c.source === 'both'
            ? `lexical+semantic sim=${c.sim?.toFixed(2) ?? '-'}`
            : 'lexical';
      promptLines.push(
        `  ${c.id}: "${c.label}" (type=${c.type}, docs=${c.docCount}, via=${provenance})`,
      );
    }
  }
  promptLines.push(
    '',
    'Output ONLY a JSON object, no markdown fences:',
    '{"decisions":[{"mention":"M1","links":[{"candidate":"c1","confidence":0.95,"matchType":"exact"},' +
      '{"candidate":"c3","confidence":0.7,"matchType":"variant"}]}]}',
  );
  return promptLines.join('\n');
}

/** surface + variants 归一化去重取前 4 个形态逐个嵌入；失败自动退回纯词汇召回 */
async function embedMentionForms(mention: {
  surface: string;
  variants: string[];
}): Promise<number[][]> {
  const forms = [
    ...new Set(
      [mention.surface, ...mention.variants].map((s) => normEntity(s)),
    ),
  ]
    .filter((s) => s.length > 0)
    .slice(0, 4);
  if (forms.length === 0) return [];
  const embeddings = getEmbeddings();
  const vectors: number[][] = [];
  for (const form of forms) {
    try {
      vectors.push(await embeddings.embedQuery(form));
    } catch (error) {
      logger.warn('KG mention 形态嵌入失败，该形态跳过（词汇召回不受影响）', {
        module: MODULE,
        form,
        error: errMsg(error),
      });
    }
  }
  return vectors;
}

/** 一次 LLM 调用确认全部 mention → 阈值过滤 → 跨 mention 去重的 linkedKeys */
async function confirmLinks(
  llm: BaseChatModel,
  question: string,
  links: MentionLink[],
): Promise<string[]> {
  const linkable = links.filter((l) => l.candidates.length > 0);
  if (linkable.length === 0) return [];

  const decisions = await invokeKgLlm(
    llm,
    buildLinkPrompt(question, linkable),
    LinkDecisionSchema,
    '实体链接确认',
  );
  if (!decisions) return [];

  const confThreshold = config.kg.linkConfThreshold;
  const byId = new Map(linkable.map((l) => [l.mentionId, l]));
  for (const decision of decisions.decisions) {
    const link = byId.get(decision.mention);
    if (!link) continue;
    for (const item of decision.links) {
      const candidate = link.candidates.find((c) => c.id === item.candidate);
      if (!candidate) continue;
      if (!link.linkDetails.some((d) => d.key === candidate.key)) {
        link.linkDetails.push({
          key: candidate.key,
          confidence: item.confidence,
          matchType: item.matchType,
          source: candidate.source,
        });
      }
      // 主口径：阈值之上且非 related（related 语义上就不是同一实体，任何阈值都不该计入）
      if (
        item.matchType !== 'related' &&
        item.confidence >= confThreshold &&
        !link.linkedKeys.includes(candidate.key)
      ) {
        link.linkedKeys.push(candidate.key);
      }
    }
  }

  const linkedKeys: string[] = [];
  for (const link of links) {
    for (const key of link.linkedKeys) {
      if (!linkedKeys.includes(key)) linkedKeys.push(key);
    }
    if (link.linkDetails.length > 0) {
      logger.debug('KG mention 链接判定', {
        module: MODULE,
        mentionId: link.mentionId,
        surface: link.surface,
        exactKeys: link.exactKeys,
        candidateCount: link.candidates.length,
        linkedKeys: link.linkedKeys,
        details: link.linkDetails,
      });
    }
  }
  return linkedKeys;
}

// ==================== 查询实体链接（A 分级降级） ====================

/**
 * 在线查询实体链接：
 * ① 免 LLM 精确通道——整条查询归一化后直接命中实体键，零模型成本；
 * ② 完整通道——1 次 mention 抽取 + 每 mention ≤4 形态嵌入 + 词汇∪语义候选召回
 *    + 1 次合并式 LLM 链接确认（阈值过滤）；
 * ③ 任何环节失败 → null，调用方按纯基线继续。
 *
 * @returns 链接结果；KG 关闭 / 索引未加载 / 链接失败时为 null
 */
export async function linkQueryToEntities(
  query: string,
): Promise<QueryLinkResult | null> {
  if (!config.kg.enabled) return null;
  const snapshot = getKgIndexSnapshot();
  if (!snapshot) return null;
  const question = query.trim();
  if (!question) return null;
  const { index, keyToEmbedding } = snapshot;

  try {
    const exactKey = normEntity(question);
    if (exactKey && index.keyToDocs.has(exactKey)) {
      logger.debug('KG 在线链接命中免 LLM 精确通道', {
        module: MODULE,
        key: exactKey,
      });
      return {
        linkedKeys: [exactKey],
        graphDocs: expandFromLinkedKeys([exactKey], index),
        exactOnly: true,
        mentionCount: 0,
      };
    }

    // LLM 实例单次链接内共享（createRateLimitedLLM 自带限流保护，fast 池）
    const llm = createRateLimitedLLM(undefined, 'fast');
    const mentions = await invokeKgLlm(
      llm,
      MENTION_PROMPT + question,
      QuestionMentionsSchema,
      '问题 mention 抽取',
    );
    if (!mentions || mentions.mentions.length === 0) {
      return {
        linkedKeys: [],
        graphDocs: [],
        exactOnly: false,
        mentionCount: 0,
      };
    }

    const links: MentionLink[] = [];
    for (let i = 0; i < mentions.mentions.length; i++) {
      const mention = mentions.mentions[i];
      const queryVectors = await embedMentionForms(mention);
      links.push({
        mentionId: `M${i + 1}`,
        surface: mention.surface,
        variants: mention.variants,
        exactKeys: exactMatchKeys(mention, index),
        candidates: recallCandidates(
          mention,
          index,
          queryVectors,
          keyToEmbedding,
        ),
        linkedKeys: [],
        linkDetails: [],
      });
    }

    const linkedKeys = await confirmLinks(llm, question, links);
    return {
      linkedKeys,
      graphDocs: expandFromLinkedKeys(linkedKeys, index),
      exactOnly: false,
      mentionCount: links.length,
    };
  } catch (error) {
    logger.warn('KG 在线实体链接失败，降级纯基线检索', {
      module: MODULE,
      query: question.slice(0, 120),
      error: errMsg(error),
    });
    return null;
  }
}

// ==================== 图补充位 ====================

/** 基线结果中出现过的文档 id（字符串形态，与 KG 索引 keyToDocs 对齐） */
export function collectBaselineDocIds(
  results: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>,
): string[] {
  const ids: string[] = [];
  for (const result of results) {
    const raw = result.metadata?.documentId;
    // 只接受字符串/数字形态：其他类型无稳定字符串化语义（避免 [object Object] 这类假 id）
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const id = String(raw);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 图补充位融合（spike 融合公式原样移植）：
 * 基线保留前 `topK - slots` 条 + 追加不重复的 `slots` 条图补充块，末尾按 topK 截断。
 * 纯函数，不依赖检索结果的具体形态（两条链路各自把补充块映射成自身元素类型）。
 */
export function fuseGraphSupplements<T>(
  baseline: T[],
  supplements: T[],
  topK: number,
): T[] {
  if (topK <= 0) return baseline;
  const slots = Math.min(config.kg.supplementSlots, supplements.length);
  if (slots <= 0) return baseline;
  const keepCount = Math.max(0, topK - slots);
  const kept = baseline.slice(0, keepCount);
  return [...kept, ...supplements.slice(0, slots)].slice(0, topK);
}

/** 为补充文档定向取块：每个文档取与查询最相关的 1 块（按图权重降序并行检索） */
async function fetchSupplementChunks(
  query: string,
  targets: GraphDoc[],
): Promise<GraphSupplementChunk[]> {
  const fetched = await Promise.all(
    targets.map(async (target): Promise<GraphSupplementChunk | null> => {
      const rows = await hybridSearchKnowledgeBase(
        query,
        1,
        0.7,
        0.3,
        { documentId: target.documentId },
        undefined,
        config.retrievalMinSimilarity,
      );
      const row = rows[0];
      if (!row || !row.content?.trim()) return null;
      return {
        content: row.content,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        score: row.score,
        documentId: target.documentId,
        via: target.via,
      };
    }),
  );
  return fetched.filter(
    (chunk): chunk is GraphSupplementChunk => chunk !== null,
  );
}

/**
 * 解析本次查询的图补充块（在线链路统一入口）。
 *
 * 基线为空时不补充：补充位语义是「在既有基线之上补 1 个槽位」，
 * 基线全空说明查询与知识库无相似度关联，此时注入图扩展内容风险大于收益。
 *
 * 排除集用**全量**基线文档 id（spike 用截断后的 kept 段）：宁可少补一个槽位，
 * 也不把基线已召回（只是排在截断线外）的文档换个位置再塞回上下文。
 *
 * @param query 用户查询（原文，不做改写——门闩验证口径）
 * @param baselineDocIds 基线结果已覆盖的文档 id（图补充须与其不重复）
 * @returns 补充块（按图权重降序，最多 supplementSlots 条）；无补充或降级时为 []
 */
export async function resolveGraphSupplements(
  query: string,
  baselineDocIds: string[],
): Promise<GraphSupplementChunk[]> {
  const slots = config.kg.supplementSlots;
  if (!config.kg.enabled || slots <= 0) return [];
  if (baselineDocIds.length === 0) return [];

  try {
    const link = await linkQueryToEntities(query);
    if (!link || link.linkedKeys.length === 0 || link.graphDocs.length === 0)
      return [];

    const excluded = new Set(baselineDocIds);
    const targets = link.graphDocs
      .filter((doc) => !excluded.has(doc.documentId))
      .slice(0, slots);
    if (targets.length === 0) {
      logger.debug('KG 图扩展文档已被基线覆盖，无需补充', {
        module: MODULE,
        graphDocCount: link.graphDocs.length,
      });
      return [];
    }

    const chunks = await fetchSupplementChunks(query, targets);
    logger.info('KG 图补充位解析完成', {
      module: MODULE,
      exactOnly: link.exactOnly,
      mentionCount: link.mentionCount,
      linkedKeys: link.linkedKeys,
      graphDocCount: link.graphDocs.length,
      supplementCount: chunks.length,
      supplements: chunks.map((c) => ({
        documentId: c.documentId,
        via: c.via,
      })),
    });
    return chunks;
  } catch (error) {
    logger.warn('KG 图补充位解析失败，降级纯基线检索', {
      module: MODULE,
      query: query.slice(0, 120),
      error: errMsg(error),
    });
    return [];
  }
}
