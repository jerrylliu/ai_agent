/**
 * lib/utils.test.ts
 *
 * 工具函数单元测试
 * - generateId / generateSessionId: ID 生成
 * - formatTime / formatDate: 日期格式化
 * - sanitizeMessageContent: 消息内容渲染兜底清洗（think 块 + 工具调用控制标签）
 */

import { describe, it, expect } from 'vitest';
import { generateId, generateSessionId, formatTime, formatDate, sanitizeMessageContent } from './utils';

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

  /* ====================================================================
   * sanitizeMessageContent
   * ==================================================================*/
  describe('sanitizeMessageContent', () => {
    it('空字符串应原样返回', () => {
      expect(sanitizeMessageContent('')).toBe('');
    });

    it('无控制标签的普通文本应保持不变', () => {
      const text = '普通回答，含 <div> 容器、1 < 2 比较、<code>inline</code> 代码。';
      expect(sanitizeMessageContent(text)).toBe(text);
    });

    it('应移除 think 思考块', () => {
      expect(sanitizeMessageContent('<think>推理过程</think>最终答案')).toBe('最终答案');
    });

    it('应整块移除 DSML 控制块（含参数正文，历史泄漏案例）', () => {
      const text =
        '公开信息里没有直接标注它的纳税人资质，我换个关键词再核实一遍。\n' +
        '<｜DSML｜calls> <｜DSML｜invoke name="search_web"> <｜DSML｜parameter name="query" string="true">七格玛 枣庄 纳税人资质 增值税一般纳税人</｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜calls>';
      expect(sanitizeMessageContent(text)).toBe(
        '公开信息里没有直接标注它的纳税人资质，我换个关键词再核实一遍。\n',
      );
    });

    it('应整块移除裸 XML 方言控制块', () => {
      // 字面 parameter 开/闭标签用拼接构造，避免与工具调用协议标签混淆
      const openParam = '<para' + 'meter name="query">';
      const closeParam = '</' + 'parameter>';
      const text = [
        '先查一下。',
        '<tool_calls>',
        '<invoke name="search_web">',
        openParam + '测试关键词' + closeParam,
        '</invoke>',
        '</tool_calls>',
        '查好了。',
      ].join('\n');
      expect(sanitizeMessageContent(text)).toBe('先查一下。\n\n查好了。');
    });

    it('应整块移除 antml 前缀单数标签控制块', () => {
      const openParam = '<para' + 'meter name="query" string="true">';
      const closeParam = '</' + 'parameter>';
      const text =
        '答案<antml:invoke name="search_web">' + openParam + '关键词' + closeParam + '</antml:invoke>结尾';
      expect(sanitizeMessageContent(text)).toBe('答案结尾');
    });

    it('未闭合开标签应截断其后全部内容', () => {
      const text = '回答开头 <｜DSML｜invoke name="search_web"> <｜DSML｜parameter name="query">abc';
      expect(sanitizeMessageContent(text)).toBe('回答开头 ');
    });

    it('孤立闭标签应仅删除标签本身', () => {
      expect(sanitizeMessageContent('回答结尾 </｜DSML｜calls>')).toBe('回答结尾 ');
    });

    it('控制标签匹配应大小写不敏感', () => {
      expect(sanitizeMessageContent('a<｜DSML｜INVOKE name="x">body</｜DSML｜INVOKE>b')).toBe('ab');
    });
  });
});
