/**
 * 运行时配置持久化单元测试
 *
 * 覆盖功能：
 * 1. loadRuntimeConfig：文件不存在/存在/解析失败时的行为
 * 2. saveRuntimeConfig：写入文件
 * 3. getRuntimeConfig：返回当前内存配置
 * 4. updateRuntimeConfig：部分更新 + 合并 + 持久化
 * 5. DEFAULT_RUNTIME_CONFIG：默认值完整性
 */

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock 全局配置：runtime-config 仅用 config.ollamaBaseUrl 作为嵌入默认地址，
// 避免测试环境缺少 JWT_SECRET 等环境变量时 config.ts fail-fast 导致套件无法加载
jest.mock('./config', () => ({
  config: {
    ollamaBaseUrl: 'http://localhost:11434',
  },
}));

// Mock fs 模块
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(),
}));

jest.mock('path', () => ({
  join: jest.fn(() => '/mock/runtime-config.json'),
}));

import { readFileSync, writeFileSync, existsSync } from 'fs';
import {
  DEFAULT_RUNTIME_CONFIG,
  loadRuntimeConfig,
  saveRuntimeConfig,
  getRuntimeConfig,
  updateRuntimeConfig,
  RuntimeConfigValidationError,
  type RuntimeConfig,
} from './runtime-config';

describe('RuntimeConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==================== DEFAULT_RUNTIME_CONFIG ====================

  describe('DEFAULT_RUNTIME_CONFIG', () => {
    it('应包含完整的 cache 配置', () => {
      expect(DEFAULT_RUNTIME_CONFIG.cache).toEqual({
        maxEntries: 200,
        maxItemSizeKB: 50,
        defaultTTLMinutes: 5,
        maxTotalSizeMB: 32,
      });
    });

    it('应包含完整的 rateLimiter 配置', () => {
      expect(DEFAULT_RUNTIME_CONFIG.rateLimiter).toEqual({
        fastPoolMax: 10,
        streamingPoolMax: 5,
        tokenWaitTimeout: 10000,
        queueWaitTimeout: 120000,
      });
    });
  });

  // ==================== loadRuntimeConfig ====================

  describe('loadRuntimeConfig', () => {
    it('文件不存在时应返回默认配置', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const config = loadRuntimeConfig();
      expect(config).toEqual(DEFAULT_RUNTIME_CONFIG);
    });

    it('文件存在时应加载并合并配置', () => {
      (existsSync as jest.Mock).mockReturnValue(true);
      (readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({
          cache: { maxEntries: 100 },
          rateLimiter: { fastPoolMax: 5 },
        }),
      );

      const config = loadRuntimeConfig();
      expect(config.cache.maxEntries).toBe(100);
      expect(config.cache.maxItemSizeKB).toBe(50); // 默认值
      expect(config.rateLimiter.fastPoolMax).toBe(5);
      expect(config.rateLimiter.streamingPoolMax).toBe(5); // 默认值
    });

    it('文件解析失败时应返回默认配置', () => {
      (existsSync as jest.Mock).mockReturnValue(true);
      (readFileSync as jest.Mock).mockReturnValue('invalid json{{{');

      const config = loadRuntimeConfig();
      expect(config).toEqual(DEFAULT_RUNTIME_CONFIG);
    });

    it('单个区块脏数据只让该区块回退默认值，不连坐其它区块', () => {
      // 历史版本会把非法值静默写盘（如前端清空输入框产生 maxEntries: 0），
      // 若加载时整体校验失败就会回退到全默认，导致已保存的云端嵌入 Key 丢失
      (existsSync as jest.Mock).mockReturnValue(true);
      (readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({
          cache: { maxEntries: 'abc' },
          rateLimiter: { fastPoolMax: 3 },
          embedding: {
            localEnabled: false,
            cloud: { apiKeyEncrypted: 'encrypted-secret' },
          },
        }),
      );

      const config = loadRuntimeConfig();

      expect(config.cache).toEqual(DEFAULT_RUNTIME_CONFIG.cache); // 脏区块回退默认
      expect(config.rateLimiter.fastPoolMax).toBe(3); // 正常区块保留
      expect(config.embedding.localEnabled).toBe(false);
      expect(config.embedding.cloud.apiKeyEncrypted).toBe('encrypted-secret');
    });
  });

  // ==================== saveRuntimeConfig ====================

  describe('saveRuntimeConfig', () => {
    it('应将配置序列化后写入文件', () => {
      const config: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
      saveRuntimeConfig(config);

      expect(writeFileSync).toHaveBeenCalledTimes(1);
      const [, content] = (writeFileSync as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(config);
    });

    it('写入失败不应抛出异常', () => {
      (writeFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('磁盘已满');
      });

      expect(() => saveRuntimeConfig(DEFAULT_RUNTIME_CONFIG)).not.toThrow();
    });
  });

  // ==================== getRuntimeConfig ====================

  describe('getRuntimeConfig', () => {
    it('应返回当前内存中的配置', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      // 重新加载模块级别的 currentConfig
      const config = getRuntimeConfig();
      expect(config).toHaveProperty('cache');
      expect(config).toHaveProperty('rateLimiter');
    });
  });

  // ==================== updateRuntimeConfig ====================

  describe('updateRuntimeConfig', () => {
    it('部分更新 cache 应合并并持久化', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      // 先确保初始状态
      const before = getRuntimeConfig();

      const result = updateRuntimeConfig({ cache: { maxEntries: 50 } });

      expect(result.cache.maxEntries).toBe(50);
      expect(result.cache.maxItemSizeKB).toBe(before.cache.maxItemSizeKB);
      expect(writeFileSync).toHaveBeenCalled();

      // 恢复
      updateRuntimeConfig({ cache: { maxEntries: before.cache.maxEntries } });
    });

    it('部分更新 rateLimiter 应合并并持久化', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const before = getRuntimeConfig();

      const result = updateRuntimeConfig({ rateLimiter: { fastPoolMax: 3 } });

      expect(result.rateLimiter.fastPoolMax).toBe(3);
      expect(result.rateLimiter.streamingPoolMax).toBe(
        before.rateLimiter.streamingPoolMax,
      );
      expect(writeFileSync).toHaveBeenCalled();

      // 恢复
      updateRuntimeConfig({
        rateLimiter: { fastPoolMax: before.rateLimiter.fastPoolMax },
      });
    });

    it('同时更新 cache 和 rateLimiter', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const before = getRuntimeConfig();

      const result = updateRuntimeConfig({
        cache: { maxEntries: 100 },
        rateLimiter: { streamingPoolMax: 2 },
      });

      expect(result.cache.maxEntries).toBe(100);
      expect(result.rateLimiter.streamingPoolMax).toBe(2);

      // 恢复
      updateRuntimeConfig({
        cache: { maxEntries: before.cache.maxEntries },
        rateLimiter: { streamingPoolMax: before.rateLimiter.streamingPoolMax },
      });
    });

    it('空更新不应改变配置', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const before = getRuntimeConfig();

      const result = updateRuntimeConfig({});

      expect(result.cache).toEqual(before.cache);
      expect(result.rateLimiter).toEqual(before.rateLimiter);
    });

    it('非法值应抛错且不落盘、不改内存', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const before = getRuntimeConfig();

      // maxEntries: 0 会让缓存淘汰循环空转、fastPoolMax: 0 会让信号量永久挂起，
      // 这两个值前端「清空输入框再保存」就能产生，必须在写入前 fail-fast
      expect(() => updateRuntimeConfig({ cache: { maxEntries: 0 } })).toThrow(
        RuntimeConfigValidationError,
      );
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(getRuntimeConfig().cache.maxEntries).toBe(before.cache.maxEntries);
    });

    it('校验失败应返回字段级 issues', () => {
      const attempt = (): unknown => {
        try {
          updateRuntimeConfig({
            cache: { maxEntries: 10 ** 9 },
            rateLimiter: { fastPoolMax: -1, tokenWaitTimeout: 0 },
          });
          return undefined;
        } catch (err) {
          return err;
        }
      };

      const error = attempt();
      expect(error).toBeInstanceOf(RuntimeConfigValidationError);
      const paths = (error as RuntimeConfigValidationError).issues.map(
        (i) => i.path,
      );
      expect(paths).toEqual(
        expect.arrayContaining([
          'cache.maxEntries',
          'rateLimiter.fastPoolMax',
          'rateLimiter.tokenWaitTimeout',
        ]),
      );
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('TTL 为 0（永不过期）应被接受', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const before = getRuntimeConfig();

      const result = updateRuntimeConfig({ cache: { defaultTTLMinutes: 0 } });
      expect(result.cache.defaultTTLMinutes).toBe(0);

      // 恢复
      updateRuntimeConfig({
        cache: { defaultTTLMinutes: before.cache.defaultTTLMinutes },
      });
    });

    it('总字节预算为 0 应抛错且不落盘', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const before = getRuntimeConfig();

      // maxTotalSizeMB: 0 等价于「一条都放不下」，所有写入都会走 rejectedBudget 分支，
      // 缓存事实上被禁用却从 UI 上看不出来，必须在写入前 fail-fast
      expect(() =>
        updateRuntimeConfig({ cache: { maxTotalSizeMB: 0 } }),
      ).toThrow(RuntimeConfigValidationError);
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(getRuntimeConfig().cache.maxTotalSizeMB).toBe(
        before.cache.maxTotalSizeMB,
      );
    });

    it('应支持更新总字节预算', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      const before = getRuntimeConfig();

      const result = updateRuntimeConfig({ cache: { maxTotalSizeMB: 64 } });
      expect(result.cache.maxTotalSizeMB).toBe(64);

      // 恢复
      updateRuntimeConfig({
        cache: { maxTotalSizeMB: before.cache.maxTotalSizeMB },
      });
    });
  });
});
