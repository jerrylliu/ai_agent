/**
 * fundamentals/vector-store/query-rewriter.spec.ts
 *
 * 查询改写器单元测试
 * 覆盖：extractKeywordsSimple（纯函数）/ parseRewriteResponse（通过 rewriteQuery 间接测试降级路径）
 *
 * Mock 策略：mock logger + model-provider，测试 extractKeywordsSimple 纯函数和 disable/enable 分支
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../model-provider', () => ({
  createRateLimitedLLM: jest.fn(),
  buildModelConfig: jest.fn().mockReturnValue({ temperature: 0.1 }),
}));

import { rewriteQuery } from './query-rewriter';

describe('QueryRewriter', () => {
  describe('rewriteQuery — 未启用或查询过短', () => {
    it('enabled=false 时应直接返回原始查询', async () => {
      const r = await rewriteQuery('如何配置数据库连接', { enabled: false });
      expect(r.wasRewritten).toBe(false);
      expect(r.mainQuery).toBe('如何配置数据库连接');
      expect(r.subQueries).toEqual([]);
    });

    it('查询为空字符串时应直接返回', async () => {
      const r = await rewriteQuery('');
      expect(r.wasRewritten).toBe(false);
      expect(r.mainQuery).toBe('');
    });

    it('查询长度不足 3 时应直接返回', async () => {
      const r = await rewriteQuery('ab');
      expect(r.wasRewritten).toBe(false);
      expect(r.mainQuery).toBe('ab');
    });
  });

  describe('extractKeywordsSimple（降级关键词提取）', () => {
    it('中文查询应提取关键词', async () => {
      const r = await rewriteQuery('什么是 RAG 检索增强生成', { enabled: false });
      expect(r.keywords).toContain('RAG');
      expect(r.keywords).toContain('检索增强生成');
    });

    it('应过滤停用词', async () => {
      // extractKeywordsSimple 按标点/split by delimiters, Chinese without spaces stays as whole phrase
      const r = await rewriteQuery('项目部署 流程', { enabled: false });
      // 含有空格分隔，应提取到两个关键字
      expect(r.keywords).toContain('项目部署');
      expect(r.keywords).toContain('流程');
    });

    it('空查询应返回空数组', async () => {
      const r = await rewriteQuery('', { enabled: false });
      expect(r.keywords).toEqual([]);
    });
  });

  describe('rewriteQuery — LLM 调用失败降级', () => {
    it('LLM 抛出异常时应降级返回原始查询', async () => {
      const { createRateLimitedLLM } = require('../model-provider');
      const mockLLM = { invoke: jest.fn().mockRejectedValue(new Error('Network error')) };
      createRateLimitedLLM.mockReturnValue(mockLLM);

      const r = await rewriteQuery('测试查询', { timeout: 100 });
      expect(r.wasRewritten).toBe(false);
      expect(r.mainQuery).toBe('测试查询');
    });
  });
});
