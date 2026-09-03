/**
 * 查询改写兜底模块
 *
 * 目标：评估查询改写质量，当改写失败或改写后语义偏差大时，
 * 提示调用方降级使用原始查询作 cache key 源，避免：
 * 1. 缓存失效（相同语义的原始查询改写后每次不同，cache key 漂移）
 * 2. 命中错误缓存（语义不同的查询碰巧改写后相似，命中不该命中的缓存）
 *
 * 判断逻辑（3 层）：
 * 1. 改写失败/未改写 → 不使用改写后查询
 * 2. 改写成功，计算 mainQuery 与改写输入（query）的 Jaccard 相似度
 *    - 相似度 >= 偏差阈值 → 使用改写后 mainQuery（改写合理，归一化后命中率高）
 *    - 相似度 < 偏差阈值 → 不使用改写后查询（改写偏差大，降级保稳定）
 *
 * 重要：偏差检测比较的是"改写输入 query"与"改写输出 mainQuery"，
 * 而非"用户原始输入 originalQuery"与"mainQuery"。
 * 因为改写是基于 query 做的，只有 query vs mainQuery 才能反映改写本身是否偏差。
 *
 * 与缓存 key 归一化的配合：
 * - 本模块只评估改写质量，返回 useRewritten 标志
 * - 调用方根据 useRewritten 决定用 mainQuery 还是原始查询作 cache key 源
 * - 归一化（分词、去停用词、排序拼接）由 cache-key-normalizer.ts 负责
 */

import { calculateJaccardSimilarity } from './semantic-dedup.js';
import type { RewrittenQuery } from './vector-store/query-rewriter.js';
import { logger } from './logger.js';

// ==================== 常量 ====================

/**
 * 改写偏差阈值：改写后 mainQuery 与改写输入 query 的 Jaccard 相似度低于此值，
 * 认为改写偏差大，不使用改写后查询。
 *
 * 阈值取 0.3 的依据：
 * - 改写通常会换措辞（如"项目A 进度"→"项目A 当前进度情况"），相似度在 0.4-0.7
 * - 完全换主题的改写（如"项目A 进度"→"Q2 财务报告"）相似度通常 < 0.2
 * - 0.3 是区分"合理改写"和"偏差改写"的经验分界线
 */
const REWRITE_DEVIATION_THRESHOLD = 0.3;

// ==================== 类型 ====================

/** 不使用改写后查询的原因 */
export type FallbackReason = 'rewrite_failed' | 'no_rewrite' | 'semantic_deviation';

/** 改写质量评估结果 */
export interface RewriteEvaluation {
  /** 是否应该使用改写后 mainQuery 作 cache key 源 */
  useRewritten: boolean;
  /** 改写前后 Jaccard 相似度（改写成功时有效） */
  similarity?: number;
  /** 不使用改写后查询的原因（useRewritten 为 false 时有效） */
  fallbackReason?: FallbackReason;
}

// ==================== 改写质量评估 ====================

/**
 * 评估查询改写质量，决定是否使用改写后查询作 cache key 源
 *
 * @param rewriteInput 改写的输入文本（即 LLM 生成的工具参数 query）
 * @param rewrittenQuery 改写结果（可能为 undefined 表示改写失败）
 * @returns 评估结果，useRewritten 为 true 时调用方应使用 rewrittenQuery.mainQuery
 */
export function evaluateRewriteQuality(
  rewriteInput: string,
  rewrittenQuery: RewrittenQuery | undefined,
): RewriteEvaluation {
  // 1. 改写失败（异常或未启用）→ 不使用改写后查询
  if (!rewrittenQuery) {
    logger.info('改写兜底：改写失败，不使用改写后查询', {
      module: 'QueryRewriterFallback',
      rewriteInput: rewriteInput.substring(0, 100),
      fallbackReason: 'rewrite_failed',
    });
    return {
      useRewritten: false,
      fallbackReason: 'rewrite_failed',
    };
  }

  // 2. 改写未实际发生（mainQuery 与输入相同）→ 不使用改写后查询
  if (!rewrittenQuery.wasRewritten) {
    return {
      useRewritten: false,
      fallbackReason: 'no_rewrite',
    };
  }

  // 3. 改写成功，检测语义偏差
  // 比较"改写输入 query"与"改写输出 mainQuery"，反映改写本身是否偏差
  const similarity = calculateJaccardSimilarity(
    rewriteInput,
    rewrittenQuery.mainQuery,
  );

  if (similarity < REWRITE_DEVIATION_THRESHOLD) {
    // 偏差大，不使用改写后查询，避免 cache key 漂移
    logger.warn('改写兜底：改写后语义偏差大，不使用改写后查询', {
      module: 'QueryRewriterFallback',
      rewriteInput: rewriteInput.substring(0, 100),
      rewrittenMainQuery: rewrittenQuery.mainQuery.substring(0, 100),
      similarity: Number(similarity.toFixed(3)),
      threshold: REWRITE_DEVIATION_THRESHOLD,
      fallbackReason: 'semantic_deviation',
    });
    return {
      useRewritten: false,
      fallbackReason: 'semantic_deviation',
      similarity,
    };
  }

  // 4. 改写合理，使用改写后 mainQuery
  logger.debug('改写兜底：改写合理，使用改写后 mainQuery 作 cache key 源', {
    module: 'QueryRewriterFallback',
    rewriteInput: rewriteInput.substring(0, 100),
    rewrittenMainQuery: rewrittenQuery.mainQuery.substring(0, 100),
    similarity: Number(similarity.toFixed(3)),
  });
  return {
    useRewritten: true,
    similarity,
  };
}
