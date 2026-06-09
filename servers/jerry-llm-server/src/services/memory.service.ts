import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ChatHistory } from '../entities/chat-history.entity';
import { UserMemory } from '../entities/user-memory.entity';
import { extractMemories, mergeMemories, shouldExtractMemory } from '../fundamentals/memory-extractor';
import { logger } from '../fundamentals/logger';

@Injectable()
export class MemoryService {
  constructor(
    @InjectRepository(ChatHistory)
    private chatHistoryRepository: Repository<ChatHistory>,
    @InjectRepository(UserMemory)
    private userMemoryRepository: Repository<UserMemory>,
  ) {}

  /**
   * 获取用户的所有记忆
   */
  async getUserMemories(userId: string): Promise<UserMemory[]> {
    return this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
    });
  }

  /**
   * 获取用户记忆的文本内容（用于注入 System Prompt）
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
   * 获取用户记忆并更新访问计数（用于 prompt 注入场景）
   */
  async getMemoriesForInjection(userId: string, limit: number = 20): Promise<{ memoryTexts: string[]; injectedIds: number[] }> {
    const userMemories = await this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
      take: limit,
    });

    const memoryTexts = userMemories.map((m) => m.content);
    const injectedIds = userMemories.map((m) => m.id);

    // 更新被注入记忆的访问计数
    if (injectedIds.length > 0) {
      await this.userMemoryRepository.increment(
        { id: In(injectedIds) },
        'accessCount',
        1,
      );
    }

    return { memoryTexts, injectedIds };
  }

  /**
   * 检查并提取用户记忆
   */
  async checkAndExtractMemories(sessionId: string, userId: string = 'default'): Promise<void> {
    try {
      const messageCount = await this.chatHistoryRepository.count({
        where: { sessionId },
      });

      const sessionMemories = await this.userMemoryRepository.find({
        where: { sourceSessionId: sessionId },
      });
      const lastExtractionCount = sessionMemories.length > 0
        ? messageCount
        : 0;

      if (!shouldExtractMemory(lastExtractionCount, messageCount)) {
        return;
      }

      logger.info('会话需要提取记忆', { module: 'MemoryService', sessionId, messageCount });

      const messages = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
      });

      if (messages.length === 0) {
        return;
      }

      const newMemories = await extractMemories(
        messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      );

      if (newMemories.length === 0) {
        logger.info('会话未提取到新记忆', { module: 'MemoryService', sessionId });
        return;
      }

      const existingMemories = await this.getUserMemories(userId);
      const existingContents = existingMemories.map((m) => m.content);

      const mergeActions = await mergeMemories(newMemories, existingContents);

      let addedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      for (const action of mergeActions) {
        if (action.action === 'new') {
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

      logger.info('记忆提取完成', { module: 'MemoryService', added: addedCount, updated: updatedCount, skipped: skippedCount });
    } catch (error: any) {
      logger.error('提取用户记忆失败', { module: 'MemoryService', error: error.message });
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
