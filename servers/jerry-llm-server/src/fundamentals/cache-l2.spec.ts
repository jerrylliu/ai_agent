/**
 * LRUCache 的 L2（Redis）二级缓存专项测试
 *
 * 与 cache.spec.ts 分开：那边跑在 REDIS_ENABLED=false 的真实环境下，只能验证
 * 「Redis 不可用时短路降级」；这边用可控的假 Redis 验证 L2 真正工作时的行为 ——
 * key 形态（结构版本号 + 世代号）、故障降级、以及失败日志节流。
 *
 * 日志节流单独测的原因：Redis 挂掉 1 小时 × 10 次检索/秒 = 36000 条 warn，
 * 一个「加速层挂了」的小故障会顺着日志管道扩散成「Loki 挂了」的大故障。
 */

// ==================== Mocks ====================

interface FakeRedisState {
  ready: boolean;
  store: Map<string, string>;
  /** 非 null 时所有 GET 抛此错误 */
  getError: Error | null;
  /** 非 null 时所有 SET 抛此错误 */
  setError: Error | null;
  getCalls: string[];
  setCalls: string[];
}

const redisState: FakeRedisState = {
  ready: false,
  store: new Map(),
  getError: null,
  setError: null,
  getCalls: [],
  setCalls: [],
};

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./redis-client', () => ({
  isRedisReady: () => redisState.ready,
  getRedis: () => {
    if (!redisState.ready) return null;
    return {
      // 注意：不能写成 async —— 这里靠「同步 throw」模拟 Redis 报错，
      // 显式 Promise.reject 才能保留同样的 rejected Promise 语义（async 会被 require-await 拦下）
      get: (key: string) => {
        redisState.getCalls.push(key);
        if (redisState.getError) return Promise.reject(redisState.getError);
        const v = redisState.store.get(key);
        return Promise.resolve(v === undefined ? null : v);
      },
      set: (key: string, value: string) => {
        redisState.setCalls.push(key);
        if (redisState.setError) return Promise.reject(redisState.setError);
        redisState.store.set(key, value);
        return Promise.resolve('OK');
      },
    };
  },
}));

// runtime-config 的 mock 与 cache.spec.ts 保持一致
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
  },
}));

import { logger } from './logger';
import { LRUCache } from './cache';

const warnMock = logger.warn as jest.Mock;

/**
 * 取出第 n 次 warn 的结构化 meta。
 * jest.Mock 的 calls 是 any[][]，直接点属性会触发 no-unsafe-member-access，
 * 这里统一显式收窄成 Record<string, unknown>。
 */
const warnMeta = (n: number): Record<string, unknown> => {
  const calls = warnMock.mock.calls as unknown[][];
  return (calls[n]?.[1] ?? {}) as Record<string, unknown>;
};

/** 等待未 await 的 Redis 写（advanceGeneration 里的 void redis.set）落地 */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** 当前 L2 结构版本号，与 cache.ts 的 L2_SCHEMA_VERSION 对应 */
const SCHEMA = 'v2';

function makeCache(namespace = 'test-ns'): LRUCache<string> {
  // (maxEntries, maxItemSize, defaultTTL, maxTotalSize, namespace)
  return new LRUCache<string>(
    100,
    50 * 1024,
    60_000,
    32 * 1024 * 1024,
    namespace,
  );
}

describe('LRUCache L2（Redis 二级缓存）', () => {
  beforeEach(() => {
    redisState.ready = true;
    redisState.store.clear();
    redisState.getError = null;
    redisState.setError = null;
    redisState.getCalls = [];
    redisState.setCalls = [];
    warnMock.mockClear();
    jest.restoreAllMocks();
  });

  // ==================== key 形态 ====================

  describe('L2 key 形态', () => {
    it('写入的 key 应内嵌结构版本号与世代号', async () => {
      const cache = makeCache();
      await cache.setAsync('k1', 'v1');

      const dataKeys = [...redisState.store.keys()].filter(
        (k) => !k.endsWith(':gen'),
      );
      expect(dataKeys).toEqual([`test-ns:${SCHEMA}:g0:k1`]);
    });

    it('结构版本号变更应让旧 key 立刻不可达（部署后不读到旧结构）', async () => {
      const cache = makeCache();
      // 手工塞一条「上一个版本」写入的数据
      redisState.store.set(
        'test-ns:v1:g0:k1',
        JSON.stringify({ legacy: true }),
      );

      await expect(cache.getAsync('k1')).resolves.toBeUndefined();
      expect(cache.getStats().l2Hits).toBe(0);
    });

    it('应从 Redis 载入已有世代号，接续上一轮进程', async () => {
      redisState.store.set('test-ns:gen', '7');
      const cache = makeCache();

      await cache.setAsync('k1', 'v1');
      expect(redisState.store.has('test-ns:v2:g7:k1')).toBe(true);
      expect(cache.getStats().l2Enabled).toBe(true);
    });

    it('世代号非法时应回退到 0', async () => {
      redisState.store.set('test-ns:gen', 'not-a-number');
      const cache = makeCache();

      await cache.setAsync('k1', 'v1');
      expect(redisState.store.has('test-ns:v2:g0:k1')).toBe(true);
    });
  });

  // ==================== 世代号失效 ====================

  describe('clear() 的世代号失效', () => {
    it('clear 后旧世代的数据应读不到，新写入落到新世代', async () => {
      const cache = makeCache();
      await cache.setAsync('k1', 'v1');
      expect(redisState.store.has('test-ns:v2:g0:k1')).toBe(true);

      cache.clear('知识库更新');
      await flush();

      // 世代号已写回 Redis，重启后的新进程也能接续
      expect(redisState.store.get('test-ns:gen')).toBe('1');

      // L1 已清空、L2 旧 key 因世代号推进而不可达 → miss
      await expect(cache.getAsync('k1')).resolves.toBeUndefined();

      await cache.setAsync('k1', 'v2');
      expect(redisState.store.has('test-ns:v2:g1:k1')).toBe(true);
      await expect(cache.getAsync('k1')).resolves.toBe('v2');
    });

    it('世代号尚未载入时 clear 应记为待办，载入后补做自增', async () => {
      redisState.store.set('test-ns:gen', '3');
      const cache = makeCache();

      // 还没发生过任何 L2 访问 → 世代号未载入
      cache.clear('启动即失效');
      await flush();
      // 不得用凭空的小号覆盖 Redis 中更大的号，否则旧 key 会重新可达
      expect(redisState.store.get('test-ns:gen')).toBe('3');

      await cache.setAsync('k1', 'v1');
      await flush();
      expect(redisState.store.get('test-ns:gen')).toBe('4');
      expect(redisState.store.has('test-ns:v2:g4:k1')).toBe(true);
    });

    it('世代号写入失败不应让 clear() 抛错（clear 挂在事件总线监听器上）', async () => {
      const cache = makeCache();
      await cache.setAsync('k1', 'v1');

      redisState.setError = new Error('redis down');
      // EventEmitter 监听器同步抛错会中断 emit，波及同一事件的其他监听器
      expect(() => cache.clear('知识库更新')).not.toThrow();
      await flush();

      expect(cache.getStats().l2Errors).toBeGreaterThan(0);
    });
  });

  // ==================== 故障降级 ====================

  describe('Redis 故障降级', () => {
    it('L2 读取抛错时 getAsync 应降级为 miss，不向上抛', async () => {
      const cache = makeCache();
      await cache.setAsync('k1', 'v1'); // 先让世代号正常载入

      redisState.getError = new Error('connection reset');
      // L1 也被清掉，强制走 L2
      cache.clear();
      redisState.getError = new Error('connection reset');

      await expect(cache.getAsync('k1')).resolves.toBeUndefined();
      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.l2Errors).toBeGreaterThan(0);
    });

    it('L2 写入抛错时 setAsync 仍应成功（L1 已写入）', async () => {
      const cache = makeCache();
      redisState.setError = new Error('OOM command not allowed');

      await expect(cache.setAsync('k1', 'v1')).resolves.toBe(true);
      expect(cache.get('k1')).toBe('v1');
      expect(cache.getStats().l2Errors).toBeGreaterThan(0);
    });

    it('世代号载入抛错时应跳过 L2 且 l2Enabled 为 false', async () => {
      redisState.getError = new Error('NOAUTH');
      const cache = makeCache();

      await expect(cache.getAsync('k1')).resolves.toBeUndefined();
      expect(cache.getStats().l2Enabled).toBe(false);
      expect(cache.getStats().l2Errors).toBe(1);
    });

    it('Redis 恢复后应能自动接上，无需重启进程', async () => {
      redisState.getError = new Error('NOAUTH');
      const cache = makeCache();
      await expect(cache.getAsync('k1')).resolves.toBeUndefined();
      expect(cache.getStats().l2Enabled).toBe(false);

      redisState.getError = null;
      await cache.setAsync('k1', 'v1');
      expect(cache.getStats().l2Enabled).toBe(true);
      expect(redisState.store.has('test-ns:v2:g0:k1')).toBe(true);
    });

    it('isRedisReady 为 false 时不应触碰 Redis', async () => {
      redisState.ready = false;
      const cache = makeCache();

      await cache.setAsync('k1', 'v1');
      await expect(cache.getAsync('k1')).resolves.toBe('v1');

      expect(redisState.getCalls).toEqual([]);
      expect(redisState.setCalls).toEqual([]);
      expect(cache.getStats().l2Enabled).toBe(false);
      expect(warnMock).not.toHaveBeenCalled();
    });
  });

  // ==================== 失败日志节流 ====================

  describe('L2 失败日志节流', () => {
    it('60 秒内的多次失败只应输出 1 条 warn，但 l2Errors 照常累加', async () => {
      const cache = makeCache();
      redisState.getError = new Error('redis down');

      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      await cache.getAsync('k1'); // 第 1 次 → 放行
      now.mockReturnValue(1_500);
      await cache.getAsync('k2'); // 被压掉
      now.mockReturnValue(2_000);
      await cache.getAsync('k3'); // 被压掉

      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMeta(0).suppressedSinceLastWarn).toBe(0);
      // 计数器不节流：这是判断故障规模的唯一准确信号
      expect(cache.getStats().l2Errors).toBe(3);
    });

    it('超过间隔后应放行新的一条，并带上期间被压掉的条数', async () => {
      const cache = makeCache();
      redisState.getError = new Error('redis down');

      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      await cache.getAsync('k1');
      now.mockReturnValue(1_500);
      await cache.getAsync('k2');
      now.mockReturnValue(2_000);
      await cache.getAsync('k3');
      // 距上一条恰好 60s → 放行
      now.mockReturnValue(61_000);
      await cache.getAsync('k4');

      expect(warnMock).toHaveBeenCalledTimes(2);
      expect(warnMeta(1).suppressedSinceLastWarn).toBe(2);
      expect(warnMeta(1).l2ErrorsTotal).toBe(4);

      // 放行后计数归零，重新进入下一个节流窗口
      now.mockReturnValue(61_500);
      await cache.getAsync('k5');
      expect(warnMock).toHaveBeenCalledTimes(2);
    });

    it('不同缓存实例应各自独立节流', async () => {
      redisState.getError = new Error('redis down');
      const a = makeCache('ns-a');
      const b = makeCache('ns-b');

      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      await a.getAsync('k');
      await b.getAsync('k');

      expect(warnMock).toHaveBeenCalledTimes(2);
    });
  });
});
