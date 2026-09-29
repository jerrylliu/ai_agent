/**
 * fundamentals/tools/evaluation-ops.spec.ts
 *
 * 评估查询工具单元测试（只读）
 * Mock EvaluationService，验证按当前用户隔离与返回裁剪。
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { queryEvaluationStatsSchema } from './evaluation-ops';

describe('evaluation-ops 工具', () => {
  /* ====================================================================
   * Schema
   * ==================================================================*/
  describe('Schema', () => {
    it('days 应为可选参数（默认 7 天）', () => {
      expect(
        queryEvaluationStatsSchema.function.parameters.required ?? [],
      ).not.toContain('days');
    });
  });

  /* ====================================================================
   * executeQueryEvaluationStats
   * ==================================================================*/
  describe('executeQueryEvaluationStats', () => {
    const buildStats = () => ({
      humanEvaluation: {
        totalFeedbacks: 10,
        positiveCount: 8,
        negativeCount: 2,
        satisfactionRate: 0.8,
        recentFeedbacks: [{ id: 1 }],
      },
      autoEvaluation: {
        totalEvaluations: 30,
        avgScore: 4.2,
        recentEvaluations: [{ id: 1 }],
        judge: {
          judgedCount: 30,
          faithfulCount: 29,
          relevantCount: 30,
          faithfulnessRate: 0.9667,
          relevanceRate: 1,
          unfaithfulDetails: [
            {
              question: '什么是 RAG？',
              claims: ['RAG 是检索增强生成'],
              judgeReason: 'contexts 无此依据',
              createdAt: new Date('2026-09-29T00:00:00Z'),
              extraField: '应被裁剪',
            },
          ],
        },
      },
      dailyFeedback: [{ date: '2026-09-29', count: 3 }],
    });

    it('服务未注入时应返回失败', async () => {
      jest.resetModules();
      const fresh = require('./evaluation-ops');
      const r = await fresh.executeQueryEvaluationStats({});
      expect(r.success).toBe(false);
      expect(r.message).toContain('未初始化');
    });

    it('无 context 时应使用 default 用户与默认 7 天窗口', async () => {
      jest.resetModules();
      const fresh = require('./evaluation-ops');
      const getEvaluationStats = jest.fn().mockResolvedValue(buildStats());
      fresh.initEvaluationOps({ getEvaluationStats });

      const r = await fresh.executeQueryEvaluationStats({});
      expect(getEvaluationStats).toHaveBeenCalledWith('default', 7);
      expect(r.success).toBe(true);
      expect(r.days).toBe(7);
      expect(r.humanEvaluation?.totalFeedbacks).toBe(10);
    });

    it('context.userId 应隔离数据归属并透传自定义时间窗', async () => {
      jest.resetModules();
      const fresh = require('./evaluation-ops');
      const getEvaluationStats = jest.fn().mockResolvedValue(buildStats());
      fresh.initEvaluationOps({ getEvaluationStats });

      const r = await fresh.executeQueryEvaluationStats(
        { days: 30 },
        { userId: '15' },
      );
      expect(getEvaluationStats).toHaveBeenCalledWith('15', 30);
      expect(r.days).toBe(30);
    });

    it('返回应裁剪到可读字段（不带服务端内部字段）', async () => {
      jest.resetModules();
      const fresh = require('./evaluation-ops');
      fresh.initEvaluationOps({ getEvaluationStats: jest.fn().mockResolvedValue(buildStats()) });

      const r = await fresh.executeQueryEvaluationStats({});
      const detail = r.autoEvaluation?.judge.unfaithfulDetails[0];
      expect(detail).toEqual({
        question: '什么是 RAG？',
        claims: ['RAG 是检索增强生成'],
        judgeReason: 'contexts 无此依据',
        createdAt: '2026-09-29T00:00:00.000Z',
      });
      expect(JSON.stringify(r)).not.toContain('extraField');
      expect(JSON.stringify(r)).not.toContain('recentFeedbacks');
    });

    it('服务抛错时应返回失败而不抛异常', async () => {
      jest.resetModules();
      const fresh = require('./evaluation-ops');
      fresh.initEvaluationOps({
        getEvaluationStats: jest.fn().mockRejectedValue(new Error('db down')),
      });

      const r = await fresh.executeQueryEvaluationStats({});
      expect(r.success).toBe(false);
      expect(r.message).toContain('db down');
    });
  });
});
