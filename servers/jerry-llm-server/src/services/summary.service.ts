import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatHistory } from '../entities/chat-history.entity';
import { SessionSummary } from '../entities/session-summary.entity';
import { generateSummary } from '../fundamentals/summarizer';
import { logger } from '../fundamentals/logger';

@Injectable()
export class SummaryService {
  constructor(
    @InjectRepository(ChatHistory)
    private chatHistoryRepository: Repository<ChatHistory>,
    @InjectRepository(SessionSummary)
    private sessionSummaryRepository: Repository<SessionSummary>,
  ) {}

  /**
   * 获取指定会话的摘要
   */
  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    return this.sessionSummaryRepository.findOne({
      where: { sessionId },
    });
  }

  /**
   * 检查并生成/更新会话摘要
   * 触发策略：
   * - 首次生成：消息轮数 >= 3 轮（3 个 user 消息）
   * - 增量更新：每新增 3 轮更新一次
   */
  async checkAndUpdateSummary(sessionId: string, userId: string = 'default'): Promise<void> {
    try {
      const messages = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
      });

      // 计算用户消息数（即轮数）
      const userMessageCount = messages.filter(m => m.role === 'user').length;

      const existingSummary = await this.sessionSummaryRepository.findOne({
        where: { sessionId },
      });

      // 计算已覆盖的轮数
      const coveredUserCount = existingSummary
        ? messages.slice(0, existingSummary.coveredMessageCount).filter(m => m.role === 'user').length
        : 0;

      const SUMMARY_ROUNDS_THRESHOLD = 3; // 每 3 轮生成/更新一次摘要

      logger.info('摘要检查', { module: 'SummaryService', sessionId, totalRounds: userMessageCount, coveredRounds: coveredUserCount });

      // 首次生成：轮数 >= 3
      if (!existingSummary && userMessageCount < SUMMARY_ROUNDS_THRESHOLD) {
        logger.debug('不需要生成摘要（轮数不足）', { module: 'SummaryService', userMessageCount, threshold: SUMMARY_ROUNDS_THRESHOLD });
        return;
      }

      // 增量更新：新增轮数 >= 3
      if (existingSummary && userMessageCount - coveredUserCount < SUMMARY_ROUNDS_THRESHOLD) {
        logger.debug('不需要更新摘要（新增轮数不足）', { module: 'SummaryService', newRounds: userMessageCount - coveredUserCount, threshold: SUMMARY_ROUNDS_THRESHOLD });
        return;
      }

      logger.info('会话需要更新摘要', { module: 'SummaryService', sessionId, coveredRounds: coveredUserCount, totalRounds: userMessageCount });

      // 获取需要摘要的新消息
      const newMessages = existingSummary
        ? messages.slice(existingSummary.coveredMessageCount)
        : messages;

      logger.debug('获取待摘要消息', { module: 'SummaryService', messageCount: newMessages.length });

      if (newMessages.length === 0) {
        logger.debug('无待摘要消息，跳过', { module: 'SummaryService' });
        return;
      }

      logger.info('开始调用 generateSummary', { module: 'SummaryService' });
      const summaryContent = await generateSummary(
        newMessages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        existingSummary?.summaryContent || '',
      );

      logger.info('摘要生成结果', { module: 'SummaryService', summaryLength: summaryContent?.length || 0, preview: summaryContent?.substring(0, 100) || '空' });

      if (existingSummary) {
        await this.sessionSummaryRepository.update(
          { sessionId },
          {
            summaryContent,
            coveredMessageCount: messages.length,
          },
        );
      } else {
        const newSummary = this.sessionSummaryRepository.create({
          sessionId,
          summaryContent,
          coveredMessageCount: messages.length,
          userId,
        });
        await this.sessionSummaryRepository.save(newSummary);
      }

      logger.info('会话摘要已更新', { module: 'SummaryService', sessionId, coveredMessages: messages.length, coveredRounds: userMessageCount });
    } catch (error: any) {
      logger.error('更新会话摘要失败', { module: 'SummaryService', error: error.message });
    }
  }
}
