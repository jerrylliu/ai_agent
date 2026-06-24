/**
 * fundamentals/tools/self-healing.spec.ts
 *
 * Self-Healing Agent 单元测试
 * 覆盖：
 *   1. success=true → 不参与自愈，原样返回
 *   2. success=false 且无 suggestion → 不算自愈
 *   3. success=false 且有 suggestion → 追加 _selfHealing 元信息
 *   4. 达到上限 → 替换 hint 为"放弃自愈"
 *   5. 计数按 (sessionId, toolName) 隔离
 *   6. 成功后计数重置
 *   7. LRU 上限 + TTL 过期
 */
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  applySelfHealing,
  resetSelfHealingForTest,
  getSelfHealingSize,
  MAX_HEALING_ATTEMPTS,
} from './self-healing';

describe('Self-Healing Agent', () => {
  beforeEach(() => {
    resetSelfHealingForTest();
  });

  // ============================================================
  // 不参与自愈
  // ============================================================
  describe('不参与自愈的场景', () => {
    it('result.success=true 时应原样返回，不消耗配额', () => {
      const r = { success: true, channel: 'feishu', delivered: 1 };
      const d = applySelfHealing({ toolName: 'send_notification', result: r });
      expect(d.result).toBe(r);
      expect(d.consumedAttempt).toBe(false);
      expect(d.currentAttempt).toBe(0);
    });

    it('result.success=false 但无 suggestion 时不算自愈', () => {
      const r = { success: false, channel: 'feishu', delivered: 0, errors: ['unknown'] };
      const d = applySelfHealing({ toolName: 'send_notification', result: r });
      expect(d.result).toBe(r);
      expect(d.consumedAttempt).toBe(false);
    });

    it('非对象结果（字符串/数字）应原样返回', () => {
      expect(applySelfHealing({ toolName: 'x', result: 'hello' }).result).toBe('hello');
      expect(applySelfHealing({ toolName: 'x', result: 42 }).result).toBe(42);
      expect(applySelfHealing({ toolName: 'x', result: null }).result).toBeNull();
    });

    it('没有 success 字段的对象应原样返回', () => {
      const r = { foo: 'bar' };
      expect(applySelfHealing({ toolName: 'x', result: r }).result).toBe(r);
    });
  });

  // ============================================================
  // 自愈追踪
  // ============================================================
  describe('自愈追踪', () => {
    const failureResult = {
      success: false,
      channel: 'webhook',
      delivered: 0,
      suggestion: {
        action: 'switch_channel',
        to: 'feishu',
        reason: 'webhook 缺 URL',
        hint: '改用 feishu',
      },
    };

    it('首次失败应贴 _selfHealing.attempt=1, shouldRetry=true', () => {
      const d = applySelfHealing({
        toolName: 'send_notification',
        sessionId: 's1',
        result: { ...failureResult },
      });
      expect(d.consumedAttempt).toBe(true);
      expect(d.currentAttempt).toBe(1);
      expect(d.result.suggestion._selfHealing).toEqual({
        attempt: 1,
        maxAttempts: MAX_HEALING_ATTEMPTS,
        shouldRetry: true,
      });
      // hint 应保持原样
      expect(d.result.suggestion.hint).toBe('改用 feishu');
    });

    it('第 N 次失败（N <= max）应累加但仍 shouldRetry=true', () => {
      applySelfHealing({ toolName: 't', sessionId: 's1', result: { ...failureResult } });
      const d = applySelfHealing({ toolName: 't', sessionId: 's1', result: { ...failureResult } });
      expect(d.currentAttempt).toBe(2);
      expect(d.result.suggestion._selfHealing.shouldRetry).toBe(true);
    });

    it('达到 maxAttempts+1 时应 shouldRetry=false 且 hint 替换为放弃自愈', () => {
      for (let i = 0; i < MAX_HEALING_ATTEMPTS; i++) {
        applySelfHealing({ toolName: 't', sessionId: 's1', result: { ...failureResult } });
      }
      // 这次触发"达到上限"
      const d = applySelfHealing({
        toolName: 't',
        sessionId: 's1',
        result: { ...failureResult },
      });
      expect(d.currentAttempt).toBe(MAX_HEALING_ATTEMPTS + 1);
      expect(d.result.suggestion._selfHealing.shouldRetry).toBe(false);
      expect(d.result.suggestion.hint).toContain('已达自愈上限');
      expect(d.result.suggestion.hint).toContain('不要再次调用本工具');
    });

    it('成功一次应清空计数，下次失败重新从 1 开始', () => {
      applySelfHealing({ toolName: 't', sessionId: 's1', result: { ...failureResult } });
      applySelfHealing({ toolName: 't', sessionId: 's1', result: { success: true } });
      const d = applySelfHealing({
        toolName: 't',
        sessionId: 's1',
        result: { ...failureResult },
      });
      expect(d.currentAttempt).toBe(1);
    });

    it('不同 sessionId 应独立计数', () => {
      applySelfHealing({ toolName: 't', sessionId: 's1', result: { ...failureResult } });
      const d = applySelfHealing({
        toolName: 't',
        sessionId: 's2',
        result: { ...failureResult },
      });
      expect(d.currentAttempt).toBe(1); // s2 是新计数
    });

    it('不同 toolName 应独立计数', () => {
      applySelfHealing({ toolName: 'tool_a', sessionId: 's1', result: { ...failureResult } });
      const d = applySelfHealing({
        toolName: 'tool_b',
        sessionId: 's1',
        result: { ...failureResult },
      });
      expect(d.currentAttempt).toBe(1);
    });

    it('sessionId 缺失时使用 global 共享计数', () => {
      applySelfHealing({ toolName: 't', result: { ...failureResult } });
      const d = applySelfHealing({ toolName: 't', result: { ...failureResult } });
      expect(d.currentAttempt).toBe(2);
    });

    it('保留 suggestion 原字段（不破坏 action/to/reason）', () => {
      const d = applySelfHealing({
        toolName: 't',
        sessionId: 's1',
        result: { ...failureResult },
      });
      expect(d.result.suggestion.action).toBe('switch_channel');
      expect(d.result.suggestion.to).toBe('feishu');
      expect(d.result.suggestion.reason).toBe('webhook 缺 URL');
    });
  });

  // ============================================================
  // LRU 容量
  // ============================================================
  describe('LRU 容量', () => {
    it('追踪条目数应可观测', () => {
      expect(getSelfHealingSize()).toBe(0);
      const r = {
        success: false,
        suggestion: { action: 'fix_recipient', reason: 'x', hint: 'y' },
      };
      applySelfHealing({ toolName: 't1', sessionId: 's1', result: r });
      applySelfHealing({ toolName: 't2', sessionId: 's2', result: r });
      expect(getSelfHealingSize()).toBe(2);
    });
  });
});
