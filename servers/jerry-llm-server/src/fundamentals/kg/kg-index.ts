import { config } from '../config.js';
import { cosine, normEntity, tokenize } from './kg-core.js';
import type { DocExtract } from './kg-core.js';

/**
 * KG 内存索引层：图构建 + 候选召回 + 图扩展（纯函数 + 进程级单例）
 *
 * 移植自 scripts/bench/kg-link-spike.ts（30 题门闩验证 v2 版本）。
 * 持久化在 MySQL 三表（kg_entity / kg_triple / kg_extract_op），
 * 启动/增量更新后由 KgExtractService 全量加载重建本层内存索引；
 * 在线链路只读本层单例，不触库。
 */

// ==================== 数据结构 ====================

/** 索引构建输入行：一篇文档的抽取结果（与 spike 的 DocEntityRow 同构） */
export interface DocEntityRow {
  /** 文档 id 的字符串形态（与检索结果的 documentId 对齐） */
  documentId: string;
  entities: DocExtract['entities'];
  triples: DocExtract['triples'];
}

export interface EntityIndex {
  /** 归一化键 → 展示用原始 label（首次出现的表述） */
  keyToLabel: Map<string, string>;
  keyToType: Map<string, string>;
  /** 归一化键 → 出现该实体的文档 id 集合 */
  keyToDocs: Map<string, Set<string>>;
  /** 归一化键 → 三元组邻居键（无向） */
  adjacency: Map<string, Set<string>>;
  /** token → 实体键集合（候选召回用倒排） */
  tokenToKeys: Map<string, Set<string>>;
  /**
   * 别名键 → 主名键（canonical 映射）。
   * 链接命中别名时按主名权重 1.0 扩展，不再因走 1 跳边而降权到 0.5。
   */
  keyToCanonical: Map<string, string>;
  /** 三元组总数（含跨文档重复计数，仅报告用） */
  tripleCount: number;
}

export type CandidateSource = 'lexical' | 'semantic' | 'both';

export interface RecalledCandidate {
  id: string;
  key: string;
  label: string;
  type: string;
  docCount: number;
  score: number;
  source: CandidateSource;
  /** 语义余弦相似度（source 含 semantic 时有值） */
  sim?: number;
}

export interface GraphDoc {
  documentId: string;
  score: number;
  /** 贡献来源（链接实体 label / 1 跳邻居 label），诊断可读性用 */
  via: string[];
}

// ==================== 图构建 ====================

export function buildIndex(rows: DocEntityRow[]): EntityIndex {
  const index: EntityIndex = {
    keyToLabel: new Map(),
    keyToType: new Map(),
    keyToDocs: new Map(),
    adjacency: new Map(),
    tokenToKeys: new Map(),
    keyToCanonical: new Map(),
    tripleCount: 0,
  };

  /** 作为主名（实体名 / 三元组端点）注册过的键，别名映射不得覆盖它 */
  const primaryKeys = new Set<string>();

  const registerKey = (
    raw: string,
    type?: string,
    isPrimary = true,
  ): string => {
    const key = normEntity(raw);
    if (!key) return key;
    if (isPrimary) primaryKeys.add(key);
    if (!index.keyToLabel.has(key)) {
      index.keyToLabel.set(key, raw.trim());
      index.keyToType.set(key, type ?? 'unknown');
      for (const token of tokenize(raw)) {
        const posting = index.tokenToKeys.get(token);
        if (posting) posting.add(key);
        else index.tokenToKeys.set(token, new Set([key]));
      }
    }
    return key;
  };

  const addDoc = (key: string, documentId: string): void => {
    if (!key) return;
    const docs = index.keyToDocs.get(key);
    if (docs) docs.add(documentId);
    else index.keyToDocs.set(key, new Set([documentId]));
  };

  const addEdge = (a: string, b: string): void => {
    if (!a || !b || a === b) return;
    const na = index.adjacency.get(a);
    if (na) na.add(b);
    else index.adjacency.set(a, new Set([b]));
    const nb = index.adjacency.get(b);
    if (nb) nb.add(a);
    else index.adjacency.set(b, new Set([a]));
  };

  for (const row of rows) {
    for (const entity of row.entities) {
      const key = registerKey(entity.name, entity.type);
      addDoc(key, row.documentId);
      for (const alias of entity.aliases) {
        // 别名与主名归一到同一节点（别名作为该节点的另一种表述）
        const aliasKey = registerKey(alias, entity.type, false);
        if (!aliasKey) continue;
        addDoc(aliasKey, row.documentId);
        addEdge(key, aliasKey);
        // 登记 alias→主名 canonical 映射（首次出现优先；不覆盖已是主名的键）
        if (aliasKey !== key && !index.keyToCanonical.has(aliasKey)) {
          index.keyToCanonical.set(aliasKey, key);
        }
      }
    }
    for (const triple of row.triples) {
      index.tripleCount++;
      const head = registerKey(triple.head);
      const tail = registerKey(triple.tail);
      addDoc(head, row.documentId);
      addDoc(tail, row.documentId);
      addEdge(head, tail);
    }
  }

  // 二次修正：某键若在后续文档中被当作主名注册（抽取顺序造成的先后偏差），
  // 撤销其别名身份，避免把独立实体误折叠到别的实体上。
  for (const aliasKey of [...index.keyToCanonical.keys()]) {
    if (primaryKeys.has(aliasKey)) index.keyToCanonical.delete(aliasKey);
  }

  return index;
}

// ==================== 候选召回 ====================

/**
 * 词汇通道召回（**v1 同口径，不得改动**：精确 1.0 / 子串 0.8 / token 重叠 ×0.6，
 * MIN_SCORE 过滤后取 top-K）。语义通道只做「额外补充」，保证与门闩验证可比。
 */
export function recallLexical(
  mention: { surface: string; variants: string[] },
  index: EntityIndex,
): Array<{ key: string; score: number }> {
  const scores = new Map<string, number>();
  const surfaces = [mention.surface, ...mention.variants].filter(
    (s) => s.trim().length > 0,
  );

  for (const surface of surfaces) {
    const norm = normEntity(surface);
    const tokens = new Set(tokenize(surface));
    if (norm.length === 0) continue;

    // ① 精确归一化命中：直接满分
    if (index.keyToDocs.has(norm)) scores.set(norm, 1);

    // ② token 倒排召回（通用 token 剪枝，避免候选爆炸）
    const candidateKeys = new Set<string>();
    for (const token of tokens) {
      const posting = index.tokenToKeys.get(token);
      if (!posting || posting.size > config.kg.tokenPostingCap) continue;
      for (const key of posting) candidateKeys.add(key);
    }

    for (const key of candidateKeys) {
      const label = index.keyToLabel.get(key) ?? key;
      const labelNorm = normEntity(label);
      let score = scores.get(key) ?? 0;

      if (labelNorm === norm) score = Math.max(score, 1);
      else if (
        norm.length >= 4 &&
        (labelNorm.includes(norm) ||
          (labelNorm.length >= 4 && norm.includes(labelNorm)))
      ) {
        // ③ 子串包含（型号/代码类实体的常见形态）
        score = Math.max(score, 0.8);
      } else {
        // ④ token 重叠率（以 mention 变体 token 数为分母）
        const keyTokens = new Set(tokenize(label));
        let common = 0;
        for (const t of tokens) if (keyTokens.has(t)) common++;
        const overlap = tokens.size > 0 ? (0.6 * common) / tokens.size : 0;
        score = Math.max(score, overlap);
      }
      if (score > 0) scores.set(key, score);
    }
  }

  return [...scores.entries()]
    .filter(([, score]) => score >= config.kg.candidateMinScore)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, config.kg.candidateTopK)
    .map(([key, score]) => ({ key, score }));
}

/**
 * 语义向量补充通道。
 *
 * 词汇通道对「无字面重叠」的表述是系统性盲区（如 "EU Central"→eu-central-1），
 * 此处用余弦在词汇 top-K 之外额外补最多 embedSupplementSlots 个候选。
 * 相似度阈值刻意宽松（embedMinSim=0.5）：召回只负责把候选送进池子，
 * 是否链接由 LLM 确认 + 置信度阈值把关，宁多勿漏。
 *
 * 多个查询向量（surface + variants）取逐键最大相似度，避免单一表述的向量偏差。
 *
 * @param keyToEmbedding 实体键 → 向量（生产只为主名 key 生成；spike 覆盖全部键，
 *   别名键缺失的影响由词汇通道 1.0 精确命中兜底）
 */
export function semanticSupplement(
  queryVectors: number[][],
  index: EntityIndex,
  keyToEmbedding: Map<string, number[]>,
  lexicalKeys: Set<string>,
): Array<{ key: string; sim: number; alreadyLexical: boolean }> {
  if (queryVectors.length === 0 || keyToEmbedding.size === 0) return [];
  const ranked: Array<{ key: string; sim: number }> = [];
  for (const key of index.keyToLabel.keys()) {
    const vec = keyToEmbedding.get(key);
    if (!vec) continue;
    let best = 0;
    for (const qv of queryVectors) {
      const sim = cosine(qv, vec);
      if (sim > best) best = sim;
    }
    if (best >= config.kg.embedMinSim) ranked.push({ key, sim: best });
  }
  ranked.sort((a, b) => b.sim - a.sim || a.key.localeCompare(b.key));

  const out: Array<{ key: string; sim: number; alreadyLexical: boolean }> = [];
  let slots = config.kg.embedSupplementSlots;
  for (const r of ranked) {
    if (lexicalKeys.has(r.key)) {
      // 已在词汇 top-K 中：只打 both 标记，不占补充槽位
      out.push({ ...r, alreadyLexical: true });
      continue;
    }
    if (slots <= 0) break;
    slots--;
    out.push({ ...r, alreadyLexical: false });
  }
  return out;
}

/** 单 mention 的候选召回 = 词汇通道（v1 同口径）∪ 语义补充通道 */
export function recallCandidates(
  mention: { surface: string; variants: string[] },
  index: EntityIndex,
  queryVectors: number[][],
  keyToEmbedding: Map<string, number[]> | null,
): RecalledCandidate[] {
  const lexical = recallLexical(mention, index);
  const picked: RecalledCandidate[] = lexical.map((c, i) => ({
    id: `c${i + 1}`,
    key: c.key,
    label: index.keyToLabel.get(c.key) ?? c.key,
    type: index.keyToType.get(c.key) ?? 'unknown',
    docCount: index.keyToDocs.get(c.key)?.size ?? 0,
    score: c.score,
    source: 'lexical' as CandidateSource,
  }));

  if (
    !keyToEmbedding ||
    keyToEmbedding.size === 0 ||
    queryVectors.length === 0
  ) {
    return picked;
  }

  const lexicalKeys = new Set(lexical.map((c) => c.key));
  for (const s of semanticSupplement(
    queryVectors,
    index,
    keyToEmbedding,
    lexicalKeys,
  )) {
    const sim = Number(s.sim.toFixed(4));
    if (s.alreadyLexical) {
      const hit = picked.find((p) => p.key === s.key);
      if (hit) {
        hit.source = 'both';
        hit.sim = sim;
      }
      continue;
    }
    picked.push({
      id: `c${picked.length + 1}`,
      key: s.key,
      label: index.keyToLabel.get(s.key) ?? s.key,
      type: index.keyToType.get(s.key) ?? 'unknown',
      docCount: index.keyToDocs.get(s.key)?.size ?? 0,
      score: sim,
      source: 'semantic',
      sim,
    });
  }
  return picked;
}

// ==================== 图扩展 ====================

/** 链接实体 → 其文档（权重 1.0）+ 1 跳邻居实体 → 其文档（权重 hopNeighborWeight） */
export function expandFromLinkedKeys(
  linkedKeys: string[],
  index: EntityIndex,
): GraphDoc[] {
  const scores = new Map<string, { score: number; via: Set<string> }>();
  const add = (documentId: string, weight: number, viaLabel: string): void => {
    const entry = scores.get(documentId);
    if (entry) {
      entry.score += weight;
      entry.via.add(viaLabel);
    } else {
      scores.set(documentId, { score: weight, via: new Set([viaLabel]) });
    }
  };

  for (const rawKey of linkedKeys) {
    // 链接命中**别名**时，别名与其主名是同一实体的两种表述，
    // 必须按同等权重 1.0 扩展；否则要多走 1 跳边而被降权到 0.5，
    // 白白削弱 alias 强化抽取带来的收益。
    const canonical = index.keyToCanonical.get(rawKey) ?? rawKey;
    const core = [rawKey, canonical].filter(
      (k, i, arr) => k && arr.indexOf(k) === i,
    );

    for (const key of core) {
      const label = index.keyToLabel.get(key) ?? key;
      for (const documentId of index.keyToDocs.get(key) ?? [])
        add(documentId, 1, label);
    }
    for (const key of core) {
      for (const neighbor of index.adjacency.get(key) ?? []) {
        // 别名↔主名这条边已按 1.0 计入，不再重复按 1 跳降权
        if (core.includes(neighbor)) continue;
        const neighborLabel = index.keyToLabel.get(neighbor) ?? neighbor;
        for (const documentId of index.keyToDocs.get(neighbor) ?? []) {
          add(documentId, config.kg.hopNeighborWeight, `1hop:${neighborLabel}`);
        }
      }
    }
  }

  return [...scores.entries()]
    .map(([documentId, entry]) => ({
      documentId,
      score: entry.score,
      via: [...entry.via],
    }))
    .sort(
      (a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId),
    );
}

// ==================== 进程级单例 ====================

/** 内存索引快照：index 与 keyToEmbedding 必须成对替换，避免读到不一致的中间态 */
export interface KgIndexSnapshot {
  index: EntityIndex;
  /** 主名键 → 语义向量（嵌入失败时为空 Map，语义通道自动关闭） */
  keyToEmbedding: Map<string, number[]>;
  /** 快照构建时间（诊断用） */
  builtAt: number;
}

let currentSnapshot: KgIndexSnapshot | null = null;

/** 由 KgExtractService 在启动加载/增量更新后调用（整体替换，读侧无锁安全） */
export function setKgIndexSnapshot(
  index: EntityIndex,
  keyToEmbedding: Map<string, number[]>,
): void {
  currentSnapshot = { index, keyToEmbedding, builtAt: Date.now() };
}

/** 在线链路读取当前快照；null = 尚未加载或 KG 关闭 */
export function getKgIndexSnapshot(): KgIndexSnapshot | null {
  return currentSnapshot;
}

/** 清空快照（知识库整体重建等场景） */
export function clearKgIndexSnapshot(): void {
  currentSnapshot = null;
}
