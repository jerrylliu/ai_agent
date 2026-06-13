/**
 * fundamentals/human-in-the-loop.spec.ts
 *
 * Human-in-the-Loop 确认机制单元测试
 * 覆盖：requiresConfirmation / getConfirmationConfig / requestConfirmation / handleConfirmationResponse
 *       / getPendingConfirmationInfo / registerConfirmationConfig
 */

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
      expect(mod.requiresConfirmation('manage_session', { action: 'list' })).toBe(false);
      expect(mod.requiresConfirmation('manage_session', { action: 'search' })).toBe(false);
    });

    it('manage_session 的破坏性操作应返回 true', () => {
      expect(mod.requiresConfirmation('manage_session', { action: 'delete' })).toBe(true);
      expect(mod.requiresConfirmation('manage_session', { action: 'create' })).toBe(true);
      expect(mod.requiresConfirmation('manage_session', { action: 'pin' })).toBe(true);
    });
  });

  /* ====================================================================
   * getConfirmationConfig
   * ==================================================================*/
  describe('getConfirmationConfig', () => {
    beforeEach(loadModule);

    it('应返回已配置工具的确认配置', () => {
      const config = mod.getConfirmationConfig('send_notification');
      expect(config).toBeDefined();
      expect(config!.riskLevel).toBe('medium');
      expect(config!.message).toContain('通知');
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
      const promise = mod.requestConfirmation('query_database', { sql: 'SELECT 1' });
      const id = (promise as any).confirmationId;

      let resolved = false;
      let resolvedValue: any = undefined;
      promise.then((v: any) => { resolved = true; resolvedValue = v; });

      mod.handleConfirmationResponse(id, true);
      await Promise.resolve(); // flush microtasks

      expect(resolved).toBe(true);
      expect(resolvedValue).toBe(true);
    });

    it('handleConfirmationResponse 拒绝时应 resolve false', async () => {
      await loadModule();
      const promise = mod.requestConfirmation('mcp_proxy', { server: 'git', tool: 'push' });
      const id = (promise as any).confirmationId;

      let resolvedValue: any = undefined;
      promise.then((v: any) => { resolvedValue = v; });

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
      const promise = mod.requestConfirmation('send_notification', { channel: 'email' });

      let resolvedValue: any = null;
      promise.then((v: any) => { resolvedValue = v; });

      // 快进 6 分钟（超过 5 分钟超时）
      jest.advanceTimersByTime(6 * 60 * 1000);
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
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      const promise = mod.requestConfirmation('query_database', { sql: 'SELECT 1', purpose: '测试' });
      const id = (promise as any).confirmationId;

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
