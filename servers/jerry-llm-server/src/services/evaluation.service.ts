import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { MessageFeedback } from '../entities/message-feedback.entity';
import { AutoEvaluation } from '../entities/auto-evaluation.entity';
import { SearchFeedback } from '../entities/search-feedback.entity';
import { logger } from '../fundamentals/logger';

@Injectable()
export class EvaluationService {
  constructor(
    @InjectRepository(MessageFeedback)
    private messageFeedbackRepository: Repository<MessageFeedback>,
    @InjectRepository(AutoEvaluation)
    private autoEvaluationRepository: Repository<AutoEvaluation>,
    @InjectRepository(SearchFeedback)
    private searchFeedbackRepository: Repository<SearchFeedback>,
  ) {}

  /**
   * 提交消息反馈（点赞/点踩）
   */
  async submitFeedback(params: {
    userId: string;
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
    rating: 'positive' | 'negative';
    comment?: string;
    modelId?: string;
    usedKnowledgeBase?: boolean;
  }): Promise<{ action: 'created' | 'updated' | 'removed'; rating?: string }> {
    const existing = await this.messageFeedbackRepository.findOne({
      where: {
        userId: params.userId,
        sessionId: params.sessionId,
        assistantMessage: params.assistantMessage,
      },
    });

    if (existing) {
      if (existing.rating === params.rating) {
        await this.messageFeedbackRepository.remove(existing);
        return { action: 'removed', rating: params.rating };
      } else {
        existing.rating = params.rating;
        existing.comment = params.comment || existing.comment;
        await this.messageFeedbackRepository.save(existing);
        return { action: 'updated', rating: params.rating };
      }
    }

    const feedback = this.messageFeedbackRepository.create({
      userId: params.userId,
      sessionId: params.sessionId,
      userMessage: params.userMessage,
      assistantMessage: params.assistantMessage,
      rating: params.rating,
      comment: params.comment,
      modelId: params.modelId,
      usedKnowledgeBase: params.usedKnowledgeBase || false,
    });
    await this.messageFeedbackRepository.save(feedback);
    return { action: 'created', rating: params.rating };
  }

  /**
   * 自动评估回答质量（基于规则的轻量评估）
   */
  async autoEvaluate(params: {
    userId: string;
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
    modelId?: string;
    usedKnowledgeBase?: boolean;
    responseTimeMs?: number;
  }): Promise<AutoEvaluation> {
    let score = 0.5;
    const reasons: string[] = [];

    if (params.assistantMessage && params.assistantMessage.length > 50) {
      score += 0.1;
      reasons.push('回答内容充实');
    } else if (!params.assistantMessage || params.assistantMessage.length < 10) {
      score -= 0.2;
      reasons.push('回答过短');
    }

    if (params.usedKnowledgeBase) {
      score += 0.15;
      reasons.push('使用了知识库');
    }

    if (params.responseTimeMs && params.responseTimeMs < 5000) {
      score += 0.1;
      reasons.push('响应速度快');
    } else if (params.responseTimeMs && params.responseTimeMs > 30000) {
      score -= 0.1;
      reasons.push('响应时间过长');
    }

    if (/【文档\s*\d+】/.test(params.assistantMessage)) {
      score += 0.1;
      reasons.push('标注了信息来源');
    }

    if (/无法|不确定|不知道/.test(params.assistantMessage)) {
      score -= 0.1;
      reasons.push('回答包含不确定表述');
    }

    score = Math.max(0, Math.min(1, score));

    const evaluation = this.autoEvaluationRepository.create({
      userId: params.userId,
      sessionId: params.sessionId,
      userMessage: params.userMessage,
      assistantMessage: params.assistantMessage,
      score,
      reason: reasons.join('；'),
      dimension: 'relevance',
      modelId: params.modelId,
      usedKnowledgeBase: params.usedKnowledgeBase || false,
      responseTimeMs: params.responseTimeMs || 0,
    });
    return this.autoEvaluationRepository.save(evaluation);
  }

  /**
   * 获取准确率评估统计
   */
  async getEvaluationStats(userId: string = 'default', days: number = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // 人工反馈统计
    const feedbacks = await this.messageFeedbackRepository.find({
      where: { userId, createdAt: MoreThan(since) as any },
      order: { createdAt: 'DESC' },
    });

    const positiveCount = feedbacks.filter(f => f.rating === 'positive').length;
    const negativeCount = feedbacks.filter(f => f.rating === 'negative').length;
    const totalFeedbacks = positiveCount + negativeCount;
    const satisfactionRate = totalFeedbacks > 0 ? positiveCount / totalFeedbacks : 0;

    // 自动评估统计
    const autoEvals = await this.autoEvaluationRepository.find({
      where: { userId, createdAt: MoreThan(since) as any },
      order: { createdAt: 'DESC' },
    });

    const avgAutoScore = autoEvals.length > 0
      ? autoEvals.reduce((sum, e) => sum + e.score, 0) / autoEvals.length
      : 0;

    // 按天聚合
    const dailyFeedback: Record<string, { positive: number; negative: number }> = {};
    for (const f of feedbacks) {
      const day = new Date(f.createdAt).toISOString().slice(0, 10);
      if (!dailyFeedback[day]) dailyFeedback[day] = { positive: 0, negative: 0 };
      if (f.rating === 'positive') dailyFeedback[day].positive++;
      else dailyFeedback[day].negative++;
    }

    return {
      humanEvaluation: {
        totalFeedbacks,
        positiveCount,
        negativeCount,
        satisfactionRate: Math.round(satisfactionRate * 100) / 100,
        recentFeedbacks: feedbacks.slice(0, 20),
      },
      autoEvaluation: {
        totalEvaluations: autoEvals.length,
        avgScore: Math.round(avgAutoScore * 100) / 100,
        recentEvaluations: autoEvals.slice(0, 20),
      },
      dailyFeedback,
    };
  }

  // ==================== 隐式反馈收集（检索召回评估 Level 2） ====================

  /**
   * 记录检索隐式反馈
   *
   * 由前端在检测到用户行为时上报：
   * - regenerate：用户点击"重新生成" → 检索结果可能不相关
   * - followup：用户追问 → 检索结果有一定参考价值
   * - abandon：用户离开会话 → 可能未找到所需信息
   * - positive/negative：与人工反馈交叉关联
   *
   * @param params 隐式反馈参数
   */
  async recordSearchFeedback(params: {
    userId: string;
    sessionId: string;
    query: string;
    retrievedDocIds?: string[];
    action: 'regenerate' | 'followup' | 'abandon' | 'positive' | 'negative';
    responseTimeMs?: number;
    resultCount?: number;
    modelId?: string;
    searchType?: string;
    metadata?: Record<string, any>;
  }): Promise<SearchFeedback> {
    const feedback = this.searchFeedbackRepository.create({
      userId: params.userId,
      sessionId: params.sessionId,
      query: params.query,
      retrievedDocIds: JSON.stringify(params.retrievedDocIds || []),
      action: params.action,
      responseTimeMs: params.responseTimeMs || 0,
      resultCount: params.resultCount || 0,
      modelId: params.modelId,
      searchType: params.searchType || 'hybrid',
      metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
    });

    const saved = await this.searchFeedbackRepository.save(feedback);
    logger.debug('记录检索隐式反馈', {
      module: 'EvaluationService',
      userId: params.userId,
      sessionId: params.sessionId,
      action: params.action,
      query: params.query.substring(0, 80),
    });
    return saved;
  }

  /**
   * 获取隐式反馈统计
   *
   * 统计指定时间范围内各行为类型的数量和比例，
   * 用于评估检索质量的整体趋势。
   */
  async getImplicitFeedbackStats(userId: string = 'default', days: number = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const feedbacks = await this.searchFeedbackRepository.find({
      where: { userId, createdAt: MoreThan(since) as any },
      order: { createdAt: 'DESC' },
    });

    // 按行为类型统计
    const actionCounts: Record<string, number> = {
      regenerate: 0,
      followup: 0,
      abandon: 0,
      positive: 0,
      negative: 0,
    };

    for (const f of feedbacks) {
      if (actionCounts[f.action] !== undefined) {
        actionCounts[f.action]++;
      }
    }

    const total = feedbacks.length;
    // 负向信号 = regenerate + negative + abandon
    const negativeSignals = actionCounts.regenerate + actionCounts.negative + actionCounts.abandon;
    // 正向信号 = followup + positive
    const positiveSignals = actionCounts.followup + actionCounts.positive;

    // 满意度 = 正向 / (正向 + 负向)，仅在有信号时计算
    const satisfactionRate = positiveSignals + negativeSignals > 0
      ? positiveSignals / (positiveSignals + negativeSignals)
      : 0;

    // 按天聚合
    const dailyStats: Record<string, Record<string, number>> = {};
    for (const f of feedbacks) {
      const day = new Date(f.createdAt).toISOString().slice(0, 10);
      if (!dailyStats[day]) {
        dailyStats[day] = { regenerate: 0, followup: 0, abandon: 0, positive: 0, negative: 0 };
      }
      if (dailyStats[day][f.action] !== undefined) {
        dailyStats[day][f.action]++;
      }
    }

    return {
      total,
      actionCounts,
      positiveSignals,
      negativeSignals,
      satisfactionRate: Math.round(satisfactionRate * 100) / 100,
      dailyStats,
      recentFeedbacks: feedbacks.slice(0, 20),
    };
  }

  /**
   * 获取低满意度查询列表
   *
   * 按查询文本分组，统计每个查询的负向信号比例，
   * 返回负向信号最多的查询，用于定位检索质量差的查询模式。
   *
   * @param userId 用户 ID
   * @param days 统计时间范围（天）
   * @param minSamples 最小样本数（低于此数的查询不纳入统计，避免噪声）
   * @param limit 返回条数
   */
  async getLowSatisfactionQueries(
    userId: string = 'default',
    days: number = 7,
    minSamples: number = 2,
    limit: number = 20,
  ) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const feedbacks = await this.searchFeedbackRepository.find({
      where: { userId, createdAt: MoreThan(since) as any },
    });

    // 按查询文本分组
    const queryGroups: Map<string, {
      query: string;
      total: number;
      negative: number;
      positive: number;
      actions: Record<string, number>;
      sampleRetrievedDocIds: string[];
    }> = new Map();

    for (const f of feedbacks) {
      // 归一化查询：去空格、转小写，让相似查询合并
      const normalizedQuery = f.query.trim().toLowerCase().replace(/\s+/g, ' ');

      if (!queryGroups.has(normalizedQuery)) {
        queryGroups.set(normalizedQuery, {
          query: f.query,
          total: 0,
          negative: 0,
          positive: 0,
          actions: { regenerate: 0, followup: 0, abandon: 0, positive: 0, negative: 0 },
          sampleRetrievedDocIds: [],
        });
      }

      const group = queryGroups.get(normalizedQuery)!;
      group.total++;
      if (group.actions[f.action] !== undefined) {
        group.actions[f.action]++;
      }

      // 负向信号
      if (f.action === 'regenerate' || f.action === 'negative' || f.action === 'abandon') {
        group.negative++;
      }
      // 正向信号
      if (f.action === 'followup' || f.action === 'positive') {
        group.positive++;
      }

      // 保留一份检索结果样本
      if (group.sampleRetrievedDocIds.length === 0 && f.retrievedDocIds) {
        try {
          group.sampleRetrievedDocIds = JSON.parse(f.retrievedDocIds);
        } catch {
          group.sampleRetrievedDocIds = [];
        }
      }
    }

    // 过滤样本数不足的查询，计算负向率，按负向率降序
    const results = Array.from(queryGroups.values())
      .filter((g) => g.total >= minSamples)
      .map((g) => ({
        query: g.query,
        total: g.total,
        negative: g.negative,
        positive: g.positive,
        negativeRate: Math.round((g.negative / g.total) * 100) / 100,
        actions: g.actions,
        sampleRetrievedDocIds: g.sampleRetrievedDocIds,
      }))
      .sort((a, b) => b.negativeRate - a.negativeRate || b.total - a.total)
      .slice(0, limit);

    return {
      totalQueries: queryGroups.size,
      analyzedQueries: results.length,
      lowSatisfactionQueries: results,
    };
  }
}
