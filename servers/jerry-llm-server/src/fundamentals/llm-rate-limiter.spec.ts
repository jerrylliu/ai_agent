/**
 * LLM 限流器单元测试
 */

// Mock 基础设施，避免 logger 初始化报错
jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock runtime-config，提供默认配置
jest.mock('./runtime-config', () => ({
  getRuntimeConfig: () => ({
    cache: {
      maxEntries: 200,
      maxItemSizeKB: 50,
      defaultTTLMinutes: 5,
      maxTotalSizeMB: 32,
    },
    rateLimiter: {
      fastPoolMax: 10,
      streamingPoolMax: 5,
      tokenWaitTimeout: 10000,
      queueWaitTimeout: 120000,
    },
    // store-state.ts 在模块加载时会读取 embedding.localEnabled 推导初始生效模式，
    // mock 必须提供该字段；测试环境无 Ollama，置为 false 直接走云端分支，避免网络探测
    embedding: {
      localEnabled: false,
      ollama: { baseUrl: 'http://localhost:11434', model: 'bge-m3' },
      cloud: {
        provider: 'custom',
        baseUrl: '',
        apiKeyEncrypted: '',
        model: '',
      },
    },
  }),
  updateRuntimeConfig: jest.fn(),
  loadRuntimeConfig: jest.fn(),
  saveRuntimeConfig: jest.fn(),
  DEFAULT_RUNTIME_CONFIG: {
    cache: {
      maxEntries: 200,
      maxItemSizeKB: 50,
      defaultTTLMinutes: 5,
      maxTotalSizeMB: 32,
    },
    rateLimiter: {
      fastPoolMax: 10,
      streamingPoolMax: 5,
      tokenWaitTimeout: 10000,
      queueWaitTimeout: 120000,
    },
    embedding: {
      localEnabled: false,
      ollama: { baseUrl: 'http://localhost:11434', model: 'bge-m3' },
      cloud: {
        provider: 'custom',
        baseUrl: '',
        apiKeyEncrypted: '',
        model: '',
      },
    },
  },
}));

import {
  LLMRateLimiter,
  getRateLimiterStatus,
  updateRateLimiterConfig,
} from './llm-rate-limiter';

describe('LLMRateLimiter', () => {
  let limiter: LLMRateLimiter;

  beforeEach(() => {
    // 每个测试用独立实例，避免状态污染
    limiter = new LLMRateLimiter({
      fastPoolMax: 2,
      streamingPoolMax: 1,
      providerRPM: { deepseek: 60, zhipu: 60 }, // 60 RPM = 1 RPS，方便测试
      tokenWaitTimeout: 2000,
    });
  });

  // ==================== 信号量并发控制 ====================

  describe('信号量并发控制', () => {
    it('未超并发数时应立即执行', async () => {
      const result = await limiter.execute(
        'deepseek',
        'fast',
        async () => 'ok',
      );
      expect(result).toBe('ok');
    });

    it('fast 池超并发数时应排队等待', async () => {
      const order: string[] = [];

      // fast 池最大并发 2，第三个请求应排队
      const p1 = limiter.execute('deepseek', 'fast', async () => {
        order.push('start-1');
        await delay(100);
        order.push('end-1');
        return 'r1';
      });
      const p2 = limiter.execute('deepseek', 'fast', async () => {
        order.push('start-2');
        await delay(100);
        order.push('end-2');
        return 'r2';
      });
      const p3 = limiter.execute('deepseek', 'fast', async () => {
        order.push('start-3');
        return 'r3';
      });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1).toBe('r1');
      expect(r2).toBe('r2');
      expect(r3).toBe('r3');

      // p3 应在 p1 或 p2 完成后才开始
      expect(order).toContain('start-3');
      // start-3 应在 end-1 或 end-2 之后
      const start3Idx = order.indexOf('start-3');
      const end1Idx = order.indexOf('end-1');
      const end2Idx = order.indexOf('end-2');
      expect(start3Idx).toBeGreaterThan(Math.min(end1Idx, end2Idx));
    });

    it('streaming 池超并发数时应排队等待', async () => {
      const order: string[] = [];

      // streaming 池最大并发 1
      const p1 = limiter.execute('deepseek', 'streaming', async () => {
        order.push('s1-start');
        await delay(50);
        order.push('s1-end');
        return 'stream1';
      });
      const p2 = limiter.execute('deepseek', 'streaming', async () => {
        order.push('s2-start');
        return 'stream2';
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe('stream1');
      expect(r2).toBe('stream2');

      // p2 应在 p1 完成后才开始
      const s2Idx = order.indexOf('s2-start');
      const s1EndIdx = order.indexOf('s1-end');
      expect(s2Idx).toBeGreaterThan(s1EndIdx);
    });

    it('fast 和 streaming 池互不影响', async () => {
      // streaming 池占满
      const p1 = limiter.execute('deepseek', 'streaming', async () => {
        await delay(100);
        return 'stream1';
      });
      // fast 池应不受影响
      const p2 = limiter.execute('deepseek', 'fast', async () => 'fast1');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('stream1');
      expect(r2).toBe('fast1');
    });
  });

  // ==================== 排队超时与扩容唤醒 ====================

  describe('排队超时与扩容唤醒', () => {
    it('排队超过 queueWaitTimeout 应拒绝请求而不是永久挂起', async () => {
      // 没有超时兜底时，池子被打满 + 上游长时间不释放会让请求永久挂起，
      // 连接一直堆积，前端表现为无限转圈
      const tight = new LLMRateLimiter({
        fastPoolMax: 1,
        streamingPoolMax: 1,
        providerRPM: {}, // 不配令牌桶，隔离出信号量行为
        tokenWaitTimeout: 2000,
        queueWaitTimeout: 150,
      });

      const p1 = tight.execute('openai', 'fast', async () => {
        await delay(600);
        return 'r1';
      });
      const p2 = tight.execute('openai', 'fast', async () => 'r2');

      await expect(p2).rejects.toThrow('排队超时');
      await expect(p1).resolves.toBe('r1');
    }, 10000);

    it('扩大并发上限应立即唤醒排队者', async () => {
      const l = new LLMRateLimiter({
        fastPoolMax: 1,
        streamingPoolMax: 1,
        providerRPM: {},
        tokenWaitTimeout: 2000,
        queueWaitTimeout: 5000,
      });

      let secondStarted = false;
      const p1 = l.execute('openai', 'fast', async () => {
        await delay(800);
        return 'r1';
      });
      const p2 = l.execute('openai', 'fast', async () => {
        secondStarted = true;
        return 'r2';
      });

      await delay(50);
      expect(secondStarted).toBe(false); // 仍在排队

      l.updateConfig({ fastPoolMax: 2 });
      await delay(20);
      expect(secondStarted).toBe(true); // 扩容后立刻放行，无需等 release

      await expect(Promise.all([p1, p2])).resolves.toEqual(['r1', 'r2']);
    }, 10000);
  });

  // ==================== Ollama 不限流 ====================

  describe('Ollama 不限流', () => {
    it('Ollama 应直接执行，不受信号量限制', async () => {
      // streaming 池只有 1 个并发，但 Ollama 应不受限
      const promises = Array.from({ length: 5 }, (_, i) =>
        limiter.execute('ollama', 'streaming', async () => `ollama-${i}`),
      );

      const results = await Promise.all(promises);
      expect(results).toEqual([
        'ollama-0',
        'ollama-1',
        'ollama-2',
        'ollama-3',
        'ollama-4',
      ]);
    });
  });

  // ==================== 令牌桶速率限制 ====================

  describe('令牌桶速率限制', () => {
    it('未配置的 provider 不应限流（无令牌桶）', async () => {
      // openai 未配置 RPM，应直接执行
      const result = await limiter.execute('openai', 'fast', async () => 'ok');
      expect(result).toBe('ok');
    });

    it('令牌超时被拒绝后应归还并发槽位', async () => {
      const strict = new LLMRateLimiter({
        fastPoolMax: 1,
        streamingPoolMax: 1,
        providerRPM: { deepseek: 1 }, // 1 RPM，抽干后 1 分钟才回补 1 个
        tokenWaitTimeout: 100,
        queueWaitTimeout: 200,
      });

      await strict.execute('deepseek', 'fast', async () => 'r1');
      await expect(
        strict.execute('deepseek', 'fast', async () => 'r2'),
      ).rejects.toThrow('速率超限');

      // 槽位若未归还，running 会一直停在 max，后续请求全部排队直至超时
      expect(strict.getStatus().fastPool.running).toBe(0);
      expect(strict.getStatus().fastPool.queueLength).toBe(0);
    }, 10000);
  });

  // ==================== 异常处理 ====================

  describe('异常处理', () => {
    it('执行函数抛异常时应释放信号量', async () => {
      // 先占满 fast 池
      const p1 = limiter.execute('deepseek', 'fast', async () => {
        await delay(50);
        return 'r1';
      });

      // 这个会失败
      const p2 = limiter.execute('deepseek', 'fast', async () => {
        throw new Error('test error');
      });

      await expect(p2).rejects.toThrow('test error');

      // 信号量应已释放，新请求应能执行
      const p3 = limiter.execute('deepseek', 'fast', async () => 'r3');
      await expect(p3).resolves.toBe('r3');

      await p1;
    });

    it('令牌桶超时应抛出速率超限错误', async () => {
      // 创建一个 RPM 极低且超时极短的限流器
      const strictLimiter = new LLMRateLimiter({
        fastPoolMax: 10,
        streamingPoolMax: 10,
        providerRPM: { deepseek: 1 }, // 1 RPM
        tokenWaitTimeout: 100, // 100ms 超时
      });

      // 先消耗令牌
      await strictLimiter.execute('deepseek', 'fast', async () => 'r1');

      // 第二次请求应因令牌不足而超时
      await expect(
        strictLimiter.execute('deepseek', 'fast', async () => 'r2'),
      ).rejects.toThrow('API 请求速率超限');
    }, 10000);
  });

  // ==================== 状态查询 ====================

  describe('getStatus', () => {
    it('应返回各池和令牌桶状态', () => {
      const status = limiter.getStatus();

      expect(status.fastPool).toHaveProperty('running');
      expect(status.fastPool).toHaveProperty('max');
      expect(status.fastPool).toHaveProperty('queueLength');
      expect(status.fastPool.max).toBe(2);

      expect(status.streamingPool).toHaveProperty('running');
      expect(status.streamingPool.max).toBe(1);

      expect(status.tokenBuckets).toHaveProperty('deepseek');
      expect(status.tokenBuckets).toHaveProperty('zhipu');
    });
  });

  // ==================== 配置更新 ====================

  describe('updateConfig', () => {
    it('应更新池大小', () => {
      limiter.updateConfig({ fastPoolMax: 5 });
      const status = limiter.getStatus();
      expect(status.fastPool.max).toBe(5);
    });

    it('应更新 provider RPM', () => {
      limiter.updateConfig({ providerRPM: { deepseek: 120 } });
      const status = limiter.getStatus();
      expect(status.tokenBuckets.deepseek).toBeDefined();
    });

    it('应添加新 provider 的令牌桶', () => {
      limiter.updateConfig({ providerRPM: { openai: 60 } });
      const status = limiter.getStatus();
      expect(status.tokenBuckets).toHaveProperty('openai');
    });

    it('调整 provider RPM 应原地改速率，不重置令牌桶', async () => {
      const l = new LLMRateLimiter({
        fastPoolMax: 10,
        streamingPoolMax: 10,
        providerRPM: { deepseek: 2 },
        tokenWaitTimeout: 100,
        queueWaitTimeout: 5000,
      });
      await l.execute('deepseek', 'fast', async () => 'a');
      await l.execute('deepseek', 'fast', async () => 'b'); // 令牌抽干

      // 提高 RPM：若重建为满桶会立刻放行 60 个突发请求，正好打爆上游配额
      l.updateConfig({ providerRPM: { deepseek: 60 } });
      await expect(
        l.execute('deepseek', 'fast', async () => 'c'),
      ).rejects.toThrow('速率超限');
    }, 10000);

    it('tokenWaitTimeout 运行时调整应立即生效', async () => {
      const l = new LLMRateLimiter({
        fastPoolMax: 10,
        streamingPoolMax: 10,
        providerRPM: { deepseek: 60 },
        tokenWaitTimeout: 100,
        queueWaitTimeout: 5000,
      });
      // 抽干 60 个初始令牌（RPM 60 → 每秒回补 1 个）
      for (let i = 0; i < 60; i += 1) {
        await l.execute('deepseek', 'fast', async () => i);
      }
      await expect(
        l.execute('deepseek', 'fast', async () => 'x'),
      ).rejects.toThrow('速率超限');

      l.updateConfig({ tokenWaitTimeout: 3000 });
      await expect(
        l.execute('deepseek', 'fast', async () => 'ok'),
      ).resolves.toBe('ok');
    }, 15000);

    it('非法配置值应被忽略并保留原值', () => {
      limiter.updateConfig({ fastPoolMax: 0 });
      expect(limiter.getStatus().fastPool.max).toBe(2); // beforeEach 构造时的原值
      limiter.updateConfig({ streamingPoolMax: -1 });
      expect(limiter.getStatus().streamingPool.max).toBe(1);
      limiter.updateConfig({ providerRPM: { deepseek: 0 } });
      expect(limiter.getStatus().tokenBuckets.deepseek).toBeDefined();
    });
  });
});

describe('全局限流器工具函数', () => {
  it('getRateLimiterStatus 应返回状态', () => {
    const status = getRateLimiterStatus();
    expect(status).toHaveProperty('fastPool');
    expect(status).toHaveProperty('streamingPool');
    expect(status).toHaveProperty('tokenBuckets');
  });

  it('updateRateLimiterConfig 应更新配置', () => {
    updateRateLimiterConfig({ fastPoolMax: 20 });
    const status = getRateLimiterStatus();
    expect(status.fastPool.max).toBe(20);
    // 恢复默认
    updateRateLimiterConfig({ fastPoolMax: 10 });
  });
});

// ==================== 辅助函数 ====================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
