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
    },
    rateLimiter: {
      fastPoolMax: 10,
      streamingPoolMax: 5,
      tokenWaitTimeout: 10000,
    },
  }),
  updateRuntimeConfig: jest.fn(),
  loadRuntimeConfig: jest.fn(),
  saveRuntimeConfig: jest.fn(),
  DEFAULT_RUNTIME_CONFIG: {
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  },
}));

import { LRUCache, searchCache, getCacheStats, updateCacheConfig, clearCache } from './cache';
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
