import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatHistory } from '../entities/chat-history.entity';
import { Session } from '../entities/session.entity';
import { SessionSummary } from '../entities/session-summary.entity';
import { LlmUsage } from '../entities/llm-usage.entity';
import { MessageFeedback } from '../entities/message-feedback.entity';
import { AutoEvaluation } from '../entities/auto-evaluation.entity';
import { logger } from '../fundamentals/logger';
import { SummaryService } from './summary.service';
import { MemoryService } from './memory.service';

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(ChatHistory)
    private chatHistoryRepository: Repository<ChatHistory>,
    @InjectRepository(Session)
    private sessionRepository: Repository<Session>,
    @InjectRepository(SessionSummary)
    private sessionSummaryRepository: Repository<SessionSummary>,
    @InjectRepository(LlmUsage)
    private llmUsageRepository: Repository<LlmUsage>,
    @InjectRepository(MessageFeedback)
    private messageFeedbackRepository: Repository<MessageFeedback>,
    @InjectRepository(AutoEvaluation)
    private autoEvaluationRepository: Repository<AutoEvaluation>,
    private readonly summaryService: SummaryService,
    private readonly memoryService: MemoryService,
  ) {}

  // 保存对话记录
  async saveChatHistory(sessionId: string, role: string, content: string, userId: string = 'default') {
    logger.debug('保存聊天记录', { module: 'SessionService', sessionId, role, contentLength: content.length });
    const chatHistory = this.chatHistoryRepository.create({
      userId,
      sessionId,
      role,
      content,
    });
    const savedHistory = await this.chatHistoryRepository.save(chatHistory);

    // 检查是否需要更新会话标题
    const session = await this.sessionRepository.findOne({
      where: { sessionId },
    });

    if (!session) {
      // 创建新会话
      const newSession = this.sessionRepository.create({
        sessionId,
        title: content.substring(0, 50),
        userId,
      });
      await this.sessionRepository.save(newSession);
    } else {
      // 更新会话的 updatedAt
      await this.sessionRepository.update(
        { sessionId },
        { updatedAt: new Date() }
      );
    }

    // 异步检查并更新摘要和记忆（不阻塞主流程）
    if (role === 'assistant') {
      this.summaryService.checkAndUpdateSummary(sessionId, userId).catch(() => {});
      this.memoryService.checkAndExtractMemories(sessionId, userId).catch(() => {});
    }

    return savedHistory;
  }

  // 获取会话历史
  async getSessionHistory(sessionId: string) {
    return this.chatHistoryRepository.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    });
  }

  // 获取所有会话
  async getSessions(userId: string = 'default') {
    return this.sessionRepository.find({
      where: { userId },
      order: {
        isPinned: 'DESC',
        updatedAt: 'DESC',
      },
    });
  }

  // 创建新会话
  async createSession(sessionId: string, title: string, userId: string = 'default') {
    const session = this.sessionRepository.create({
      sessionId,
      title,
      userId,
    });
    return this.sessionRepository.save(session);
  }

  // 获取指定会话
  async getSessionBySessionId(sessionId: string) {
    return this.sessionRepository.findOne({
      where: { sessionId },
    });
  }

  // 更新会话标题
  async updateSessionTitle(sessionId: string, title: string, userId?: string) {
    const where: any = { sessionId };
    if (userId) {
      where.userId = userId;
    }
    return this.sessionRepository.update(where, { title });
  }

  // 删除会话
  async deleteSession(sessionId: string, userId?: string) {
    const where: any = { sessionId };
    if (userId) {
      where.userId = userId;
    }
    // 先删除相关的摘要
    await this.sessionSummaryRepository.delete({ sessionId });
    // 删除相关的用量记录
    await this.llmUsageRepository.delete({ sessionId });
    // 删除相关的反馈
    await this.messageFeedbackRepository.delete({ sessionId });
    // 删除相关的自动评估
    await this.autoEvaluationRepository.delete({ sessionId });
    // 再删除相关的聊天记录
    await this.chatHistoryRepository.delete({ sessionId });
    // 最后删除会话
    return this.sessionRepository.delete(where);
  }

  // 切换会话置顶状态
  async toggleSessionPin(sessionId: string, userId?: string) {
    const where: any = { sessionId };
    if (userId) {
      where.userId = userId;
    }
    const session = await this.sessionRepository.findOne({ where });
    if (session) {
      session.isPinned = !session.isPinned;
      return this.sessionRepository.save(session);
    }
    return null;
  }

  // 更新消息
  async updateMessage(id: string, content: string) {
    return this.chatHistoryRepository.update(
      { id: parseInt(id) },
      { content }
    );
  }

  // 删除消息
  async deleteMessage(id: string) {
    return this.chatHistoryRepository.delete({ id: parseInt(id) });
  }

  // 获取所有聊天记录（用于调试）
  async getAllChatHistory() {
    return this.chatHistoryRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  // 复制会话
  async duplicateSession(sessionId: string, userId: string = 'default'): Promise<Session> {
    const originalSession = await this.sessionRepository.findOne({
      where: { sessionId },
    });
    if (!originalSession) {
      throw new NotFoundException('会话不存在');
    }

    const newSessionId = `${sessionId}_copy_${Date.now()}`;
    const newTitle = `${originalSession.title} (副本)`;

    const newSession = this.sessionRepository.create({
      sessionId: newSessionId,
      title: newTitle,
      userId,
    });
    await this.sessionRepository.save(newSession);

    const originalMessages = await this.chatHistoryRepository.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    });

    for (const msg of originalMessages) {
      const newMsg = this.chatHistoryRepository.create({
        userId,
        sessionId: newSessionId,
        role: msg.role,
        content: msg.content,
      });
      await this.chatHistoryRepository.save(newMsg);
    }

    return newSession;
  }

  // 导出会话
  async exportSession(sessionId: string, format: string = 'json'): Promise<any> {
    try {
      const session = await this.sessionRepository.findOne({
        where: { sessionId },
      });
      if (!session) {
        logger.warn('导出会话失败: 会话不存在', { module: 'SessionService', sessionId });
        throw new NotFoundException('会话不存在');
      }

      const messages = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
      });

      logger.info('导出会话', { module: 'SessionService', sessionId, format, messageCount: messages.length });

      if (format === 'markdown') {
        let md = `# ${session.title}\n\n`;
        md += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
        md += `---\n\n`;
        for (const msg of messages) {
          const role = msg.role === 'user' ? '👤 用户' : '🤖 AI';
          const time = new Date(msg.createdAt).toLocaleString('zh-CN');
          md += `### ${role}  *${time}*\n\n`;
          md += `${msg.content}\n\n`;
          md += `---\n\n`;
        }
        return { content: md, filename: `${session.title}.md` };
      }

      if (format === 'text') {
        let text = `${session.title}\n`;
        text += `导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
        text += `${'='.repeat(50)}\n\n`;
        for (const msg of messages) {
          const role = msg.role === 'user' ? '用户' : 'AI';
          const time = new Date(msg.createdAt).toLocaleString('zh-CN');
          text += `[${role}] (${time}):\n${msg.content}\n\n${'-'.repeat(40)}\n\n`;
        }
        return { content: text, filename: `${session.title}.txt` };
      }

      // 默认 JSON 格式
      return {
        session: {
          sessionId: session.sessionId,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        })),
        exportedAt: new Date().toISOString(),
        filename: `${session.title}.json`,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      logger.error('导出会话异常', { module: 'SessionService', sessionId, format, error: String(error) });
      throw error;
    }
  }
}
