/**
 * 检索增强策略测试
 *
 * 测试 Query Rewriting、Multi-hop Search、Result Reranker 三个模块
 * 以及 search-knowledge-base.ts 的集成流程
 *
 * 策略：只 mock 底层依赖（model-provider、vector-search），
 * 让被测模块的真实逻辑运行，验证端到端行为。
 */

// ==================== Mock 声明（必须在顶层） ====================

const mockLLMInvoke = jest.fn();
const mockHybridSearch = jest.fn();

jest.mock('../model-provider.js', () => ({
  createLLM: () => ({ invoke: mockLLMInvoke }),
  createRateLimitedLLM: () => ({ invoke: mockLLMInvoke }),
  buildModelConfig: (modelId: string) => ({
    provider: 'deepseek',
    model: modelId?.split(':')[1] || 'test',
    temperature: 0.1,
    apiKey: 'test-key',
  }),
}));

jest.mock('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../vector-store/vector-search.js', () => ({
  hybridSearchKnowledgeBase: mockHybridSearch,
}));

jest.mock('../vector-store', () => ({
  hybridSearchKnowledgeBase: mockHybridSearch,
}));

jest.mock('../runtime-config.js', () => ({
  getRuntimeConfig: () => ({
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  }),
  updateRuntimeConfig: jest.fn(),
  saveRuntimeConfig: jest.fn(),
}));

jest.mock('../llm-rate-limiter.js', () => ({
  llmRateLimiter: {
    acquire: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
  },
  getRateLimiterStatus: jest.fn().mockReturnValue({}),
  getRateLimiterConfig: jest.fn().mockReturnValue({}),
  updateRateLimiterConfig: jest.fn(),
}));

jest.mock('../cache.js', () => ({
  searchCache: {
    get: jest.fn().mockReturnValue(undefined),
    set: jest.fn(),
    clear: jest.fn(),
    getStats: jest.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0, size: 0, maxSize: 200, memoryUsageKB: 0 }),
  },
  getCacheStats: jest.fn(),
  getCacheConfig: jest.fn(),
  updateCacheConfig: jest.fn(),
  clearCache: jest.fn(),
}));

// Mock config for DashScope
jest.mock('../config.js', () => ({
  config: {
    dashscopeBaseUrl: 'https://dashscope.aliyuncs.com',
    dashscopeApiKey: 'test-dashscope-key',
  },
}));

// Mock global fetch for DashScope Reranker tests
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// ==================== Query Rewriter 测试 ====================

import { rewriteQuery } from '../vector-store/query-rewriter.js';

describe('query-rewriter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rewriteQuery', () => {
    it('查询为空时应返回原始查询', async () => {
      const result = await rewriteQuery('');
      expect(result.mainQuery).toBe('');
      expect(result.wasRewritten).toBe(false);
      expect(mockLLMInvoke).not.toHaveBeenCalled();
    });

    it('查询过短（<3字符）时应返回原始查询', async () => {
      const result = await rewriteQuery('AB');
      expect(result.mainQuery).toBe('AB');
      expect(result.wasRewritten).toBe(false);
      expect(mockLLMInvoke).not.toHaveBeenCalled();
    });

    it('禁用改写时应返回原始查询', async () => {
      const result = await rewriteQuery('如何配置数据库', { enabled: false });
      expect(result.mainQuery).toBe('如何配置数据库');
      expect(result.wasRewritten).toBe(false);
      expect(mockLLMInvoke).not.toHaveBeenCalled();
    });

    it('LLM 返回有效 JSON 时应正确解析', async () => {
      mockLLMInvoke.mockResolvedValue({
        content: JSON.stringify({
          main_query: '数据库 连接 配置 database connection',
          sub_queries: ['数据库连接配置方法', 'database connection setup'],
          keywords: ['数据库', '连接', '配置'],
        }),
      });

      const result = await rewriteQuery('怎么配置数据库连接？');
      expect(result.mainQuery).toBe('数据库 连接 配置 database connection');
      expect(result.subQueries).toHaveLength(2);
      expect(result.keywords).toContain('数据库');
      expect(result.wasRewritten).toBe(true);
    });

    it('LLM 返回 markdown 代码块时应正确提取 JSON', async () => {
      mockLLMInvoke.mockResolvedValue({
        content: '```json\n{"main_query": "RAG 检索增强", "sub_queries": [], "keywords": ["RAG"]}\n```',
      });

      const result = await rewriteQuery('什么是RAG');
      expect(result.mainQuery).toBe('RAG 检索增强');
      expect(result.keywords).toContain('RAG');
    });

    it('LLM 调用失败时应回退到原始查询', async () => {
      mockLLMInvoke.mockRejectedValue(new Error('LLM 不可用'));

      const result = await rewriteQuery('测试查询');
      expect(result.mainQuery).toBe('测试查询');
      expect(result.wasRewritten).toBe(false);
    });

    it('LLM 返回无效 JSON 时应回退到原始查询', async () => {
      mockLLMInvoke.mockResolvedValue({ content: '这不是JSON格式' });

      const result = await rewriteQuery('测试查询');
      expect(result.mainQuery).toBe('测试查询');
      expect(result.wasRewritten).toBe(false);
    });

    it('简单关键词提取应过滤停用词', async () => {
      const result = await rewriteQuery('如何配置数据库连接', { enabled: false });
      expect(result.keywords.length).toBeGreaterThan(0);
      expect(result.keywords).not.toContain('如何');
    });
  });
});

// ==================== Result Reranker 测试 ====================

import { rerankResults } from '../vector-store/result-reranker.js';

describe('result-reranker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('关键词重排', () => {
    it('禁用重排时应直接返回原始结果', async () => {
      const results = [
        { content: '文档A', metadata: {}, score: 0.8 },
        { content: '文档B', metadata: {}, score: 0.6 },
      ];
      const reranked = await rerankResults('测试', results, { enabled: false });
      expect(reranked).toHaveLength(2);
      expect(reranked[0].originalScore).toBe(0.8);
    });

    it('结果为空时应返回空数组', async () => {
      const reranked = await rerankResults('测试', []);
      expect(reranked).toHaveLength(0);
    });

    it('只有 1 个结果时无需重排', async () => {
      const results = [{ content: '文档A', metadata: {}, score: 0.8 }];
      const reranked = await rerankResults('测试', results);
      expect(reranked).toHaveLength(1);
      expect(reranked[0].rerankScore).toBe(1.0);
    });

    it('关键词重排应按匹配度排序', async () => {
      const results = [
        { content: '天气晴朗，适合出行', metadata: {}, score: 0.5 },
        { content: '今天北京天气如何', metadata: {}, score: 0.3 },
        { content: '数据库配置方法', metadata: {}, score: 0.9 },
      ];
      const reranked = await rerankResults('北京天气', results, {
        strategy: 'keyword',
        originalScoreWeight: 0,
      });
      expect(reranked).toHaveLength(3);
      expect(reranked[0].content).toContain('天气');
    });

    it('英文关键词匹配', async () => {
      const results = [
        { content: 'database configuration guide', metadata: {}, score: 0.5 },
        { content: 'weather forecast today', metadata: {}, score: 0.3 },
        { content: 'database connection pool setup', metadata: {}, score: 0.9 },
      ];
      const reranked = await rerankResults('database configuration', results, {
        strategy: 'keyword',
        originalScoreWeight: 0,
      });
      expect(reranked[0].content).toContain('database');
    });

    it('originalScoreWeight 应影响最终排序', async () => {
      const results = [
        { content: '天气信息', metadata: {}, score: 0.9 },
        { content: '北京天气预报详情', metadata: {}, score: 0.2 },
      ];

      const rerankedPure = await rerankResults('北京天气', results, {
        strategy: 'keyword',
        originalScoreWeight: 0,
      });

      const rerankedOriginal = await rerankResults('北京天气', results, {
        strategy: 'keyword',
        originalScoreWeight: 1,
      });

      expect(rerankedPure).toHaveLength(2);
      expect(rerankedOriginal).toHaveLength(2);
    });
  });

  describe('LLM 重排', () => {
    it('LLM 返回有效分数时应正确重排', async () => {
      mockLLMInvoke.mockResolvedValue({
        content: JSON.stringify([
          { index: 0, score: 0.3 },
          { index: 1, score: 0.9 },
          { index: 2, score: 0.5 },
        ]),
      });

      const results = [
        { content: '文档A', metadata: {}, score: 0.9 },
        { content: '文档B', metadata: {}, score: 0.5 },
        { content: '文档C', metadata: {}, score: 0.3 },
      ];
      const reranked = await rerankResults('测试查询', results, {
        strategy: 'llm',
        originalScoreWeight: 0,
      });
      expect(reranked[0].content).toBe('文档B');
      expect(reranked[0].rerankScore).toBe(0.9);
    });

    it('LLM 调用失败时应回退', async () => {
      mockLLMInvoke.mockRejectedValue(new Error('LLM 不可用'));

      const results = [
        { content: '文档A', metadata: {}, score: 0.9 },
        { content: '文档B', metadata: {}, score: 0.5 },
      ];
      const reranked = await rerankResults('测试', results, { strategy: 'llm' });
      expect(reranked).toHaveLength(2);
    });
  });

  describe('DashScope Reranker (qwen3-vl-rerank)', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('DashScope 返回有效分数时应正确重排', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          output: {
            results: [
              { index: 1, relevance_score: 0.95 },
              { index: 0, relevance_score: 0.3 },
            ],
          },
          usage: { total_tokens: 100 },
          request_id: 'test-req-1',
        }),
      });

      const results = [
        { content: '数据库配置指南', metadata: {}, score: 0.9 },
        { content: '北京天气预报详情', metadata: {}, score: 0.5 },
      ];
      const reranked = await rerankResults('北京天气', results, {
        strategy: 'dashscope',
        originalScoreWeight: 0,
      });

      expect(reranked[0].content).toBe('北京天气预报详情');
      expect(reranked[0].rerankScore).toBe(0.95);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('DashScope API 请求失败时应回退', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const results = [
        { content: '文档A', metadata: {}, score: 0.9 },
        { content: '文档B', metadata: {}, score: 0.5 },
      ];
      const reranked = await rerankResults('测试', results, {
        strategy: 'dashscope',
      });
      // 失败时回退到原始排序
      expect(reranked).toHaveLength(2);
      expect(reranked[0].originalScore).toBe(0.9);
    });

    it('DashScope 返回错误码时应回退', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'InvalidParameter',
          message: 'Invalid query',
        }),
      });

      const results = [
        { content: '文档A', metadata: {}, score: 0.9 },
      ];
      const reranked = await rerankResults('测试', results, {
        strategy: 'dashscope',
      });
      expect(reranked).toHaveLength(1);
    });

    it('DashScope 请求应包含正确的请求体', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          output: { results: [
            { index: 0, relevance_score: 0.8 },
            { index: 1, relevance_score: 0.3 },
          ] },
          usage: { total_tokens: 50 },
        }),
      });

      const results = [
        { content: '测试文档A', metadata: {}, score: 0.5 },
        { content: '测试文档B', metadata: {}, score: 0.3 },
      ];
      await rerankResults('测试查询', results, {
        strategy: 'dashscope',
        originalScoreWeight: 0,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('dashscope.aliyuncs.com');
      expect(options.headers.Authorization).toBe('Bearer test-dashscope-key');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('qwen3-vl-rerank');
      expect(body.input.query).toBe('测试查询');
      expect(body.input.documents).toEqual(['测试文档A', '测试文档B']);
      expect(body.parameters.return_documents).toBe(false);
    });
  });
});

// ==================== Multi-hop Search 测试 ====================

import { multiHopSearch } from '../vector-store/multi-hop-search.js';

describe('multi-hop-search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHybridSearch.mockResolvedValue([
      { content: '测试文档1', metadata: { source: 'test' }, score: 0.8, vectorScore: 0.8, sources: ['test'] },
      { content: '测试文档2', metadata: { source: 'test' }, score: 0.6, vectorScore: 0.6, sources: ['test'] },
    ]);
  });

  it('禁用多跳时应执行单跳检索', async () => {
    const result = await multiHopSearch('测试查询', undefined, 3, { enabled: false });
    expect(result.hopsExecuted).toBe(1);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('启用多跳时第 1 跳应使用改写后的主查询', async () => {
    const rewrittenQuery = {
      mainQuery: '数据库 连接 配置',
      subQueries: ['数据库连接方法'],
      keywords: ['数据库', '连接'],
      wasRewritten: true,
    };

    // LLM 判断无需追问
    mockLLMInvoke.mockResolvedValue({
      content: JSON.stringify({ need_follow_up: false }),
    });

    const result = await multiHopSearch('怎么配置数据库', rewrittenQuery, 3, {
      enabled: true,
      maxHops: 1,
    });
    expect(result.hopsExecuted).toBe(1);
    expect(result.hopDetails.length).toBeGreaterThanOrEqual(1);
  });

  it('LLM 判断无需追问时应停止多跳', async () => {
    mockLLMInvoke.mockResolvedValue({
      content: JSON.stringify({ need_follow_up: false }),
    });

    const result = await multiHopSearch('测试查询', undefined, 3, {
      enabled: true,
      maxHops: 3,
    });
    expect(result.hopsExecuted).toBe(1);
  });

  it('LLM 判断需要追问时应执行第 2 跳', async () => {
    let callCount = 0;
    mockLLMInvoke.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          content: JSON.stringify({
            need_follow_up: true,
            follow_up_queries: ['追问查询1'],
          }),
        });
      }
      return Promise.resolve({
        content: JSON.stringify({ need_follow_up: false }),
      });
    });

    const result = await multiHopSearch('测试查询', undefined, 3, {
      enabled: true,
      maxHops: 3,
    });
    expect(result.hopsExecuted).toBe(2);
    expect(result.hopDetails.length).toBeGreaterThanOrEqual(2);
  });

  it('结果应按分数降序排列', async () => {
    const result = await multiHopSearch('测试查询', undefined, 3, { enabled: false });
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1].score).toBeGreaterThanOrEqual(result.results[i].score);
    }
  });
});

// ==================== Search Knowledge Base 集成测试 ====================

import { executeSearchKnowledgeBase } from './search-knowledge-base.js';

describe('search-knowledge-base (增强版集成)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // 清空缓存，避免测试间互相影响
    const cacheMod = require('../cache');
    cacheMod.searchCache.clear('测试重置');

    // 为集成测试设置 LLM mock 默认行为
    mockLLMInvoke.mockResolvedValue({
      content: JSON.stringify({
        main_query: '数据库 连接 配置',
        sub_queries: ['数据库连接方法'],
        keywords: ['数据库', '连接'],
      }),
    });

    mockHybridSearch.mockResolvedValue([
      { content: '数据库连接配置文档', metadata: { source: 'db-guide.pdf', documentId: '1', versionId: 'v1' }, score: 0.8, vectorScore: 0.8, sources: ['db-guide.pdf'] },
      { content: 'API 接口说明文档', metadata: { source: 'api-docs.pdf', documentId: '2', versionId: 'v1' }, score: 0.5, vectorScore: 0.5, sources: ['api-docs.pdf'] },
    ]);
  });

  it('空查询应返回空结果', async () => {
    const result = await executeSearchKnowledgeBase({ query: '' });
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.meta?.queryRewritten).toBe(false);
  });

  it('完整增强流程应返回带 meta 信息的结果', async () => {
    const result = await executeSearchKnowledgeBase({
      query: '怎么配置数据库连接',
      top_k: 3,
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.meta).toBeDefined();
    expect(result.meta?.queryRewritten).toBe(true);
    expect(result.meta?.reranked).toBe(true);
    expect(result.meta?.timings.total).toBeGreaterThanOrEqual(0);
  });

  it('禁用所有增强时应直接检索', async () => {
    const result = await executeSearchKnowledgeBase({
      query: '测试查询',
      _options: {
        enableQueryRewrite: false,
        enableMultiHop: false,
        enableRerank: false,
      },
    });
    expect(result.results).toBeDefined();
    expect(result.meta?.queryRewritten).toBe(false);
    expect(result.meta?.reranked).toBe(false);
  });

  it('结果应包含 hop 和 rerankScore 字段', async () => {
    const result = await executeSearchKnowledgeBase({
      query: '测试查询',
    });
    for (const r of result.results) {
      expect(r.hop).toBeDefined();
      expect(r.rerankScore).toBeDefined();
    }
  });

  it('document_id 过滤应传递到检索层', async () => {
    await executeSearchKnowledgeBase({
      query: '测试查询',
      document_id: 42,
    });
    // hybridSearchKnowledgeBase(query, topK, vectorWeight, bm25Weight, filter, cacheKeyOverride)
    // filter 是第 5 个参数（index 4）
    const lastCall = mockHybridSearch.mock.calls[mockHybridSearch.mock.calls.length - 1];
    expect(lastCall[4]).toEqual({ documentId: '42' });
  });
});

// ==================== Parent-Child Chunking 测试 ====================

import { parentChildSplit } from '../vector-store/text-splitter.js';

describe('parent-child-chunking', () => {
  describe('parentChildSplit', () => {
    it('短文本应产生 1 个父块', async () => {
      const text = '这是一段短文本，不需要切分。';
      const result = await parentChildSplit(text);
      expect(result).toHaveLength(1);
      expect(result[0].parent.text).toBe(text);
      expect(result[0].children.length).toBeGreaterThan(0);
    });

    it('空文本应返回空数组', async () => {
      const result = await parentChildSplit('');
      expect(result).toHaveLength(0);
    });

    it('长文本应产生多个父块', async () => {
      // 生成 3000 字符的文本
      const text = '这是一段很长的文本内容。'.repeat(100);
      const result = await parentChildSplit(text, {
        parentChunkSize: 500,
        parentChunkOverlap: 50,
        childChunkSize: 100,
        childChunkOverlap: 20,
      });
      expect(result.length).toBeGreaterThan(1);
      // 每个父块应有子块
      for (const pc of result) {
        expect(pc.children.length).toBeGreaterThan(0);
      }
    });

    it('子块文本应包含在父块文本中', async () => {
      const text = '人工智能是计算机科学的一个分支，它企图了解智能的实质，并生产出一种新的能以人类智能相似的方式做出反应的智能机器。研究领域包括机器人、语言识别、图像识别、自然语言处理等。';
      const result = await parentChildSplit(text, {
        parentChunkSize: 200,
        parentChunkOverlap: 30,
        childChunkSize: 50,
        childChunkOverlap: 10,
      });

      for (const pc of result) {
        for (const child of pc.children) {
          // 子块文本应该是父块文本的子串
          expect(pc.parent.text).toContain(child.text);
        }
      }
    });

    it('自定义切分参数应生效', async () => {
      const text = 'A'.repeat(1000);
      const resultSmall = await parentChildSplit(text, {
        parentChunkSize: 200,
        parentChunkOverlap: 20,
        childChunkSize: 50,
        childChunkOverlap: 10,
      });
      const resultLarge = await parentChildSplit(text, {
        parentChunkSize: 500,
        parentChunkOverlap: 50,
        childChunkSize: 200,
        childChunkOverlap: 20,
      });

      // 更小的父块 → 更多父块
      expect(resultSmall.length).toBeGreaterThan(resultLarge.length);
    });

    it('父块和子块应有正确的 index', async () => {
      const text = '测试文本内容，用于验证索引编号。'.repeat(50);
      const result = await parentChildSplit(text, {
        parentChunkSize: 200,
        parentChunkOverlap: 20,
        childChunkSize: 50,
        childChunkOverlap: 10,
      });

      for (let i = 0; i < result.length; i++) {
        expect(result[i].parent.index).toBe(i);
        for (let j = 0; j < result[i].children.length; j++) {
          expect(result[i].children[j].index).toBe(j);
        }
      }
    });
  });
});
