/**
 * 检索结果去重模块（Layer 2：连续检索结果重叠率检测）
 *
 * 目标：当模型连续两次调用 search_knowledge_base 且返回高度重叠的文档时，
 * 说明模型在"原地打转"——查到了同样的内容却还在反复查。
 * 此时在 ToolMessage 中追加警告，让模型意识到已查到相同内容，引导其基于已有信息回答。
 *
 * 与 Layer 1（Jaccard 参数相似度）互补：
 * - Layer 1：参数文本相似就拦截（防"换措辞查"，如"项目A 进度" vs "项目A 最新进度"）
 * - Layer 2：参数不同但结果重叠也提示（防"换关键词查同一批文档"，如"项目A 进度" vs "Q2 季度报告"命中同一批文档）
 *
 * 设计取舍：Layer 2 采取"软警告"而非硬拦截
 * - Layer 1 参数相似几乎可确定是重复查询，硬拦截安全
 * - Layer 2 结果重叠可能只是模型想确认信息，硬拦截风险大
 * - 所以 Layer 2 只追加警告到 ToolMessage，由模型自行判断是否继续
 */

import { logger } from './logger.js';

// ==================== 常量 ====================

/** 重叠率阈值：超过此值判定为"高度重叠"，触发警告（0-1） */
const OVERLAP_THRESHOLD = 0.6;

/** 每个会话最多追踪的历史检索结果数量（避免内存无限增长） */
const MAX_HISTORY_PER_SESSION = 5;

/** 参与 fingerprint 计算的 content 前缀长度（截断避免 hash 长文本开销） */
const FINGERPRINT_CONTENT_PREFIX = 200;

// ==================== Fingerprint ====================

/**
 * 简单字符串 hash（非加密强度，仅用于结果指纹去重）
 *
 * 基于 djb2 变种：hash = hash * 33 + char，速度快、碰撞率可接受。
 * 用于将 content 前缀压缩为短字符串，配合 documentId 组成文档唯一指纹。
 *
 * @param s 待 hash 的字符串
 * @returns 短哈希字符串（base36 编码）
 */
function simpleHash(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i); // hash * 33 + char
    hash |= 0; // 强制转 32 位整数
  }
  return Math.abs(hash).toString(36);
}

/**
 * 计算单条检索结果的指纹
 *
 * 指纹 = `${documentId}:${contentHash}`
 * - documentId 区分不同文档
 * - contentHash（content 前 200 字符的 hash）区分同一文档的不同 chunk
 *
 * @param result 检索结果项
 * @returns 指纹字符串
 */
function fingerprintResult(result: {
  documentId?: string;
  content?: string;
}): string {
  const docId = result.documentId || 'unknown';
  const contentPrefix = (result.content || '').substring(0, FINGERPRINT_CONTENT_PREFIX);
  return `${docId}:${simpleHash(contentPrefix)}`;
}

// ==================== 类型 ====================

/** 单次检索的历史记录 */
interface SearchHistoryEntry {
  /** 触发检索的 query（用于日志和警告文案） */
  query: string;
  /** 本次检索返回的文档指纹集合 */
  fingerprints: Set<string>;
}

/** 重叠率检测结果 */
export interface SearchResultOverlapResult {
  /** 是否高度重叠（超过阈值） */
  isHighOverlap: boolean;
  /** 重叠率 [0, 1]，非重叠时为 0 */
  overlapRate: number;
  /** 重叠的文档数量 */
  overlapCount: number;
  /** 当前检索的文档总数 */
  currentCount: number;
  /** 匹配到的历史查询（如果重叠） */
  matchedQuery: string | null;
}

// ==================== 检索结果去重追踪器 ====================

/**
 * 检索结果去重追踪器
 *
 * 按 sessionId 维度追踪 search_knowledge_base 的历史检索结果指纹，
 * 新的检索结果到来时检查是否与历史结果高度重叠。
 *
 * 生命周期：一个 FC 循环创建一个实例，循环结束后丢弃。
 */
export class SearchResultDedupTracker {
  /** sessionId → 历史检索记录列表 */
  private history: Map<string, SearchHistoryEntry[]> = new Map();

  /**
   * 检查当前检索结果是否与历史结果高度重叠
   *
   * @param sessionId 会话 ID
   * @param query 当前检索的 query（用于警告文案）
   * @param results 当前检索返回的结果列表
   * @returns 重叠率检测结果
   */
  check(
    sessionId: string,
    query: string,
    results: Array<{ documentId?: string; content?: string }>,
  ): SearchResultOverlapResult {
    // 空结果无法判断重叠，直接返回不重叠
    if (!results || results.length === 0) {
      return {
        isHighOverlap: false,
        overlapRate: 0,
        overlapCount: 0,
        currentCount: 0,
        matchedQuery: null,
      };
    }

    const sessionHistory = this.history.get(sessionId) || [];
    if (sessionHistory.length === 0) {
      return {
        isHighOverlap: false,
        overlapRate: 0,
        overlapCount: 0,
        currentCount: results.length,
        matchedQuery: null,
      };
    }

    // 计算当前结果的指纹集合
    const currentFingerprints = new Set(results.map(fingerprintResult));
    const currentCount = currentFingerprints.size;

    // 遍历历史，找最大重叠率
    let maxOverlapRate = 0;
    let maxOverlapCount = 0;
    let matchedQuery: string | null = null;

    for (const entry of sessionHistory) {
      let overlapCount = 0;
      // 遍历当前指纹，统计在历史指纹中出现的数量
      for (const fp of currentFingerprints) {
        if (entry.fingerprints.has(fp)) {
          overlapCount++;
        }
      }

      // 重叠率 = 重叠数量 / 当前结果数量
      // 用当前结果数作分母：衡量"本次检索中有多少是已查过的"
      const overlapRate = currentCount > 0 ? overlapCount / currentCount : 0;

      if (overlapRate > maxOverlapRate) {
        maxOverlapRate = overlapRate;
        maxOverlapCount = overlapCount;
        matchedQuery = entry.query;
      }
    }

    const isHighOverlap = maxOverlapRate >= OVERLAP_THRESHOLD;

    if (isHighOverlap) {
      logger.info('检索结果去重：检测到高度重叠', {
        module: 'SearchResultDedup',
        sessionId,
        currentQuery: query.substring(0, 100),
        matchedQuery: matchedQuery?.substring(0, 100),
        overlapRate: Number(maxOverlapRate.toFixed(3)),
        overlapCount: maxOverlapCount,
        currentCount,
        threshold: OVERLAP_THRESHOLD,
      });
    }

    return {
      isHighOverlap,
      overlapRate: maxOverlapRate,
      overlapCount: maxOverlapCount,
      currentCount,
      matchedQuery,
    };
  }

  /**
   * 记录一次检索结果到历史
   *
   * 在工具执行成功后调用，供后续轮次比对。
   *
   * @param sessionId 会话 ID
   * @param query 本次检索的 query
   * @param results 本次检索返回的结果列表
   */
  record(
    sessionId: string,
    query: string,
    results: Array<{ documentId?: string; content?: string }>,
  ): void {
    if (!results || results.length === 0) return;

    const entry: SearchHistoryEntry = {
      query,
      fingerprints: new Set(results.map(fingerprintResult)),
    };

    let sessionHistory = this.history.get(sessionId);
    if (!sessionHistory) {
      sessionHistory = [];
      this.history.set(sessionId, sessionHistory);
    }

    sessionHistory.push(entry);

    // 限制历史长度，超出时移除最早的（FIFO）
    if (sessionHistory.length > MAX_HISTORY_PER_SESSION) {
      sessionHistory.shift();
    }
  }
}
