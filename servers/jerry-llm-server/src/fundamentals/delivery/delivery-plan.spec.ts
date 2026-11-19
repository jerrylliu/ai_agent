/**
 * DeliveryPlan schema 单元测试
 * 覆盖：schema 校验（合法/非法）、协议判断、dedupeKey 生成
 */

import {
  deliveryPlanSchema,
  isFcProtocolUrl,
  isHttpUrl,
  buildDedupeKey,
} from './delivery-plan.js';

describe('delivery-plan', () => {
  describe('deliveryPlanSchema', () => {
    const validPlan = {
      channel: 'email',
      title: '测试邮件',
      content: '正文内容',
      recipients: ['user@qq.com'],
      attachments: [
        { filename: 'spring.png', url: 'fc://image/abc123' },
        { filename: 'report.pdf', url: 'fc://document/doc1' },
      ],
      dedupeKey: 'delivery:sess1:2:0',
      createdAt: 1700000000000,
      source: 'fc-loop',
    };

    it('合法计划应通过校验', () => {
      const r = deliveryPlanSchema.safeParse(validPlan);
      expect(r.success).toBe(true);
    });

    it('channel 非法值应拒绝', () => {
      const r = deliveryPlanSchema.safeParse({ ...validPlan, channel: 'sms' });
      expect(r.success).toBe(false);
    });

    it('title 为空应拒绝', () => {
      const r = deliveryPlanSchema.safeParse({ ...validPlan, title: '' });
      expect(r.success).toBe(false);
    });

    it('dedupeKey 过短应拒绝（防模型传入弱键）', () => {
      const r = deliveryPlanSchema.safeParse({ ...validPlan, dedupeKey: 'x' });
      expect(r.success).toBe(false);
    });

    it('source 非法值应拒绝', () => {
      const r = deliveryPlanSchema.safeParse({ ...validPlan, source: 'magic' });
      expect(r.success).toBe(false);
    });

    it('attachments 超过 20 个应拒绝', () => {
      const many = Array.from({ length: 21 }, (_, i) => ({
        filename: `f${i}.png`,
        url: `fc://image/k${i}`,
      }));
      const r = deliveryPlanSchema.safeParse({ ...validPlan, attachments: many });
      expect(r.success).toBe(false);
    });
  });

  describe('isFcProtocolUrl / isHttpUrl', () => {
    it.each([
      'fc://image/abc',
      'fc://chart/abc',
      'fc://mindmap/abc',
      'fc://document/20261119_abc',
    ])('fc 协议 %s 应识别为 true', (url) => {
      expect(isFcProtocolUrl(url)).toBe(true);
    });

    it.each([
      'https://example.com/a.png',
      'http://oss.example.com/b.pdf',
      'ftp://example.com/c',
      'data:image/png;base64,xxx',
      'fc://unknown/xyz', // 未注册的 fc 子协议
      'just-text',
    ])('非注册协议 %s 应识别为 false', (url) => {
      expect(isFcProtocolUrl(url)).toBe(false);
    });

    it.each(['https://x.com/a', 'HTTP://x.com/b'])('http 大小写不敏感 %s', (url) => {
      expect(isHttpUrl(url)).toBe(true);
      expect(isFcProtocolUrl(url)).toBe(false);
    });
  });

  describe('buildDedupeKey', () => {
    it('同会话同轮同序号生成相同键（同轮重试拿到同一键）', () => {
      const k1 = buildDedupeKey('s1', 2, 0);
      const k2 = buildDedupeKey('s1', 2, 0);
      expect(k1).toBe(k2);
    });

    it('不同轮次生成不同键', () => {
      expect(buildDedupeKey('s1', 1, 0)).not.toBe(buildDedupeKey('s1', 2, 0));
    });

    it('不同会话生成不同键', () => {
      expect(buildDedupeKey('s1', 1, 0)).not.toBe(buildDedupeKey('s2', 1, 0));
    });

    it('同轮不同序号生成不同键（一轮多计划互不干扰）', () => {
      expect(buildDedupeKey('s1', 1, 0)).not.toBe(buildDedupeKey('s1', 1, 1));
    });
  });
});
