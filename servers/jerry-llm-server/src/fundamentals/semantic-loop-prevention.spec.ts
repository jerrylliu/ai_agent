/**
 * 语义空转预防机制测试
 *
 * 覆盖 4 个模块：
 * 1. semantic-dedup.ts — calculateJaccardSimilarity + SemanticDedupTracker
 * 2. search-result-dedup.ts — SearchResultDedupTracker
 * 3. cache-key-normalizer.ts — buildNormalizedCacheKey + buildIntersectionCacheKey
 * 4. query-rewriter-fallback.ts — selectCacheKeySource
 *
 * 这些模块共同构成防止 FC Agent 语义空转的三层防线 + 缓存 key 优化。
 */

// ==================== Mock 声明（必须在顶层） ====================

jest.mock('./logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

// ==================== 导入被测模块 ====================

import {
  SemanticDedupTracker,
  calculateJaccardSimilarity,
} from './semantic-dedup';
import { SearchResultDedupTracker } from './search-result-dedup';
import {
  buildNormalizedCacheKey,
  buildIntersectionCacheKey,
} from './cache-key-normalizer';
import { evaluateRewriteQuality } from './query-rewriter-fallback';
import type { RewrittenQuery } from './vector-store/query-rewriter';

// ==================== 1. calculateJaccardSimilarity ====================

describe('calculateJaccardSimilarity', () => {
  it('完全相同的文本相似度应为 1', () => {
    expect(calculateJaccardSimilarity('项目A 进度', '项目A 进度')).toBe(1);
  });

  it('完全不同的文本相似度应为 0', () => {
    expect(calculateJaccardSimilarity('项目A', '天气预报')).toBe(0);
  });

  it('语义相似的文本相似度应较高（换措辞查）', () => {
    const sim = calculateJaccardSimilarity('项目A 进度', '项目A 最新进度');
    // "项目A 进度" vs "项目A 最新进度"：bigram 部分重叠，相似度约 0.5
    expect(sim).toBeGreaterThanOrEqual(0.4);
  });

  it('空文本之间相似度应为 1（两个空集）', () => {
    expect(calculateJaccardSimilarity('', '')).toBe(1);
  });

  it('空文本与非空文本相似度应为 0', () => {
    expect(calculateJaccardSimilarity('', '项目A')).toBe(0);
  });

  it('英文文本应不区分大小写', () => {
    expect(calculateJaccardSimilarity('ProjectA Progress', 'projecta progress')).toBe(1);
  });
});

// ==================== 2. SemanticDedupTracker ====================

describe('SemanticDedupTracker', () => {
  let tracker: SemanticDedupTracker;

  beforeEach(() => {
    tracker = new SemanticDedupTracker();
  });

  it('首次调用不应判定为重复', () => {
    const result = tracker.check('session-1', 'search_knowledge_base', {
      query: '项目A 进度',
    });
    expect(result.isDuplicate).toBe(false);
  });

  it('完全相同的参数应判定为重复', () => {
    tracker.record('session-1', 'search_knowledge_base', { query: '项目A 进度' });
    const result = tracker.check('session-1', 'search_knowledge_base', {
      query: '项目A 进度',
    });
    expect(result.isDuplicate).toBe(true);
    expect(result.similarity).toBe(1);
  });

  it('语义相似的参数（换措辞）应判定为重复', () => {
    tracker.record('session-1', 'search_knowledge_base', { query: '项目A 进度' });
    // "项目A 进度" vs "项目A 进度报告"：相似度约 0.73 > 0.6 阈值
    const result = tracker.check('session-1', 'search_knowledge_base', {
      query: '项目A 进度报告',
    });
    expect(result.isDuplicate).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.6);
  });

  it('语义不同的参数不应判定为重复', () => {
    tracker.record('session-1', 'search_knowledge_base', { query: '项目A 进度' });
    const result = tracker.check('session-1', 'search_knowledge_base', {
      query: '天气预报',
    });
    expect(result.isDuplicate).toBe(false);
  });

  it('不同会话应独立追踪', () => {
    tracker.record('session-1', 'search_knowledge_base', { query: '项目A 进度' });
    const result = tracker.check('session-2', 'search_knowledge_base', {
      query: '项目A 进度',
    });
    expect(result.isDuplicate).toBe(false);
  });

  it('不在白名单中的工具不应检测', () => {
    tracker.record('session-1', 'calculate', { expression: '1+1' });
    const result = tracker.check('session-1', 'calculate', { expression: '1+1' });
    expect(result.isDuplicate).toBe(false);
  });

  it('空 query 参数不应判定为重复', () => {
    tracker.record('session-1', 'search_knowledge_base', { query: '' });
    const result = tracker.check('session-1', 'search_knowledge_base', { query: '' });
    expect(result.isDuplicate).toBe(false);
  });
});

// ==================== 3. SearchResultDedupTracker ====================

describe('SearchResultDedupTracker', () => {
  let tracker: SearchResultDedupTracker;

  beforeEach(() => {
    tracker = new SearchResultDedupTracker();
  });

  const makeResults = (docs: Array<{ id: string; content: string }>) =>
    docs.map((d) => ({ documentId: d.id, content: d.content }));

  it('首次检索不应判定为重叠', () => {
    const results = makeResults([
      { id: 'doc1', content: '项目A 进度报告' },
      { id: 'doc2', content: '项目A 财务情况' },
    ]);
    const result = tracker.check('session-1', '项目A 进度', results);
    expect(result.isHighOverlap).toBe(false);
  });

  it('完全相同的结果应判定为高度重叠', () => {
    const results = makeResults([
      { id: 'doc1', content: '项目A 进度报告' },
      { id: 'doc2', content: '项目A 财务情况' },
    ]);
    tracker.record('session-1', '项目A 进度', results);
    const result = tracker.check('session-1', '项目A 最新进度', results);
    expect(result.isHighOverlap).toBe(true);
    expect(result.overlapRate).toBe(1);
  });

  it('部分重叠超过阈值应判定为高度重叠', () => {
    const firstResults = makeResults([
      { id: 'doc1', content: '内容1' },
      { id: 'doc2', content: '内容2' },
      { id: 'doc3', content: '内容3' },
    ]);
    const secondResults = makeResults([
      { id: 'doc1', content: '内容1' }, // 重叠
      { id: 'doc2', content: '内容2' }, // 重叠
      { id: 'doc4', content: '内容4' }, // 不重叠
    ]);
    tracker.record('session-1', '查询1', firstResults);
    const result = tracker.check('session-1', '查询2', secondResults);
    // 重叠率 = 2/3 ≈ 0.67 > 0.6 阈值
    expect(result.isHighOverlap).toBe(true);
    expect(result.overlapCount).toBe(2);
  });

  it('重叠率低于阈值不应判定为高度重叠', () => {
    const firstResults = makeResults([
      { id: 'doc1', content: '内容1' },
      { id: 'doc2', content: '内容2' },
      { id: 'doc3', content: '内容3' },
    ]);
    const secondResults = makeResults([
      { id: 'doc1', content: '内容1' }, // 重叠
      { id: 'doc4', content: '内容4' }, // 不重叠
      { id: 'doc5', content: '内容5' }, // 不重叠
    ]);
    tracker.record('session-1', '查询1', firstResults);
    const result = tracker.check('session-1', '查询2', secondResults);
    // 重叠率 = 1/3 ≈ 0.33 < 0.6 阈值
    expect(result.isHighOverlap).toBe(false);
  });

  it('空结果不应判定为重叠', () => {
    tracker.record('session-1', '查询1', makeResults([{ id: 'doc1', content: '内容1' }]));
    const result = tracker.check('session-1', '查询2', []);
    expect(result.isHighOverlap).toBe(false);
  });

  it('不同会话应独立追踪', () => {
    const results = makeResults([{ id: 'doc1', content: '内容1' }]);
    tracker.record('session-1', '查询1', results);
    const result = tracker.check('session-2', '查询2', results);
    expect(result.isHighOverlap).toBe(false);
  });

  it('同一文档不同 chunk 内容应有不同指纹', () => {
    const firstResults = makeResults([{ id: 'doc1', content: '前半部分内容' }]);
    const secondResults = makeResults([{ id: 'doc1', content: '后半部分内容' }]);
    tracker.record('session-1', '查询1', firstResults);
    const result = tracker.check('session-1', '查询2', secondResults);
    // 同 documentId 但 content 不同 → 指纹不同 → 不重叠
    expect(result.isHighOverlap).toBe(false);
  });
});

// ==================== 4. buildNormalizedCacheKey ====================

describe('buildNormalizedCacheKey', () => {
  it('应去除停用词', () => {
    const key1 = buildNormalizedCacheKey('项目A 的 进度');
    const key2 = buildNormalizedCacheKey('项目A 进度');
    expect(key1).toBe(key2);
  });

  it('应不区分语序（排序后拼接）', () => {
    const key1 = buildNormalizedCacheKey('项目A 进度');
    const key2 = buildNormalizedCacheKey('进度 项目A');
    expect(key1).toBe(key2);
  });

  it('应忽略标点和空格差异', () => {
    const key1 = buildNormalizedCacheKey('项目A，进度！');
    const key2 = buildNormalizedCacheKey('  项目A 进度  ');
    expect(key1).toBe(key2);
  });

  it('英文应转小写', () => {
    const key1 = buildNormalizedCacheKey('ProjectA Progress');
    const key2 = buildNormalizedCacheKey('projecta progress');
    expect(key1).toBe(key2);
  });

  it('空查询应返回空字符串', () => {
    expect(buildNormalizedCacheKey('')).toBe('');
    expect(buildNormalizedCacheKey('   ')).toBe('');
  });

  it('全停用词应返回空字符串', () => {
    expect(buildNormalizedCacheKey('的 了 是')).toBe('');
  });

  it('应返回非空指纹', () => {
    const key = buildNormalizedCacheKey('项目A 进度');
    expect(key.length).toBeGreaterThan(0);
    expect(key).toContain('|');
  });
});

// ==================== 5. buildIntersectionCacheKey ====================

describe('buildIntersectionCacheKey', () => {
  it('应返回两个查询的交集词指纹', () => {
    const key = buildIntersectionCacheKey('项目A 进度', '项目A 最新进度');
    expect(key.length).toBeGreaterThan(0);
    expect(key).toContain('|');
  });

  it('无交集时应返回空字符串', () => {
    const key = buildIntersectionCacheKey('项目A 进度', '天气预报');
    expect(key).toBe('');
  });

  it('相同查询的交集应等于归一化指纹', () => {
    const intersection = buildIntersectionCacheKey('项目A 进度', '项目A 进度');
    const normalized = buildNormalizedCacheKey('项目A 进度');
    expect(intersection).toBe(normalized);
  });
});

// ==================== 6. evaluateRewriteQuality ====================

describe('evaluateRewriteQuality', () => {
  it('改写失败（undefined）应不使用改写后查询', () => {
    const result = evaluateRewriteQuality('项目A 进度', undefined);
    expect(result.useRewritten).toBe(false);
    expect(result.fallbackReason).toBe('rewrite_failed');
  });

  it('未实际改写（wasRewritten=false）应不使用改写后查询', () => {
    const rewritten: RewrittenQuery = {
      mainQuery: '项目A 进度',
      subQueries: [],
      keywords: [],
      wasRewritten: false,
    };
    const result = evaluateRewriteQuality('项目A 进度', rewritten);
    expect(result.useRewritten).toBe(false);
    expect(result.fallbackReason).toBe('no_rewrite');
  });

  it('改写合理（相似度高）应使用改写后 mainQuery', () => {
    const rewritten: RewrittenQuery = {
      mainQuery: '项目A 当前进度情况',
      subQueries: [],
      keywords: [],
      wasRewritten: true,
    };
    const result = evaluateRewriteQuality('项目A 进度', rewritten);
    expect(result.useRewritten).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.3);
  });

  it('改写偏差大（相似度低）应不使用改写后查询', () => {
    const rewritten: RewrittenQuery = {
      mainQuery: 'Q2 季度财务报告',
      subQueries: [],
      keywords: [],
      wasRewritten: true,
    };
    const result = evaluateRewriteQuality('项目A 进度', rewritten);
    expect(result.useRewritten).toBe(false);
    expect(result.fallbackReason).toBe('semantic_deviation');
    expect(result.similarity).toBeLessThan(0.3);
  });

  it('相似度应被正确计算', () => {
    const rewritten: RewrittenQuery = {
      mainQuery: '项目A 进度',
      subQueries: [],
      keywords: [],
      wasRewritten: true,
    };
    const result = evaluateRewriteQuality('项目A 进度', rewritten);
    expect(result.similarity).toBe(1);
  });
});
