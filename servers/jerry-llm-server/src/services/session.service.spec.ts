/**
 * services/session.service.spec.ts
 *
 * SessionService 纯单元测试（不依赖 NestJS DI 容器）
 *
 * mock 策略：直接 mock @nestjs/typeorm 的装饰器 + 模拟各 Repository
 */

/* =====================================================================
 * Mock 基础模块，防止级联 import 报错
 * ==================================================================*/
jest.mock('../fundamentals/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../fundamentals/config', () => ({
  config: {
    jwtSecret: 'test-jwt-secret',
    port: 3000,
    db: { host: 'localhost', port: 3306, username: 'root', password: '', database: 'test' },
    ollamaBaseUrl: 'http://localhost:11434',
    chromaUrl: 'http://localhost:8000',
    chromaHost: 'localhost',
    chromaPort: 8000,
    serverBaseUrl: 'http://localhost:3000',
    deepseekBaseUrl: 'https://api.deepseek.com',
    zhipuBaseUrl: '',
    dashscopeBaseUrl: '',
    dashscopeApiKey: '',
    logLevel: 'info',
    searchApiUrl: '',
    searchApiKey: '',
    qweatherApiKey: '',
    qweatherApiBase: '',
    lokiHost: '',
    corsOrigins: ['http://localhost:5173'],
  },
}));

/* =====================================================================
 * Mock @nestjs/typeorm — InjectRepository 直接返回 mock
 * ==================================================================*/
const mockRepos: Record<string, any> = {};
function getMockRepo(name: string) {
  if (!mockRepos[name]) {
    mockRepos[name] = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
  }
  return mockRepos[name];
}

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (target: any, key: string, index: number) => {},
  getRepositoryToken: () => 'mockRepo',
}));

/* =====================================================================
 * 导入被测模块
 * ==================================================================*/
import { SessionService } from './session.service';
import { NotFoundException } from '@nestjs/common';

const mockSummaryService = {
  checkAndUpdateSummary: jest.fn().mockResolvedValue(undefined),
};
const mockMemoryService = {
  checkAndExtractMemories: jest.fn().mockResolvedValue(undefined),
};

describe('SessionService', () => {
  /* ====================================================================
   * 测试辅助：直接构造 SessionService 实例
   * ==================================================================*/
  function createService() {
    return new SessionService(
      getMockRepo('chatHistory'),
      getMockRepo('session'),
      getMockRepo('sessionSummary'),
      getMockRepo('llmUsage'),
      getMockRepo('messageFeedback'),
      getMockRepo('autoEvaluation'),
      getMockRepo('generatedDocument'),
      mockSummaryService as any,
      mockMemoryService as any,
    );
  }

  beforeEach(() => {
    Object.keys(mockRepos).forEach((k) => {
      const r = mockRepos[k];
      Object.keys(r).forEach((m) => r[m].mockClear?.());
    });
    mockSummaryService.checkAndUpdateSummary.mockClear();
    mockMemoryService.checkAndExtractMemories.mockClear();
  });

  /* ====================================================================
   * saveChatHistory
   * ==================================================================*/
  describe('saveChatHistory', () => {
    const chatRepo = getMockRepo('chatHistory');
    const sessionRepo = getMockRepo('session');

    it('首次聊天时应创建新会话', async () => {
      const service = createService();
      chatRepo.create.mockReturnValue({ id: 1 });
      chatRepo.save.mockResolvedValue({ id: 1 });
      sessionRepo.findOne.mockResolvedValue(null);
      sessionRepo.create.mockReturnValue({});
      sessionRepo.save.mockResolvedValue({});

      await service.saveChatHistory('s1', 'user', 'hello', 'u1');

      expect(sessionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', title: 'hello' }),
      );
      expect(sessionRepo.save).toHaveBeenCalled();
    });

    it('已有会话时应更新 updatedAt', async () => {
      const service = createService();
      chatRepo.create.mockReturnValue({ id: 1 });
      chatRepo.save.mockResolvedValue({ id: 1 });
      sessionRepo.findOne.mockResolvedValue({ sessionId: 's1' });

      await service.saveChatHistory('s1', 'user', 'msg', 'u1');

      expect(sessionRepo.update).toHaveBeenCalledWith(
        { sessionId: 's1' },
        expect.objectContaining({ updatedAt: expect.any(Date) }),
      );
    });

    it('assistant 消息应触发摘要和记忆检查（异步）', async () => {
      const service = createService();
      chatRepo.create.mockReturnValue({ id: 1 });
      chatRepo.save.mockResolvedValue({ id: 1 });
      sessionRepo.findOne.mockResolvedValue({ sessionId: 's1' });

      await service.saveChatHistory('s1', 'assistant', 'reply', 'u1');

      expect(mockSummaryService.checkAndUpdateSummary).toHaveBeenCalledWith('s1', 'u1');
      expect(mockMemoryService.checkAndExtractMemories).toHaveBeenCalledWith('s1', 'u1');
    });
  });

  /* ====================================================================
   * getSessionHistory
   * ==================================================================*/
  describe('getSessionHistory', () => {
    it('应按创建时间升序返回消息', async () => {
      const service = createService();
      const repo = getMockRepo('chatHistory');
      const docRepo = getMockRepo('generatedDocument');
      const msgs = [
        { id: 1, role: 'user', createdAt: new Date('2024-01-01T00:00:00Z') },
        { id: 2, role: 'assistant', createdAt: new Date('2024-01-01T00:00:01Z') },
      ];
      repo.find.mockResolvedValue(msgs);
      // 没有附件场景：返回空数组，确保不影响消息顺序断言
      docRepo.find.mockResolvedValue([]);

      const result = await service.getSessionHistory('s1');
      expect(result).toEqual(msgs.map((m) => ({ ...m, attachments: [] })));
      expect(repo.find).toHaveBeenCalledWith({
        where: { sessionId: 's1' },
        order: { createdAt: 'ASC' },
      });
    });
  });

  /* ====================================================================
   * getSessions
   * ==================================================================*/
  describe('getSessions', () => {
    it('应返回会话列表（置顶优先）', async () => {
      const service = createService();
      const repo = getMockRepo('session');
      repo.find.mockResolvedValue([{ id: 1 }]);

      await service.getSessions('u1');
      expect(repo.find).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        order: { isPinned: 'DESC', updatedAt: 'DESC' },
      });
    });
  });

  /* ====================================================================
   * createSession
   * ==================================================================*/
  describe('createSession', () => {
    it('应创建并保存会话', async () => {
      const service = createService();
      const repo = getMockRepo('session');
      const s = { sessionId: 'new' };
      repo.create.mockReturnValue(s);
      repo.save.mockResolvedValue(s);

      await service.createSession('new', 'Title', 'u1');
      expect(repo.create).toHaveBeenCalledWith({
        sessionId: 'new', title: 'Title', userId: 'u1',
      });
    });
  });

  /* ====================================================================
   * deleteSession
   * ==================================================================*/
  describe('deleteSession', () => {
    it('删除会话时应清理 6 张关联表', async () => {
      const service = createService();
      Object.values(mockRepos).forEach((r) => r.delete?.mockResolvedValue({}));

      await service.deleteSession('s1', 'u1');

      expect(getMockRepo('sessionSummary').delete).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(getMockRepo('llmUsage').delete).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(getMockRepo('messageFeedback').delete).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(getMockRepo('autoEvaluation').delete).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(getMockRepo('chatHistory').delete).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(getMockRepo('session').delete).toHaveBeenCalledWith({
        sessionId: 's1', userId: 'u1',
      });
    });
  });

  /* ====================================================================
   * toggleSessionPin
   * ==================================================================*/
  describe('toggleSessionPin', () => {
    it('应翻转 isPinned', async () => {
      const service = createService();
      const repo = getMockRepo('session');
      const s = { sessionId: 's1', isPinned: false };
      repo.findOne.mockResolvedValue(s);

      await service.toggleSessionPin('s1');
      expect(s.isPinned).toBe(true);
    });

    it('会话不存在时返回 null', async () => {
      const service = createService();
      getMockRepo('session').findOne.mockResolvedValue(null);
      const result = await service.toggleSessionPin('ghost');
      expect(result).toBeNull();
    });
  });

  /* ====================================================================
   * 标签和分类
   * ==================================================================*/
  describe('标签和分类', () => {
    it('getSessionsByTag 应过滤标签', async () => {
      const service = createService();
      getMockRepo('session').find.mockResolvedValue([
        { tags: ['ai'] },
        { tags: ['code'] },
        { tags: ['ai', 'chat'] },
      ]);
      const result = await service.getSessionsByTag('ai');
      expect(result).toHaveLength(2);
    });

    it('getAllTags 应去重返回所有标签', async () => {
      const service = createService();
      getMockRepo('session').find.mockResolvedValue([
        { tags: ['ai', 'code'] },
        { tags: ['code', 'chat'] },
        { tags: null },
      ]);
      const result = await service.getAllTags('u1');
      expect(result.sort()).toEqual(['ai', 'chat', 'code'].sort());
    });
  });

  /* ====================================================================
   * 消息操作
   * ==================================================================*/
  describe('消息操作', () => {
    it('updateMessage 应更新消息', async () => {
      const service = createService();
      const repo = getMockRepo('chatHistory');
      await service.updateMessage('42', 'new');
      expect(repo.update).toHaveBeenCalledWith({ id: 42 }, { content: 'new' });
    });
  });

  /* ====================================================================
   * duplicateSession
   * ==================================================================*/
  describe('duplicateSession', () => {
    it('应复制会话及消息', async () => {
      const service = createService();
      const sessionRepo = getMockRepo('session');
      const chatRepo = getMockRepo('chatHistory');

      sessionRepo.findOne.mockResolvedValue({ sessionId: 'orig', title: 'O' });
      sessionRepo.save.mockResolvedValue({});
      chatRepo.find.mockResolvedValue([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
      chatRepo.create.mockReturnValue({});
      chatRepo.save.mockResolvedValue({});

      await service.duplicateSession('orig', 'u1');
      expect(chatRepo.create).toHaveBeenCalledTimes(2);
      expect(chatRepo.save).toHaveBeenCalledTimes(2);
    });

    it('原会话不存在时抛出 NotFound', async () => {
      const service = createService();
      getMockRepo('session').findOne.mockResolvedValue(null);
      await expect(service.duplicateSession('ghost')).rejects.toThrow(NotFoundException);
    });
  });

  /* ====================================================================
   * exportSession
   * ==================================================================*/
  describe('exportSession', () => {
    it('导出 JSON 格式', async () => {
      const service = createService();
      getMockRepo('session').findOne.mockResolvedValue({
        sessionId: 's1', title: 'T', createdAt: new Date(), updatedAt: new Date(),
      });
      getMockRepo('chatHistory').find.mockResolvedValue([
        { role: 'user', content: 'hi', createdAt: new Date('2025-01-01') },
      ]);
      const result = await service.exportSession('s1', 'json');
      expect(result.messages).toHaveLength(1);
      expect(result.filename).toContain('.json');
    });

    it('导出 markdown 格式', async () => {
      const service = createService();
      getMockRepo('session').findOne.mockResolvedValue({
        sessionId: 's1', title: 'My Chat', createdAt: new Date(), updatedAt: new Date(),
      });
      getMockRepo('chatHistory').find.mockResolvedValue([
        { role: 'user', content: '你好', createdAt: new Date() },
      ]);
      const result = await service.exportSession('s1', 'markdown');
      expect(result.content).toContain('# My Chat');
      expect(result.content).toContain('你好');
      expect(result.filename).toContain('.md');
    });

    it('会话不存在时抛出 NotFound', async () => {
      const service = createService();
      getMockRepo('session').findOne.mockResolvedValue(null);
      await expect(service.exportSession('ghost')).rejects.toThrow(NotFoundException);
    });
  });
});
