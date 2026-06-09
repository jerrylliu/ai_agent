import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { MessageFeedback } from '../entities/message-feedback.entity';
import { AutoEvaluation } from '../entities/auto-evaluation.entity';
import { logger } from '../fundamentals/logger';

@Injectable()
export class EvaluationService {
  constructor(
    @InjectRepository(MessageFeedback)
    private messageFeedbackRepository: Repository<MessageFeedback>,
    @InjectRepository(AutoEvaluation)
    private autoEvaluationRepository: Repository<AutoEvaluation>,
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
}
