/**
 * fundamentals/multi-level-cache.spec.ts
 *
 * MultiLevelCache 单元测试
 * 覆盖：
 *   1. L1 命中 / L2 命中 / miss 三条读取路径
 *   2. Histogram observe 在三个出口均被调用（layer=L1/L2/miss）
 *   3. L2 异常降级为 miss
 *   4. L1 LRU 淘汰
 *   5. set 不写空值（防穿透污染）
 *   6. touch 续期
 *   7. delete 双写清理
 *   8. TTL 抖动
 *   9. getStats 统计正确
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Mock logger，避免测试日志刷屏
jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { MultiLevelCache } from './multi-level-cache';
import { metrics } from './metrics';

// ==================== 辅助：可控 Redis Mock ====================

interface MockRedis {
  get: jest.Mock;
  set: jest.Mock;
  expire: jest.Mock;
  unlink: jest.Mock;
}

/** 创建一个可控的 mock Redis 客户端 */
function createMockRedis(): MockRedis {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, val: string, _ex?: string, _ttl?: number) => {
      store.set(key, val);
      return 'OK';
    }),
    expire: jest.fn(async (key: string, ttl: number) => {
      return store.has(key) ? 1 : 0;
    }),
    unlink: jest.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };
}

/** 动态控制 getRedis / isRedisReady 的返回值 */
let mockRedis: MockRedis | null = null;
let mockRedisReady = false;

jest.mock('./redis-client', () => ({
  getRedis: () => mockRedis,
  isRedisReady: () => mockRedisReady,
}));

// ==================== 测试 ====================

describe('MultiLevelCache', () => {
  let cache: MultiLevelCache<{ name: string }>;
  let observeSpy: jest.SpyInstance;

  beforeEach(() => {
    // 重置 Redis mock 状态
    mockRedis = createMockRedis();
    mockRedisReady = false;

    cache = new MultiLevelCache<{ name: string }>({
      namespace: 'test',
      ttlSec: 60,
      l1MaxSize: 3,
      ttlJitterRatio: 0,
    });

    // Spy Histogram observe，验证调用参数
    observeSpy = jest.spyOn(metrics.cacheGetDuration, 'observe');
  });

  afterEach(() => {
    observeSpy.mockRestore();
    mockRedis = null;
    mockRedisReady = false;
  });

  // ==================== 读取路径 ====================

  describe('get - 读取路径', () => {
    it('L1 命中时应直接返回值，不查 L2', async () => {
      // 先写入 L1（Redis 不可用，只写 L1）
      await cache.set('k1', { name: 'alice' });
      expect(mockRedis?.set).not.toHaveBeenCalled(); // Redis 不可用，不写 L2

      // 第二次读取应命中 L1
      const result = await cache.get('k1');
      expect(result).toEqual({ name: 'alice' });

      // 统计
      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(1);
      expect(stats.l2Hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('L1 miss 但 L2 命中时应返回值并回填 L1', async () => {
      mockRedisReady = true;
      // 手动往 Redis mock 里写数据
      await mockRedis!.set('test:k2', JSON.stringify({ name: 'bob' }));

      // 清空 L1，确保走 L2
      cache.clearL1ForTest();

      const result = await cache.get('k2');
      expect(result).toEqual({ name: 'bob' });

      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(0);
      expect(stats.l2Hits).toBe(1);
      expect(stats.misses).toBe(0);

      // 再次读取应命中 L1（已被回填）
      const result2 = await cache.get('k2');
      expect(result2).toEqual({ name: 'bob' });
      expect(cache.getStats().l1Hits).toBe(1);
    });

    it('L1 和 L2 都 miss 时应返回 null', async () => {
      mockRedisReady = true;

      const result = await cache.get('nonexistent');
      expect(result).toBeNull();

      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(0);
      expect(stats.l2Hits).toBe(0);
      expect(stats.misses).toBe(1);
    });

    it('L1 过期后应降级查 L2', async () => {
      mockRedisReady = true;
      // 用极短 TTL 创建缓存
      const shortCache = new MultiLevelCache<{ name: string }>({
        namespace: 'short-ttl',
        ttlSec: 1,
        l1MaxSize: 10,
        ttlJitterRatio: 0,
      });

      await shortCache.set('k3', { name: 'charlie' });
      expect(mockRedis!.set).toHaveBeenCalled(); // 写入 L2

      // 等 TTL 过期
      await new Promise((r) => setTimeout(r, 1100));

      // L1 已过期，应走 L2
      const result = await shortCache.get('k3');
      expect(result).toEqual({ name: 'charlie' });

      const stats = shortCache.getStats();
      expect(stats.l1Hits).toBe(0);
      expect(stats.l2Hits).toBe(1);
    });
  });

  // ==================== Histogram observe 验证 ====================

  describe('Histogram observe', () => {
    it('L1 命中时应以 layer=L1 observe', async () => {
      await cache.set('k1', { name: 'alice' });
      observeSpy.mockClear(); // 清掉 set 阶段的调用

      await cache.get('k1');

      expect(observeSpy).toHaveBeenCalledTimes(1);
      const [labels, duration] = observeSpy.mock.calls[0];
      expect(labels).toEqual({ namespace: 'test', layer: 'L1' });
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(0.1); // L1 应在 0.1ms 内
    });

    it('L2 命中时应以 layer=L2 observe', async () => {
      mockRedisReady = true;
      await mockRedis!.set('test:k2', JSON.stringify({ name: 'bob' }));

      await cache.get('k2');

      expect(observeSpy).toHaveBeenCalledTimes(1);
      const [labels] = observeSpy.mock.calls[0];
      expect(labels).toEqual({ namespace: 'test', layer: 'L2' });
    });

    it('miss 时应以 layer=miss observe', async () => {
      mockRedisReady = true;

      await cache.get('nonexistent');

      expect(observeSpy).toHaveBeenCalledTimes(1);
      const [labels] = observeSpy.mock.calls[0];
      expect(labels).toEqual({ namespace: 'test', layer: 'miss' });
    });

    it('Redis 不可用时 miss 也应 observe', async () => {
      mockRedisReady = false;

      await cache.get('nonexistent');

      expect(observeSpy).toHaveBeenCalledTimes(1);
      const [labels] = observeSpy.mock.calls[0];
      expect(labels).toEqual({ namespace: 'test', layer: 'miss' });
    });
  });

  // ==================== L2 异常降级 ====================

  describe('L2 异常降级', () => {
    it('Redis get 抛异常时应降级为 miss，不 crash', async () => {
      mockRedisReady = true;
      mockRedis!.get.mockRejectedValueOnce(new Error('Redis connection lost'));

      const result = await cache.get('k1');
      expect(result).toBeNull();

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.l2Errors).toBe(1);
    });
  });

  // ==================== set 行为 ====================

  describe('set', () => {
    it('null 值不应写入缓存', async () => {
      mockRedisReady = true;
      await cache.set('k1', null);
      await cache.set('k2', undefined);

      expect(mockRedis!.set).not.toHaveBeenCalled();
      const result = await cache.get('k1');
      expect(result).toBeNull();
    });

    it('Redis 不可用时只写 L1，不 crash', async () => {
      mockRedisReady = false;
      await cache.set('k1', { name: 'alice' });

      // L1 应有数据
      const result = await cache.get('k1');
      expect(result).toEqual({ name: 'alice' });
    });

    it('Redis set 抛异常时应记录 l2Errors 但不影响 L1', async () => {
      mockRedisReady = true;
      mockRedis!.set.mockRejectedValueOnce(new Error('Redis write failed'));

      await cache.set('k1', { name: 'alice' });

      // L1 仍应有数据
      const result = await cache.get('k1');
      expect(result).toEqual({ name: 'alice' });

      const stats = cache.getStats();
      expect(stats.l2Errors).toBe(1);
    });
  });

  // ==================== LRU 淘汰 ====================

  describe('L1 LRU 淘汰', () => {
    it('超过 l1MaxSize 时应淘汰最久未访问项', async () => {
      mockRedisReady = false; // 只用 L1
      const smallCache = new MultiLevelCache<number>({
        namespace: 'lru-test',
        ttlSec: 60,
        l1MaxSize: 2,
      });

      await smallCache.set('a', 1);
      await smallCache.set('b', 2);
      await smallCache.set('c', 3); // 应淘汰 'a'

      expect(await smallCache.get('a')).toBeNull(); // 'a' 被淘汰
      expect(await smallCache.get('b')).toBe(2); // 'b' 仍在
      expect(await smallCache.get('c')).toBe(3); // 'c' 仍在
    });

    it('访问后应移到末尾，避免被淘汰', async () => {
      mockRedisReady = false;
      const smallCache = new MultiLevelCache<number>({
        namespace: 'lru-test2',
        ttlSec: 60,
        l1MaxSize: 2,
      });

      await smallCache.set('a', 1);
      await smallCache.set('b', 2);
      await smallCache.get('a'); // 访问 'a'，移到末尾
      await smallCache.set('c', 3); // 应淘汰 'b' 而非 'a'

      expect(await smallCache.get('a')).toBe(1); // 'a' 仍在
      expect(await smallCache.get('b')).toBeNull(); // 'b' 被淘汰
    });
  });

  // ==================== touch 续期 ====================

  describe('touch', () => {
    it('应续期 L1 中已有 key', async () => {
      mockRedisReady = false;
      await cache.set('k1', { name: 'alice' });

      // 续期
      await cache.touch('k1');

      // 统计不应变化（touch 不算 get）
      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('Redis 可用时应同时续期 L2', async () => {
      mockRedisReady = true;
      await cache.set('k1', { name: 'alice' });
      mockRedis!.expire.mockClear();

      await cache.touch('k1');

      expect(mockRedis!.expire).toHaveBeenCalledWith('test:k1', expect.any(Number));
    });

    it('不存在的 key touch 不应 crash', async () => {
      mockRedisReady = true;
      await cache.touch('nonexistent');
      // 不抛异常即可
    });
  });

  // ==================== delete ====================

  describe('delete', () => {
    it('应同时清除 L1 和 L2', async () => {
      mockRedisReady = true;
      await cache.set('k1', { name: 'alice' });

      await cache.delete('k1');

      // L1 应被清除
      expect(await cache.get('k1')).toBeNull();
      // L2 应被清除
      expect(mockRedis!.unlink).toHaveBeenCalledWith('test:k1');
    });

    it('Redis 不可用时只清 L1，不 crash', async () => {
      mockRedisReady = false;
      await cache.set('k1', { name: 'alice' });

      await cache.delete('k1');

      expect(await cache.get('k1')).toBeNull();
    });
  });

  // ==================== getStats ====================

  describe('getStats', () => {
    it('应正确统计 l1Hits / l2Hits / misses / l2Errors', async () => {
      mockRedisReady = true;
      await cache.set('hit1', { name: 'a' });
      await mockRedis!.set('test:hit2', JSON.stringify({ name: 'b' }));

      await cache.get('hit1'); // L1 hit
      await cache.get('hit2'); // L2 hit
      await cache.get('miss'); // miss

      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(1);
      expect(stats.l2Hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.total).toBe(3);
      expect(stats.l1HitRate).toBeCloseTo(0.3333, 3);
      expect(stats.overallHitRate).toBeCloseTo(0.6667, 3);
      expect(stats.l1Size).toBe(2); // hit1 + hit2 回填
      expect(stats.l1MaxSize).toBe(3);
    });

    it('无任何操作时 total=0，命中率为 0', () => {
      const stats = cache.getStats();
      expect(stats.total).toBe(0);
      expect(stats.l1HitRate).toBe(0);
      expect(stats.overallHitRate).toBe(0);
    });
  });

  // ==================== TTL 抖动 ====================

  describe('TTL 抖动', () => {
    it('ttlJitterRatio=0 时 TTL 不抖动', async () => {
      mockRedisReady = true;
      await cache.set('k1', { name: 'a' });
      // set 的第三、四个参数是 'EX' 和 ttl
      const setCall = mockRedis!.set.mock.calls[0];
      expect(setCall[2]).toBe('EX');
      expect(setCall[3]).toBe(60); // 原始 TTL，无抖动
    });

    it('ttlJitterRatio=0.1 时 TTL 在 54~66 范围内', async () => {
      mockRedisReady = true;
      const jitterCache = new MultiLevelCache<{ name: string }>({
        namespace: 'jitter',
        ttlSec: 60,
        ttlJitterRatio: 0.1,
      });

      // 跑 20 次，验证所有 TTL 都在 [54, 66] 范围内
      const ttls: number[] = [];
      for (let i = 0; i < 20; i++) {
        await jitterCache.set(`k${i}`, { name: 'a' });
        const call = mockRedis!.set.mock.calls[mockRedis!.set.mock.calls.length - 1];
        ttls.push(call[3] as number);
      }

      for (const ttl of ttls) {
        expect(ttl).toBeGreaterThanOrEqual(54);
        expect(ttl).toBeLessThanOrEqual(66);
      }

      // 至少应该有一些不同的值（概率性验证）
      const uniqueTtls = new Set(ttls);
      expect(uniqueTtls.size).toBeGreaterThan(1);
    });
  });

  // ==================== clearL1ForTest ====================

  describe('clearL1ForTest', () => {
    it('应清空 L1 和统计计数', async () => {
      mockRedisReady = false;
      await cache.set('k1', { name: 'a' });
      await cache.get('k1'); // L1 hit

      expect(cache.getStats().l1Hits).toBe(1);

      cache.clearL1ForTest();

      expect(cache.getStats().l1Hits).toBe(0);
      expect(cache.getStats().total).toBe(0);
      expect(await cache.get('k1')).toBeNull(); // L1 已清空
    });
  });
});
