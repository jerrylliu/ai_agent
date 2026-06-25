/**
 * controllers/chat.controller.spec.ts
 *
 * ChatController 单元测试
 * 覆盖：会话 CRUD / 消息管理 / 统计 / 标签分类 / 确认 / 反馈 / 导出
 *
 * Mock 策略：mock 全部 5 个注入 Service + AppService（防止 ESM 链式加载崩溃）
 */

// 在任何 import 之前注入测试用环境变量，避免 fundamentals/config.ts 启动校验失败
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

/* =====================================================================
 * Mock 所有链式依赖，防止 ESM 加载崩溃
 * ==================================================================*/

// logger
jest.mock('../fundamentals/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// guards
jest.mock('../auth/optional-auth.guard', () => {
  class MockOptionalAuthGuard {
    canActivate(ctx: any) {
      const req = ctx.switchToHttp().getRequest();
      if (!req.userId) req.userId = 'u1';
      return true;
    }
  }
  return { OptionalAuthGuard: MockOptionalAuthGuard };
});

// human-in-the-loop
jest.mock('../fundamentals/human-in-the-loop', () => ({
  handleConfirmationResponse: jest.fn().mockReturnValue(true),
}));

// AppService（防止其导入链触发 ESM 崩溃）
jest.mock('../app.service', () => ({
  AppService: class {
    prompt = jest.fn().mockResolvedValue(undefined);
    rag = jest.fn().mockResolvedValue([]);
  },
}));

// SessionService
jest.mock('../services/session.service', () => {
  return {
    SessionService: class {
      saveChatHistory = jest.fn().mockResolvedValue({});
      getSessionHistory = jest.fn().mockResolvedValue([]);
      getAllChatHistory = jest.fn().mockResolvedValue([]);
      getSessions = jest.fn().mockResolvedValue([]);
      createSession = jest.fn().mockResolvedValue({});
      deleteSession = jest.fn().mockResolvedValue({});
      toggleSessionPin = jest.fn().mockResolvedValue({});
      exportSession = jest.fn().mockResolvedValue({ content: '', filename: 'x.json', messages: [] });
      getSessionBySessionId = jest.fn().mockResolvedValue({});
      updateSessionTitle = jest.fn().mockResolvedValue({});
      updateMessage = jest.fn().mockResolvedValue({});
      deleteMessage = jest.fn().mockResolvedValue({});
      updateSessionTags = jest.fn().mockResolvedValue({});
      updateSessionCategory = jest.fn().mockResolvedValue({});
      getSessionsByTag = jest.fn().mockResolvedValue([]);
      getSessionsByCategory = jest.fn().mockResolvedValue([]);
      getAllTags = jest.fn().mockResolvedValue([]);
      duplicateSession = jest.fn().mockResolvedValue({});
    },
  };
});

// UsageService
jest.mock('../services/usage.service', () => ({
  UsageService: class { getLlmUsageStats = jest.fn().mockResolvedValue({}); },
}));

// EvaluationService
jest.mock('../services/evaluation.service', () => ({
  EvaluationService: class {
    submitFeedback = jest.fn().mockResolvedValue({});
    getEvaluationStats = jest.fn().mockResolvedValue({});
  },
}));

// ToolUsageService
jest.mock('../services/tool-usage.service', () => ({
  ToolUsageService: class { getToolUsageStats = jest.fn().mockResolvedValue({}); },
}));

// GeneratedDocumentService（防止 ESM 链式加载到 fundamentals/config.ts）
jest.mock('../services/generated-document.service', () => ({
  GeneratedDocumentService: class {
    save = jest.fn().mockResolvedValue({});
    read = jest.fn().mockResolvedValue(null);
    list = jest.fn().mockResolvedValue([]);
    listRecentBySession = jest.fn().mockResolvedValue([]);
    toggleFavorite = jest.fn().mockResolvedValue({});
    delete = jest.fn().mockResolvedValue({});
  },
}));

const mockFindFeishuChatSessionBySessionId = jest.fn();
const mockDeleteFeishuChatSessionBySessionId = jest.fn();
const mockSendPlainTextMessage = jest.fn();
const mockUploadImage = jest.fn();
const mockSendImageMessage = jest.fn();

jest.mock('../fundamentals/feishu/feishu-chat-session.js', () => ({
  findFeishuChatSessionBySessionId: (...args: unknown[]) => mockFindFeishuChatSessionBySessionId(...args),
  deleteFeishuChatSessionBySessionId: (...args: unknown[]) => mockDeleteFeishuChatSessionBySessionId(...args),
}));

jest.mock('../fundamentals/feishu-notify.service.js', () => ({
  sendPlainTextMessage: (...args: unknown[]) => mockSendPlainTextMessage(...args),
  uploadImage: (...args: unknown[]) => mockUploadImage(...args),
  sendImageMessage: (...args: unknown[]) => mockSendImageMessage(...args),
}));

jest.mock('../fundamentals/chat-event-bus.js', () => ({
  subscribeChatHistoryEvents: jest.fn(() => () => {}),
}));

jest.mock('../auth/auth.service', () => ({
  AuthService: class {
    verifyToken = jest.fn().mockReturnValue(null);
    getUserById = jest.fn().mockResolvedValue(null);
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from './chat.controller';
import { AppService } from '../app.service';
import { SessionService } from '../services/session.service';
import { UsageService } from '../services/usage.service';
import { EvaluationService } from '../services/evaluation.service';
import { ToolUsageService } from '../services/tool-usage.service';
import { GeneratedDocumentService } from '../services/generated-document.service';
import { AuthService } from '../auth/auth.service';

describe('ChatController', () => {
  let controller: ChatController;
  let sessionService: any;
  let usageService: any;
  let evaluationService: any;
  let toolUsageService: any;
  let appService: any;

  beforeEach(async () => {
    mockFindFeishuChatSessionBySessionId.mockReset();
    mockDeleteFeishuChatSessionBySessionId.mockReset();
    mockSendPlainTextMessage.mockReset();
    mockUploadImage.mockReset();
    mockSendImageMessage.mockReset();
    mockFindFeishuChatSessionBySessionId.mockResolvedValue(null);
    mockDeleteFeishuChatSessionBySessionId.mockResolvedValue(undefined);
    mockSendPlainTextMessage.mockResolvedValue({ success: true });
    mockUploadImage.mockResolvedValue({ success: true, key: 'img_key_1' });
    mockSendImageMessage.mockResolvedValue({ success: true });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: AppService, useValue: new (AppService as any)() },
        { provide: SessionService, useValue: new (SessionService as any)() },
        { provide: UsageService, useValue: new (UsageService as any)() },
        { provide: EvaluationService, useValue: new (EvaluationService as any)() },
        { provide: ToolUsageService, useValue: new (ToolUsageService as any)() },
        { provide: GeneratedDocumentService, useValue: new (GeneratedDocumentService as any)() },
        { provide: AuthService, useValue: new (AuthService as any)() },
      ],
    }).compile();

    controller = module.get<ChatController>(ChatController);
    appService = module.get(AppService);
    sessionService = module.get(SessionService);
    usageService = module.get(UsageService);
    evaluationService = module.get(EvaluationService);
    toolUsageService = module.get(ToolUsageService);
  });

  /* ====================================================================
   * 会话管理
   * ==================================================================*/
  describe('getSessions', () => {
    it('应委托 SessionService.getSessions', async () => {
      await controller.getSessions({ userId: 'u1' });
      expect(sessionService.getSessions).toHaveBeenCalledWith('u1');
    });
  });

  describe('createSession', () => {
    it('应委托 SessionService.createSession', async () => {
      await controller.createSession({ sessionId: 's1', title: 'T' }, { userId: 'u1' });
      expect(sessionService.createSession).toHaveBeenCalledWith('s1', 'T', 'u1');
    });
  });

  describe('deleteSession', () => {
    it('应委托 SessionService.deleteSession 并清理飞书映射', async () => {
      await controller.deleteSession('s1', { userId: 'u1' });
      expect(sessionService.deleteSession).toHaveBeenCalledWith('s1', 'u1');
      expect(mockDeleteFeishuChatSessionBySessionId).toHaveBeenCalledWith('s1', 'u1');
    });
  });

  describe('toggleSessionPin', () => {
    it('应委托 SessionService.toggleSessionPin', async () => {
      await controller.toggleSessionPin('s1', { userId: 'u1' });
      expect(sessionService.toggleSessionPin).toHaveBeenCalledWith('s1', 'u1');
    });
  });

  describe('updateSessionTitle', () => {
    it('应委托 SessionService.updateSessionTitle', async () => {
      await controller.updateSessionTitle('s1', { title: 'New' }, { userId: 'u1' });
      expect(sessionService.updateSessionTitle).toHaveBeenCalledWith('s1', 'New', 'u1');
    });
  });

  describe('duplicateSession', () => {
    it('应委托 SessionService.duplicateSession', async () => {
      await controller.duplicateSession('s1', { userId: 'u1' });
      expect(sessionService.duplicateSession).toHaveBeenCalledWith('s1', 'u1');
    });
  });

  /* ====================================================================
   * 聊天记录
   * ==================================================================*/
  describe('saveChatHistory', () => {
    it('应委托 SessionService.saveChatHistory（无 documentCards）', async () => {
      await controller.saveChatHistory(
        { sessionId: 's1', role: 'user', content: 'hi' },
        { userId: 'u1' },
      );
      // 第五个参数 documentCards 未传时为 undefined
      expect(sessionService.saveChatHistory).toHaveBeenCalledWith('s1', 'user', 'hi', 'u1', undefined);
    });

    it('应把 documentCards 透传给 SessionService', async () => {
      const cards = [{ id: 'c1', fileName: 'test.docx', sizeBytes: 1024 }];
      await controller.saveChatHistory(
        { sessionId: 's2', role: 'user', content: 'hello', documentCards: cards },
        { userId: 'u2' },
      );
      expect(sessionService.saveChatHistory).toHaveBeenCalledWith('s2', 'user', 'hello', 'u2', cards);
    });

    it('普通 Web 会话不应同步到飞书', async () => {
      await controller.saveChatHistory(
        { sessionId: 'normal-session', role: 'user', content: 'hi' },
        { userId: 'u1' },
      );
      await Promise.resolve();

      expect(mockFindFeishuChatSessionBySessionId).toHaveBeenCalledWith('normal-session');
      expect(mockSendPlainTextMessage).not.toHaveBeenCalled();
    });

    it('飞书私聊映射会话应把 Web user 消息同步到 sender open_id', async () => {
      mockFindFeishuChatSessionBySessionId.mockResolvedValue({
        ownerUserId: 'u1',
        chatType: 'p2p',
        chatId: 'p2p:ou_1',
        senderOpenId: 'ou_1',
      });

      await controller.saveChatHistory(
        { sessionId: 'feishu-session', role: 'user', content: '继续聊' },
        { userId: 'u1' },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendPlainTextMessage).toHaveBeenCalledWith(
        'ou_1',
        'open_id',
        '来自 Web 端的消息：\n继续聊',
        expect.any(String),
      );
    });

    it('飞书群聊映射会话应把 assistant 回复同步到 chat_id', async () => {
      mockFindFeishuChatSessionBySessionId.mockResolvedValue({
        ownerUserId: 'u1',
        chatType: 'group',
        chatId: 'oc_1',
        senderOpenId: 'ou_1',
      });

      await controller.saveChatHistory(
        { sessionId: 'feishu-session', role: 'assistant', content: 'AI 回复' },
        { userId: 'u1' },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendPlainTextMessage).toHaveBeenCalledWith(
        'oc_1',
        'chat_id',
        'AI 回复',
        expect.any(String),
      );
    });

    it('assistant 回复包含 Markdown 图片时应同步为飞书原生图片', async () => {
      mockFindFeishuChatSessionBySessionId.mockResolvedValue({
        ownerUserId: 'u1',
        chatType: 'p2p',
        chatId: 'p2p:ou_1',
        senderOpenId: 'ou_1',
      });

      await controller.saveChatHistory(
        { sessionId: 'feishu-session', role: 'assistant', content: '生成好了\n![星空](https://example.com/star.png)' },
        { userId: 'u1' },
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendPlainTextMessage).toHaveBeenCalledWith('ou_1', 'open_id', '生成好了', expect.any(String));
      expect(mockUploadImage).toHaveBeenCalledWith('https://example.com/star.png');
      expect(mockSendImageMessage).toHaveBeenCalledWith('ou_1', 'open_id', 'img_key_1', expect.any(String));
    });

    it('群聊 assistant 回复包含 Markdown 图片时应同步为群内原生图片', async () => {
      mockFindFeishuChatSessionBySessionId.mockResolvedValue({
        ownerUserId: 'u1',
        chatType: 'group',
        chatId: 'oc_group_1',
        senderOpenId: 'ou_1',
      });

      await controller.saveChatHistory(
        { sessionId: 'feishu-group-session', role: 'assistant', content: '生成好了\n![星空](https://example.com/group-star.png)' },
        { userId: 'u1' },
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendPlainTextMessage).toHaveBeenCalledWith('oc_group_1', 'chat_id', '生成好了', expect.any(String));
      expect(mockUploadImage).toHaveBeenCalledWith('https://example.com/group-star.png');
      expect(mockSendImageMessage).toHaveBeenCalledWith('oc_group_1', 'chat_id', 'img_key_1', expect.any(String));
    });

    it('飞书图片上传失败时应降级发送图片链接', async () => {
      mockFindFeishuChatSessionBySessionId.mockResolvedValue({
        ownerUserId: 'u1',
        chatType: 'p2p',
        chatId: 'p2p:ou_1',
        senderOpenId: 'ou_1',
      });
      mockUploadImage.mockResolvedValue({ success: false, error: 'download failed' });

      await controller.saveChatHistory(
        { sessionId: 'feishu-session', role: 'assistant', content: '![星空](https://example.com/star.png)' },
        { userId: 'u1' },
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendPlainTextMessage).toHaveBeenCalledWith('ou_1', 'open_id', 'AI 生成了内容：', expect.any(String));
      expect(mockSendPlainTextMessage).toHaveBeenCalledWith('ou_1', 'open_id', 'https://example.com/star.png', expect.any(String));
    });

    it('飞书映射 owner 不匹配时不应同步到飞书', async () => {
      mockFindFeishuChatSessionBySessionId.mockResolvedValue({
        ownerUserId: 'other-user',
        chatType: 'p2p',
        chatId: 'p2p:ou_1',
        senderOpenId: 'ou_1',
      });

      await controller.saveChatHistory(
        { sessionId: 'feishu-session', role: 'user', content: '越权消息' },
        { userId: 'u1' },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendPlainTextMessage).not.toHaveBeenCalled();
    });

    it('owner 为数字而映射存字符串时仍应判定为同一用户并同步', async () => {
      mockFindFeishuChatSessionBySessionId.mockResolvedValue({
        ownerUserId: '15',
        chatType: 'p2p',
        chatId: 'p2p:ou_1',
        senderOpenId: 'ou_1',
      });

      await controller.saveChatHistory(
        { sessionId: 'feishu-session', role: 'user', content: '继续聊' },
        { userId: 15 },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendPlainTextMessage).toHaveBeenCalledWith(
        'ou_1',
        'open_id',
        '来自 Web 端的消息：\n继续聊',
        expect.any(String),
      );
    });
  });

  describe('getSessionHistory', () => {
    it('应委托 SessionService.getSessionHistory', async () => {
      await controller.getSessionHistory('s1');
      expect(sessionService.getSessionHistory).toHaveBeenCalledWith('s1');
    });
  });

  describe('getAllChatHistory', () => {
    it('应委托 SessionService.getAllChatHistory', async () => {
      await controller.getAllChatHistory();
      expect(sessionService.getAllChatHistory).toHaveBeenCalled();
    });
  });

  /* ====================================================================
   * 消息管理
   * ==================================================================*/
  describe('updateMessage', () => {
    it('应委托 SessionService.updateMessage', async () => {
      await controller.updateMessage('42', { content: 'new' });
      expect(sessionService.updateMessage).toHaveBeenCalledWith('42', 'new');
    });
  });

  describe('deleteMessage', () => {
    it('应委托 SessionService.deleteMessage', async () => {
      await controller.deleteMessage('42');
      expect(sessionService.deleteMessage).toHaveBeenCalledWith('42');
    });
  });

  /* ====================================================================
   * 导出
   * ==================================================================*/
  describe('exportSession', () => {
    it('应委托 SessionService.exportSession', async () => {
      await controller.exportSession('s1', 'json');
      expect(sessionService.exportSession).toHaveBeenCalledWith('s1', 'json');
    });

    it('默认格式为 json', async () => {
      await controller.exportSession('s1', undefined as any);
      expect(sessionService.exportSession).toHaveBeenCalledWith('s1', 'json');
    });
  });

  /* ====================================================================
   * getSessionBySessionId / getSessionMessages
   * ==================================================================*/
  describe('getSessionBySessionId', () => {
    it('应委托 SessionService.getSessionBySessionId', async () => {
      await controller.getSessionBySessionId('s1');
      expect(sessionService.getSessionBySessionId).toHaveBeenCalledWith('s1');
    });
  });

  describe('getSessionMessages', () => {
    it('应委托 SessionService.getSessionHistory', async () => {
      await controller.getSessionMessages('s1');
      expect(sessionService.getSessionHistory).toHaveBeenCalledWith('s1');
    });
  });

  /* ====================================================================
   * RAG / 统计 / 反馈 / 确认
   * ==================================================================*/
  describe('rag', () => {
    it('应委托 AppService.rag', async () => {
      await controller.rag({ message: 'test' });
      expect(appService.rag).toHaveBeenCalledWith('test');
    });
  });

  describe('getLlmUsageStats', () => {
    it('应委托 UsageService.getLlmUsageStats（默认 7 天）', async () => {
      await controller.getLlmUsageStats('7', { userId: 'u1' });
      expect(usageService.getLlmUsageStats).toHaveBeenCalledWith('u1', 7);
    });

    it('无效 days 应回退为 7', async () => {
      await controller.getLlmUsageStats('xyz', { userId: 'u1' });
      expect(usageService.getLlmUsageStats).toHaveBeenCalledWith('u1', 7);
    });
  });

  describe('getEvaluationStats', () => {
    it('应委托 EvaluationService.getEvaluationStats', async () => {
      await controller.getEvaluationStats('30', { userId: 'u1' });
      expect(evaluationService.getEvaluationStats).toHaveBeenCalledWith('u1', 30);
    });
  });

  describe('getToolUsageStats', () => {
    it('应委托 ToolUsageService.getToolUsageStats', async () => {
      await controller.getToolUsageStats('14', { userId: 'u1' });
      expect(toolUsageService.getToolUsageStats).toHaveBeenCalledWith('u1', 14);
    });
  });

  describe('submitFeedback', () => {
    it('应委托 EvaluationService.submitFeedback', async () => {
      await controller.submitFeedback({
        sessionId: 's1', userMessage: 'Q', assistantMessage: 'A', rating: 'positive',
      }, { userId: 'u1' });
      expect(evaluationService.submitFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', sessionId: 's1', rating: 'positive' }),
      );
    });
  });

  describe('handleConfirmation', () => {
    it('应委托 handleConfirmationResponse', async () => {
      const { handleConfirmationResponse } = require('../fundamentals/human-in-the-loop');
      const r = await controller.handleConfirmation({ confirmationId: 'c1', confirmed: true });
      expect(handleConfirmationResponse).toHaveBeenCalledWith('c1', true);
      expect(r.success).toBe(true);
    });
  });

  /* ====================================================================
   * 标签和分类
   * ==================================================================*/
  describe('updateSessionTags', () => {
    it('应委托 SessionService.updateSessionTags', async () => {
      await controller.updateSessionTags('s1', { tags: ['ai'] }, { userId: 'u1' });
      expect(sessionService.updateSessionTags).toHaveBeenCalledWith('s1', ['ai'], 'u1');
    });
  });

  describe('updateSessionCategory', () => {
    it('应委托 SessionService.updateSessionCategory', async () => {
      await controller.updateSessionCategory('s1', { category: 'work' }, { userId: 'u1' });
      expect(sessionService.updateSessionCategory).toHaveBeenCalledWith('s1', 'work', 'u1');
    });
  });

  describe('getSessionsByTag', () => {
    it('应委托 SessionService.getSessionsByTag', async () => {
      await controller.getSessionsByTag('ai', { userId: 'u1' });
      expect(sessionService.getSessionsByTag).toHaveBeenCalledWith('ai', 'u1');
    });
  });

  describe('getSessionsByCategory', () => {
    it('应委托 SessionService.getSessionsByCategory', async () => {
      await controller.getSessionsByCategory('work', { userId: 'u1' });
      expect(sessionService.getSessionsByCategory).toHaveBeenCalledWith('work', 'u1');
    });
  });

  describe('getAllTags', () => {
    it('应委托 SessionService.getAllTags', async () => {
      await controller.getAllTags({ userId: 'u1' });
      expect(sessionService.getAllTags).toHaveBeenCalledWith('u1');
    });
  });
});
