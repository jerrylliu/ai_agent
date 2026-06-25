// 注入测试环境变量，避免 config 启动校验失败
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Redis 不可用：死信走内存兜底
jest.mock('./redis-client.js', () => ({
  getRedis: () => null,
  isRedisReady: () => false,
}));

import {
  isRetryable,
  deliverWithRetry,
  peekDeadLetters,
  __resetRateLimiterForTest,
  __resetDeadLettersForTest,
  type FeishuApiResult,
} from './feishu-delivery';

describe('feishu-delivery（F4：重试 + 限流 + 死信）', () => {
  beforeEach(() => {
    __resetRateLimiterForTest();
    __resetDeadLettersForTest();
  });

  describe('isRetryable', () => {
    it('网络错误可重试', () => {
      expect(isRetryable({ code: -1, networkError: true })).toBe(true);
    });
    it('HTTP 429 可重试', () => {
      expect(isRetryable({ code: 0, httpStatus: 429 })).toBe(true);
    });
    it('HTTP 5xx 可重试', () => {
      expect(isRetryable({ code: 0, httpStatus: 503 })).toBe(true);
    });
    it('飞书限流码 99991400 可重试', () => {
      expect(isRetryable({ code: 99991400, httpStatus: 200 })).toBe(true);
    });
    it('token 失效码 99991663 可重试', () => {
      expect(isRetryable({ code: 99991663, httpStatus: 200 })).toBe(true);
    });
    it('业务错误（收件人不存在）不可重试', () => {
      expect(isRetryable({ code: 230002, httpStatus: 200 })).toBe(false);
    });
  });

  describe('deliverWithRetry', () => {
    it('首次成功直接返回，不重试', async () => {
      const fn = jest.fn().mockResolvedValue({ code: 0, httpStatus: 200 } as FeishuApiResult);
      const r = await deliverWithRetry(fn, { op: 'test' });
      expect(r.code).toBe(0);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('可重试错误后成功：重试到成功为止', async () => {
      const fn = jest
        .fn()
        .mockResolvedValueOnce({ code: 0, httpStatus: 503 } as FeishuApiResult)
        .mockResolvedValueOnce({ code: 0, httpStatus: 200 } as FeishuApiResult);
      const r = await deliverWithRetry(fn, { op: 'test' });
      expect(r.httpStatus).toBe(200);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('不可重试错误：立即返回，不重试，不进死信', async () => {
      const fn = jest.fn().mockResolvedValue({ code: 230002, httpStatus: 200 } as FeishuApiResult);
      const r = await deliverWithRetry(fn, { op: 'test' });
      expect(r.code).toBe(230002);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(await peekDeadLetters()).toHaveLength(0);
    });

    it('可重试错误重试耗尽：进入死信队列', async () => {
      const fn = jest.fn().mockResolvedValue({ code: 0, httpStatus: 503 } as FeishuApiResult);
      await deliverWithRetry(fn, { op: 'sendCardMessage', receiveId: 'oc_1' });
      // 首次 + 3 次重试 = 4 次
      expect(fn).toHaveBeenCalledTimes(4);
      const dead = await peekDeadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0].op).toBe('sendCardMessage');
      expect(dead[0].attempts).toBe(4);
    });

    it('网络异常重试耗尽：进入死信队列', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
      const r = await deliverWithRetry(fn, { op: 'sendImageMessage' });
      expect(r.networkError).toBe(true);
      expect(fn).toHaveBeenCalledTimes(4);
      const dead = await peekDeadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0].lastError).toContain('ETIMEDOUT');
    });
  });
});
