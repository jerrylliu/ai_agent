/**
 * controllers/model.controller.spec.ts
 *
 * ModelController 单元测试（简化版）
 *
 * 说明：ModelController 使用 dynamic import('model-provider.js') 加载模型模块，
 * Jest 的 jest.mock 对含 .js 后缀的动态 import 兼容性有限。
 * 这里仅测试参数校验逻辑，完整的模型切换/API Key 设置由 E2E 测试覆盖。
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ModelController } from './model.controller';

jest.mock('../fundamentals/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('ModelController', () => {
  let controller: ModelController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ModelController],
    }).compile();
    controller = module.get<ModelController>(ModelController);
  });

  /* ====================================================================
   * switchModel — 参数校验
   * ==================================================================*/
  describe('switchModel', () => {
    it('modelId 为空时应返回失败', async () => {
      const r = await controller.switchModel({ modelId: '' });
      expect(r.success).toBe(false);
    });

    it('modelId 为 undefined 时应返回失败', async () => {
      const r = await controller.switchModel({ modelId: undefined as any });
      expect(r.success).toBe(false);
    });
  });

  /* ====================================================================
   * setApiKey — 参数校验
   * ==================================================================*/
  describe('setApiKey', () => {
    it('apiKey 为空时应返回失败', async () => {
      const r = await controller.setApiKey({ provider: 'deepseek', apiKey: '' });
      expect(r.success).toBe(false);
    });

    it('不支持的 provider 应返回失败', async () => {
      const r = await controller.setApiKey({ provider: 'openai', apiKey: 'sk-openai' });
      expect(r.success).toBe(false);
    });
  });
});
