/**
 * fundamentals/tools/search-knowledge-base.executor.spec.ts
 *
 * 二段式检索（S4.1）行为测试：
 *   1. 召回阶段按 max(top_k, config.rerankCandidatePool) 宽取（传给 multiHop / hybrid 的 topK）
 *   2. 精排后按 LLM 请求的 top_k 收口截断 —— 最终返回条数不因宽召回膨胀
 *   3. 重排关闭时同样收口（原始 score 排序取前 top_k）
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// config 整体 mock：避免 zod fail-fast 依赖完整环境变量
jest.mock('../config', () => ({
  config: { rerankCandidatePool: 30 },
}));

jest.mock('../vector-store', () => ({
  hybridSearchKnowledgeBase: jest.fn(),
}));
jest.mock('../vector-store/query-rewriter', () => ({
  rewriteQuery: jest.fn(),
}));
jest.mock('../vector-store/multi-hop-search', () => ({
  multiHopSearch: jest.fn(),
}));
jest.mock('../vector-store/result-reranker', () => ({
  rerankResults: jest.fn(),
}));
// rag-service 是重型模块（拉起 TypeORM 等依赖），executor 只用到图片补查与父块去重两个函数
jest.mock('../rag-service', () => ({
  enrichWithImageDescriptions: jest.fn().mockResolvedValue(undefined),
  // 去重逻辑与 rag-service.ts 中实现保持一致（内联真实实现，行为测试才有意义）
  dedupeByNormalizedContent: (results: Array<{ content: string }>) => {
    const seen = new Set<string>();
    return results.filter((r) => {
      const key = r.content.replace(/\s+/g, ' ').trim();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  },
}));

import { executeSearchKnowledgeBase } from './search-knowledge-base';
import { multiHopSearch } from '../vector-store/multi-hop-search';
import { hybridSearchKnowledgeBase } from '../vector-store';
import { rerankResults } from '../vector-store/result-reranker';
import { rewriteQuery } from '../vector-store/query-rewriter';

const mockedMultiHop = multiHopSearch as jest.Mock;
const mockedHybrid = hybridSearchKnowledgeBase as jest.Mock;
const mockedRerank = rerankResults as jest.Mock;
const mockedRewrite = rewriteQuery as jest.Mock;

/** 构造 n 条递减分数的检索结果（模拟宽召回池） */
function makeWidePool(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    content: `chunk-${i}`,
    score: (n - i) / n, // 1.0 → 递减
    metadata: { documentId: `doc-${i}` },
  }));
}

/** rerank 透传 mock：打乱顺序返回（模拟精排重排序），并补 rerankScore 字段 */
function passthroughRerankShuffled(): void {
  mockedRerank.mockImplementation(async (_query: string, results: Array<Record<string, unknown>>) =>
    [...results]
      .reverse()
      .map((r) => ({ ...r, originalScore: r.score, rerankScore: r.score })),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRewrite.mockResolvedValue({
    mainQuery: '',
    subQueries: [],
    keywords: [],
    wasRewritten: false,
    queryType: 'keyword',
    hypotheticalAnswer: '',
  });
});

describe('二段式检索：宽召回', () => {
  it('multi-hop 路径：应以候选池宽度（30）而非 LLM top_k 调用 multiHopSearch', async () => {
    mockedMultiHop.mockResolvedValue({
      results: makeWidePool(30),
      hopsExecuted: 1,
      hopDetails: [],
    });
    passthroughRerankShuffled();

    await executeSearchKnowledgeBase({ query: '测试查询', top_k: 3 });

    expect(mockedMultiHop).toHaveBeenCalledTimes(1);
    expect(mockedMultiHop.mock.calls[0][2]).toBe(30);
  });

  it('单跳路径：应以候选池宽度（30）调用 hybridSearchKnowledgeBase', async () => {
    mockedHybrid.mockResolvedValue(makeWidePool(30));
    passthroughRerankShuffled();

    await executeSearchKnowledgeBase({
      query: '测试查询',
      top_k: 3,
      _options: { enableMultiHop: false },
    });

    expect(mockedHybrid).toHaveBeenCalledTimes(1);
    expect(mockedHybrid.mock.calls[0][1]).toBe(30);
  });

  it('LLM 显式要更多结果（top_k > 候选池）时以 LLM 为准', async () => {
    mockedMultiHop.mockResolvedValue({
      results: makeWidePool(30),
      hopsExecuted: 1,
      hopDetails: [],
    });
    passthroughRerankShuffled();

    await executeSearchKnowledgeBase({ query: '测试查询', top_k: 50 });

    expect(mockedMultiHop.mock.calls[0][2]).toBe(50);
  });
});

describe('二段式检索：收口截断', () => {
  it('精排后按 top_k 截断：30 条候选只返回 3 条且按分数降序', async () => {
    mockedMultiHop.mockResolvedValue({
      results: makeWidePool(30),
      hopsExecuted: 1,
      hopDetails: [],
    });
    passthroughRerankShuffled();

    const result = await executeSearchKnowledgeBase({ query: '测试查询', top_k: 3 });

    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.score)).toEqual([1, 0.9666666666666667, 0.9333333333333333]);
    expect(result.results[0].content).toBe('chunk-0');
  });

  it('重排关闭时同样按原始分数收口到 top_k', async () => {
    mockedMultiHop.mockResolvedValue({
      results: makeWidePool(30),
      hopsExecuted: 1,
      hopDetails: [],
    });

    const result = await executeSearchKnowledgeBase({
      query: '测试查询',
      top_k: 3,
      _options: { enableRerank: false },
    });

    expect(mockedRerank).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(3);
    expect(result.results[0].content).toBe('chunk-0');
  });
});

describe('二段式检索：父块去重', () => {
  it('精排池出现同父块重复文本（含空白差异）时，去重让唯一块补位', async () => {
    const pool = [
      { content: 'parent-A', score: 1.0, metadata: { documentId: 'd1' } },
      { content: 'parent-A  ', score: 0.95, metadata: { documentId: 'd1' } },
      { content: 'parent-B', score: 0.9, metadata: { documentId: 'd2' } },
    ];
    mockedMultiHop.mockResolvedValue({
      results: pool,
      hopsExecuted: 1,
      hopDetails: [],
    });
    mockedRerank.mockImplementation(
      async (_query: string, results: Array<Record<string, unknown>>) =>
        results.map((r) => ({ ...r, originalScore: r.score, rerankScore: r.score })),
    );

    const result = await executeSearchKnowledgeBase({ query: '测试查询', top_k: 3 });

    expect(result.results.map((r) => r.content)).toEqual(['parent-A', 'parent-B']);
  });
});
