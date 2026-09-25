/**
 * SingleFlight（请求合并 / 防缓存击穿）单元测试
 *
 * 重点覆盖超时兜底：单进程架构下，一个永久挂住的回源会通过
 * 「inflight 常驻 → HTTP 连接堆积 → FD 耗尽」把飞书 / 语音 / 文档生成
 * 等完全无关的功能一起打死，因此超时相关的行为必须有测试保护。
 */

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { SingleFlight } from './single-flight';

/** 等待指定毫秒，用于让微任务与定时器落地 */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('SingleFlight', () => {
  let flight: SingleFlight;

  beforeEach(() => {
    flight = new SingleFlight();
  });

  // ==================== 合并语义 ====================

  describe('请求合并', () => {
    it('同一 key 的并发调用只应执行一次回源，后到者共享结果', async () => {
      let calls = 0;
      const slow = (): Promise<string> =>
        new Promise((resolve) => {
          calls++;
          setTimeout(() => resolve(`result-${calls}`), 20);
        });

      const results = await Promise.all([
        flight.do('k', slow),
        flight.do('k', slow),
        flight.do('k', slow),
      ]);

      expect(calls).toBe(1);
      expect(results).toEqual(['result-1', 'result-1', 'result-1']);
      expect(flight.coalescedCount).toBe(2);
      expect(flight.pending).toBe(0);
    });

    it('不同 key 应各自回源，互不合并', async () => {
      let calls = 0;
      const slow = (tag: string): Promise<string> =>
        new Promise((resolve) => {
          calls++;
          setTimeout(() => resolve(tag), 10);
        });

      const [a, b] = await Promise.all([
        flight.do('k1', () => slow('a')),
        flight.do('k2', () => slow('b')),
      ]);

      expect(a).toBe('a');
      expect(b).toBe('b');
      expect(calls).toBe(2);
      expect(flight.coalescedCount).toBe(0);
    });

    it('回源完成后应释放飞行中状态，后续请求重新回源', async () => {
      let calls = 0;
      const fn = (): Promise<number> => Promise.resolve(++calls);

      await expect(flight.do('k', fn)).resolves.toBe(1);
      expect(flight.pending).toBe(0);
      await expect(flight.do('k', fn)).resolves.toBe(2);
    });
  });

  // ==================== 错误传播 ====================

  describe('错误传播', () => {
    it('回源异步抛错时所有共享者都应收到同一个异常', async () => {
      const failing = (): Promise<string> =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('boom')), 10),
        );

      const outcomes = await Promise.allSettled([
        flight.do('k', failing),
        flight.do('k', failing),
      ]);

      expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
      const reasons = outcomes.map((o) =>
        o.status === 'rejected' ? (o.reason as Error).message : null,
      );
      expect(reasons).toEqual(['boom', 'boom']);
      expect(flight.pending).toBe(0);
    });

    it('回源同步抛错也应统一变成 rejected Promise', async () => {
      const throwing = (): Promise<string> => {
        throw new Error('sync-boom');
      };

      await expect(flight.do('k', throwing)).rejects.toThrow('sync-boom');
      expect(flight.pending).toBe(0);
    });

    it('回源抛错后应释放飞行中状态，后续请求可重试', async () => {
      let attempt = 0;
      const failing = (): Promise<string> =>
        Promise.resolve().then(() => {
          attempt++;
          if (attempt === 1) throw new Error('boom');
          return 'ok';
        });

      await expect(flight.do('k', failing)).rejects.toThrow('boom');
      await expect(flight.do('k', failing)).resolves.toBe('ok');
      expect(attempt).toBe(2);
    });
  });

  // ==================== 超时兜底 ====================

  describe('超时兜底', () => {
    it('回源永久挂住时应在 timeoutMs 后 reject 并释放 key', async () => {
      const hanging = (): Promise<string> => new Promise(() => undefined);

      await expect(flight.do('k', hanging, 30)).rejects.toThrow(/回源超时/);
      // key 必须被摘掉，否则后续同 key 请求会永久挂在死 Promise 上
      expect(flight.pending).toBe(0);
      expect(flight.timeoutCount).toBe(1);
    });

    it('被合并进来的请求也应一起收到超时，而不是永远挂着', async () => {
      const hanging = (): Promise<string> => new Promise(() => undefined);

      // leader 与 follower 共享同一个「带超时」的 Promise：
      // 若 inflight 里存的是裸 Promise，超时只救了第一个人
      const outcomes = await Promise.allSettled([
        flight.do('k', hanging, 30),
        flight.do('k', hanging, 30),
        flight.do('k', hanging, 30),
      ]);

      expect(outcomes.map((o) => o.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
      ]);
      expect(flight.coalescedCount).toBe(2);
      expect(flight.timeoutCount).toBe(1);
    });

    it('超时释放后新请求应能重新发起回源', async () => {
      let calls = 0;
      const fn = (): Promise<string> => {
        calls++;
        // 第一次永久挂住，第二次立刻返回
        return calls === 1
          ? new Promise<string>(() => undefined)
          : Promise.resolve('recovered');
      };

      await expect(flight.do('k', fn, 20)).rejects.toThrow(/回源超时/);
      await expect(flight.do('k', fn, 1000)).resolves.toBe('recovered');
      expect(calls).toBe(2);
    });

    it('回源在超时前完成时不应触发超时', async () => {
      const fast = (): Promise<string> =>
        new Promise((resolve) => setTimeout(() => resolve('ok'), 5));

      await expect(flight.do('k', fast, 500)).resolves.toBe('ok');
      expect(flight.timeoutCount).toBe(0);
    });

    it('超时后底层 Promise 再 reject 不应产生 unhandledRejection', async () => {
      const onUnhandled = jest.fn();
      process.on('unhandledRejection', onUnhandled);

      let lateReject: (e: Error) => void = () => undefined;
      const hanging = new Promise<string>((_, reject) => {
        lateReject = reject;
      });

      await expect(flight.do('k', () => hanging, 20)).rejects.toThrow(
        /回源超时/,
      );

      // 放弃等待之后底层请求才失败：没有 catch 的话这里会崩掉整个 Node 进程
      lateReject(new Error('late failure'));
      await wait(60);

      expect(onUnhandled).not.toHaveBeenCalled();
      process.off('unhandledRejection', onUnhandled);
    });

    it('超时释放后新请求的合并保护不应被旧 Promise 迟到 settle 破坏', async () => {
      let releaseFirst: () => void = () => undefined;
      const first = new Promise<string>((resolve) => {
        releaseFirst = () => resolve('first');
      });

      await expect(flight.do('k', () => first, 20)).rejects.toThrow(/回源超时/);
      expect(flight.pending).toBe(0);

      let calls = 0;
      const second = (): Promise<string> =>
        new Promise((resolve) => {
          calls++;
          setTimeout(() => resolve('second'), 30);
        });

      const p2 = flight.do('k', second);
      const p3 = flight.do('k', second);
      expect(flight.pending).toBe(1);

      // 旧 leader 此刻才完成，不得影响新一轮的合并
      releaseFirst();
      await wait(5);
      expect(flight.pending).toBe(1);
      expect(calls).toBe(1);

      await expect(p2).resolves.toBe('second');
      await expect(p3).resolves.toBe('second');
      expect(flight.coalescedCount).toBe(1);
    });

    it('未传 timeoutMs 时不设超时（回源自带超时保护的调用方可用）', async () => {
      const slow = (): Promise<string> =>
        new Promise((resolve) => setTimeout(() => resolve('slow-ok'), 60));

      await expect(flight.do('k', slow)).resolves.toBe('slow-ok');
      expect(flight.timeoutCount).toBe(0);
    });

    it('timeoutMs 为 0 或负数时视为不设超时', async () => {
      const slow = (): Promise<string> =>
        new Promise((resolve) => setTimeout(() => resolve('ok'), 40));

      await expect(flight.do('k1', slow, 0)).resolves.toBe('ok');
      await expect(flight.do('k2', slow, -1)).resolves.toBe('ok');
      expect(flight.timeoutCount).toBe(0);
    });
  });

  // ==================== 统计与重置 ====================

  describe('统计与重置', () => {
    it('resetStats 应清零计数器但不中断进行中的请求', () => {
      const hanging = (): Promise<string> => new Promise(() => undefined);
      const p = flight.do('k', hanging, 1000);
      void flight.do('k', hanging, 1000).catch(() => undefined);

      expect(flight.coalescedCount).toBe(1);
      flight.resetStats();
      expect(flight.coalescedCount).toBe(0);
      // 进行中的请求不受影响，仍挂在同一个 Promise 上
      expect(flight.pending).toBe(1);

      void p.catch(() => undefined);
    });

    it('clearForTest 应清空飞行记录，后续调用不再挂到旧 Promise 上', () => {
      let calls = 0;
      const hanging = (): Promise<string> => {
        calls++;
        return new Promise(() => undefined);
      };

      void flight.do('k', hanging, 1000).catch(() => undefined);
      flight.clearForTest();
      expect(flight.pending).toBe(0);

      void flight.do('k', hanging, 1000).catch(() => undefined);
      expect(calls).toBe(2);
      expect(flight.pending).toBe(1);
    });
  });
});
