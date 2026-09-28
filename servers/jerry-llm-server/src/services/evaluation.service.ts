import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { MessageFeedback } from '../entities/message-feedback.entity';
import { AutoEvaluation } from '../entities/auto-evaluation.entity';
import { SearchFeedback } from '../entities/search-feedback.entity';
import { logger } from '../fundamentals/logger';
import { config } from '../fundamentals/config.js';
import { buildModelConfig, createLLM } from '../fundamentals/model-provider.js';
import { judgeOne, type JudgeVerdict } from '../fundamentals/eval/judge.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// ==================== 在线 judge 配置 ====================

/** 单次在线 judge 的超时上限（AbortSignal.timeout 真取消，防挂起拖垮评估链路） */
const ONLINE_JUDGE_TIMEOUT_MS = 30000;
/** 送给 judge 的 contexts 保护性截断：条数与单条长度上限，防跨工具轮次聚合过大撑爆上下文 */
const ONLINE_JUDGE_MAX_CONTEXTS = 12;
const ONLINE_JUDGE_MAX_CONTEXT_CHARS = 2400;
/** 问题/答案保护性截断（只影响在线 judge 输入；benchmark 不受影响）：
 * 触发频率极低（聊天消息 95%+ 远低于此阈值），目的是防巨型请求稀释 judge 注意力与成本失控 */
const ONLINE_JUDGE_MAX_QUESTION_CHARS = 2000;
const ONLINE_JUDGE_MAX_ANSWER_CHARS = 6000;

/** 省略标记：显式告知 judge 有内容被省略，避免头尾直接拼接产生误读 */
const TRUNCATION_ELLIPSIS = '\n…【中间内容因超长已省略】…\n';

/**
 * 头尾保留截断（middle truncation，业界 judge 系统的标准做法）：
 * 掐中间、保两端——开头定主题，结尾往往是用户的核心诉求/答案的最新结论。
 * 80/20 分配：头部信息密度通常更高，但尾部诉求不可丢失。
 */
function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const keep = maxLen - TRUNCATION_ELLIPSIS.length;
  const head = Math.ceil(keep * 0.8);
  const tail = keep - head;
  return text.slice(0, head) + TRUNCATION_ELLIPSIS + text.slice(-tail);
}

/**
 * 安全解析 unfaithfulClaims JSON 列（与 session.service 的 safeParseJsonArray 同款降级语义：
 * null/空串/非法 JSON/非数组 → 空数组 + warn，绝不让脏数据把统计接口打 500）。
 * 不直接复用 safeParseJsonArray：它住在 session.service，会拖入 Summary/Memory 一整串重依赖。
 */
function parseUnfaithfulClaims(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === 'string');
  } catch (error: unknown) {
    logger.warn('unfaithfulClaims 反序列化失败，已忽略该字段', {
      module: 'EvaluationService',
      rawLength: raw.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

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
   *
   * 规则分只量"长短/快慢/有无标注"，量不出对错；保存规则分后会异步追加
   * 在线 judge（faithfulness/relevance 两维），判分结果回写同一行的 judge* 列。
   * judge 全程不阻塞、失败静默降级为只保留规则分。
   */
  async autoEvaluate(params: {
    userId: string;
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
    modelId?: string;
    usedKnowledgeBase?: boolean;
    responseTimeMs?: number;
    /** 本次回答实际参与生成的检索上下文（faithfulness 判分的依据来源；空 = 跳过 judge） */
    retrievedContexts?: string[];
  }): Promise<AutoEvaluation> {
    let score = 0.5;
    const reasons: string[] = [];

    if (params.assistantMessage && params.assistantMessage.length > 50) {
      score += 0.1;
      reasons.push('回答内容充实');
    } else if (
      !params.assistantMessage ||
      params.assistantMessage.length < 10
    ) {
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
    const saved = await this.autoEvaluationRepository.save(evaluation);

    // 异步追加在线 judge 判分（fire-and-forget：不阻塞返回，失败只丢判分不丢规则分）
    void this.appendJudgeVerdict(saved.id, params).catch((err: unknown) => {
      logger.warn('在线 judge 追加异常（规则分已保留）', {
        module: 'EvaluationService',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return saved;
  }

  // ==================== 在线 judge（faithfulness / relevance） ====================

  /**
   * judge 模型实例缓存。
   * 用 buildModelConfig（纯函数）而非 switchModel——后者会改全局 currentModelId，
   * 污染用户正在使用的对话模型（与 kg-extract.service 同款纪律）。
   */
  private judgeLlmInstance: BaseChatModel | null = null;
  /** createLLM 失败（如 Key 未配置）的告警只发一次，避免每条消息刷屏 */
  private judgeUnavailableWarned = false;

  /**
   * 获取 judge 模型实例（失败返回 null，调用方静默跳过判分）。
   * Key 来源与对话模型一致：Redis 恢复（启动时 loadApiKeysFromStorage）→ .env 兜底。
   */
  private getJudgeLlm(): BaseChatModel | null {
    if (this.judgeLlmInstance) return this.judgeLlmInstance;
    try {
      this.judgeLlmInstance = createLLM(
        buildModelConfig(config.onlineJudgeModel),
      );
      this.judgeUnavailableWarned = false;
      return this.judgeLlmInstance;
    } catch (err: unknown) {
      if (!this.judgeUnavailableWarned) {
        this.judgeUnavailableWarned = true;
        logger.warn('在线 judge 模型不可用，判分跳过（规则分不受影响）', {
          module: 'EvaluationService',
          judgeModel: config.onlineJudgeModel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
  }

  /**
   * 对已保存的规则评估行追加 judge 判分结果（faithfulness / relevance 两维）。
   *
   * 线上没有 gold 标准答案，correctness 无法可靠评估，故只评两维：
   *   - faithfulness：答案论断是否都有检索上下文依据（幻觉检测，核心价值）
   *   - relevance：是否答非所问
   * 判分失败（模型异常/输出解析失败/超时）不写 judge 列，行保留规则分。
   */
  private async appendJudgeVerdict(
    evaluationId: number,
    params: {
      userMessage: string;
      assistantMessage: string;
      retrievedContexts?: string[];
    },
  ): Promise<void> {
    if (!config.onlineJudgeEnabled) return;

    const contexts = (params.retrievedContexts ?? [])
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .slice(0, ONLINE_JUDGE_MAX_CONTEXTS)
      .map((c) => c.slice(0, ONLINE_JUDGE_MAX_CONTEXT_CHARS));
    // 没有检索上下文就没有 faithfulness 的核对依据（如纯对话/纯工具回答），跳过
    if (contexts.length === 0) return;

    const llm = this.getJudgeLlm();
    if (!llm) return;

    // 头尾保留截断（掐中间保两端，见 truncateMiddle 注释）
    const truncatedQuestion = truncateMiddle(
      params.userMessage,
      ONLINE_JUDGE_MAX_QUESTION_CHARS,
    );
    const truncatedAnswer = truncateMiddle(
      params.assistantMessage,
      ONLINE_JUDGE_MAX_ANSWER_CHARS,
    );
    // 截断率可观测：正常情况不触发不刷屏；若日志频繁出现说明阈值需要调整
    if (
      truncatedQuestion !== params.userMessage ||
      truncatedAnswer !== params.assistantMessage
    ) {
      logger.warn('judge 输入超长已头尾保留截断（若频繁出现请调整阈值）', {
        module: 'EvaluationService',
        evaluationId,
        questionLen: params.userMessage.length,
        answerLen: params.assistantMessage.length,
      });
    }

    const verdict: JudgeVerdict | null = await judgeOne(
      llm,
      {
        question: truncatedQuestion,
        answer: truncatedAnswer,
        goldAnswer: '',
        answerFacts: [],
        contexts,
        questionType: 'online',
      },
      { signal: AbortSignal.timeout(ONLINE_JUDGE_TIMEOUT_MS) },
    );
    if (!verdict) {
      logger.warn('在线 judge 判分失败（保留规则分）', {
        module: 'EvaluationService',
        evaluationId,
      });
      return;
    }

    await this.autoEvaluationRepository.update(evaluationId, {
      judgeFaithful: verdict.faithful,
      judgeRelevant: verdict.relevant,
      unfaithfulClaims:
        verdict.unfaithful_claims.length > 0
          ? JSON.stringify(verdict.unfaithful_claims)
          : null,
      judgeReason: verdict.reason,
      judgeModel: config.onlineJudgeModel,
    });
    logger.info('在线 judge 判分完成', {
      module: 'EvaluationService',
      evaluationId,
      judgeModel: config.onlineJudgeModel,
      faithful: verdict.faithful,
      relevant: verdict.relevant,
      unfaithfulClaimCount: verdict.unfaithful_claims.length,
    });
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

    const positiveCount = feedbacks.filter(
      (f) => f.rating === 'positive',
    ).length;
    const negativeCount = feedbacks.filter(
      (f) => f.rating === 'negative',
    ).length;
    const totalFeedbacks = positiveCount + negativeCount;
    const satisfactionRate =
      totalFeedbacks > 0 ? positiveCount / totalFeedbacks : 0;

    // 自动评估统计
    const autoEvals = await this.autoEvaluationRepository.find({
      where: { userId, createdAt: MoreThan(since) as any },
      order: { createdAt: 'DESC' },
    });

    const avgAutoScore =
      autoEvals.length > 0
        ? autoEvals.reduce((sum, e) => sum + e.score, 0) / autoEvals.length
        : 0;

    // ==================== 在线 judge 三维统计 ====================
    // judgeFaithful=null 表示未判分（未启用/无检索上下文/判分失败），不计入分母
    const judged = autoEvals.filter((e) => e.judgeFaithful !== null);
    const faithfulCount = judged.filter((e) => e.judgeFaithful === true).length;
    const relevantCount = judged.filter((e) => e.judgeRelevant === true).length;
    // 幻觉明细：faithful=false 的题摘出编造原句（JSON 列安全解析，脏数据降级为空列表）
    const unfaithfulDetails = judged
      .filter((e) => e.judgeFaithful === false)
      .slice(0, 10)
      .map((e) => ({
        id: e.id,
        question: e.userMessage.slice(0, 120),
        claims: parseUnfaithfulClaims(e.unfaithfulClaims),
        judgeReason: e.judgeReason ?? '',
        createdAt: e.createdAt,
        judgeModel: e.judgeModel ?? '',
      }));

    // 按天聚合
    const dailyFeedback: Record<
      string,
      { positive: number; negative: number }
    > = {};
    for (const f of feedbacks) {
      const day = new Date(f.createdAt).toISOString().slice(0, 10);
      if (!dailyFeedback[day])
        dailyFeedback[day] = { positive: 0, negative: 0 };
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
        judge: {
          judgedCount: judged.length,
          faithfulCount,
          relevantCount,
          faithfulnessRate:
            judged.length > 0
              ? Math.round((faithfulCount / judged.length) * 100) / 100
              : 0,
          relevanceRate:
            judged.length > 0
              ? Math.round((relevantCount / judged.length) * 100) / 100
              : 0,
          unfaithfulDetails,
        },
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
    const negativeSignals =
      actionCounts.regenerate + actionCounts.negative + actionCounts.abandon;
    // 正向信号 = followup + positive
    const positiveSignals = actionCounts.followup + actionCounts.positive;

    // 满意度 = 正向 / (正向 + 负向)，仅在有信号时计算
    const satisfactionRate =
      positiveSignals + negativeSignals > 0
        ? positiveSignals / (positiveSignals + negativeSignals)
        : 0;

    // 按天聚合
    const dailyStats: Record<string, Record<string, number>> = {};
    for (const f of feedbacks) {
      const day = new Date(f.createdAt).toISOString().slice(0, 10);
      if (!dailyStats[day]) {
        dailyStats[day] = {
          regenerate: 0,
          followup: 0,
          abandon: 0,
          positive: 0,
          negative: 0,
        };
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
    const queryGroups: Map<
      string,
      {
        query: string;
        total: number;
        negative: number;
        positive: number;
        actions: Record<string, number>;
        sampleRetrievedDocIds: string[];
      }
    > = new Map();

    for (const f of feedbacks) {
      // 归一化查询：去空格、转小写，让相似查询合并
      const normalizedQuery = f.query.trim().toLowerCase().replace(/\s+/g, ' ');

      if (!queryGroups.has(normalizedQuery)) {
        queryGroups.set(normalizedQuery, {
          query: f.query,
          total: 0,
          negative: 0,
          positive: 0,
          actions: {
            regenerate: 0,
            followup: 0,
            abandon: 0,
            positive: 0,
            negative: 0,
          },
          sampleRetrievedDocIds: [],
        });
      }

      const group = queryGroups.get(normalizedQuery)!;
      group.total++;
      if (group.actions[f.action] !== undefined) {
        group.actions[f.action]++;
      }

      // 负向信号
      if (
        f.action === 'regenerate' ||
        f.action === 'negative' ||
        f.action === 'abandon'
      ) {
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
