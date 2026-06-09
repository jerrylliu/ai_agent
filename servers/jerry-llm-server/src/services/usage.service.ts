import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { LlmUsage } from '../entities/llm-usage.entity';
import { logger } from '../fundamentals/logger';
import type { UsageData } from '../fundamentals/prompt';

@Injectable()
export class UsageService {
  constructor(
    @InjectRepository(LlmUsage)
    private llmUsageRepository: Repository<LlmUsage>,
  ) {}

  /**
   * 保存一次 LLM 调用的用量记录
   */
  async saveLlmUsage(usage: UsageData): Promise<LlmUsage> {
    logger.info('LLM 用量记录', {
      module: 'UsageService',
      historyCount: usage.historyCount,
      usedKnowledgeBase: usage.usedKnowledgeBase,
      imageCount: usage.imageCount,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      responseTimeMs: usage.responseTimeMs,
    });
    const record = this.llmUsageRepository.create({
      userId: usage.userId,
      sessionId: usage.sessionId,
      modelId: usage.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      historyCount: usage.historyCount,
      usedKnowledgeBase: usage.usedKnowledgeBase,
      imageCount: usage.imageCount,
      responseTimeMs: usage.responseTimeMs,
      userMessage: usage.userMessage?.substring(0, 500),
    });
    return this.llmUsageRepository.save(record);
  }

  /**
   * 获取 LLM 用量统计
   */
  async getLlmUsageStats(userId: string = 'default', days: number = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const records = await this.llmUsageRepository.find({
      where: { userId, createdAt: MoreThan(since) as any },
      order: { createdAt: 'DESC' },
    });

    const totalInputTokens = records.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalOutputTokens = records.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalCalls = records.length;
    const avgResponseTime = totalCalls > 0
      ? Math.round(records.reduce((sum, r) => sum + (r.responseTimeMs || 0), 0) / totalCalls)
      : 0;
    const knowledgeBaseHitRate = totalCalls > 0
      ? records.filter(r => r.usedKnowledgeBase).length / totalCalls
      : 0;

    // 按天聚合
    const dailyStats: Record<string, { calls: number; inputTokens: number; outputTokens: number }> = {};
    for (const r of records) {
      const day = new Date(r.createdAt).toISOString().slice(0, 10);
      if (!dailyStats[day]) {
        dailyStats[day] = { calls: 0, inputTokens: 0, outputTokens: 0 };
      }
      dailyStats[day].calls++;
      dailyStats[day].inputTokens += r.inputTokens;
      dailyStats[day].outputTokens += r.outputTokens;
    }

    return {
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      avgResponseTimeMs: avgResponseTime,
      knowledgeBaseHitRate: Math.round(knowledgeBaseHitRate * 100) / 100,
      dailyStats,
      recentRecords: records.slice(0, 50),
    };
  }
}
