/**
 * controllers/chat.controller.spec.ts
 *
 * ChatController 单元测试
 * 覆盖：会话 CRUD / 消息管理 / 统计 / 标签分类 / 确认 / 反馈 / 导出
 *
 * Mock 策略：mock 全部 5 个注入 Service + AppService（防止 ESM 链式加载崩溃）
 */

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

import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from './chat.controller';
import { AppService } from '../app.service';
import { SessionService } from '../services/session.service';
import { UsageService } from '../services/usage.service';
import { EvaluationService } from '../services/evaluation.service';
import { ToolUsageService } from '../services/tool-usage.service';

describe('ChatController', () => {
  let controller: ChatController;
  let sessionService: any;
  let usageService: any;
  let evaluationService: any;
  let toolUsageService: any;
  let appService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: AppService, useValue: new (AppService as any)() },
        { provide: SessionService, useValue: new (SessionService as any)() },
        { provide: UsageService, useValue: new (UsageService as any)() },
        { provide: EvaluationService, useValue: new (EvaluationService as any)() },
        { provide: ToolUsageService, useValue: new (ToolUsageService as any)() },
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
    it('应委托 SessionService.deleteSession', async () => {
      await controller.deleteSession('s1', { userId: 'u1' });
      expect(sessionService.deleteSession).toHaveBeenCalledWith('s1', 'u1');
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
    it('应委托 SessionService.saveChatHistory', async () => {
      await controller.saveChatHistory(
        { sessionId: 's1', role: 'user', content: 'hi' },
        { userId: 'u1' },
      );
      expect(sessionService.saveChatHistory).toHaveBeenCalledWith('s1', 'user', 'hi', 'u1');
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
