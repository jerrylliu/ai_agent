import { Injectable, NotFoundException } from '@nestjs/common';
import { promptTemplate as promptInvoke } from './fundamentals/prompt';
import { ragWithLLM } from './fundamentals/rag-service';
import { generateSummary, shouldGenerateSummary } from './fundamentals/summarizer';
import { extractMemories, mergeMemories, shouldExtractMemory } from './fundamentals/memory-extractor';
import { logger } from './fundamentals/logger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThan } from 'typeorm';
import type { Response } from 'express';
import { ChatHistory } from './entities/chat-history.entity';
import { Session } from './entities/session.entity';
import { SessionSummary } from './entities/session-summary.entity';
import { UserMemory } from './entities/user-memory.entity';
import { LlmUsage } from './entities/llm-usage.entity';
import { MessageFeedback } from './entities/message-feedback.entity';
import { AutoEvaluation } from './entities/auto-evaluation.entity';
import type { UsageData } from './fundamentals/prompt';

@Injectable()
export class AppService {
  constructor(
    @InjectRepository(ChatHistory)
    private chatHistoryRepository: Repository<ChatHistory>,
    @InjectRepository(Session)
    private sessionRepository: Repository<Session>,
    @InjectRepository(SessionSummary)
    private sessionSummaryRepository: Repository<SessionSummary>,
    @InjectRepository(UserMemory)
    private userMemoryRepository: Repository<UserMemory>,
    @InjectRepository(LlmUsage)
    private llmUsageRepository: Repository<LlmUsage>,
    @InjectRepository(MessageFeedback)
    private messageFeedbackRepository: Repository<MessageFeedback>,
    @InjectRepository(AutoEvaluation)
    private autoEvaluationRepository: Repository<AutoEvaluation>,
  ) {}
  getHello(): string {
    return 'Hello World!';
  }
  async prompt(
    message?: string,
    images?: string[],
    history?: Array<{ role: string, content: string, images?: string[] }>,
    res?: Response,
    sessionId?: string,
    isCancelled?: () => boolean,
    userId: string = 'default',
    memoryEnabled?: boolean,
    summaryEnabled?: boolean,
    injectMemory?: boolean,
    abortController?: AbortController, // 用于中断 LLM 底层 HTTP 连接的 AbortController
  ) {
    // 获取会话摘要（如果摘要功能已启用）
    let sessionSummary: string | undefined;
    if (sessionId && summaryEnabled !== false) {
      const summary = await this.getSessionSummary(sessionId);
      if (summary && summary.summaryContent) {
        sessionSummary = summary.summaryContent;
      }
    }

    // 获取用户记忆（如果记忆功能已启用且允许注入）
    let memoryTexts: string[] = [];
    if (memoryEnabled !== false && injectMemory !== false) {
      const userMemories = await this.getUserMemories(userId);
      const topMemories = userMemories
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 20); // 最多注入 20 条最重要的记忆
      memoryTexts = topMemories.map((m) => m.content);

      // 更新被注入记忆的访问计数
      if (topMemories.length > 0) {
        const injectedIds = topMemories.map((m) => m.id);
        await this.userMemoryRepository.increment(
          { id: In(injectedIds) },
          'accessCount',
          1,
        );
      }
    }

    await promptInvoke(
      message, images, history, res, sessionSummary, memoryTexts,
      isCancelled, abortController, userId, sessionId,
      (usage: UsageData) => {
        this.saveLlmUsage(usage).catch((err) => {
          logger.error('保存 LLM 用量失败', { module: 'AppService', error: String(err) });
        });
        // 自动评估：异步执行，不阻塞主流程
        if (usage.assistantMessage) {
          this.autoEvaluate({
            userId: usage.userId,
            sessionId: usage.sessionId || '',
            userMessage: usage.userMessage,
            assistantMessage: usage.assistantMessage,
            modelId: usage.modelId,
            usedKnowledgeBase: usage.usedKnowledgeBase,
            responseTimeMs: usage.responseTimeMs,
          }).catch((err) => {
            logger.error('自动评估失败', { module: 'AppService', error: String(err) });
          });
        }
      },
    );
  }
  rag(message?: string){
    return ragWithLLM(message || '');
  }

  // 保存对话记录
  async saveChatHistory(sessionId: string, role: string, content: string, userId: string = 'default') {
    logger.debug('保存聊天记录', { module: 'AppService', sessionId, role, contentLength: content.length });
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
        title: content.substring(0, 50), // 使用第一条消息作为标题
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

    // 异步检查并更新摘要（不阻塞主流程）
    // 只在 assistant 消息保存时触发，避免每条消息都检查
    if (role === 'assistant') {
      this.checkAndUpdateSummary(sessionId, userId).catch(() => {});
      this.checkAndExtractMemories(sessionId, userId).catch(() => {});
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

  // ==================== 摘要相关方法 ====================

  /**
   * 获取指定会话的摘要
   * @param sessionId 会话 ID
   * @returns 摘要对象或 null
   */
  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    return this.sessionSummaryRepository.findOne({
      where: { sessionId },
    });
  }

  /**
   * 检查并生成/更新会话摘要
   * 在保存聊天记录后异步调用，不阻塞主流程
   *
   * @param sessionId 会话 ID
   */
  async checkAndUpdateSummary(sessionId: string, userId: string = 'default'): Promise<void> {
    try {
      // 获取该会话的总消息数
      const messageCount = await this.chatHistoryRepository.count({
        where: { sessionId },
      });

      // 获取已有摘要
      const existingSummary = await this.sessionSummaryRepository.findOne({
        where: { sessionId },
      });

      const coveredCount = existingSummary?.coveredMessageCount || 0;

      logger.info('摘要检查', { module: 'AppService', sessionId, totalMessages: messageCount, coveredMessages: coveredCount });

      // 判断是否需要生成/更新摘要
      if (!shouldGenerateSummary(coveredCount, messageCount)) {
        logger.debug('不需要生成摘要（条件未满足）', { module: 'AppService' });
        return;
      }

      logger.info('会话需要更新摘要', { module: 'AppService', sessionId, coveredCount, totalMessages: messageCount });

      // 获取需要摘要的消息（增量更新时只取新增部分）
      const messagesToSummarize = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
        skip: coveredCount, // 跳过已摘要的消息
        take: messageCount - coveredCount, // SQL Server 要求 skip 必须配合 take 使用
      });

      logger.debug('获取待摘要消息', { module: 'AppService', messageCount: messagesToSummarize.length });

      if (messagesToSummarize.length === 0) {
        logger.debug('无待摘要消息，跳过', { module: 'AppService' });
        return;
      }

      // 调用摘要服务生成摘要
      logger.info('开始调用 generateSummary', { module: 'AppService' });
      const summaryContent = await generateSummary(
        messagesToSummarize.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        existingSummary?.summaryContent || '',
      );

      logger.info('摘要生成结果', { module: 'AppService', summaryLength: summaryContent?.length || 0, preview: summaryContent?.substring(0, 100) || '空' });

      // 保存或更新摘要
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

      logger.info('会话摘要已更新', { module: 'AppService', sessionId, coveredMessages: messageCount });
    } catch (error: any) {
      logger.error('更新会话摘要失败', { module: 'AppService', error: error.message });
      // 摘要失败不影响主流程，静默处理
    }
  }

  // ==================== 用户记忆相关方法 ====================

  /**
   * 获取用户的所有记忆
   * @param userId 用户 ID
   * @returns 记忆列表
   */
  async getUserMemories(userId: string): Promise<UserMemory[]> {
    return this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
    });
  }

  /**
   * 获取用户记忆的文本内容（用于注入 System Prompt）
   * @param userId 用户 ID
   * @param limit 最大条数
   * @returns 记忆内容数组
   */
  async getUserMemoryTexts(userId: string, limit: number = 20): Promise<string[]> {
    const memories = await this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
      take: limit,
    });
    return memories.map((m) => m.content);
  }

  /**
   * 检查并提取用户记忆
   * 在保存聊天记录后异步调用
   *
   * @param sessionId 会话 ID
   */
  async checkAndExtractMemories(sessionId: string, userId: string = 'default'): Promise<void> {
    try {
      // 获取该会话的消息总数
      const messageCount = await this.chatHistoryRepository.count({
        where: { sessionId },
      });

      // 获取该会话已提取记忆时的消息数（通过查询该会话来源的记忆条数间接判断）
      const sessionMemories = await this.userMemoryRepository.find({
        where: { sourceSessionId: sessionId },
      });
      const lastExtractionCount = sessionMemories.length > 0
        ? messageCount // 简化：如果已有来源此会话的记忆，说明已提取过
        : 0;

      // 判断是否需要提取
      if (!shouldExtractMemory(lastExtractionCount, messageCount)) {
        return;
      }

      logger.info('会话需要提取记忆', { module: 'AppService', sessionId, messageCount });

      // 获取最近的对话消息用于提取
      const messages = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
      });

      if (messages.length === 0) {
        return;
      }

      // 调用记忆提取服务
      const newMemories = await extractMemories(
        messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      );

      if (newMemories.length === 0) {
        logger.info('会话未提取到新记忆', { module: 'AppService', sessionId });
        return;
      }

      // 获取已有记忆用于去重/合并
      const existingMemories = await this.getUserMemories(userId);
      const existingContents = existingMemories.map((m) => m.content);

      // 合并去重
      const mergeActions = await mergeMemories(newMemories, existingContents);

      let addedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      for (const action of mergeActions) {
        if (action.action === 'new') {
          // 添加新记忆
          const memory = this.userMemoryRepository.create({
            content: action.newMemory,
            category: newMemories.find((m) => m.content === action.newMemory)?.category || 'fact',
            importance: newMemories.find((m) => m.content === action.newMemory)?.importance || 3,
            sourceSessionId: sessionId,
            userId,
          });
          await this.userMemoryRepository.save(memory);
          addedCount++;
        } else if (action.action === 'update' && action.existingMemoryIndex >= 0) {
          // 更新已有记忆
          const existing = existingMemories[action.existingMemoryIndex];
          if (existing) {
            await this.userMemoryRepository.update(
              { id: existing.id },
              {
                content: action.newMemory,
                importance: Math.max(existing.importance,
                  newMemories.find((m) => m.content === action.newMemory)?.importance || 3),
              },
            );
            updatedCount++;
          }
        } else {
          skippedCount++;
        }
      }

      logger.info('记忆提取完成', { module: 'AppService', added: addedCount, updated: updatedCount, skipped: skippedCount });
    } catch (error: any) {
      logger.error('提取用户记忆失败', { module: 'AppService', error: error.message });
    }
  }

  /**
   * 手动添加一条用户记忆
   */
  async addUserMemory(content: string, category: string, importance: number, userId: string = 'default'): Promise<UserMemory> {
    const memory = this.userMemoryRepository.create({
      content,
      category,
      importance,
      userId,
    });
    return this.userMemoryRepository.save(memory);
  }

  /**
   * 删除一条用户记忆
   */
  async deleteUserMemory(id: number): Promise<void> {
    await this.userMemoryRepository.delete({ id });
  }

  /**
   * 更新一条用户记忆
   */
  async updateUserMemory(id: number, content: string, category?: string, importance?: number): Promise<UserMemory> {
    const memory = await this.userMemoryRepository.findOne({ where: { id } });
    if (!memory) {
      throw new Error('记忆不存在');
    }
    memory.content = content;
    if (category !== undefined) memory.category = category;
    if (importance !== undefined) memory.importance = importance;
    return this.userMemoryRepository.save(memory);
  }

  /**
   * 清空用户所有记忆
   */
  async clearUserMemories(userId: string = 'default'): Promise<void> {
    await this.userMemoryRepository.delete({ userId });
  }

  // ==================== 会话复制与导出 ====================

  /**
   * 复制会话：创建一个新会话，复制原会话的所有消息
   * @param sessionId 原会话 ID
   * @param userId 用户 ID
   * @returns 新创建的会话
   */
  async duplicateSession(sessionId: string, userId: string = 'default'): Promise<Session> {
    // 获取原会话
    const originalSession = await this.sessionRepository.findOne({
      where: { sessionId },
    });
    if (!originalSession) {
      throw new NotFoundException('会话不存在');
    }

    // 生成新的会话 ID
    const newSessionId = `${sessionId}_copy_${Date.now()}`;
    const newTitle = `${originalSession.title} (副本)`;

    // 创建新会话
    const newSession = this.sessionRepository.create({
      sessionId: newSessionId,
      title: newTitle,
      userId,
    });
    await this.sessionRepository.save(newSession);

    // 复制原会话的所有消息
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

  /**
   * 导出会话：返回会话信息和所有消息，支持不同格式
   * @param sessionId 会话 ID
   * @param format 导出格式 (json / markdown / text)
   * @returns 导出内容
   */
  async exportSession(sessionId: string, format: string = 'json'): Promise<any> {
    try {
      const session = await this.sessionRepository.findOne({
        where: { sessionId },
      });
      if (!session) {
        logger.warn('导出会话失败: 会话不存在', { module: 'AppService', sessionId });
        throw new NotFoundException('会话不存在');
      }

      const messages = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
      });

      logger.info('导出会话', { module: 'AppService', sessionId, format, messageCount: messages.length });

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
      logger.error('导出会话异常', { module: 'AppService', sessionId, format, error: String(error) });
      throw error;
    }
  }

  // ==================== LLM 用量统计 ====================

  /**
   * 保存一次 LLM 调用的用量记录
   */
  async saveLlmUsage(usage: UsageData): Promise<LlmUsage> {
    logger.info('LLM 用量记录', {
      module: 'AppService',
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
   * @param userId 用户 ID
   * @param days 统计最近多少天（默认 7 天）
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

  // ==================== 准确率评估 ====================

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
    // 查找该用户+会话+消息的任意反馈记录
    const existing = await this.messageFeedbackRepository.findOne({
      where: {
        userId: params.userId,
        sessionId: params.sessionId,
        assistantMessage: params.assistantMessage,
      },
    });

    if (existing) {
      if (existing.rating === params.rating) {
        // 相同评分 → 删除（取消）
        await this.messageFeedbackRepository.remove(existing);
        return { action: 'removed', rating: params.rating };
      } else {
        // 相反评分 → 更新为新的评分（保持同一ID）
        existing.rating = params.rating;
        existing.comment = params.comment || existing.comment;
        await this.messageFeedbackRepository.save(existing);
        return { action: 'updated', rating: params.rating };
      }
    }

    // 无记录 → 创建新反馈
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
   * 评估维度：响应时间、知识库命中、消息长度等
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
    let score = 0.5; // 基础分
    const reasons: string[] = [];

    // 规则1：回答非空且有一定长度
    if (params.assistantMessage && params.assistantMessage.length > 50) {
      score += 0.1;
      reasons.push('回答内容充实');
    } else if (!params.assistantMessage || params.assistantMessage.length < 10) {
      score -= 0.2;
      reasons.push('回答过短');
    }

    // 规则2：知识库命中加分
    if (params.usedKnowledgeBase) {
      score += 0.15;
      reasons.push('使用了知识库');
    }

    // 规则3：响应时间合理
    if (params.responseTimeMs && params.responseTimeMs < 5000) {
      score += 0.1;
      reasons.push('响应速度快');
    } else if (params.responseTimeMs && params.responseTimeMs > 30000) {
      score -= 0.1;
      reasons.push('响应时间过长');
    }

    // 规则4：回答中包含来源引用（标注了文档来源）
    if (/【文档\s*\d+】/.test(params.assistantMessage)) {
      score += 0.1;
      reasons.push('标注了信息来源');
    }

    // 规则5：回答中包含"无法"等否定词减分
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
