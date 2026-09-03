/**
 * 语义去重模块（Layer 1：Jaccard 参数相似度检测）
 *
 * 目标：同一工具连续调用时，如果参数语义高度相似（如"项目A 进度" vs "项目A 最新进度"），
 * 提前拦截，避免模型反复换措辞查询浪费 API 调用和时间。
 *
 * 与精确去重（工具名+参数 JSON 完全匹配）互补：
 * - 精确去重：参数完全一样才拦截
 * - 语义去重：参数语义相似度超阈值就拦截
 */

import { logger } from './logger.js';

// ==================== 常量 ====================

/** Jaccard 相似度阈值：超过此值判定为"语义重复"，中文分词后词数少，阈值适当降低 */
const SEMANTIC_DEDUP_THRESHOLD = 0.6;

/** 支持语义去重的工具白名单：只有参数含文本 query 的工具才检查 */
const SEMANTIC_DEDUP_TOOLS = new Set<string>([
  'search_knowledge_base',
  'search_web',
  'search_images',
]);

/** 每个会话最多追踪的历史 query 数量 */
const MAX_HISTORY_PER_SESSION = 5;

// ==================== 分词 ====================

/**
 * 提取文本中的词项（中文 bigram + 英文单词）
 *
 * 和 result-reranker.ts 的 extractTerms 逻辑一致：
 * - 英文：提取 2 字符以上的单词，转小写
 * - 中文：提取相邻二元组（bigram）+ 单字
 *
 * @param text 原始文本
 * @returns 词项集合
 */
function tokenizeForJaccard(text: string): Set<string> {
  const terms = new Set<string>();

  // 英文词
  const englishWords = text.match(/[a-zA-Z]{2,}/g) || [];
  for (const w of englishWords) {
    terms.add(w.toLowerCase());
  }

  // 中文二元组（bigram）
  const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i < chineseChars.length - 1; i++) {
    terms.add(chineseChars[i] + chineseChars[i + 1]);
  }
  // 单字也加入（短查询时 bigram 可能不足）
  for (const c of chineseChars) {
    terms.add(c);
  }

  return terms;
}

// ==================== Jaccard 相似度 ====================

/**
 * 计算两个集合的 Jaccard 相似度
 *
 * Jaccard = 交集大小 / 并集大小
 * 范围 [0, 1]，1 表示完全相同，0 表示完全不相交
 *
 * @param a 集合 A
 * @param b 集合 B
 * @returns 相似度 [0, 1]
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // 两个空集认为完全相同
  if (a.size === 0 || b.size === 0) return 0; // 一个空一个非空，完全不同

  let intersectionCount = 0;
  // 遍历较小的集合，在较大的集合中查找
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersectionCount++;
  }

  const unionCount = a.size + b.size - intersectionCount;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

/**
 * 计算两段文本的 Jaccard 相似度（公共接口）
 *
 * 内部使用 tokenizeForJaccard 分词 + jaccardSimilarity 计算。
 * 供其他模块（如 query-rewriter-fallback）复用，避免重复实现分词逻辑。
 *
 * @param textA 文本 A
 * @param textB 文本 B
 * @returns 相似度 [0, 1]
 */
export function calculateJaccardSimilarity(textA: string, textB: string): number {
  return jaccardSimilarity(tokenizeForJaccard(textA), tokenizeForJaccard(textB));
}

// ==================== 语义去重追踪器 ====================

/**
 * 从工具调用参数中提取 query 文本
 *
 * 不同工具的 query 参数名可能不同，统一提取逻辑：
 * - search_knowledge_base / search_web / search_images: args.query
 *
 * @param toolName 工具名
 * @param args 工具参数
 * @returns query 文本，如果无法提取返回 null
 */
function extractQueryFromArgs(toolName: string, args: Record<string, unknown>): string | null {
  // 统一从 query 字段提取
  const query = args?.query;
  if (typeof query === 'string' && query.trim().length > 0) {
    return query.trim();
  }
  return null;
}

/**
 * 检查工具是否支持语义去重
 */
export function isSemanticDedupTool(toolName: string): boolean {
  return SEMANTIC_DEDUP_TOOLS.has(toolName);
}

/**
 * 语义去重检测结果
 */
export interface SemanticDedupResult {
  /** 是否语义重复 */
  isDuplicate: boolean;
  /** 相似度分数（0-1），非重复时为 0 */
  similarity: number;
  /** 重复匹配的历史 query（如果是重复） */
  matchedQuery: string | null;
}

/**
 * 语义去重追踪器
 *
 * 按 sessionId 维度追踪每个会话中已执行的工具 query 历史，
 * 新的 tool call 到来时检查是否和历史 query 语义重复。
 *
 * 生命周期：一个 FC 循环创建一个实例，循环结束后丢弃。
 */
export class SemanticDedupTracker {
  /** sessionId → 已执行的 query 列表 */
  private history: Map<string, Array<{ toolName: string; query: string; tokens: Set<string> }>> = new Map();

  /**
   * 检查工具调用是否语义重复
   *
   * @param sessionId 会话 ID
   * @param toolName 工具名
   * @param args 工具参数
   * @returns 检测结果
   */
  check(sessionId: string, toolName: string, args: Record<string, unknown>): SemanticDedupResult {
    // 非白名单工具，不检查
    if (!SEMANTIC_DEDUP_TOOLS.has(toolName)) {
      return { isDuplicate: false, similarity: 0, matchedQuery: null };
    }

    const query = extractQueryFromArgs(toolName, args);
    if (!query) {
      return { isDuplicate: false, similarity: 0, matchedQuery: null };
    }

    const currentTokens = tokenizeForJaccard(query);
    const sessionHistory = this.history.get(sessionId) || [];

    // 和同工具的历史 query 比较
    let maxSimilarity = 0;
    let matchedQuery: string | null = null;

    for (const entry of sessionHistory) {
      if (entry.toolName !== toolName) continue; // 只和同工具比较
      const sim = jaccardSimilarity(currentTokens, entry.tokens);
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        matchedQuery = entry.query;
      }
    }

    if (maxSimilarity >= SEMANTIC_DEDUP_THRESHOLD) {
      logger.info('FC模式：语义去重拦截——参数相似度过高', {
        module: 'SemanticDedup',
        sessionId,
        toolName,
        currentQuery: query.substring(0, 100),
        matchedQuery: matchedQuery?.substring(0, 100),
        similarity: Number(maxSimilarity.toFixed(3)),
        threshold: SEMANTIC_DEDUP_THRESHOLD,
      });
      return { isDuplicate: true, similarity: maxSimilarity, matchedQuery };
    }

    return { isDuplicate: false, similarity: maxSimilarity, matchedQuery: null };
  }

  /**
   * 记录已执行的工具 query
   *
   * 在工具执行成功后调用，把 query 加入历史记录。
   *
   * @param sessionId 会话 ID
   * @param toolName 工具名
   * @param args 工具参数
   */
  record(sessionId: string, toolName: string, args: Record<string, unknown>): void {
    if (!SEMANTIC_DEDUP_TOOLS.has(toolName)) return;

    const query = extractQueryFromArgs(toolName, args);
    if (!query) return;

    let sessionHistory = this.history.get(sessionId);
    if (!sessionHistory) {
      sessionHistory = [];
      this.history.set(sessionId, sessionHistory);
    }

    sessionHistory.push({
      toolName,
      query,
      tokens: tokenizeForJaccard(query),
    });

    // 限制历史记录长度，超出时移除最早的
    if (sessionHistory.length > MAX_HISTORY_PER_SESSION) {
      sessionHistory.shift();
    }
  }
}
