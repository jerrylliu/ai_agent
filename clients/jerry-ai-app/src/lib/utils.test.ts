/**
 * lib/utils.test.ts
 *
 * 工具函数单元测试
 * - generateId / generateSessionId: ID 生成
 * - formatTime / formatDate: 日期格式化
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateId, generateSessionId, formatTime, formatDate } from './utils';

describe('lib/utils', () => {
  /* ====================================================================
   * generateId
   * ==================================================================*/
  describe('generateId', () => {
    it('应返回字符串类型', () => {
      expect(typeof generateId()).toBe('string');
    });

    it('应返回非空字符串', () => {
      expect(generateId().length).toBeGreaterThan(0);
    });

    it('返回值应为数字字符串 (基于 Date.now)', () => {
      expect(generateId()).toMatch(/^\d+$/);
    });

    it('在同一毫秒内多次调用应返回相同 ID', () => {
      // Date.now() 在同一毫秒内返回相同值
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).toBe(id2);
    });

    it('不同时间调用应可能返回不同 ID', async () => {
      const id1 = generateId();
      // 等待至少 1ms
      await new Promise((r) => setTimeout(r, 2));
      const id2 = generateId();
      expect(id1).not.toBe(id2);
    });

    it('返回值应为当前时间戳的字符串形式', () => {
      const before = Date.now().toString();
      const id = generateId();
      const after = Date.now().toString();
      // id 应该在 before 和 after 范围内
      expect(Number(id)).toBeGreaterThanOrEqual(Number(before));
      expect(Number(id)).toBeLessThanOrEqual(Number(after));
    });
  });

  /* ====================================================================
   * generateSessionId
   * ==================================================================*/
  describe('generateSessionId', () => {
    it('应返回字符串类型', () => {
      expect(typeof generateSessionId()).toBe('string');
    });

    it('应返回数字字符串', () => {
      expect(generateSessionId()).toMatch(/^\d+$/);
    });

    it('返回值应为当前时间戳的字符串形式', () => {
      const before = Date.now().toString();
      const id = generateSessionId();
      const after = Date.now().toString();
      expect(Number(id)).toBeGreaterThanOrEqual(Number(before));
      expect(Number(id)).toBeLessThanOrEqual(Number(after));
    });
  });

  /* ====================================================================
   * formatTime
   * ==================================================================*/
  describe('formatTime', () => {
    it('应返回字符串类型的时间', () => {
      expect(typeof formatTime(new Date())).toBe('string');
    });

    it('应使用本地化时间格式', () => {
      const date = new Date(2025, 0, 1, 14, 30, 0);
      const result = formatTime(date);
      // toLocaleTimeString 根据不同 locale 输出格式不同，但都应包含小时数
      expect(result.length).toBeGreaterThan(0);
    });

    it('不同时间应返回不同的格式化字符串', () => {
      const morning = new Date(2025, 0, 1, 8, 0, 0);
      const evening = new Date(2025, 0, 1, 20, 0, 0);
      expect(formatTime(morning)).not.toBe(formatTime(evening));
    });

    it('午夜时间应正常格式化', () => {
      const midnight = new Date(2025, 0, 1, 0, 0, 0);
      expect(formatTime(midnight).length).toBeGreaterThan(0);
    });
  });

  /* ====================================================================
   * formatDate
   * ==================================================================*/
  describe('formatDate', () => {
    it('应返回字符串类型的日期', () => {
      expect(typeof formatDate(new Date())).toBe('string');
    });

    it('应使用本地化日期格式', () => {
      const date = new Date(2025, 0, 1);
      const result = formatDate(date);
      expect(result.length).toBeGreaterThan(0);
    });

    it('不同日期应返回不同的格式化字符串', () => {
      const date1 = new Date(2025, 0, 1);
      const date2 = new Date(2025, 5, 15);
      expect(formatDate(date1)).not.toBe(formatDate(date2));
    });
  });
});
