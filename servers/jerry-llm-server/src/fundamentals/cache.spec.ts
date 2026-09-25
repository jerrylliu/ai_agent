/**
 * LRU 缓存单元测试
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
  LRUCache,
  searchCache,
  getCacheStats,
  updateCacheConfig,
  clearCache,
} from './cache';
import { eventBus } from './event-bus';

describe('LRUCache', () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    cache = new LRUCache<string>(3, 1024, 60 * 1000); // 3 条上限，1KB/条，1 分钟 TTL
  });

  describe('基本读写', () => {
    it('set 后 get 应返回对应值', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('未设置的 key 应返回 undefined', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('覆盖已存在的 key 应返回新值', () => {
      cache.set('key1', 'value1');
      cache.set('key1', 'value2');
      expect(cache.get('key1')).toBe('value2');
    });
  });

  describe('LRU 淘汰', () => {
    it('容量满时淘汰最久未访问的条目', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');

      // 容量已满（3 条），再插入应淘汰 a（最久未访问）
      cache.set('d', '4');

      expect(cache.get('a')).toBeUndefined(); // 被淘汰
      expect(cache.get('b')).toBe('2');
      expect(cache.get('c')).toBe('3');
      expect(cache.get('d')).toBe('4');
    });

    it('访问条目应更新其 LRU 顺序', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');

      // 访问 a，使其变为最近访问
      cache.get('a');

      // 插入新条目，应淘汰 b（现在是最久未访问）
      cache.set('d', '4');

      expect(cache.get('a')).toBe('1'); // a 被访问过，不会被淘汰
      expect(cache.get('b')).toBeUndefined(); // b 被淘汰
      expect(cache.get('c')).toBe('3');
      expect(cache.get('d')).toBe('4');
    });
  });

  describe('TTL 过期', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('TTL 过期后 get 应返回 undefined', () => {
      cache.set('key1', 'value1', 1000); // 1 秒 TTL
      expect(cache.get('key1')).toBe('value1');

      jest.advanceTimersByTime(1001);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('未过期时应正常返回', () => {
      cache.set('key1', 'value1', 5000); // 5 秒 TTL
      jest.advanceTimersByTime(4000);
      expect(cache.get('key1')).toBe('value1');
    });

    it('TTL=0 表示永不过期', () => {
      const foreverCache = new LRUCache<string>(10, 1024, 0);
      foreverCache.set('key1', 'value1');

      jest.advanceTimersByTime(999999999);
      expect(foreverCache.get('key1')).toBe('value1');
    });
  });

  describe('单条大小限制', () => {
    it('超过 maxItemSize 的值不应被缓存', () => {
      const smallCache = new LRUCache<string>(10, 10, 60000); // 10 字节上限
      const longValue = 'a'.repeat(100); // 远超 10 字节

      smallCache.set('big', longValue);
      expect(smallCache.get('big')).toBeUndefined();
    });

    it('不超过 maxItemSize 的值应正常缓存', () => {
      const smallCache = new LRUCache<string>(10, 100, 60000);
      smallCache.set('small', 'hello');
      expect(smallCache.get('small')).toBe('hello');
    });
  });

  // ==================== 容量治理：字节预算 ====================

  describe('字节预算（maxTotalSize）', () => {
    // 条目大小 = Buffer.byteLength(JSON.stringify(value))，
    // 'a'.repeat(20) 序列化后带一对引号，实际 22 字节
    const value22 = (ch: string): string => ch.repeat(20);

    it('超出总预算时应按 LRU 淘汰最旧条目', () => {
      // 预算 50 字节，每条 22 字节 → 只够放 2 条
      const budgetCache = new LRUCache<string>(10, 1024, 60000, 50);
      budgetCache.set('a', value22('a'));
      budgetCache.set('b', value22('b'));
      budgetCache.set('c', value22('c'));

      const stats = budgetCache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.evictedByBudget).toBe(1);
      expect(stats.evictedBySize).toBe(0);
      expect(stats.evictedTotal).toBe(1);
      // 最旧的 a 被淘汰
      expect(budgetCache.get('a')).toBeUndefined();
      expect(budgetCache.get('c')).toBe(value22('c'));
    });

    it('单条体积撑爆整个预算时应拒绝写入，而不是先清空缓存', () => {
      const budgetCache = new LRUCache<string>(10, 1024, 60000, 30);
      budgetCache.set('keep', 'small');

      // 若不前置拦截，淘汰循环会先把 keep 清掉、然后仍然放不下这一条，
      // 结果是「一条永远写不进去的巨型条目顺手清空了全部缓存」
      expect(budgetCache.set('huge', 'a'.repeat(100))).toBe(false);

      const stats = budgetCache.getStats();
      expect(stats.rejectedBudget).toBe(1);
      expect(stats.evictedByBudget).toBe(0);
      expect(budgetCache.get('keep')).toBe('small');
    });

    it('超过单条上限应计入 rejectedOversize 且不淘汰已有条目', () => {
      const smallCache = new LRUCache<string>(10, 10, 60000);
      smallCache.set('keep', 'ok');

      expect(smallCache.set('big', 'a'.repeat(100))).toBe(false);

      const stats = smallCache.getStats();
      expect(stats.rejectedOversize).toBe(1);
      expect(stats.rejectedBudget).toBe(0);
      expect(smallCache.get('keep')).toBe('ok');
    });

    it('调小总预算应追溯淘汰并计入 evictedByConfig', () => {
      const budgetCache = new LRUCache<string>(10, 1024, 60000, 1024);
      budgetCache.set('a', value22('a'));
      budgetCache.set('b', value22('b'));

      // 44 字节 > 30 字节新预算 → 淘汰最旧的 a
      budgetCache.updateConfig({ maxTotalSize: 30 });

      const stats = budgetCache.getStats();
      expect(stats.size).toBe(1);
      expect(stats.evictedByConfig).toBe(1);
      expect(budgetCache.get('b')).toBe(value22('b'));
    });

    it('非法总预算应保留原值', () => {
      const budgetCache = new LRUCache<string>(10, 1024, 60000, 1024);

      budgetCache.updateConfig({ maxTotalSize: 0 });
      expect(budgetCache.getStats().maxTotalSizeKB).toBe(1);

      budgetCache.updateConfig({ maxTotalSize: Number.NaN });
      expect(budgetCache.getStats().maxTotalSizeKB).toBe(1);
    });
  });

  describe('条目大小分布指标', () => {
    it('P95 应暴露被均值掩盖的巨型条目', () => {
      const sizeCache = new LRUCache<string>(30, 4096, 60000);
      // 18 条 3 字节的小条目 + 2 条 1026 字节的大条目
      for (let i = 0; i < 18; i++) sizeCache.set(`s${i}`, 'x');
      sizeCache.set('big1', 'y'.repeat(1024));
      sizeCache.set('big2', 'y'.repeat(1024));

      const stats = sizeCache.getStats();
      expect(stats.size).toBe(20);
      // 均值 (18*3 + 2*1026)/20 ≈ 105 字节 ≈ 0.1KB
      expect(stats.avgEntrySizeKB).toBeCloseTo(0.1, 1);
      // P95 落在大条目上 ≈ 1026 字节 ≈ 1KB，是均值的 10 倍
      expect(stats.p95EntrySizeKB).toBeCloseTo(1, 1);
      expect(stats.p95EntrySizeKB).toBeGreaterThan(stats.avgEntrySizeKB);
    });

    it('空缓存的体积指标应为 0 而非 NaN', () => {
      const stats = new LRUCache<string>(10, 1024, 60000).getStats();
      expect(stats.weightedSizeKB).toBe(0);
      expect(stats.avgEntrySizeKB).toBe(0);
      expect(stats.p95EntrySizeKB).toBe(0);
    });
  });

  // ==================== 防击穿：单飞 ====================

  describe('dedupe（单飞防击穿）', () => {
    it('同一 key 的并发回源只应执行一次', async () => {
      let calls = 0;
      const slow = (): Promise<string> =>
        new Promise((resolve) => {
          calls++;
          setTimeout(() => resolve(`result-${calls}`), 10);
        });

      const results = await Promise.all([
        cache.dedupe('k', slow),
        cache.dedupe('k', slow),
        cache.dedupe('k', slow),
      ]);

      expect(calls).toBe(1);
      expect(results).toEqual(['result-1', 'result-1', 'result-1']);
      // 后到的 2 个请求被合并
      expect(cache.getStats().coalescedRequests).toBe(2);
    });

    it('不同 key 应各自回源，互不合并', async () => {
      let calls = 0;
      const slow = (tag: string): Promise<string> =>
        new Promise((resolve) => {
          calls++;
          setTimeout(() => resolve(tag), 5);
        });

      const [a, b] = await Promise.all([
        cache.dedupe('k1', () => slow('a')),
        cache.dedupe('k2', () => slow('b')),
      ]);

      expect(a).toBe('a');
      expect(b).toBe('b');
      expect(calls).toBe(2);
      expect(cache.getStats().coalescedRequests).toBe(0);
    });

    it('回源抛错后应释放飞行中状态，后续请求可重试', async () => {
      let attempt = 0;
      const failing = (): Promise<string> =>
        Promise.resolve().then(() => {
          attempt++;
          if (attempt === 1) throw new Error('boom');
          return 'ok';
        });

      await expect(cache.dedupe('k', failing)).rejects.toThrow('boom');
      await expect(cache.dedupe('k', failing)).resolves.toBe('ok');
      expect(attempt).toBe(2);
    });

    // 超时是 single-flight 的必要配件：合并把 N 次各自独立的超时机会压成了 1 次，
    // 回源永久挂住时若没有超时，这个 key 会常驻 inflight，后续同 key 请求全部挂死
    // → HTTP 连接堆积 → FD 耗尽 → 单进程下的飞书 / 语音 / 文档生成一起被打死。
    it('回源永久挂住时应超时 reject，并释放 key 让后续请求重试', async () => {
      let calls = 0;
      const fn = (): Promise<string> => {
        calls++;
        return calls === 1
          ? new Promise<string>(() => undefined) // 永不 settle，模拟下游黑洞
          : Promise.resolve('recovered');
      };

      await expect(cache.dedupe('k', fn, 30)).rejects.toThrow(/回源超时/);
      await expect(cache.dedupe('k', fn, 1000)).resolves.toBe('recovered');
      expect(calls).toBe(2);
    });

    it('被合并进来的请求也应一起收到超时，而不是永远挂着', async () => {
      const hanging = (): Promise<string> => new Promise(() => undefined);

      const outcomes = await Promise.allSettled([
        cache.dedupe('k', hanging, 30),
        cache.dedupe('k', hanging, 30),
      ]);

      expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    });

    it('默认应带 30s 超时保险丝，而不是无限等待', async () => {
      // 用极短的自定义超时验证「传参可覆盖默认值」；
      // 默认值本身（30s）不适合在单测里等，靠 single-flight.spec.ts 覆盖机制
      const hanging = (): Promise<string> => new Promise(() => undefined);
      await expect(cache.dedupe('k', hanging, 20)).rejects.toThrow(
        /回源超时（20ms）/,
      );
    });

    // 超时次数必须能从 getStats() 透出：它是「上游 Embedding / 向量库开始变慢」
    // 的最早预警，比 l2Errors 更早触发，藏在 SingleFlight 内部等于没有可观测性
    it('超时应计入 dedupeTimeouts 指标，resetStats 后归零', async () => {
      expect(cache.getStats().dedupeTimeouts).toBe(0);

      const hanging = (): Promise<string> => new Promise(() => undefined);
      await expect(cache.dedupe('k1', hanging, 20)).rejects.toThrow(/回源超时/);
      await expect(cache.dedupe('k2', hanging, 20)).rejects.toThrow(/回源超时/);

      expect(cache.getStats().dedupeTimeouts).toBe(2);
      // 合并计数与超时计数互不干扰
      expect(cache.getStats().coalescedRequests).toBe(0);

      cache.resetStats();
      expect(cache.getStats().dedupeTimeouts).toBe(0);
    });
  });

  // ==================== L2（Redis）异步读写 ====================

  describe('getAsync / setAsync', () => {
    // 测试环境 REDIS_ENABLED 未开启，isRedisReady() 恒为 false，
    // L2 读写必须短路且不抛错——缓存是加速层，它不可用不能拖垮检索链路
    it('Redis 未就绪时应降级为纯 L1', async () => {
      await cache.setAsync('k1', 'v1');
      expect(cache.getStats().l2Enabled).toBe(false);

      await expect(cache.getAsync('k1')).resolves.toBe('v1');
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.l2Hits).toBe(0);
      expect(stats.l2Errors).toBe(0);
    });

    it('未命中应计入 misses 且不重复记账', async () => {
      await expect(cache.getAsync('nonexistent')).resolves.toBeUndefined();

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
      expect(stats.l2Hits).toBe(0);
    });

    it('L1 拒绝写入时 setAsync 应返回 false', async () => {
      const smallCache = new LRUCache<string>(10, 10, 60000);
      await expect(smallCache.setAsync('big', 'a'.repeat(100))).resolves.toBe(
        false,
      );
      expect(smallCache.getStats().rejectedOversize).toBe(1);
    });
  });

  describe('缓存统计', () => {
    it('应正确统计命中和未命中次数', () => {
      cache.set('key1', 'value1');

      cache.get('key1'); // 命中
      cache.get('key1'); // 命中
      cache.get('nonexistent'); // 未命中

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it('应正确统计条目数', () => {
      cache.set('a', '1');
      cache.set('b', '2');

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(3);
    });

    it('命中率在无访问时应为 0', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });

    it('resetStats 应重置计数器', () => {
      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('nonexistent');

      cache.resetStats();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('clear', () => {
    it('应清空所有缓存条目', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.clear();

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('构造参数兜底', () => {
    it('非法构造参数应回退到模块默认值', () => {
      // maxEntries=0 会让淘汰循环的退出条件恒真，必须在构造阶段就 clamp 掉
      const bad = new LRUCache<string>(0, -1, 60000);
      expect(bad.getStats().maxSize).toBe(200);

      // maxItemSize=-1 若未 clamp，任何条目都会被判为超限而拒绝缓存
      bad.set('k', 'hello');
      expect(bad.get('k')).toBe('hello');
    });
  });

  describe('updateConfig', () => {
    it('缩小 maxEntries 应淘汰多余条目', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');

      cache.updateConfig({ maxEntries: 1 });

      const stats = cache.getStats();
      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(1);
      // 只有最近访问的 c 应该保留
      expect(cache.get('c')).toBe('3');
    });

    it('更新 maxItemSize 不应立即淘汰已有条目', () => {
      cache.set('a', '1');
      cache.updateConfig({ maxItemSize: 1 }); // 缩小到 1 字节
      // 已有条目不会被立即淘汰，但新条目受新限制
      expect(cache.get('a')).toBe('1');
    });

    it('更新 defaultTTL 应影响后续 set 操作', () => {
      jest.useFakeTimers();
      cache.updateConfig({ defaultTTL: 1000 }); // 1 秒
      cache.set('key1', 'value1');

      jest.advanceTimersByTime(1001);
      expect(cache.get('key1')).toBeUndefined();
      jest.useRealTimers();
    });

    it('maxEntries 非法值应被忽略，后续 set 不得死循环', () => {
      cache.set('a', '1');
      cache.updateConfig({ maxEntries: 0 }); // 非法：淘汰循环退出条件会恒真
      expect(cache.getStats().maxSize).toBe(3); // 保留原值

      // 未 clamp 的话这里会 while 死循环，直接阻塞事件循环导致进程假死
      cache.set('b', '2');
      expect(cache.get('b')).toBe('2');
    });
  });

  describe('makeKey', () => {
    it('相同 query + filter 应生成相同 key', () => {
      const key1 = LRUCache.makeKey('hello', { type: 'doc' });
      const key2 = LRUCache.makeKey('hello', { type: 'doc' });
      expect(key1).toBe(key2);
    });

    it('不同 query 应生成不同 key', () => {
      const key1 = LRUCache.makeKey('hello');
      const key2 = LRUCache.makeKey('world');
      expect(key1).not.toBe(key2);
    });

    it('不同 filter 应生成不同 key', () => {
      const key1 = LRUCache.makeKey('hello', { type: 'a' });
      const key2 = LRUCache.makeKey('hello', { type: 'b' });
      expect(key1).not.toBe(key2);
    });

    it('filter 键序不同应生成相同 key', () => {
      // JSON.stringify 按插入序输出，键序不同会产生不同 key，导致同一查询缓存永不命中
      const key1 = LRUCache.makeKey('hello', { type: 'doc', topK: 5 });
      const key2 = LRUCache.makeKey('hello', { topK: 5, type: 'doc' });
      expect(key1).toBe(key2);
    });

    it('嵌套 filter 的键序不同也应生成相同 key', () => {
      const key1 = LRUCache.makeKey('hello', { meta: { a: 1, b: 2 } });
      const key2 = LRUCache.makeKey('hello', { meta: { b: 2, a: 1 } });
      expect(key1).toBe(key2);
    });

    it('无 filter 和空 filter 应生成相同 key', () => {
      const key1 = LRUCache.makeKey('hello');
      const key2 = LRUCache.makeKey('hello', undefined);
      expect(key1).toBe(key2);
    });

    it('key 长度应为 16 字符', () => {
      const key = LRUCache.makeKey('hello');
      expect(key).toHaveLength(16);
    });

    it('归一化：多空格应生成相同 key', () => {
      const key1 = LRUCache.makeKey('AI Agent 开发');
      const key2 = LRUCache.makeKey('AI Agent  开发');
      expect(key1).toBe(key2);
    });

    it('归一化：大小写应生成相同 key', () => {
      const key1 = LRUCache.makeKey('Hello World');
      const key2 = LRUCache.makeKey('hello world');
      expect(key1).toBe(key2);
    });

    it('归一化：前后空格应生成相同 key', () => {
      const key1 = LRUCache.makeKey('hello');
      const key2 = LRUCache.makeKey('  hello  ');
      expect(key1).toBe(key2);
    });
  });

  describe('事件驱动失效', () => {
    it('knowledge-base-updated 事件应清空缓存', () => {
      cache.set('a', '1');
      cache.set('b', '2');

      eventBus.emit('knowledge-base-updated', '测试');

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });
  });
});

describe('全局缓存实例和工具函数', () => {
  afterEach(() => {
    clearCache('测试清理');
  });

  it('getCacheStats 应返回 searchCache 的统计', () => {
    const stats = getCacheStats();
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
    expect(stats).toHaveProperty('hitRate');
    expect(stats).toHaveProperty('size');
  });

  it('updateCacheConfig 应更新配置', () => {
    updateCacheConfig({ maxEntries: 50 });
    const stats = getCacheStats();
    expect(stats.maxSize).toBe(50);
    // 恢复默认
    updateCacheConfig({ maxEntries: 200 });
  });

  it('clearCache 应清空缓存', () => {
    searchCache.set('test-key', 'test-value');
    clearCache('测试');
    expect(searchCache.get('test-key')).toBeUndefined();
  });
});
