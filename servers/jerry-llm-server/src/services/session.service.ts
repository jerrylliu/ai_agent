import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { ChatHistory } from '../entities/chat-history.entity';
import { Session } from '../entities/session.entity';
import { SessionSummary } from '../entities/session-summary.entity';
import { LlmUsage } from '../entities/llm-usage.entity';
import { MessageFeedback } from '../entities/message-feedback.entity';
import { AutoEvaluation } from '../entities/auto-evaluation.entity';
import { GeneratedDocument } from '../entities/generated-document.entity';
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
    @InjectRepository(GeneratedDocument)
    private generatedDocumentRepository: Repository<GeneratedDocument>,
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
    const messages = await this.chatHistoryRepository.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    });

    // 关联 generated_document：把当前会话下未过期的文档按时间顺序贴回最近的 assistant 消息
    // 这样重启或重新加载历史后，文件卡片不会丢失
    const now = new Date();
    const docs = await this.generatedDocumentRepository.find({
      where: { sessionId, expiresAt: MoreThan(now) },
      order: { createdAt: 'ASC' },
    });

    if (docs.length === 0) {
      return messages.map((m) => ({ ...m, attachments: [] as any[] }));
    }

    // 把每个 doc 关联到最近一条早于（或等于）其 createdAt 的 assistant 消息
    const enriched = messages.map((m) => ({ ...m, attachments: [] as any[] }));
    const assistantIdxList = enriched
      .map((m, idx) => ({ idx, role: m.role, createdAt: new Date(m.createdAt as any) }))
      .filter((x) => x.role === 'assistant');

    for (const doc of docs) {
      const docTime = new Date(doc.createdAt as any).getTime();
      // 找到 createdAt 不晚于 docTime 的最后一条 assistant；找不到则贴到第一条 assistant
      let target = -1;
      for (const a of assistantIdxList) {
        if (a.createdAt.getTime() <= docTime + 60 * 1000) {
          // 容忍 1 分钟时钟漂移：assistant 消息保存稍晚于文档生成
          target = a.idx;
        } else {
          break;
        }
      }
      if (target === -1 && assistantIdxList.length > 0) target = assistantIdxList[0].idx;
      if (target !== -1) {
        enriched[target].attachments.push({
          key: doc.key,
          filename: doc.filename,
          format: doc.format,
          sizeBytes: Number(doc.sizeBytes),
          downloadUrl: `/chat/documents/download/${doc.key}`,
          previewUrl: `/chat/documents/preview/${doc.key}`,
          expiresAt: doc.expiresAt.getTime(),
          favorited: doc.favorited,
        });
      }
    }

    return enriched;
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

  // 更新会话标签
  async updateSessionTags(sessionId: string, tags: string[], userId?: string) {
    const where: any = { sessionId };
    if (userId) {
      where.userId = userId;
    }
    await this.sessionRepository.update(where, { tags });
    return this.sessionRepository.findOne({ where });
  }

  // 更新会话分类
  async updateSessionCategory(sessionId: string, category: string, userId?: string) {
    const where: any = { sessionId };
    if (userId) {
      where.userId = userId;
    }
    await this.sessionRepository.update(where, { category });
    return this.sessionRepository.findOne({ where });
  }

  // 按标签查询会话
  async getSessionsByTag(tag: string, userId: string = 'default') {
    const sessions = await this.sessionRepository.find({
      where: { userId },
      order: { isPinned: 'DESC', updatedAt: 'DESC' },
    });
    return sessions.filter(s => s.tags && s.tags.includes(tag));
  }

  // 按分类查询会话
  async getSessionsByCategory(category: string, userId: string = 'default') {
    return this.sessionRepository.find({
      where: { userId, category },
      order: { isPinned: 'DESC', updatedAt: 'DESC' },
    });
  }

  // 获取所有标签
  async getAllTags(userId: string = 'default'): Promise<string[]> {
    const sessions = await this.sessionRepository.find({ where: { userId } });
    const tagSet = new Set<string>();
    for (const s of sessions) {
      if (s.tags) {
        for (const t of s.tags) {
          tagSet.add(t);
        }
      }
    }
    return [...tagSet];
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
