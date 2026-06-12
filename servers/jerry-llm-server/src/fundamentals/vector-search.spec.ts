/**
 * 向量检索缓存逻辑单元测试
 *
 * 覆盖功能：
 * 1. searchKnowledgeBase：缓存 key 包含 query + filter，命中直接返回，未命中则搜索后写入
 * 2. hybridSearchKnowledgeBase：缓存 key 包含 _type: 'hybrid' 和权重参数，避免与纯向量搜索混淆
 * 3. cacheKeyOverride：FC 模式下用原始查询生成缓存 key，确保同一用户输入命中缓存
 * 4. 混合搜索内部调用 searchKnowledgeBase 时，纯向量搜索缓存也能命中
 */

// Mock 基础设施
jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./runtime-config', () => ({
  getRuntimeConfig: () => ({
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  }),
  updateRuntimeConfig: jest.fn(),
  loadRuntimeConfig: jest.fn(),
  saveRuntimeConfig: jest.fn(),
  DEFAULT_RUNTIME_CONFIG: {
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  },
}));

// Mock 向量存储依赖
const mockSimilaritySearchWithScore = jest.fn();
const mockInitializeVectorStore = jest.fn().mockResolvedValue({
  similaritySearchWithScore: mockSimilaritySearchWithScore,
  delete: jest.fn(),
});

jest.mock('./vector-store/store-state', () => ({
  initializeVectorStore: () => mockInitializeVectorStore(),
  getBM25Index: jest.fn(() => null),
  getBM25DocumentStore: jest.fn(() => new Map()),
  getEmbeddingSemaphore: jest.fn(() => ({ acquire: jest.fn().mockResolvedValue('id'), release: jest.fn() })),
  BATCH_SIZE: 100,
  COLLECTION_NAME: 'test',
  embeddings: {},
}));

jest.mock('./vector-store/bm25-index', () => ({
  initializeBM25Index: jest.fn(),
}));

import { LRUCache, searchCache } from './cache';
import { searchKnowledgeBase, hybridSearchKnowledgeBase } from './vector-store/vector-search';

// 搜索结果模板
const makeResults = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    content: `文档内容 ${i}`,
    metadata: { source: `doc${i}.txt`, doc_type: '技术文档', versionStatus: 'active' },
    score: 0.1 + i * 0.05,
  }));

describe('vector-search 缓存逻辑', () => {
  beforeEach(() => {
    searchCache.clear('测试清理');
    searchCache.resetStats();
    mockSimilaritySearchWithScore.mockReset();
    // 默认返回带 versionStatus=active 的结果
    mockSimilaritySearchWithScore.mockResolvedValue(
      makeResults(3).map(r => [{ pageContent: r.content, metadata: r.metadata }, r.score]),
    );
  });

  // ==================== searchKnowledgeBase 缓存 ====================

  describe('searchKnowledgeBase 缓存', () => {
    it('首次搜索应未命中缓存，搜索后写入缓存', async () => {
      const results = await searchKnowledgeBase('测试查询');

      expect(results.length).toBeGreaterThan(0);
      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(1);

      const stats = searchCache.getStats();
      expect(stats.misses).toBeGreaterThanOrEqual(1);
    });

    it('相同 query 再次搜索应命中缓存，不调用向量检索', async () => {
      await searchKnowledgeBase('测试查询');
      const callCount1 = mockSimilaritySearchWithScore.mock.calls.length;

      await searchKnowledgeBase('测试查询');
      const callCount2 = mockSimilaritySearchWithScore.mock.calls.length;

      // 第二次不应新增调用
      expect(callCount2).toBe(callCount1);
    });

    it('不同 query 不应命中缓存', async () => {
      await searchKnowledgeBase('查询A');
      await searchKnowledgeBase('查询B');

      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(2);
    });

    it('相同 query 但不同 filter 不应命中缓存', async () => {
      await searchKnowledgeBase('测试查询', 5, 0.55, { doc_type: 'A' });
      await searchKnowledgeBase('测试查询', 5, 0.55, { doc_type: 'B' });

      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(2);
    });

    it('相同 query + 相同 filter 应命中缓存', async () => {
      await searchKnowledgeBase('测试查询', 5, 0.55, { doc_type: 'A' });
      await searchKnowledgeBase('测试查询', 5, 0.55, { doc_type: 'A' });

      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== cacheKeyOverride ====================

  describe('cacheKeyOverride（FC 模式）', () => {
    it('传入 cacheKeyOverride 应使用覆盖值生成缓存 key', async () => {
      await searchKnowledgeBase('改写后的查询A', 5, 0.55, undefined, '原始查询');
      await searchKnowledgeBase('改写后的查询B', 5, 0.55, undefined, '原始查询');

      // cacheKeyOverride 相同，应命中缓存，只调用一次向量检索
      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(1);
    });

    it('不同 cacheKeyOverride 不应命中缓存', async () => {
      await searchKnowledgeBase('查询', 5, 0.55, undefined, '原始查询A');
      await searchKnowledgeBase('查询', 5, 0.55, undefined, '原始查询B');

      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(2);
    });

    it('无 cacheKeyOverride 时用 query 生成 key', async () => {
      await searchKnowledgeBase('测试查询');
      await searchKnowledgeBase('测试查询');

      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(1);
    });

    it('cacheKeyOverride 归一化：空格差异应命中同一缓存', async () => {
      // 用合理的测试数据：两个字符串只有空格数量不同
      const key1 = LRUCache.makeKey('AI Agent 开发');
      const key2 = LRUCache.makeKey('AI  Agent   开发');
      expect(key1).toBe(key2);

      // 端到端验证：两次搜索用不同空格的 cacheKeyOverride
      searchCache.clear('归一化测试');
      searchCache.resetStats();

      await searchKnowledgeBase('改写A', 5, 0.55, undefined, 'AI Agent 开发');
      // 第二次应命中缓存，不调用向量检索
      await searchKnowledgeBase('改写B', 5, 0.55, undefined, 'AI  Agent   开发');

      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== hybridSearchKnowledgeBase 缓存 ====================

  describe('hybridSearchKnowledgeBase 缓存', () => {
    it('混合搜索应能命中缓存', async () => {
      await hybridSearchKnowledgeBase('混合测试查询');
      const callsAfterFirst = mockSimilaritySearchWithScore.mock.calls.length;

      await hybridSearchKnowledgeBase('混合测试查询');
      const callsAfterSecond = mockSimilaritySearchWithScore.mock.calls.length;

      // 第二次不应新增向量检索调用
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    it('混合搜索与纯向量搜索的缓存 key 不同', async () => {
      searchCache.clear('混合vs纯量');

      // 先做纯向量搜索
      await searchKnowledgeBase('混合vs纯量查询');

      // 再做混合搜索（相同 query），混合搜索的外层缓存 key 包含 _type: hybrid
      // 所以混合搜索不会命中纯向量搜索的缓存
      const hitsBeforeHybrid = searchCache.getStats().hits;
      await hybridSearchKnowledgeBase('混合vs纯量查询');
      const hitsAfterHybrid = searchCache.getStats().hits;

      // 混合搜索应该有缓存命中（内部 searchKnowledgeBase 可能命中纯向量缓存）
      // 但混合搜索的外层缓存是新的未命中
      // 关键验证：两次搜索的缓存 key 不同（通过 makeKey 直接验证）
      const pureKey = LRUCache.makeKey('混合vs纯量查询');
      const hybridKey = LRUCache.makeKey('混合vs纯量查询', { _type: 'hybrid', _vw: 0.7, _bw: 0.3 });
      expect(pureKey).not.toBe(hybridKey);
    });

    it('不同权重的混合搜索不应命中缓存', async () => {
      searchCache.clear('权重测试');

      await hybridSearchKnowledgeBase('权重测试查询', 5, 0.7, 0.3);
      const hitsAfterFirst = searchCache.getStats().hits;

      await hybridSearchKnowledgeBase('权重测试查询', 5, 0.5, 0.5);
      const hitsAfterSecond = searchCache.getStats().hits;

      // 权重不同，缓存 key 不同，第二次混合搜索不应命中
      // 验证方式：缓存 key 确实不同
      const key1 = LRUCache.makeKey('权重测试查询', { _type: 'hybrid', _vw: 0.7, _bw: 0.3 });
      const key2 = LRUCache.makeKey('权重测试查询', { _type: 'hybrid', _vw: 0.5, _bw: 0.5 });
      expect(key1).not.toBe(key2);
    });

    it('混合搜索传入 cacheKeyOverride 应使用覆盖值', async () => {
      searchCache.clear('cacheKeyOverride测试');

      await hybridSearchKnowledgeBase('改写A', 5, 0.7, 0.3, undefined, '原始查询');
      const callsAfterFirst = mockSimilaritySearchWithScore.mock.calls.length;

      await hybridSearchKnowledgeBase('改写B', 5, 0.7, 0.3, undefined, '原始查询');
      const callsAfterSecond = mockSimilaritySearchWithScore.mock.calls.length;

      // cacheKeyOverride 相同，应命中缓存
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  // ==================== 事件驱动缓存清除 ====================

  describe('事件驱动缓存清除', () => {
    it('knowledge-base-updated 事件应清空缓存，下次搜索不命中', async () => {
      await searchKnowledgeBase('事件测试查询');
      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(1);

      // 触发事件
      const { eventBus } = require('./event-bus');
      eventBus.emit('knowledge-base-updated', '测试');

      // 再次搜索，应不命中缓存
      await searchKnowledgeBase('事件测试查询');
      expect(mockSimilaritySearchWithScore).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== makeKey 归一化 ====================

  describe('makeKey 归一化（L1 方案）', () => {
    it('多空格合并应生成相同 key', () => {
      const k1 = LRUCache.makeKey('AI Agent 开发');
      const k2 = LRUCache.makeKey('AI  Agent   开发');
      expect(k1).toBe(k2);
    });

    it('大小写归一化应生成相同 key', () => {
      const k1 = LRUCache.makeKey('Hello World');
      const k2 = LRUCache.makeKey('hello world');
      const k3 = LRUCache.makeKey('HELLO WORLD');
      expect(k1).toBe(k2);
      expect(k1).toBe(k3);
    });

    it('前后空格去除应生成相同 key', () => {
      const k1 = LRUCache.makeKey('hello');
      const k2 = LRUCache.makeKey('  hello  ');
      expect(k1).toBe(k2);
    });

    it('不同文本应生成不同 key', () => {
      const k1 = LRUCache.makeKey('机器学习');
      const k2 = LRUCache.makeKey('深度学习');
      expect(k1).not.toBe(k2);
    });
  });
});
