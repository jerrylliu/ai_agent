/**
 * fundamentals/tools/settings-ops.spec.ts
 *
 * 设置域操作工具单元测试
 * Mock model-provider / runtime-config / redis-client / chat-event-bus，
 * 重点验证：Key 只暴露布尔不泄露内容、切换/开关走全局广播。
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../model-provider', () => ({
  AVAILABLE_MODELS: [
    { id: 'deepseek:deepseek-chat', name: 'DeepSeek', requiresApiKey: true },
    { id: 'ollama:minicpm', name: 'MiniCPM', requiresApiKey: false },
  ],
  getCurrentModelId: jest.fn().mockReturnValue('deepseek:deepseek-chat'),
  getDeepseekApiKey: jest.fn().mockReturnValue('sk-secret-deepseek'),
  getZhipuApiKey: jest.fn().mockReturnValue(undefined),
  switchModel: jest.fn(),
}));

jest.mock('../runtime-config', () => ({
  getFeatureDefaults: jest.fn().mockReturnValue({
    memoryEnabled: true,
    summaryEnabled: true,
    injectMemoryOnNewSession: true,
  }),
  getMineruConfigStatus: jest.fn().mockReturnValue({
    enabled: true,
    modelVersion: 'v2',
    source: 'runtime',
    hasToken: true,
  }),
  updateRuntimeConfig: jest.fn(),
}));

jest.mock('../redis-client', () => ({
  getRedis: jest.fn().mockReturnValue({ status: 'ready' }),
}));

jest.mock('../chat-event-bus', () => ({
  publishSettingsChangedEvent: jest.fn(),
}));

import { switchModelSchema, toggleFeatureSchema } from './settings-ops';

describe('settings-ops 工具', () => {
  /* ====================================================================
   * Schema
   * ==================================================================*/
  describe('Schema', () => {
    it('switch_model 应要求 modelId 必填', () => {
      expect(switchModelSchema.function.parameters.required).toEqual(
        expect.arrayContaining(['modelId']),
      );
    });

    it('toggle_feature 应要求 feature 与 enabled 必填', () => {
      expect(toggleFeatureSchema.function.parameters.required).toEqual(
        expect.arrayContaining(['feature', 'enabled']),
      );
    });
  });

  /* ====================================================================
   * executeGetSystemStatus
   * ==================================================================*/
  describe('executeGetSystemStatus', () => {
    it('Key 只暴露布尔状态，绝不泄露明文', async () => {
      jest.resetModules();
      const fresh = require('./settings-ops');

      const r = await fresh.executeGetSystemStatus();
      expect(r.success).toBe(true);
      expect(r.status.apiKeyConfigured).toEqual({ deepseek: true, zhipu: false });
      // 明文 Key 不得出现在任何返回字段中（密钥物理隔离边界）
      expect(JSON.stringify(r)).not.toContain('sk-secret-deepseek');
      expect(r.status.currentModel).toEqual({
        id: 'deepseek:deepseek-chat',
        name: 'DeepSeek',
      });
      expect(r.status.redisConnected).toBe(true);
    });
  });

  /* ====================================================================
   * executeSwitchModel
   * ==================================================================*/
  describe('executeSwitchModel', () => {
    it('切换成功后应广播 model 区块变更', async () => {
      jest.resetModules();
      const fresh = require('./settings-ops');
      const modelProvider = require('../model-provider');
      const eventBus = require('../chat-event-bus');

      const r = await fresh.executeSwitchModel({ modelId: 'zhipu:glm-4.7' });
      expect(r.success).toBe(true);
      expect(modelProvider.switchModel).toHaveBeenCalledWith('zhipu:glm-4.7');
      expect(eventBus.publishSettingsChangedEvent).toHaveBeenCalledWith({
        section: 'model',
      });
    });

    it('切换失败时应返回结构化错误并引导查询状态', async () => {
      jest.resetModules();
      const fresh = require('./settings-ops');
      const modelProvider = require('../model-provider');
      modelProvider.switchModel.mockImplementation(() => {
        throw new Error('模型 deepseek:xxx 的 API Key 未配置');
      });
      const eventBus = require('../chat-event-bus');

      const r = await fresh.executeSwitchModel({ modelId: 'deepseek:xxx' });
      expect(r.success).toBe(false);
      expect(r.message).toContain('Key 未配置');
      expect(r.message).toContain('get_system_status');
      // 失败不广播，避免在线端被误导刷新
      expect(eventBus.publishSettingsChangedEvent).not.toHaveBeenCalled();
    });
  });

  /* ====================================================================
   * executeToggleFeature
   * ==================================================================*/
  describe('executeToggleFeature', () => {
    it('记忆开关应写入 features 区块并广播', async () => {
      jest.resetModules();
      const fresh = require('./settings-ops');
      const runtimeConfig = require('../runtime-config');
      const eventBus = require('../chat-event-bus');

      const r = await fresh.executeToggleFeature({
        feature: 'memoryEnabled',
        enabled: false,
      });
      expect(r.success).toBe(true);
      expect(runtimeConfig.updateRuntimeConfig).toHaveBeenCalledWith({
        features: { memoryEnabled: false },
      });
      expect(eventBus.publishSettingsChangedEvent).toHaveBeenCalledWith({
        section: 'features',
      });
    });

    it('MinerU 开关应写入 mineru 区块而非 features', async () => {
      jest.resetModules();
      const fresh = require('./settings-ops');
      const runtimeConfig = require('../runtime-config');

      const r = await fresh.executeToggleFeature({
        feature: 'mineruEnabled',
        enabled: true,
      });
      expect(r.success).toBe(true);
      expect(runtimeConfig.updateRuntimeConfig).toHaveBeenCalledWith({
        mineru: { enabled: true },
      });
    });

    it('feature 非法值应参数校验失败且不写配置', async () => {
      jest.resetModules();
      const fresh = require('./settings-ops');
      const runtimeConfig = require('../runtime-config');

      const r = await fresh.executeToggleFeature({
        feature: 'notAFeature',
        enabled: true,
      });
      expect(r.success).toBe(false);
      expect(r.message).toContain('参数校验失败');
      expect(runtimeConfig.updateRuntimeConfig).not.toHaveBeenCalled();
    });
  });
});
