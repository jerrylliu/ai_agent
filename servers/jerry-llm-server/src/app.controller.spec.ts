/**
 * AppController API 接口单元测试
 *
 * 覆盖功能：
 * 1. GET /cache/stats — 获取缓存统计
 * 2. GET /cache/config — 获取缓存配置
 * 3. POST /cache/config — 更新缓存配置
 * 4. POST /cache/clear — 清空缓存
 * 5. GET /rate-limiter/status — 获取限流器状态
 * 6. GET /rate-limiter/config — 获取限流器配置
 * 7. POST /rate-limiter/config — 更新限流器配置
 */

jest.mock('./fundamentals/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./fundamentals/runtime-config', () => ({
  getRuntimeConfig: jest.fn(() => ({
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  })),
  updateRuntimeConfig: jest.fn(),
  loadRuntimeConfig: jest.fn(),
  saveRuntimeConfig: jest.fn(),
  DEFAULT_RUNTIME_CONFIG: {
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  },
}));

// Mock AppService 避免 ChromaDB ESM 导入问题
jest.mock('./app.service', () => ({
  AppService: jest.fn().mockImplementation(() => ({
    getHello: jest.fn().mockReturnValue('Hello World'),
  })),
}));

import { AppController } from './app.controller';

describe('AppController - 缓存与限流 API', () => {
  let controller: AppController;

  beforeEach(() => {
    const { AppService } = require('./app.service');
    controller = new AppController(new AppService());
  });

  // ==================== 缓存管理接口 ====================

  describe('GET /cache/stats', () => {
    it('应返回缓存统计信息', () => {
      const result = controller.getCacheStats();

      expect(result).toHaveProperty('hits');
      expect(result).toHaveProperty('misses');
      expect(result).toHaveProperty('hitRate');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('maxSize');
      expect(result).toHaveProperty('memoryUsageKB');
    });
  });

  describe('GET /cache/config', () => {
    it('应返回缓存当前配置', () => {
      const result = controller.getCacheConfig();

      expect(result).toHaveProperty('maxEntries');
      expect(result).toHaveProperty('maxItemSizeKB');
      expect(result).toHaveProperty('defaultTTLMinutes');
    });
  });

  describe('POST /cache/config', () => {
    it('应更新缓存配置并返回成功', () => {
      const result = controller.updateCacheConfig({ maxEntries: 100 });

      expect(result).toEqual({ success: true, message: '缓存配置已更新' });

      // 恢复默认
      controller.updateCacheConfig({ maxEntries: 200 });
    });

    it('应支持更新 maxItemSizeKB', () => {
      const result = controller.updateCacheConfig({ maxItemSizeKB: 100 });

      expect(result).toEqual({ success: true, message: '缓存配置已更新' });

      controller.updateCacheConfig({ maxItemSizeKB: 50 });
    });

    it('应支持更新 defaultTTLMinutes', () => {
      const result = controller.updateCacheConfig({ defaultTTLMinutes: 10 });

      expect(result).toEqual({ success: true, message: '缓存配置已更新' });

      controller.updateCacheConfig({ defaultTTLMinutes: 5 });
    });

    it('应支持同时更新多个配置', () => {
      const result = controller.updateCacheConfig({
        maxEntries: 50,
        maxItemSizeKB: 100,
        defaultTTLMinutes: 10,
      });

      expect(result).toEqual({ success: true, message: '缓存配置已更新' });

      controller.updateCacheConfig({
        maxEntries: 200,
        maxItemSizeKB: 50,
        defaultTTLMinutes: 5,
      });
    });
  });

  describe('POST /cache/clear', () => {
    it('应清空缓存并返回成功', () => {
      const result = controller.clearCache();

      expect(result).toEqual({ success: true, message: '缓存已清空' });
    });
  });

  // ==================== 限流管理接口 ====================

  describe('GET /rate-limiter/status', () => {
    it('应返回限流器状态', () => {
      const result = controller.getRateLimiterStatus();

      expect(result).toHaveProperty('fastPool');
      expect(result).toHaveProperty('streamingPool');
      expect(result).toHaveProperty('tokenBuckets');
      expect(result.fastPool).toHaveProperty('running');
      expect(result.fastPool).toHaveProperty('max');
      expect(result.fastPool).toHaveProperty('queueLength');
    });
  });

  describe('GET /rate-limiter/config', () => {
    it('应返回限流器当前配置', () => {
      const result = controller.getRateLimiterConfig();

      expect(result).toHaveProperty('fastPoolMax');
      expect(result).toHaveProperty('streamingPoolMax');
      expect(result).toHaveProperty('tokenWaitTimeout');
    });
  });

  describe('POST /rate-limiter/config', () => {
    it('应更新限流器配置并返回成功', () => {
      const result = controller.updateRateLimiterConfig({ fastPoolMax: 5 });

      expect(result).toEqual({ success: true, message: '限流器配置已更新' });

      controller.updateRateLimiterConfig({ fastPoolMax: 10 });
    });

    it('应支持更新 streamingPoolMax', () => {
      const result = controller.updateRateLimiterConfig({ streamingPoolMax: 3 });

      expect(result).toEqual({ success: true, message: '限流器配置已更新' });

      controller.updateRateLimiterConfig({ streamingPoolMax: 5 });
    });

    it('应支持更新 tokenWaitTimeout', () => {
      const result = controller.updateRateLimiterConfig({ tokenWaitTimeout: 5000 });

      expect(result).toEqual({ success: true, message: '限流器配置已更新' });

      controller.updateRateLimiterConfig({ tokenWaitTimeout: 10000 });
    });

    it('应支持同时更新多个配置', () => {
      const result = controller.updateRateLimiterConfig({
        fastPoolMax: 5,
        streamingPoolMax: 3,
        tokenWaitTimeout: 5000,
      });

      expect(result).toEqual({ success: true, message: '限流器配置已更新' });

      controller.updateRateLimiterConfig({
        fastPoolMax: 10,
        streamingPoolMax: 5,
        tokenWaitTimeout: 10000,
      });
    });
  });
});
