/**
 * lib/api.test.ts
 *
 * API 层单元测试
 * - mock globalThis.fetch 来测试所有 HTTP 请求函数的
 *   参数构造、请求头、错误处理和响应解析
 * - 按功能模块分组：聊天记录、会话管理、认证、模型管理、知识库
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  saveChatHistory,
  getSessionHistory,
  getAllChatHistory,
  getSessions,
  createSession,
  getSession,
  updateSessionTitle,
  deleteSession,
  toggleSessionPin,
  duplicateSession,
  exportSession,
  getSessionMessages,
  uploadFile,
  updateMessage,
  deleteMessage,
  uploadToKnowledgeBase,
  getKnowledgeBaseStatus,
  getModelInfo,
  switchModel,
  setModelApiKey,
  login,
  register,
  getProfile,
  verifyToken,
  updateProfile,
  changePassword,
  uploadAvatar,
} from './api';

/* =====================================================================
 * 测试辅助
 * ==================================================================*/
const TOKEN_KEY = 'miaoma_auth_token';

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(response),
  });
}

function mockFetchWithError(status: number, message: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({ message }),
  });
}

// 记录 fetch 调用信息，方便断言
function lastFetchCall(fetchFn: ReturnType<typeof vi.fn>) {
  const calls = fetchFn.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [url, init] = calls[calls.length - 1] as [string, RequestInit?];
  return { url, init };
}

describe('lib/api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ====================================================================
   * 聊天记录 API
   * ==================================================================*/
  describe('聊天记录', () => {
    describe('saveChatHistory', () => {
      it('未认证时应发送 POST 请求且不含 Authorization', async () => {
        const fetchSpy = mockFetch({ id: 42 });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await saveChatHistory({
          sessionId: 'sess-1',
          role: 'user',
          content: 'hello',
        });

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init?.method).toBe('POST');
        expect(url).toContain('/chat/history');
        expect(init?.headers as Record<string, string>).not.toHaveProperty(
          'Authorization',
        );
        expect(result).toEqual({ id: 42 });
      });

      it('认证后应附加 Authorization 请求头', async () => {
        localStorage.setItem(TOKEN_KEY, 'test-token');
        const fetchSpy = mockFetch({ id: 43 });
        vi.stubGlobal('fetch', fetchSpy);

        await saveChatHistory({
          sessionId: 'sess-2',
          role: 'assistant',
          content: 'response',
        });

        const { init } = lastFetchCall(fetchSpy);
        expect(init?.headers as Record<string, string>).toHaveProperty(
          'Authorization',
          'Bearer test-token',
        );
      });

      it('请求体应包含完整聊天数据', async () => {
        const fetchSpy = mockFetch({ id: 44 });
        vi.stubGlobal('fetch', fetchSpy);

        await saveChatHistory({
          sessionId: 'sess-3',
          role: 'user',
          content: 'test message',
          images: ['img1.jpg'],
        });

        const { init } = lastFetchCall(fetchSpy);
        const body = JSON.parse(init!.body as string);
        expect(body).toEqual({
          sessionId: 'sess-3',
          role: 'user',
          content: 'test message',
          images: ['img1.jpg'],
        });
      });

      it('HTTP 失败时应抛出异常', async () => {
        vi.stubGlobal('fetch', mockFetchWithError(500, 'Server Error'));

        await expect(
          saveChatHistory({ sessionId: 's-1', role: 'user', content: 'hi' }),
        ).rejects.toThrow('保存聊天记录失败');
      });
    });

    describe('getSessionHistory', () => {
      it('应发送 GET 请求并附带 sessionId 查询参数', async () => {
        const testData = [{ id: 1, content: 'msg1', role: 'user' }];
        const fetchSpy = mockFetch(testData);
        vi.stubGlobal('fetch', fetchSpy);

        const result = await getSessionHistory('sess-abc');

        const { url } = lastFetchCall(fetchSpy);
        expect(url).toContain('sessionId=sess-abc');
        expect(result).toEqual(testData);
      });
    });

    describe('getAllChatHistory', () => {
      it('应发送到 all-history 端点', async () => {
        const testData = [{ id: 1 }, { id: 2 }];
        const fetchSpy = mockFetch(testData);
        vi.stubGlobal('fetch', fetchSpy);

        const result = await getAllChatHistory();
        const { url } = lastFetchCall(fetchSpy);

        expect(url).toContain('/chat/all-history');
        expect(result).toEqual(testData);
      });
    });
  });

  /* ====================================================================
   * 会话管理 API
   * ==================================================================*/
  describe('会话管理', () => {
    describe('getSessions', () => {
      it('应返回会话列表', async () => {
        const sessions = [
          { id: 1, sessionId: 's1', title: 'S1' },
          { id: 2, sessionId: 's2', title: 'S2' },
        ];
        vi.stubGlobal('fetch', mockFetch(sessions));

        const result = await getSessions();
        expect(result).toEqual(sessions);
        expect(result).toHaveLength(2);
      });

      it('应调用 sessions 端点', async () => {
        const fetchSpy = mockFetch([]);
        vi.stubGlobal('fetch', fetchSpy);
        await getSessions();

        const { url } = lastFetchCall(fetchSpy);
        expect(url).toContain('/chat/sessions');
      });
    });

    describe('createSession', () => {
      it('应发送 POST 请求并包含 sessionId 和 title', async () => {
        const newSession = { id: 1, sessionId: 'new-sess', title: '新对话' };
        const fetchSpy = mockFetch(newSession);
        vi.stubGlobal('fetch', fetchSpy);

        const result = await createSession('new-sess', '新对话');

        const { init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        const body = JSON.parse(init!.body as string);
        expect(body).toEqual({ sessionId: 'new-sess', title: '新对话' });
        expect(result).toEqual(newSession);
      });
    });

    describe('getSession', () => {
      it('应获取指定会话', async () => {
        const session = { id: 1, sessionId: 'sess-x', title: 'Test' };
        const fetchSpy = mockFetch(session);
        vi.stubGlobal('fetch', fetchSpy);

        const result = await getSession('sess-x');
        const { url } = lastFetchCall(fetchSpy);

        expect(url).toContain('/chat/sessions/sess-x');
        expect(result).toEqual(session);
      });
    });

    describe('updateSessionTitle', () => {
      it('应发送 PUT 请求更新标题', async () => {
        const fetchSpy = mockFetch({ ok: true });
        vi.stubGlobal('fetch', fetchSpy);

        await updateSessionTitle('sess-1', '新标题');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('PUT');
        expect(url).toContain('/chat/sessions/sess-1');
        expect(JSON.parse(init!.body as string)).toEqual({ title: '新标题' });
      });
    });

    describe('deleteSession', () => {
      it('应发送 DELETE 请求', async () => {
        const fetchSpy = mockFetch({ ok: true });
        vi.stubGlobal('fetch', fetchSpy);

        await deleteSession('sess-to-delete');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('DELETE');
        expect(url).toContain('/chat/sessions/sess-to-delete');
      });

      it('删除失败应抛出异常', async () => {
        vi.stubGlobal('fetch', mockFetchWithError(500, 'Delete failed'));
        await expect(deleteSession('sess-1')).rejects.toThrow('删除会话失败');
      });
    });

    describe('toggleSessionPin', () => {
      it('应发送 PATCH 请求', async () => {
        const fetchSpy = mockFetch({ ok: true });
        vi.stubGlobal('fetch', fetchSpy);

        await toggleSessionPin('sess-pin');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('PATCH');
        expect(url).toContain('/chat/sessions/sess-pin/pin');
      });
    });

    describe('duplicateSession', () => {
      it('应发送 POST 请求到 duplicate 端点', async () => {
        const newSession = { id: 2, sessionId: 'dup', title: 'S1 (副本)' };
        const fetchSpy = mockFetch(newSession);
        vi.stubGlobal('fetch', fetchSpy);

        const result = await duplicateSession('sess-original');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        expect(url).toContain('/chat/sessions/sess-original/duplicate');
        expect(result).toEqual(newSession);
      });
    });

    describe('exportSession', () => {
      it('默认导出为 JSON 格式', async () => {
        const exportData = { content: '...', filename: 'export.json' };
        const fetchSpy = mockFetch(exportData);
        vi.stubGlobal('fetch', fetchSpy);

        const result = await exportSession('sess-exp');

        const { url } = lastFetchCall(fetchSpy);
        expect(url).toContain('format=json');
        expect(result).toEqual(exportData);
      });

      it('支持 markdown 格式', async () => {
        const fetchSpy = mockFetch({ filename: 'export.md' });
        vi.stubGlobal('fetch', fetchSpy);

        await exportSession('sess-exp', 'markdown');
        const { url } = lastFetchCall(fetchSpy);
        expect(url).toContain('format=markdown');
      });

      it('支持 text 格式', async () => {
        const fetchSpy = mockFetch({ filename: 'export.txt' });
        vi.stubGlobal('fetch', fetchSpy);

        await exportSession('sess-exp', 'text');
        const { url } = lastFetchCall(fetchSpy);
        expect(url).toContain('format=text');
      });
    });

    describe('getSessionMessages', () => {
      it('应获取指定会话的消息列表', async () => {
        const messages = [{ id: 1, content: 'm1' }, { id: 2, content: 'm2' }];
        vi.stubGlobal('fetch', mockFetch(messages));

        const result = await getSessionMessages('sess-msg');
        expect(result).toEqual(messages);
      });
    });
  });

  /* ====================================================================
   * 消息操作 API
   * ==================================================================*/
  describe('消息操作', () => {
    describe('updateMessage', () => {
      it('应发送 PUT 请求更新消息内容', async () => {
        const fetchSpy = mockFetch({ ok: true });
        vi.stubGlobal('fetch', fetchSpy);

        await updateMessage('msg-1', 'updated content');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('PUT');
        expect(url).toContain('/chat/messages/msg-1');
        expect(JSON.parse(init!.body as string)).toEqual({
          content: 'updated content',
        });
      });
    });

    describe('deleteMessage', () => {
      it('应发送 DELETE 请求', async () => {
        const fetchSpy = mockFetch({ ok: true });
        vi.stubGlobal('fetch', fetchSpy);

        await deleteMessage('msg-del');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('DELETE');
        expect(url).toContain('/chat/messages/msg-del');
      });
    });
  });

  /* ====================================================================
   * 文件上传 API
   * ==================================================================*/
  describe('文件上传', () => {
    describe('uploadFile', () => {
      it('应发送 POST 请求并以 FormData 形式上传', async () => {
        const fetchSpy = mockFetch({ url: 'https://cdn.example.com/file.pdf' });
        vi.stubGlobal('fetch', fetchSpy);

        const file = new File(['content'], 'test.pdf', { type: 'application/pdf' });
        const result = await uploadFile(file);

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        expect(url).toContain('/upload');
        expect(init!.body).toBeInstanceOf(FormData);
        expect(result).toEqual({ url: 'https://cdn.example.com/file.pdf' });
      });
    });
  });

  /* ====================================================================
   * 知识库 API
   * ==================================================================*/
  describe('知识库', () => {
    describe('uploadToKnowledgeBase', () => {
      it('应发送文件到知识库上传端点', async () => {
        const response = { success: true, message: 'OK', documentCount: 5 };
        const fetchSpy = mockFetch(response);
        vi.stubGlobal('fetch', fetchSpy);

        const file = new File(['doc'], 'doc.txt');
        const result = await uploadToKnowledgeBase(file);

        const { url } = lastFetchCall(fetchSpy);
        expect(url).toContain('/knowledge/upload');
        expect(result).toEqual(response);
      });
    });

    describe('getKnowledgeBaseStatus', () => {
      it('应返回知识库状态', async () => {
        const response = {
          success: true,
          status: 'ready',
          message: '知识库就绪',
          stats: { documentCount: 10, uploadedDocumentCount: 5, knowledgeSourcePageCount: 3, collectionName: 'default' },
        };
        vi.stubGlobal('fetch', mockFetch(response));

        const result = await getKnowledgeBaseStatus();
        expect(result.status).toBe('ready');
        expect(result.stats?.documentCount).toBe(10);
      });

      it('应有 documentCount 字段', async () => {
        const response = {
          success: true,
          status: 'ready',
          message: '',
          documentCount: 3,
        };
        vi.stubGlobal('fetch', mockFetch(response));

        const result = await getKnowledgeBaseStatus();
        expect(result.stats?.documentCount).toBe(3);
      });
    });
  });

  /* ====================================================================
   * 模型管理 API
   * ==================================================================*/
  describe('模型管理', () => {
    describe('getModelInfo', () => {
      it('应返回模型信息', async () => {
        const modelInfo = {
          success: true,
          currentModelId: 'ollama:minicpm',
          availableModels: [
            { id: 'ollama:minicpm', provider: 'ollama', name: 'MiniCPM' },
          ],
          hasDeepseekApiKey: false,
          hasZhipuApiKey: false,
          supportsVision: true,
          supportsFunctionCalling: false,
        };
        vi.stubGlobal('fetch', mockFetch(modelInfo));

        const result = await getModelInfo();
        expect(result.success).toBe(true);
        expect(result.currentModelId).toBe('ollama:minicpm');
        expect(result.availableModels).toHaveLength(1);
      });

      it('应调用 /models 端点', async () => {
        const fetchSpy = mockFetch({ success: true, currentModelId: 'm1', availableModels: [] });
        vi.stubGlobal('fetch', fetchSpy);

        await getModelInfo();
        const { url } = lastFetchCall(fetchSpy);
        expect(url).toContain('/models');
      });
    });

    describe('switchModel', () => {
      it('应发送 POST 请求切换模型', async () => {
        const fetchSpy = mockFetch({ success: true, message: 'switched' });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await switchModel('ollama:llama3');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        expect(url).toContain('/models/switch');
        expect(JSON.parse(init!.body as string)).toEqual({ modelId: 'ollama:llama3' });
        expect(result.success).toBe(true);
      });
    });

    describe('setModelApiKey', () => {
      it('应发送 POST 请求设置 API Key', async () => {
        const fetchSpy = mockFetch({ success: true, message: 'OK' });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await setModelApiKey('deepseek', 'sk-test123');

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        expect(url).toContain('/models/apikey');
        expect(JSON.parse(init!.body as string)).toEqual({
          provider: 'deepseek',
          apiKey: 'sk-test123',
        });
        expect(result.success).toBe(true);
      });
    });
  });

  /* ====================================================================
   * 认证 API
   * ==================================================================*/
  describe('认证', () => {
    const mockUser = {
      id: 1,
      email: 'test@example.com',
      phone: null,
      username: 'tester',
      avatar: null,
      isActive: true,
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    };

    describe('register', () => {
      it('应发送 POST 请求注册', async () => {
        const fetchSpy = mockFetch({
          success: true,
          message: '注册成功',
          user: mockUser,
          token: 'new-token',
        });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await register({
          email: 'test@test.com',
          password: 'pass123',
          username: 'tester',
        });

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        expect(url).toContain('/auth/register');
        expect(result.user).toEqual(mockUser);
        expect(result.token).toBe('new-token');
      });

      it('注册请求体应包含注册信息', async () => {
        const fetchSpy = mockFetch({ success: true, user: mockUser, token: 't' });
        vi.stubGlobal('fetch', fetchSpy);

        await register({ phone: '13800138000', password: 'pwd' });

        const { init } = lastFetchCall(fetchSpy);
        const body = JSON.parse(init!.body as string);
        expect(body).toEqual({ phone: '13800138000', password: 'pwd' });
      });
    });

    describe('login', () => {
      it('应发送 POST 请求登录', async () => {
        const fetchSpy = mockFetch({
          success: true,
          message: '登录成功',
          user: mockUser,
          token: 'login-token',
        });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await login({ account: 'test@test.com', password: 'pass' });

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        expect(url).toContain('/auth/login');
        expect(result.user).toEqual(mockUser);
      });

      it('登录请求体应包含 account 和 password', async () => {
        const fetchSpy = mockFetch({ success: true, user: mockUser, token: 't' });
        vi.stubGlobal('fetch', fetchSpy);

        await login({ account: 'admin', password: 'secret' });

        const { init } = lastFetchCall(fetchSpy);
        expect(JSON.parse(init!.body as string)).toEqual({
          account: 'admin',
          password: 'secret',
        });
      });
    });

    describe('getProfile', () => {
      it('应使用传入的 token 请求用户信息', async () => {
        const fetchSpy = mockFetch(mockUser);
        vi.stubGlobal('fetch', fetchSpy);

        const result = await getProfile('my-token');

        const { init } = lastFetchCall(fetchSpy);
        expect(init!.headers as Record<string, string>).toHaveProperty(
          'Authorization',
          'Bearer my-token',
        );
        expect(result).toEqual(mockUser);
      });
    });

    describe('verifyToken', () => {
      it('应请求验证 token 有效性', async () => {
        const fetchSpy = mockFetch({ success: true, valid: true, user: mockUser });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await verifyToken('valid-token');
        expect(result.valid).toBe(true);
        expect(result.user).toEqual(mockUser);
      });

      it('无效 token 应返回 valid: false', async () => {
        vi.stubGlobal('fetch', mockFetch({ success: true, valid: false, user: null }));

        const result = await verifyToken('bad-token');
        expect(result.valid).toBe(false);
      });
    });

    describe('updateProfile', () => {
      it('应发送 PUT 请求更新用户信息', async () => {
        const updatedUser = { ...mockUser, username: 'new-name' };
        const fetchSpy = mockFetch({ success: true, message: 'OK', user: updatedUser });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await updateProfile('token-x', { username: 'new-name' });

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('PUT');
        expect(url).toContain('/auth/profile');
        expect(JSON.parse(init!.body as string)).toEqual({ username: 'new-name' });
        expect(result.user.username).toBe('new-name');
      });
    });

    describe('changePassword', () => {
      it('应发送 PUT 请求修改密码', async () => {
        const fetchSpy = mockFetch({ success: true, message: '密码已修改' });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await changePassword('token-y', {
          oldPassword: 'old',
          newPassword: 'new',
        });

        const { url, init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('PUT');
        expect(url).toContain('/auth/password');
        expect(result.success).toBe(true);
      });
    });

    describe('uploadAvatar', () => {
      it('应使用 FormData 上传头像', async () => {
        const fetchSpy = mockFetch({ success: true, message: 'OK', user: mockUser });
        vi.stubGlobal('fetch', fetchSpy);

        const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });
        const result = await uploadAvatar('token-z', file);

        const { init } = lastFetchCall(fetchSpy);
        expect(init!.method).toBe('POST');
        expect(init!.body).toBeInstanceOf(FormData);
        // 认证 token 应存在于请求头
        expect(init!.headers as Record<string, string>).toHaveProperty(
          'Authorization',
          'Bearer token-z',
        );
        expect(result.success).toBe(true);
      });
    });
  });

  /* ====================================================================
   * 错误处理
   * ==================================================================*/
  describe('错误处理', () => {
    it('非 OK 状态码应抛出异常 (含服务端消息)', async () => {
      vi.stubGlobal('fetch', mockFetchWithError(400, '请求参数无效'));

      // getSessionMessages 使用 handleResponse
      await expect(getSessionMessages('sess-1')).rejects.toThrow('请求参数无效');
    });

    it('非 OK 状态码且无 message 时应显示默认错误', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: vi.fn().mockResolvedValue({}),
        }),
      );

      await expect(getSessionMessages('sess-x')).rejects.toThrow('请求失败: 500');
    });

    it('非 OK 状态码且 message 为数组时应 join', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: vi.fn().mockResolvedValue({ message: ['字段A不能为空', '字段B无效'] }),
        }),
      );

      await expect(getSessionMessages('sess-x')).rejects.toThrow('字段A不能为空; 字段B无效');
    });
  });
});
