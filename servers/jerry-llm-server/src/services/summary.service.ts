import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatHistory } from '../entities/chat-history.entity';
import { SessionSummary } from '../entities/session-summary.entity';
import { generateSummary, shouldGenerateSummary } from '../fundamentals/summarizer';
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
   */
  async checkAndUpdateSummary(sessionId: string, userId: string = 'default'): Promise<void> {
    try {
      const messageCount = await this.chatHistoryRepository.count({
        where: { sessionId },
      });

      const existingSummary = await this.sessionSummaryRepository.findOne({
        where: { sessionId },
      });

      const coveredCount = existingSummary?.coveredMessageCount || 0;

      logger.info('摘要检查', { module: 'SummaryService', sessionId, totalMessages: messageCount, coveredMessages: coveredCount });

      if (!shouldGenerateSummary(coveredCount, messageCount)) {
        logger.debug('不需要生成摘要（条件未满足）', { module: 'SummaryService' });
        return;
      }

      logger.info('会话需要更新摘要', { module: 'SummaryService', sessionId, coveredCount, totalMessages: messageCount });

      const messagesToSummarize = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
        skip: coveredCount,
        take: messageCount - coveredCount,
      });

      logger.debug('获取待摘要消息', { module: 'SummaryService', messageCount: messagesToSummarize.length });

      if (messagesToSummarize.length === 0) {
        logger.debug('无待摘要消息，跳过', { module: 'SummaryService' });
        return;
      }

      logger.info('开始调用 generateSummary', { module: 'SummaryService' });
      const summaryContent = await generateSummary(
        messagesToSummarize.map((msg) => ({
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
            coveredMessageCount: messageCount,
          },
        );
      } else {
        const newSummary = this.sessionSummaryRepository.create({
          sessionId,
          summaryContent,
          coveredMessageCount: messageCount,
          userId,
        });
        await this.sessionSummaryRepository.save(newSummary);
      }

      logger.info('会话摘要已更新', { module: 'SummaryService', sessionId, coveredMessages: messageCount });
    } catch (error: any) {
      logger.error('更新会话摘要失败', { module: 'SummaryService', error: error.message });
    }
  }
}
