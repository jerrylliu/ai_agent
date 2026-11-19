/**
 * fundamentals/human-in-the-loop.spec.ts
 *
 * Human-in-the-Loop 确认机制单元测试
 * 覆盖：requiresConfirmation / getConfirmationConfig / requestConfirmation / handleConfirmationResponse
 *       / getPendingConfirmationInfo / registerConfirmationConfig
 */

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// 飞书双通道审批仅在配置了 NOTIFY_FEISHU_HITL_USER 时启用，
// 测试中 mock 掉避免模块加载时触发 config 解析（fail-fast 缺少 JWT_SECRET）
jest.mock('./feishu-notify.service', () => ({
  sendCardMessage: jest
    .fn()
    .mockResolvedValue({ success: false, error: 'mocked' }),
  buildCardJson: jest.fn().mockReturnValue({}),
  detectReceiveIdType: jest.fn().mockReturnValue('email'),
  updateCard: jest.fn().mockResolvedValue({ success: true }),
}));

// 每个测试独立导入（模块内部有 Map 共享状态）
// 用 require 方式动态导入以获取清空的模块状态

describe('HumanInTheLoop', () => {
  let mod: any;

  beforeEach(() => {
    jest.resetModules();
  });

  async function loadModule() {
    mod = require('./human-in-the-loop');
  }

  /* ====================================================================
   * requiresConfirmation
   * ==================================================================*/
  describe('requiresConfirmation', () => {
    beforeEach(loadModule);

    it('配置中的工具应返回 true', () => {
      expect(mod.requiresConfirmation('manage_session')).toBe(true);
      expect(mod.requiresConfirmation('send_notification')).toBe(true);
      expect(mod.requiresConfirmation('query_database')).toBe(true);
      expect(mod.requiresConfirmation('mcp_proxy')).toBe(true);
    });

    it('未配置的工具应返回 false', () => {
      expect(mod.requiresConfirmation('calculate')).toBe(false);
      expect(mod.requiresConfirmation('unknown_tool')).toBe(false);
    });

    it('manage_session 的只读操作应返回 false', () => {
      // list/search/list_tags 不在 actionFilter 中
      expect(
        mod.requiresConfirmation('manage_session', { action: 'list' }),
      ).toBe(false);
      expect(
        mod.requiresConfirmation('manage_session', { action: 'search' }),
      ).toBe(false);
    });

    it('manage_session 的破坏性操作应返回 true', () => {
      expect(
        mod.requiresConfirmation('manage_session', { action: 'delete' }),
      ).toBe(true);
      expect(
        mod.requiresConfirmation('manage_session', { action: 'create' }),
      ).toBe(true);
      expect(
        mod.requiresConfirmation('manage_session', { action: 'pin' }),
      ).toBe(true);
    });
  });

  /* ====================================================================
   * getConfirmationConfig
   * ==================================================================*/
  describe('getConfirmationConfig', () => {
    beforeEach(loadModule);

    it('应返回已配置工具的确认配置（两阶段交付：message 为登记语义）', () => {
      const config = mod.getConfirmationConfig('send_notification');
      expect(config).toBeDefined();
      expect(config!.riskLevel).toBe('medium');
      // 阶段 6 升级后 message 描述"登记交付计划"而非"发送"
      expect(config!.message).toContain('登记');
      // paramSummary 含附件清单（最终组装预览）
      const summary = config!.paramSummary({
        channel: 'email',
        title: 'T',
        content: 'hello world content',
        recipients: ['a@x.com'],
        attachments: [
          { filename: 'a.png', url: 'https://x/a.png' },
          { filename: 'b.pdf', url: 'fc://document/k1' },
        ],
      });
      expect(summary).toContain('附件（2）：a.png、b.pdf');
      expect(summary).toContain('正文预览：hello world content');
    });

    it('未配置的工具应返回 null', () => {
      expect(mod.getConfirmationConfig('unknown')).toBeNull();
    });
  });

  /* ====================================================================
   * requestConfirmation / handleConfirmationResponse
   * ==================================================================*/
  describe('requestConfirmation & handleConfirmationResponse', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('未配置的工具应直接 resolve true', async () => {
      await loadModule();
      const result = await mod.requestConfirmation('unknown_tool', {});
      expect(result).toBe(true);
    });

    it('应创建确认请求并返回 Promise', async () => {
      await loadModule();
      const promise = mod.requestConfirmation('send_notification', {
        channel: 'email',
        recipients: ['a@b.com'],
      });
      expect(promise.confirmationId).toBeDefined();
      expect(typeof promise.confirmationId).toBe('string');
      expect(promise.confirmationId).toMatch(/^confirm_/);
    });

    it('handleConfirmationResponse 确认时应 resolve true', async () => {
      await loadModule();
      const promise = mod.requestConfirmation('query_database', {
        sql: 'SELECT 1',
      });
      const id = promise.confirmationId;

      let resolved = false;
      let resolvedValue: any = undefined;
      promise.then((v: any) => {
        resolved = true;
        resolvedValue = v;
      });

      mod.handleConfirmationResponse(id, true);
      await Promise.resolve(); // flush microtasks

      expect(resolved).toBe(true);
      expect(resolvedValue).toBe(true);
    });

    it('handleConfirmationResponse 拒绝时应 resolve false', async () => {
      await loadModule();
      const promise = mod.requestConfirmation('mcp_proxy', {
        server: 'git',
        tool: 'push',
      });
      const id = promise.confirmationId;

      let resolvedValue: any = undefined;
      promise.then((v: any) => {
        resolvedValue = v;
      });

      mod.handleConfirmationResponse(id, false);
      await Promise.resolve();

      expect(resolvedValue).toBe(false);
    });

    it('handleConfirmationResponse 对不存在的 ID 应返回 false', async () => {
      await loadModule();
      expect(mod.handleConfirmationResponse('nonexistent', true)).toBe(false);
    });

    it('超时后应自动拒绝', async () => {
      await loadModule();
      const promise = mod.requestConfirmation('send_notification', {
        channel: 'email',
      });

      let resolvedValue: any = null;
      promise.then((v: any) => {
        resolvedValue = v;
      });

      // 快进超过超时阈值（10 分钟，见 CONFIRMATION_TIMEOUT_MS）
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      await Promise.resolve();

      expect(resolvedValue).toBe(false);
    });
  });

  /* ====================================================================
   * getPendingConfirmationInfo
   * ==================================================================*/
  describe('getPendingConfirmationInfo', () => {
    beforeEach(async () => {
      jest.useFakeTimers();
      await loadModule();
    });

    afterEach(() => jest.useRealTimers());

    it('应返回待确认请求的信息', () => {
      const promise = mod.requestConfirmation('query_database', {
        sql: 'SELECT 1',
        purpose: '测试',
      });
      const id = promise.confirmationId;

      const info = mod.getPendingConfirmationInfo(id);
      expect(info).toBeDefined();
      expect(info!.id).toBe(id);
      expect(info!.toolName).toBe('query_database');
      expect(info!.riskLevel).toBe('low');
    });

    it('不存在的 ID 应返回 null', () => {
      expect(mod.getPendingConfirmationInfo('fake')).toBeNull();
    });
  });

  /* ====================================================================
   * listPendingConfirmationsForUser（/chat/events 回放）
   * ==================================================================*/
  describe('listPendingConfirmationsForUser', () => {
    beforeEach(async () => {
      jest.useFakeTimers();
      await loadModule();
    });

    afterEach(() => jest.useRealTimers());

    it('应列出该用户所有挂起的确认请求（回放用）', async () => {
      const p1 = mod.requestConfirmation(
        'query_database',
        { sql: 'SELECT 1' },
        'user-a',
      );
      mod.requestConfirmation(
        'send_notification',
        { channel: 'email', title: 't' },
        'user-b',
      );

      const list = mod.listPendingConfirmationsForUser('user-a');
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(p1.confirmationId);
      expect(list[0].toolName).toBe('query_database');
      // 结构与流内 confirmation_request payload 一致，前端可按同构去重
      expect(Object.keys(list[0]).sort()).toEqual([
        'id',
        'message',
        'paramsSummary',
        'riskLevel',
        'toolName',
      ]);
    });

    it('已解决的请求不应再出现在回放列表中', async () => {
      const p1 = mod.requestConfirmation(
        'query_database',
        { sql: 'SELECT 1' },
        'user-a',
      );
      mod.handleConfirmationResponse(p1.confirmationId, true, 'web');
      await Promise.resolve(); // 让 handleConfirmationResponse 的 promise resolve

      expect(mod.listPendingConfirmationsForUser('user-a')).toHaveLength(0);
    });

    it('超时的请求不应出现在回放列表中', () => {
      mod.requestConfirmation(
        'query_database',
        { sql: 'SELECT 1' },
        'user-a',
      );
      // 快进超过超时阈值（触发超时清理定时器）
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);

      expect(mod.listPendingConfirmationsForUser('user-a')).toHaveLength(0);
    });
  });

  /* ====================================================================
   * registerConfirmationConfig
   * ==================================================================*/
  describe('registerConfirmationConfig', () => {
    beforeEach(loadModule);

    it('应注册自定义工具配置', () => {
      mod.registerConfirmationConfig('custom_tool', {
        riskLevel: 'high',
        message: '确认执行',
        paramSummary: (p: any) => p.action || '-',
      });

      expect(mod.requiresConfirmation('custom_tool')).toBe(true);
      const config = mod.getConfirmationConfig('custom_tool');
      expect(config!.riskLevel).toBe('high');
    });
  });
});
