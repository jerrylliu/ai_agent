/**
 * 缓存 key 归一化模块
 *
 * 目标：将改写后的查询归一化为稳定的缓存 key，
 * 使同一批文档的不同查询措辞都能命中同一缓存。
 *
 * 归一化策略（4 步）：
 * 1. 分词：英文单词（≥2 字符）+ 中文 bigram + 中文单字
 * 2. 去停用词：剔除"的、了、是、在"等高频虚词，保留核心实体
 * 3. 排序去重：确保不同语序的相同查询生成相同 key（"项目A 进度" == "进度 项目A"）
 * 4. 拼接指纹：用 `|` 连接排序后的词项
 *
 * 与"用原始用户输入作 cache key"的区别：
 * - 原始输入：每次可能有微小差异（多空格、标点、语序），导致 cache miss
 * - 归一化指纹：提取核心实体词，去除噪音，提高命中率
 *
 * 使用场景：查询改写成功且语义未偏差时，用改写后查询的归一化指纹作 cache key。
 * 改写失败或语义偏差大时（由 query-rewriter-fallback 处理），回退到原始查询词项。
 */

import { logger } from './logger.js';

// ==================== 停用词表 ====================

/**
 * 中文高频虚词 + 英文常见停用词
 *
 * 这些词在查询中信息量低，剔除后不影响语义匹配，反而能提高缓存命中率
 * （因为"项目A 的 进度"和"项目A 进度"归一化后都是 "项目a|进度"）。
 */
const STOP_WORDS = new Set<string>([
  // 中文虚词/代词/介词/连词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
  '和', '与', '或', '但', '而', '也', '都', '就', '还', '又',
  '把', '被', '让', '给', '对', '向', '从', '到', '为', '于',
  '这', '那', '哪', '个', '些', '什么', '怎么', '为什么', '如何',
  '可以', '应该', '需要', '已经', '正在', '将', '会', '能', '要',
  '不', '没', '没有', '非', '未', '别', '莫',
  '一', '二', '三', '个', '种', '些',
  // 英文停用词
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'not',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'by', 'with',
  'from', 'into', 'about', 'how', 'what', 'why', 'when', 'where',
  'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'must', 'shall',
]);

// ==================== 分词 ====================

/**
 * 提取文本中的词项（英文单词 + 中文单字）
 *
 * 与 semantic-dedup.ts 的 tokenizeForJaccard 不同：
 * - semantic-dedup 用 bigram + 单字（Jaccard 需要捕获中文语义）
 * - cache-key-normalizer 只用单字（缓存 key 需要语序无关 + 停用词可过滤）
 *
 * 为什么不用 bigram？
 * - bigram "目的" 包含停用词"的"但不是纯停用词，无法被停用词表过滤
 * - bigram 对语序敏感："项目进度"和"进度项目"的 bigram 不同
 * - 缓存 key 只需核心实体词，单字 + 英文单词足够区分
 *
 * @param text 原始文本
 * @returns 词项数组（未去重、未排序）
 */
function tokenize(text: string): string[] {
  const terms: string[] = [];

  // 英文词（≥2 字符，转小写）
  const englishWords = text.match(/[a-zA-Z]{2,}/g) || [];
  for (const w of englishWords) {
    terms.push(w.toLowerCase());
  }

  // 中文单字（不用 bigram：确保语序无关 + 停用词可过滤）
  const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
  for (const c of chineseChars) {
    terms.push(c);
  }

  return terms;
}

// ==================== 归一化缓存 key ====================

/**
 * 将查询归一化为稳定的缓存 key 指纹
 *
 * 处理流程：分词 → 去停用词 → 去重排序 → 拼接
 *
 * @param query 待归一化的查询文本（通常是改写后的 mainQuery）
 * @returns 归一化指纹字符串（如 "进度|项目a"），空查询返回空字符串
 *
 * @example
 * buildNormalizedCacheKey('项目A 的 进度')    // "进度|项目a"
 * buildNormalizedCacheKey('项目A 进度')       // "进度|项目a"  ← 与上面相同，命中缓存
 * buildNormalizedCacheKey('  项目A，进度！')  // "进度|项目a"  ← 标点空格不影响
 */
export function buildNormalizedCacheKey(query: string): string {
  if (!query || query.trim().length === 0) {
    return '';
  }

  // 1. 分词
  const tokens = tokenize(query);

  // 2. 去停用词 + 去重
  const filteredSet = new Set<string>();
  let removedStopWordCount = 0;
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) {
      removedStopWordCount++;
      continue;
    }
    filteredSet.add(token);
  }

  // 3. 排序
  const sorted = [...filteredSet].sort();

  // 4. 拼接
  const fingerprint = sorted.join('|');

  logger.debug('缓存 key 归一化完成', {
    module: 'CacheKeyNormalizer',
    originalQuery: query.substring(0, 100),
    tokenCount: tokens.length,
    removedStopWordCount,
    finalTokenCount: sorted.length,
    fingerprint: fingerprint.substring(0, 100),
  });

  return fingerprint;
}

/**
 * 计算两个查询的交集词指纹
 *
 * 取两个查询归一化后词项的交集，作为更保守的缓存 key。
 * 适用于：改写后查询与原始查询有部分重叠时，用交集词作 key，
 * 既能命中改写前的缓存，也能被后续相似查询命中。
 *
 * @param queryA 查询 A
 * @param queryB 查询 B
 * @returns 交集词指纹（排序后拼接），无交集返回空字符串
 */
export function buildIntersectionCacheKey(queryA: string, queryB: string): string {
  const tokensA = new Set(tokenize(queryA).filter((t) => !STOP_WORDS.has(t)));
  const tokensB = new Set(tokenize(queryB).filter((t) => !STOP_WORDS.has(t)));

  // 取交集
  const intersection: string[] = [];
  for (const t of tokensA) {
    if (tokensB.has(t)) {
      intersection.push(t);
    }
  }

  if (intersection.length === 0) {
    return '';
  }

  intersection.sort();
  return intersection.join('|');
}
