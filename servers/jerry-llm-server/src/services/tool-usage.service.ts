import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { ToolUsage } from '../entities/tool-usage.entity';
import { logger } from '../fundamentals/logger';

@Injectable()
export class ToolUsageService {
  constructor(
    @InjectRepository(ToolUsage)
    private toolUsageRepository: Repository<ToolUsage>,
  ) {}

  /**
   * 保存一次工具调用记录
   */
  async saveToolUsage(data: {
    userId?: string;
    sessionId?: string;
    toolName: string;
    success: boolean;
    durationMs: number;
    paramsSummary?: string;
    errorMessage?: string;
    modelId?: string;
  }): Promise<ToolUsage> {
    const record = this.toolUsageRepository.create({
      userId: data.userId || 'default',
      sessionId: data.sessionId,
      toolName: data.toolName,
      success: data.success,
      durationMs: data.durationMs,
      paramsSummary: data.paramsSummary?.substring(0, 500),
      errorMessage: data.errorMessage?.substring(0, 500),
      modelId: data.modelId,
    });
    return this.toolUsageRepository.save(record);
  }

  /**
   * 获取工具使用统计
   */
  async getToolUsageStats(userId: string = 'default', days: number = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const records = await this.toolUsageRepository.find({
      where: { userId, createdAt: MoreThan(since) as any },
      order: { createdAt: 'DESC' },
    });

    const totalCalls = records.length;
    const successCalls = records.filter(r => r.success).length;
    const successRate = totalCalls > 0 ? Math.round((successCalls / totalCalls) * 100) / 100 : 0;
    const avgDuration = totalCalls > 0
      ? Math.round(records.reduce((sum, r) => sum + r.durationMs, 0) / totalCalls)
      : 0;

    // 按工具名聚合
    const byTool: Record<string, { calls: number; successRate: number; avgDurationMs: number }> = {};
    for (const r of records) {
      if (!byTool[r.toolName]) {
        byTool[r.toolName] = { calls: 0, successRate: 0, avgDurationMs: 0 };
      }
      byTool[r.toolName].calls++;
    }
    for (const [name, stat] of Object.entries(byTool)) {
      const toolRecords = records.filter(r => r.toolName === name);
      const toolSuccess = toolRecords.filter(r => r.success).length;
      stat.successRate = stat.calls > 0 ? Math.round((toolSuccess / stat.calls) * 100) / 100 : 0;
      stat.avgDurationMs = stat.calls > 0
        ? Math.round(toolRecords.reduce((sum, r) => sum + r.durationMs, 0) / stat.calls)
        : 0;
    }

    // 按天聚合
    const dailyStats: Record<string, { calls: number; successCalls: number }> = {};
    for (const r of records) {
      const day = new Date(r.createdAt).toISOString().slice(0, 10);
      if (!dailyStats[day]) {
        dailyStats[day] = { calls: 0, successCalls: 0 };
      }
      dailyStats[day].calls++;
      if (r.success) dailyStats[day].successCalls++;
    }

    return {
      totalCalls,
      successCalls,
      failedCalls: totalCalls - successCalls,
      successRate,
      avgDurationMs: avgDuration,
      byTool,
      dailyStats,
      recentRecords: records.slice(0, 50),
    };
  }
}
