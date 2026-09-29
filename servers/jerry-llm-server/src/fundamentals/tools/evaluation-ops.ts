/**
 * 评估查询工具（只读）
 *
 * 让 Agent 可以查询评估面板数据：
 * - query_evaluation_stats: 查询任意时间窗的人工反馈统计、自动评估统计、
 *   AI 质量判分（faithfulness/relevance）结果与编造内容明细
 *
 * 纯只读工具，不需要人工确认（设计文档"看类操作不用确认"）。
 * 按当前用户隔离：只返回 ToolContext.userId 自己的评估数据。
 */

import { z } from 'zod';
import { logger } from '../logger';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== EvaluationService 注入 ====================

let evaluationService: any = null;

/**
 * 注入 EvaluationService 实例（AppModule 初始化时调用）
 */
export function initEvaluationOps(service: any): void {
  evaluationService = service;
  logger.info('评估查询工具：EvaluationService 已注入', {
    module: 'Tool:EvaluationOps',
  });
}

// ==================== query_evaluation_stats（只读） ====================

export const queryEvaluationStatsParamsSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('统计时间窗（天，默认 7，最大 365）'),
});

export type QueryEvaluationStatsParams = z.infer<
  typeof queryEvaluationStatsParamsSchema
>;

export const queryEvaluationStatsSchema = buildToolJsonSchema(
  'query_evaluation_stats',
  '查询回答质量评估统计：用户点赞点踩分布、自动评估平均分、AI 质量判分（忠实率/相关率）与编造内容明细。用户问"最近回答质量怎么样/编造了哪些内容"时使用。',
  queryEvaluationStatsParamsSchema,
);

export interface EvaluationStatsResult {
  success: boolean;
  days: number;
  humanEvaluation?: {
    totalFeedbacks: number;
    positiveCount: number;
    negativeCount: number;
    satisfactionRate: number;
  };
  autoEvaluation?: {
    totalEvaluations: number;
    avgScore: number;
    judge: {
      judgedCount: number;
      faithfulCount: number;
      relevantCount: number;
      faithfulnessRate: number;
      relevanceRate: number;
      unfaithfulDetails: {
        question: string;
        claims: string[];
        judgeReason: string;
        createdAt?: string;
      }[];
    };
  };
  message: string;
}

export async function executeQueryEvaluationStats(
  rawParams: unknown,
  context?: { userId?: string },
): Promise<EvaluationStatsResult> {
  const parsed = safeParseToolParams(
    queryEvaluationStatsParamsSchema,
    rawParams,
  );
  if (!parsed.success) {
    return { success: false, days: 0, message: `参数校验失败: ${parsed.error}` };
  }
  const params = parsed.data;
  const days = params.days ?? 7;

  if (!evaluationService) {
    return { success: false, days, message: '评估服务未初始化' };
  }

  try {
    // 按当前用户隔离：与评估面板同口径（面板查当前登录用户，未登录为 default）
    const userId = context?.userId || 'default';
    const stats = await evaluationService.getEvaluationStats(userId, days);

    const human = stats.humanEvaluation;
    const auto = stats.autoEvaluation;

    logger.info('FC工具 [query_evaluation_stats] 查询完成', {
      module: 'Tool:EvaluationOps',
      userId,
      days,
      totalFeedbacks: human?.totalFeedbacks,
      totalEvaluations: auto?.totalEvaluations,
    });

    return {
      success: true,
      days,
      humanEvaluation: human
        ? {
            totalFeedbacks: human.totalFeedbacks,
            positiveCount: human.positiveCount,
            negativeCount: human.negativeCount,
            satisfactionRate: human.satisfactionRate,
          }
        : undefined,
      autoEvaluation: auto
        ? {
            totalEvaluations: auto.totalEvaluations,
            avgScore: auto.avgScore,
            judge: {
              judgedCount: auto.judge?.judgedCount ?? 0,
              faithfulCount: auto.judge?.faithfulCount ?? 0,
              relevantCount: auto.judge?.relevantCount ?? 0,
              faithfulnessRate: auto.judge?.faithfulnessRate ?? 0,
              relevanceRate: auto.judge?.relevanceRate ?? 0,
              // 编造明细只取前 10 条（服务端已截断），字段裁剪为可读摘要
              unfaithfulDetails: (auto.judge?.unfaithfulDetails ?? []).map(
                (d: any) => ({
                  question: d.question,
                  claims: Array.isArray(d.claims) ? d.claims : [],
                  judgeReason: d.judgeReason,
                  createdAt: d.createdAt
                    ? new Date(d.createdAt).toISOString()
                    : undefined,
                }),
              ),
            },
          }
        : undefined,
      message: `最近 ${days} 天：人工反馈 ${human?.totalFeedbacks ?? 0} 条（赞 ${human?.positiveCount ?? 0} / 踩 ${human?.negativeCount ?? 0}），自动评估 ${auto?.totalEvaluations ?? 0} 次，AI 判分忠实率 ${Math.round((auto?.judge?.faithfulnessRate ?? 0) * 100)}%`,
    };
  } catch (error: any) {
    logger.error('FC工具 [query_evaluation_stats] 查询失败', {
      module: 'Tool:EvaluationOps',
      error: error.message,
    });
    return {
      success: false,
      days,
      message: `查询评估统计失败: ${error.message}`,
    };
  }
}
