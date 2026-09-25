/**
 * 分布式锁单元测试
 *
 * 只覆盖 cleanupStaleSessionLocks：这个函数曾长期静默失效
 * （KEYS 的 pattern 不受 ioredis keyPrefix 影响、KEYS 返回值又已含前缀，
 * 于是「匹配不到」和「删错 key」两个问题互相掩盖，清理数恒为 0），
 * 而它没有任何测试保护。这里的假 Redis 刻意**忠实复刻 keyPrefix 语义**，
 * 让同类回归一旦出现就必然失败。
 */

// ==================== Mocks ====================

interface FakeRedisState {
  ready: boolean;
  keyPrefix: string;
  /** 存放的是 Redis 里的原始完整 key（含前缀） */
  store: Map<string, string>;
  delCalls: string[][];
  keysCalls: string[];
  /** 非 null 时 KEYS 抛此错误 */
  keysError: Error | null;
}

const state: FakeRedisState = {
  ready: true,
  keyPrefix: 'jerry:',
  store: new Map(),
  delCalls: [],
  keysCalls: [],
  keysError: null,
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
  isRedisReady: () => state.ready,
  getRedis: () => {
    if (!state.ready) return null;
    const p = state.keyPrefix;
    /** ioredis 只对普通命令的 key 参数加前缀 */
    const withPrefix = (key: string): string => `${p}${key}`;
    /** 把 glob pattern 转成正则（只需支持 * 通配） */
    const globToRe = (pattern: string): RegExp => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
    };
    return {
      options: { keyPrefix: p },
      // 这里刻意不写 async：靠「同步 throw」模拟 Redis 报错，
      // 显式 Promise.reject 才能保留同样的 rejected Promise 语义（async 会被 require-await 拦下）
      // KEYS 的 pattern 参数**不加前缀**，返回值是原始完整 key
      keys: (pattern: string) => {
        state.keysCalls.push(pattern);
        if (state.keysError) return Promise.reject(state.keysError);
        const re = globToRe(pattern);
        return Promise.resolve(
          [...state.store.keys()].filter((k) => re.test(k)),
        );
      },
      del: (...keys: string[]) => {
        state.delCalls.push(keys);
        let removed = 0;
        for (const k of keys) {
          if (state.store.delete(withPrefix(k))) removed++;
        }
        return Promise.resolve(removed);
      },
      get: (key: string) => {
        const v = state.store.get(withPrefix(key));
        return Promise.resolve(v === undefined ? null : v);
      },
      set: (key: string, value: string) => {
        state.store.set(withPrefix(key), value);
        return Promise.resolve('OK');
      },
    };
  },
}));

import { cleanupStaleSessionLocks } from './distributed-lock';

describe('cleanupStaleSessionLocks', () => {
  beforeEach(() => {
    state.ready = true;
    state.keyPrefix = 'jerry:';
    state.store.clear();
    state.delCalls = [];
    state.keysCalls = [];
    state.keysError = null;
  });

  it('KEYS 的 pattern 必须自己带上 keyPrefix，否则匹配不到任何锁', async () => {
    state.store.set('jerry:lock:chat:session:abc', 'token-1');

    const cleaned = await cleanupStaleSessionLocks();

    expect(state.keysCalls).toEqual(['jerry:lock:chat:session:*']);
    expect(cleaned).toBe(1);
  });

  it('DEL 前必须 strip 掉 keyPrefix，否则删的是不存在的 key', async () => {
    state.store.set('jerry:lock:chat:session:abc', 'token-1');
    state.store.set('jerry:lock:chat:session:def', 'token-2');

    const cleaned = await cleanupStaleSessionLocks();

    expect(cleaned).toBe(2);
    expect(state.delCalls).toEqual([
      ['lock:chat:session:abc', 'lock:chat:session:def'],
    ]);
    expect(state.store.size).toBe(0);
  });

  it('不应误删其他命名空间的锁', async () => {
    state.store.set('jerry:lock:chat:session:abc', 'token-1');
    state.store.set('jerry:lock:cron:summary', 'token-2');
    state.store.set('jerry:cache:rag-search:gen', '3');

    const cleaned = await cleanupStaleSessionLocks();

    expect(cleaned).toBe(1);
    expect(state.store.has('jerry:lock:cron:summary')).toBe(true);
    expect(state.store.has('jerry:cache:rag-search:gen')).toBe(true);
  });

  it('没有残留锁时不应调用 DEL', async () => {
    const cleaned = await cleanupStaleSessionLocks();

    expect(cleaned).toBe(0);
    expect(state.delCalls).toEqual([]);
  });

  it('未配置 keyPrefix 时也应正常工作', async () => {
    state.keyPrefix = '';
    state.store.set('lock:chat:session:abc', 'token-1');

    const cleaned = await cleanupStaleSessionLocks();

    expect(state.keysCalls).toEqual(['lock:chat:session:*']);
    expect(cleaned).toBe(1);
    expect(state.store.size).toBe(0);
  });

  it('Redis 未就绪时应直接返回 0，不触碰 Redis', async () => {
    state.ready = false;
    state.store.set('jerry:lock:chat:session:abc', 'token-1');

    await expect(cleanupStaleSessionLocks()).resolves.toBe(0);
    expect(state.keysCalls).toEqual([]);
  });

  it('Redis 抛错时应降级为 0，不能让启动流程失败', async () => {
    state.store.set('jerry:lock:chat:session:abc', 'token-1');
    state.keysError = new Error('Connection is closed');

    await expect(cleanupStaleSessionLocks()).resolves.toBe(0);
    expect(state.store.size).toBe(1);
  });
});
