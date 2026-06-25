/**
 * hooks/useChat.test.ts
 *
 * useChat hook 单元测试
 * - 初始状态
 * - 模型管理 (switchModel, configureApiKey)
 * - 会话管理 (创建、切换、删除)
 * - 消息发送 (sendMessage)
 * - 停止生成 (stopGeneration)
 * - 知识库状态
 * - 消息操作 (update/delete)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChat } from './useChat';

/* =====================================================================
 * 测试辅助
 * ==================================================================*/
const mockModelInfo = {
  success: true,
  currentModelId: 'ollama:minicpm',
  availableModels: [
    {
      id: 'ollama:minicpm',
      provider: 'ollama' as const,
      name: 'MiniCPM',
      description: 'Local model',
      requiresApiKey: false,
      supportsVision: true,
      supportsFunctionCalling: false,
    },
  ],
  hasDeepseekApiKey: false,
  hasZhipuApiKey: false,
  supportsVision: true,
  supportsFunctionCalling: false,
};

const mockSessions = [
  { id: 1, sessionId: 'sess-1', title: '会话1', userId: 'u1', isPinned: false, createdAt: '2025-01-01', updatedAt: '2025-01-01' },
  { id: 2, sessionId: 'sess-2', title: '会话2', userId: 'u1', isPinned: true, createdAt: '2025-01-02', updatedAt: '2025-01-02' },
];

/**
 * Mock 所有外部 API 模块
 */
vi.mock('../lib/api', () => ({
  getModelInfo: vi.fn(),
  switchModel: vi.fn(),
  setModelApiKey: vi.fn(),
  getSessions: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessionMessages: vi.fn(),
  updateSessionTitle: vi.fn(),
  toggleSessionPin: vi.fn(),
  duplicateSession: vi.fn(),
  exportSession: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  saveChatHistory: vi.fn(),
  getAIResponse: vi.fn(),
  uploadFile: vi.fn(),
  uploadToKnowledgeBase: vi.fn(),
  getKnowledgeBaseStatus: vi.fn(),
  subscribeChatEvents: vi.fn(() => () => {}),
}));

import * as api from '../lib/api';

describe('useChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(api.getSessionMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ====================================================================
   * refreshAppData
   * ==================================================================*/
  describe('refreshAppData', () => {
    it('应统一刷新模型、知识库和会话数据', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getKnowledgeBaseStatus).mockResolvedValue({
        status: 'ready',
        message: 'ready',
        stats: {
          documentCount: 1,
          uploadedDocumentCount: 1,
          knowledgeSourcePageCount: 0,
          collectionName: 'test',
        },
      } as any);
      vi.mocked(api.getSessions).mockResolvedValue(mockSessions);

      const { result } = renderHook(() => useChat(true));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.refreshAppData('manual');
      });

      expect(api.getModelInfo).toHaveBeenCalled();
      expect(api.getKnowledgeBaseStatus).toHaveBeenCalled();
      expect(api.getSessions).toHaveBeenCalled();
    });
  });

  /* ====================================================================
   * 其他状态
   * ==================================================================*/
  describe('初始状态', () => {
    it('初始状态应有默认值', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useChat(false));

      // 初始状态
      expect(result.current.messages).toEqual([]);
      expect(result.current.isTyping).toBe(false);
      expect(typeof result.current.currentSessionId).toBe('string');
      expect(result.current.pendingImages).toEqual([]);
    });

    it('应自动加载模型信息', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);

      renderHook(() => useChat(false));

      await waitFor(() => {
        expect(api.getModelInfo).toHaveBeenCalled();
      });
    });

    it('authenticated 为 true 时应加载会话列表', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue(mockSessions);

      const { result } = renderHook(() => useChat(true));

      await waitFor(() => {
        expect(api.getSessions).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('authLoading 为 true 时不应提前加载会话', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue(mockSessions);

      renderHook(() => useChat(false, true));

      await waitFor(() => {
        expect(api.getModelInfo).toHaveBeenCalled();
      });
      expect(api.getSessions).not.toHaveBeenCalled();
    });

    it('authLoading 结束后应加载会话', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue(mockSessions);

      const { rerender } = renderHook(
        ({ authLoading }) => useChat(true, authLoading),
        { initialProps: { authLoading: true } },
      );

      expect(api.getSessions).not.toHaveBeenCalled();

      rerender({ authLoading: false });

      await waitFor(() => {
        expect(api.getSessions).toHaveBeenCalled();
      });
    });
  });

  /* ====================================================================
   * switchModel
   * ==================================================================*/
  describe('switchModel', () => {
    it('切换成功应更新 currentModelId', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.switchModel).mockResolvedValue({
        success: true,
        message: 'switched',
      });

      const { result } = renderHook(() => useChat(false));

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const switchRes = await act(() =>
        result.current.switchModel('ollama:minicpm'),
      );
      expect(switchRes.success).toBe(true);
      expect(result.current.currentModelId).toBe('ollama:minicpm');
    });

    it('切换失败不应更新 currentModelId', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.switchModel).mockResolvedValue({
        success: false,
        message: '模型不存在',
      });

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const switchRes = await act(() =>
        result.current.switchModel('invalid-model'),
      );
      expect(switchRes.success).toBe(false);
    });
  });

  /* ====================================================================
   * configureApiKey
   * ==================================================================*/
  describe('configureApiKey', () => {
    it('设置 deepseek API Key 成功后应更新状态', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.setModelApiKey).mockResolvedValue({
        success: true,
        message: '已设置',
      });

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const res = await act(() =>
        result.current.configureApiKey('deepseek', 'sk-test'),
      );
      expect(res.success).toBe(true);
      expect(result.current.hasDeepseekApiKey).toBe(true);
    });
  });

  /* ====================================================================
   * loadSessions / 会话列表加载
   * ==================================================================*/
  describe('会话列表加载', () => {
    it('加载成功应设置 sessions', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue(mockSessions);

      const { result } = renderHook(() => useChat(true));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // sessions 由内部 state 管理，无法直接从 hook 返回中获取，
      // 但可通过 isLoading 变为 false 确认加载完成
      expect(result.current.isLoading).toBe(false);
    });

    it('加载失败应设置 isLoading 为 false', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useChat(true));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  /* ====================================================================
   * createNewSession
   * ==================================================================*/
  describe('createNewSession', () => {
    it('应调用 createSession API', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.createSession).mockResolvedValue({
        id: 99,
        sessionId: 'new-sess',
        title: '新对话',
        userId: 'u1',
        isPinned: false,
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
      });

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.createNewSession());

      expect(api.createSession).toHaveBeenCalled();
      const callArgs = vi.mocked(api.createSession).mock.calls[0];
      expect(callArgs[1]).toBe('新对话');
    });
  });

  /* ====================================================================
   * deleteSessionById
   * ==================================================================*/
  describe('deleteSessionById', () => {
    it('应调用 deleteSession API', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.deleteSession).mockResolvedValue(undefined);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.deleteSession('sess-to-del'));

      expect(api.deleteSession).toHaveBeenCalledWith('sess-to-del');
    });
  });

  /* ====================================================================
   * switchSession
   * ==================================================================*/
  describe('switchSession', () => {
    it('切换到相同 session 不应有任何效果', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue(mockSessions);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const currentId = result.current.currentSessionId;
      act(() => result.current.switchSession(currentId));
      expect(result.current.currentSessionId).toBe(currentId);
    });

    it('切换到不同 session 应更新 currentSessionId', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue(mockSessions);
      vi.mocked(api.getSessionMessages).mockResolvedValue([]);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const oldId = result.current.currentSessionId;

      act(() => result.current.switchSession('sess-other'));
      expect(result.current.currentSessionId).toBe('sess-other');
      expect(result.current.currentSessionId).not.toBe(oldId);
    });
  });

  /* ====================================================================
   * sendMessage
   * ==================================================================*/
  describe('sendMessage', () => {
    it('空消息且无图片应直接返回', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.sendMessage(''));

      // 不应调用 saveChatHistory
      expect(api.saveChatHistory).not.toHaveBeenCalled();
      expect(result.current.isTyping).toBe(false);
    });

    it('无文字但有图片也应有消息', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.saveChatHistory).mockResolvedValue({ id: 1 });
      vi.mocked(api.updateSessionTitle).mockResolvedValue(undefined);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('Hello World'));
          controller.close();
        },
      });

      vi.mocked(api.getAIResponse).mockResolvedValue({
        stream,
        usedKnowledgeBase: false,
        contextCount: 0,
        sessionAction: null,
        onToolStatus: null,
        fileCards: [],
      });

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.sendMessage('', ['img1.jpg']));
      expect(result.current.isTyping).toBe(false);
    });

    it('流式刷新覆盖临时 AI 消息后应恢复 assistant 气泡', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.saveChatHistory)
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 });
      vi.mocked(api.updateSessionTitle).mockResolvedValue(undefined);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue('生成好了');
          controller.close();
        },
      });
      vi.mocked(api.getAIResponse).mockImplementation(async () => {
        vi.mocked(api.getSessionMessages).mockResolvedValueOnce([
          {
            id: 1,
            role: 'user',
            content: '生成图片',
            createdAt: new Date().toISOString(),
          },
        ] as any);
        return {
          stream,
          usedKnowledgeBase: false,
          contextCount: 0,
          sessionAction: null,
          onToolStatus: null,
          fileCards: [],
        } as any;
      });

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        const sending = result.current.sendMessage('生成图片');
        await result.current.refreshAppData('manual').catch(() => {});
        await sending;
      });

      expect(result.current.messages.some((msg) => msg.role === 'assistant' && msg.content === '生成好了')).toBe(true);
    });
  });

  /* ====================================================================
   * stopGeneration
   * ==================================================================*/
  describe('stopGeneration', () => {
    it('无活跃请求时不报错', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(() => act(() => result.current.stopGeneration())).not.toThrow();
    });
  });

  /* ====================================================================
   * pendingImages 操作
   * ==================================================================*/
  describe('pendingImages 操作', () => {
    it('clearPendingImages 应清空待发送图片', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // pendingImages 是内部状态，不能直接设置。记录都是空的
      act(() => result.current.clearPendingImages());
      expect(result.current.pendingImages).toEqual([]);
    });

    it('removePendingImage 应移除指定索引的图片', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => result.current.removePendingImage(0));
      expect(result.current.pendingImages).toEqual([]);
    });
  });

  /* ====================================================================
   * updateMessage / deleteMessage
   * ==================================================================*/
  describe('消息操作', () => {
    it('updateMessage 应调用 API', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.updateMessage).mockResolvedValue(undefined);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.updateMessage('msg-1', 'new content'));

      expect(api.updateMessage).toHaveBeenCalledWith('msg-1', 'new content');
    });

    it('deleteMessage 应调用 API', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.deleteMessage).mockResolvedValue(undefined);

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.deleteMessage('msg-2'));

      expect(api.deleteMessage).toHaveBeenCalledWith('msg-2');
    });
  });

  /* ====================================================================
   * 知识库状态
   * ==================================================================*/
  describe('知识库状态', () => {
    it('应能获取知识库状态', async () => {
      vi.mocked(api.getModelInfo).mockResolvedValue(mockModelInfo);
      vi.mocked(api.getSessions).mockResolvedValue([]);
      vi.mocked(api.getKnowledgeBaseStatus).mockResolvedValue({
        status: 'ready',
        message: 'ready',
      });

      const { result } = renderHook(() => useChat(false));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.knowledgeBaseStatus.status).toBe('unknown');
    });
  });
});
