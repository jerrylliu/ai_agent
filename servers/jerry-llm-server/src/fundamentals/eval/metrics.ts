/**
 * 检索评估指标计算（纯函数，无副作用）
 *
 * 用于离线评估集和在线隐式反馈的指标量化：
 * - Recall@K：召回率，relevant 文档中命中的比例
 * - Precision@K：精确率，topK 检索结果中 relevant 的比例
 * - MRR：平均倒数排名，第一个 relevant 文档排名倒数的均值
 * - NDCG@K：归一化折损累计增益，考虑排名位置的综合性指标
 *
 * 设计原则：
 *   1. 纯函数，入参均为基本类型，便于单测和复用
 *   2. 支持二元相关（binary relevance）和分级相关（graded relevance）
 *   3. 所有指标输出 [0, 1] 区间，便于聚合和对比
 */

// ==================== 类型定义 ====================

/** 单条检索结果（用于指标计算的最小结构） */
export interface RetrievedItem {
  /** 文档唯一标识，与数据集中的 expectedDocIds 对齐 */
  docId: string;
  /** 原始检索分数（可选，调试用） */
  score?: number;
}

/** 单条评估样本（离线数据集的一条） */
export interface EvalSample {
  /** 样本 ID */
  id: string;
  /** 用户查询文本 */
  query: string;
  /** 期望命中的文档 ID 列表（ground truth） */
  expectedDocIds: string[];
  /** 查询分类：entity / semantic / multi-entity / image */
  category: string;
  /** 难度：easy / medium / hard */
  difficulty?: string;
  /** 备注 */
  note?: string;
}

/** 单条查询的检索结果与期望对照 */
export interface SingleQueryEval {
  /** 样本 ID */
  sampleId: string;
  /** 原始查询 */
  query: string;
  /** 检索到的文档 ID 列表（按排名顺序） */
  retrievedDocIds: string[];
  /** 期望命中的文档 ID 列表 */
  expectedDocIds: string[];
  /** 各 K 值下的指标结果 */
  metrics: Record<string, number>;
  /** 检索耗时（ms） */
  durationMs?: number;
  /** 是否出错 */
  error?: string;
  /** 查询分类（用于分组统计） */
  category?: string;
  /** 难度（用于分组统计） */
  difficulty?: string;
}

/** 整体评估报告 */
export interface EvalReport {
  /** 样本总数 */
  totalSamples: number;
  /** 成功评估的样本数（排除出错） */
  evaluatedSamples: number;
  /** 出错样本数 */
  errorSamples: number;
  /** 聚合指标（所有样本的均值） */
  aggregate: Record<string, number>;
  /** 按分类分组的指标 */
  byCategory: Record<string, Record<string, number>>;
  /** 按难度分组的指标 */
  byDifficulty: Record<string, Record<string, number>>;
  /** 每条查询的详细结果 */
  perQuery: SingleQueryEval[];
  /** 评估时间戳 */
  timestamp: string;
  /** 评估参数 */
  params: {
    topK: number;
    kValues: number[];
    searchType: string;
  };
}

// ==================== 单条指标计算 ====================

/**
 * Recall@K：召回率
 *
 * 公式：|relevant ∩ retrieved@K| / |relevant|
 *
 * 含义：在所有相关文档中，有多少被检索到了 topK 内。
 * 取值 [0, 1]，越高越好。|relevant| 为 0 时返回 0（避免除零）。
 *
 * @param retrievedDocIds 检索结果文档 ID 列表（按排名顺序）
 * @param expectedDocIds 期望命中的文档 ID 列表（ground truth）
 * @param k 截断排名
 */
export function recallAtK(
  retrievedDocIds: string[],
  expectedDocIds: string[],
  k: number,
): number {
  if (expectedDocIds.length === 0) return 0;
  const topK = dedupePreserveOrder(retrievedDocIds).slice(0, k);
  const expectedSet = new Set(expectedDocIds);
  const hits = topK.filter((id) => expectedSet.has(id)).length;
  return hits / expectedDocIds.length;
}

/**
 * Precision@K：精确率
 *
 * 公式：|relevant ∩ retrieved@K| / K
 *
 * 含义：topK 检索结果中，有多少是相关的。
 * 取值 [0, 1]，越高越好。K 为 0 时返回 0。
 *
 * @param retrievedDocIds 检索结果文档 ID 列表（按排名顺序）
 * @param expectedDocIds 期望命中的文档 ID 列表
 * @param k 截断排名
 */
export function precisionAtK(
  retrievedDocIds: string[],
  expectedDocIds: string[],
  k: number,
): number {
  if (k <= 0) return 0;
  const topK = dedupePreserveOrder(retrievedDocIds).slice(0, k);
  const expectedSet = new Set(expectedDocIds);
  const hits = topK.filter((id) => expectedSet.has(id)).length;
  return hits / k;
}

/**
 * Reciprocal Rank（倒数排名）
 *
 * 公式：1 / rank_of_first_relevant
 *
 * 含义：第一个相关文档的排名倒数。
 * 取值 [0, 1]，越高越好。无相关文档时返回 0。
 * MRR = 所有查询的 RR 均值。
 *
 * @param retrievedDocIds 检索结果文档 ID 列表（按排名顺序）
 * @param expectedDocIds 期望命中的文档 ID 列表
 */
export function reciprocalRank(
  retrievedDocIds: string[],
  expectedDocIds: string[],
): number {
  if (expectedDocIds.length === 0) return 0;
  const deduped = dedupePreserveOrder(retrievedDocIds);
  const expectedSet = new Set(expectedDocIds);
  for (let i = 0; i < deduped.length; i++) {
    if (expectedSet.has(deduped[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * NDCG@K：归一化折损累计增益（二元相关性）
 *
 * 公式：
 *   DCG@K  = Σ (rel_i / log2(i + 1))  for i = 1..K
 *   IDCG@K = Σ (1 / log2(i + 1))      for i = 1..min(K, |relevant|)
 *   NDCG@K = DCG@K / IDCG@K
 *
 * 含义：考虑相关文档排名位置的综合性指标。
 * 排名越靠前的相关文档贡献越大（log2 折损）。
 * 取值 [0, 1]，越高越好。IDCG 为 0 时返回 0。
 *
 * @param retrievedDocIds 检索结果文档 ID 列表（按排名顺序）
 * @param expectedDocIds 期望命中的文档 ID 列表
 * @param k 截断排名
 */
export function ndcgAtK(
  retrievedDocIds: string[],
  expectedDocIds: string[],
  k: number,
): number {
  if (expectedDocIds.length === 0 || k <= 0) return 0;
  const expectedSet = new Set(expectedDocIds);
  const topK = dedupePreserveOrder(retrievedDocIds).slice(0, k);

  // DCG@K：实际检索结果中相关文档的折损累计
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (expectedSet.has(topK[i])) {
      // 二元相关性：rel = 1，位置 i 对应排名 i+1
      dcg += 1 / Math.log2(i + 2); // log2(rank+1), rank 从 1 开始
    }
  }

  // IDCG@K：理想情况下（所有相关文档排在最前）的 DCG
  const idealHits = Math.min(k, expectedDocIds.length);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}

// ==================== 单条查询评估 ====================

/**
 * 评估单条查询的各 K 值指标
 *
 * @param retrievedDocIds 检索结果文档 ID 列表（按排名顺序）
 * @param expectedDocIds 期望命中的文档 ID 列表
 * @param kValues 要计算的 K 值列表，如 [1, 3, 5, 10]
 * @returns 指标键值对，键格式如 "Recall@3"、"NDCG@5"、"MRR"
 */
export function evaluateQuery(
  retrievedDocIds: string[],
  expectedDocIds: string[],
  kValues: number[] = [1, 3, 5, 10],
): Record<string, number> {
  const metrics: Record<string, number> = {};

  for (const k of kValues) {
    metrics[`Recall@${k}`] = round(recallAtK(retrievedDocIds, expectedDocIds, k));
    metrics[`Precision@${k}`] = round(
      precisionAtK(retrievedDocIds, expectedDocIds, k),
    );
    metrics[`NDCG@${k}`] = round(ndcgAtK(retrievedDocIds, expectedDocIds, k));
  }

  // MRR 不依赖 K，只算一次
  metrics['MRR'] = round(reciprocalRank(retrievedDocIds, expectedDocIds));

  return metrics;
}

// ==================== 聚合评估 ====================

/**
 * 聚合所有查询的评估结果，生成整体报告
 *
 * 聚合方式：
 *   - aggregate：所有样本各指标的算术平均
 *   - byCategory：按查询分类分组求均值
 *   - byDifficulty：按难度分组求均值
 *
 * @param perQuery 每条查询的评估结果
 * @param params 评估参数
 */
export function aggregateResults(
  perQuery: SingleQueryEval[],
  params: { topK: number; kValues: number[]; searchType: string },
): EvalReport {
  const validResults = perQuery.filter((r) => !r.error);
  const errorCount = perQuery.length - validResults.length;

  const aggregate = averageMetrics(validResults);
  const byCategory = groupAndAverage(validResults, (r) => r.category || 'unknown');
  const byDifficulty = groupAndAverage(validResults, (r) => r.difficulty || 'unknown');

  return {
    totalSamples: perQuery.length,
    evaluatedSamples: validResults.length,
    errorSamples: errorCount,
    aggregate,
    byCategory,
    byDifficulty,
    perQuery,
    timestamp: new Date().toISOString(),
    params,
  };
}

// ==================== 辅助函数 ====================

/** 保留 4 位小数 */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 计算一组查询结果各指标的均值 */
function averageMetrics(results: SingleQueryEval[]): Record<string, number> {
  if (results.length === 0) return {};
  const metricKeys = Object.keys(results[0].metrics);
  const aggregated: Record<string, number> = {};

  for (const key of metricKeys) {
    const sum = results.reduce((acc, r) => acc + (r.metrics[key] || 0), 0);
    aggregated[key] = round(sum / results.length);
  }

  return aggregated;
}

/** 按分组键分组后求均值 */
function groupAndAverage(
  results: SingleQueryEval[],
  groupFn: (r: SingleQueryEval) => string,
): Record<string, Record<string, number>> {
  const groups: Record<string, SingleQueryEval[]> = {};

  for (const r of results) {
    const groupKey = groupFn(r);
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(r);
  }

  const result: Record<string, Record<string, number>> = {};
  for (const [groupKey, groupResults] of Object.entries(groups)) {
    result[groupKey] = averageMetrics(groupResults);
  }

  return result;
}

/**
 * 去重并保留首次出现的顺序
 *
 * 检索结果理论上不应有重复 docId，但为健壮性做去重，
 * 避免同一文档被多次计入指标。
 */
function dedupePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
