/**
 * services/tool-usage.service.spec.ts
 *
 * ToolUsageService 单元测试
 * 覆盖：saveToolUsage / getToolUsageStats
 *
 * Mock 策略：直接 mock @nestjs/typeorm 装饰器 + Repository
 */

jest.mock('../fundamentals/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (target: any, key: string) => {},
  getRepositoryToken: () => 'mockRepo',
}));

import { ToolUsageService } from './tool-usage.service';

describe('ToolUsageService', () => {
  function makeRepo() {
    return {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      findBy: jest.fn(),
    };
  }

  let service: ToolUsageService;
  let repo: any;

  beforeEach(() => {
    repo = makeRepo();
    service = new ToolUsageService(repo);
  });

  describe('saveToolUsage', () => {
    it('应创建并保存一条记录', async () => {
      repo.create.mockReturnValue({ id: 1 });
      repo.save.mockResolvedValue({ id: 1 });

      await service.saveToolUsage({
        toolName: 'calculate',
        success: true,
        durationMs: 50,
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'default',
          toolName: 'calculate',
          success: true,
          durationMs: 50,
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('应使用传入的 userId', async () => {
      repo.create.mockReturnValue({});
      repo.save.mockResolvedValue({});

      await service.saveToolUsage({
        userId: 'u123',
        sessionId: 's1',
        toolName: 'search_web',
        success: false,
        durationMs: 200,
        errorMessage: 'timeout',
        modelId: 'deepseek',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u123',
          sessionId: 's1',
          errorMessage: 'timeout',
          modelId: 'deepseek',
        }),
      );
    });

    it('paramsSummary 超过 500 字符应截断', async () => {
      repo.create.mockReturnValue({});
      repo.save.mockResolvedValue({});

      const longSummary = 'x'.repeat(600);
      await service.saveToolUsage({
        toolName: 'test',
        success: true,
        durationMs: 10,
        paramsSummary: longSummary,
      });

      const callArg = repo.create.mock.calls[0][0];
      expect(callArg.paramsSummary.length).toBeLessThanOrEqual(500);
    });
  });

  describe('getToolUsageStats', () => {
    it('应返回聚合统计', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      repo.find.mockResolvedValue([
        { toolName: 'calculate', success: true, durationMs: 50, createdAt: yesterday },
        { toolName: 'calculate', success: false, durationMs: 100, createdAt: yesterday },
        { toolName: 'search_web', success: true, durationMs: 30, createdAt: now },
      ]);

      const stats = await service.getToolUsageStats('u1', 7);
      expect(stats.totalCalls).toBe(3);
      expect(stats.successCalls).toBe(2);
      expect(stats.failedCalls).toBe(1);
      expect(stats.successRate).toBeCloseTo(0.67, 1);
      expect(stats.byTool).toHaveProperty('calculate');
      expect(stats.byTool).toHaveProperty('search_web');
    });

    it('空记录应返回 0', async () => {
      repo.find.mockResolvedValue([]);
      const stats = await service.getToolUsageStats('u1', 7);
      expect(stats.totalCalls).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    it('应按天聚合', async () => {
      repo.find.mockResolvedValue([
        { toolName: 't', success: true, durationMs: 1, createdAt: new Date('2025-01-01') },
        { toolName: 't', success: true, durationMs: 1, createdAt: new Date('2025-01-02') },
      ]);

      const stats = await service.getToolUsageStats('u1', 30);
      expect(Object.keys(stats.dailyStats)).toHaveLength(2);
      expect(stats.dailyStats['2025-01-01'].calls).toBe(1);
      expect(stats.dailyStats['2025-01-02'].calls).toBe(1);
    });
  });
});
