/**
 * 多路检索结果的统一 RRF 合并
 *
 * 解决的问题：跨路分数不可比（权重倒挂）。
 * hybridSearchKnowledgeBase 内部对"向量+BM25"做 RRF 融合，但当调用方
 * 把多条独立检索的结果合并时（主查询一路 + N 个子查询各一路 + 追问一路），
 * 各路的融合分数物理意义不同：
 *   - 有 HyDE 时主向量路权重被减半（0.35），子查询向量路满权（0.7）
 *   - 子查询 query 短、命中集中，其路内 rank-1 的 RRF 分天然偏高
 * 直接按 score 排序合并 = 子查询第 1 名系统性压过主查询的纯向量命中，
 * 池口截断时主路强块被挤出候选池（2026-09-18 验证轮 semantic 暴跌的根因）。
 *
 * 解法：把每一路视为平等 ranked list，做二次 RRF——只看路内排名，
 * 不比较跨路分数；主路可加权（primaryWeight），但不删除任何一路。
 */

import { logger } from '../logger.js';

/** 可合并的最小检索结果形状（与 hybridSearchKnowledgeBase 返回一致） */
export interface RrfMergeableResult {
  content: string;
  metadata: any;
  score: number;
  vectorScore?: number;
  sources: string[];
}

/** 二次 RRF 的 K 值（与 vector-search.ts 内层 RRF 一致，论文经验值） */
const RRF_K = 60;

/**
 * 多路结果统一 RRF 合并
 *
 * @param rankedLists 各路结果列表，每项已按该路 score 降序排列；
 *        primary 的位置（通常是第 0 路）享受 primaryWeight 加权
 * @param primaryWeight 主路权重（默认 1.0，附加路恒为 1.0）
 * @returns 合并去重后的列表（按统一 RRF 分数降序），条数 = 所有路去重后的并集
 */
export function mergeRankedListsByRRF(
  rankedLists: RrfMergeableResult[][],
  primaryWeight = 1.0,
): Array<RrfMergeableResult & { rrfScore: number }> {
  interface Merged {
    result: RrfMergeableResult;
    rrfScore: number;
    /** 记录命中的路数（日志用：多路共识是强信号） */
    hits: number;
  }
  const merged = new Map<string, Merged>();

  rankedLists.forEach((list, listIndex) => {
    const weight = listIndex === 0 ? primaryWeight : 1.0;
    list.forEach((result, rank) => {
      const rrfScore = weight / (RRF_K + rank + 1);
      const existing = merged.get(result.content);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.hits += 1;
      } else {
        merged.set(result.content, { result, rrfScore, hits: 1 });
      }
    });
  });

  const sorted = Array.from(merged.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((m) => ({ ...m.result, rrfScore: m.rrfScore }));

  logger.debug('多路统一 RRF 合并完成', {
    module: 'MultiWayRRF',
    listCount: rankedLists.length,
    primaryWeight,
    uniqueResults: sorted.length,
    top3: sorted.slice(0, 3).map((r) => ({
      rrfScore: r.rrfScore.toFixed(6),
      multiHit: merged.get(r.content)?.hits ?? 1,
    })),
  });

  return sorted;
}
