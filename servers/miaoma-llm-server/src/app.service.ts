import { Injectable } from '@nestjs/common';
import { promptTemplate as promptInvoke } from './fundamentals/prompt';
import { main as ragInvoke } from './fundamentals/rag';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Response } from 'express';
import { ChatHistory } from './entities/chat-history.entity';
import { Session } from './entities/session.entity';

@Injectable()
export class AppService {
  constructor(
    @InjectRepository(ChatHistory)
    private chatHistoryRepository: Repository<ChatHistory>,
    @InjectRepository(Session)
    private sessionRepository: Repository<Session>,
  ) {}
  getHello(): string {
    return 'Hello World!';
  }
  async prompt(
    message?: string,
    images?: string[],
    history?: Array<{ role: string, content: string, images?: string[] }>,
    res?: Response
  ) {
    await promptInvoke(message, images, history, res);
  }
  rag(message?: string){
    return ragInvoke(message);
  }

  // 保存对话记录
  async saveChatHistory(sessionId: string, role: string, content: string) {
    console.log(sessionId, role, content, 222222);
    const chatHistory = this.chatHistoryRepository.create({
      userId: 'default', // 可根据实际情况修改
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
        userId: 'default',
      });
      await this.sessionRepository.save(newSession);
    } else {
      // 更新会话的 updatedAt
      await this.sessionRepository.update(
        { sessionId },
        { updatedAt: new Date() }
      );
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
  async getSessions() {
    return this.sessionRepository.find({
      where: { userId: 'default' },
      order: {
        isPinned: 'DESC',
        updatedAt: 'DESC',
      },
    });
  }

  // 创建新会话
  async createSession(sessionId: string, title: string) {
    const session = this.sessionRepository.create({
      sessionId,
      title,
      userId: 'default',
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
  async updateSessionTitle(sessionId: string, title: string) {
    return this.sessionRepository.update(
      { sessionId },
      { title }
    );
  }

  // 删除会话
  async deleteSession(sessionId: string) {
    // 先删除相关的聊天记录
    await this.chatHistoryRepository.delete({
      sessionId,
    });
    // 再删除会话
    return this.sessionRepository.delete({
      sessionId,
    });
  }

  // 切换会话置顶状态
  async toggleSessionPin(sessionId: string) {
    const session = await this.sessionRepository.findOne({
      where: { sessionId },
    });
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
}
