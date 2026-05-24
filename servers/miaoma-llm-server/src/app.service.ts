import { Injectable } from '@nestjs/common';
import { promptTemplate as promptInvoke } from './fundamentals/prompt';
import { ragWithLLM } from './fundamentals/rag-service';
import { generateSummary, shouldGenerateSummary } from './fundamentals/summarizer';
import { extractMemories, mergeMemories, shouldExtractMemory } from './fundamentals/memory-extractor';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import type { Response } from 'express';
import { ChatHistory } from './entities/chat-history.entity';
import { Session } from './entities/session.entity';
import { SessionSummary } from './entities/session-summary.entity';
import { UserMemory } from './entities/user-memory.entity';

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

    await promptInvoke(message, images, history, res, sessionSummary, memoryTexts, isCancelled);
  }
  rag(message?: string){
    return ragWithLLM(message || '');
  }

  // 保存对话记录
  async saveChatHistory(sessionId: string, role: string, content: string, userId: string = 'default') {
    console.log(sessionId, role, content, 222222);
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

      console.log(`📊 摘要检查: sessionId=${sessionId}, 总消息=${messageCount}, 已覆盖=${coveredCount}`);

      // 判断是否需要生成/更新摘要
      if (!shouldGenerateSummary(coveredCount, messageCount)) {
        console.log(`⏭️ 不需要生成摘要 (条件未满足)`);
        return;
      }

      console.log(`🔄 会话 ${sessionId} 需要更新摘要 (已覆盖: ${coveredCount}, 总消息: ${messageCount})`);

      // 获取需要摘要的消息（增量更新时只取新增部分）
      const messagesToSummarize = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
        skip: coveredCount, // 跳过已摘要的消息
        take: messageCount - coveredCount, // SQL Server 要求 skip 必须配合 take 使用
      });

      console.log(`📋 获取到 ${messagesToSummarize.length} 条待摘要消息`);

      if (messagesToSummarize.length === 0) {
        console.log(`⏭️ 无待摘要消息，跳过`);
        return;
      }

      // 调用摘要服务生成摘要
      console.log(`🚀 开始调用 generateSummary...`);
      const summaryContent = await generateSummary(
        messagesToSummarize.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        existingSummary?.summaryContent || '',
      );

      console.log(`📝 摘要生成结果: 长度=${summaryContent?.length || 0}, 内容前100字=${summaryContent?.substring(0, 100) || '空'}`);

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

      console.log(`✅ 会话 ${sessionId} 摘要已更新，覆盖 ${messageCount} 条消息`);
    } catch (error: any) {
      console.error(`❌ 更新会话摘要失败: ${error.message}`);
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

      console.log(`🧠 会话 ${sessionId} 需要提取记忆 (消息数: ${messageCount})`);

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
        console.log(`ℹ️ 会话 ${sessionId} 未提取到新记忆`);
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

      console.log(`✅ 记忆提取完成: 新增 ${addedCount}, 更新 ${updatedCount}, 跳过 ${skippedCount}`);
    } catch (error: any) {
      console.error(`❌ 提取用户记忆失败: ${error.message}`);
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
}
