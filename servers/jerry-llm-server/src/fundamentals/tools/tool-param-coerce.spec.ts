/**
 * fundamentals/tools/tool-param-coerce.spec.ts
 *
 * schema 导向的全局参数归一化测试：
 * - coerceParamsBySchema 单元测试（内省/还原/下钻/零误伤）
 * - safeParseToolParams 全局安检集成测试（2026-10-12 四起生产案例形态复现）
 *
 * 生产案例的真实 schema 回归分布在各工具的 *.schema.spec.ts 中
 * （它们通过 safeParseToolParams 走与本测试相同的安检路径）
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { z } from 'zod';
import { coerceParamsBySchema } from './tool-param-coerce';
import { safeParseToolParams } from './_helpers';

describe('coerceParamsBySchema（单元）', () => {
  it('期望对象的字段传 JSON 字符串 → 还原并继续下钻', () => {
    const schema = z.object({ cfg: z.object({ a: z.number() }).optional() });
    const r = coerceParamsBySchema(schema, { cfg: '{"a":1}' });
    expect(r.fixes.length).toBe(1);
    expect(r.fixes[0]).toContain('cfg');
    expect(r.data).toEqual({ cfg: { a: 1 } });
  });

  it('期望数组的字段传 JSON 字符串 → 还原并逐元素下钻', () => {
    const schema = z.object({
      steps: z.array(z.object({ description: z.string() })),
    });
    const r = coerceParamsBySchema(schema, {
      steps: '[{"description":"s1","extra":1}]',
    });
    expect(r.fixes.length).toBe(1);
    expect(r.data).toEqual({ steps: [{ description: 's1', extra: 1 }] });
  });

  it('期望 record 的字段传 JSON 字符串 → 还原', () => {
    const schema = z.object({
      data: z.record(z.string(), z.unknown()).optional(),
    });
    const r = coerceParamsBySchema(schema, { data: '{"labels":["a"]}' });
    expect(r.fixes.length).toBe(1);
    expect(r.data).toEqual({ data: { labels: ['a'] } });
  });

  it('期望字符串的字段传对象 → 提取 text/content 等文本字段', () => {
    const schema = z.object({ content: z.string().min(1) });
    const r = coerceParamsBySchema(schema, {
      content: { text: '正文', src: 'web' },
    });
    expect(r.fixes.length).toBe(1);
    expect(r.data).toEqual({ content: '正文' });
  });

  it('期望字符串的字段传数组 → join 为文本', () => {
    const schema = z.object({ content: z.string().min(1) });
    const r = coerceParamsBySchema(schema, { content: ['第一段', '第二段'] });
    expect(r.fixes.length).toBe(1);
    expect(r.data).toEqual({ content: '第一段\n\n第二段' });
  });

  it('期望字符串的字段传空对象 → 不修（保留 zod 清晰报错）', () => {
    const schema = z.object({ content: z.string().min(1) });
    const r = coerceParamsBySchema(schema, { content: {} });
    expect(r.fixes.length).toBe(0);
    expect((r.data as { content: unknown }).content).toEqual({});
  });

  it('类型已匹配的值不触碰（零误伤）', () => {
    const schema = z.object({ a: z.string(), b: z.array(z.number()) });
    const value = { a: '{"x":1}', b: [1, 2] };
    const r = coerceParamsBySchema(schema, value);
    expect(r.fixes.length).toBe(0);
    expect(r.data).toEqual(value); // 内容等价，字符串字段里的 JSON 文本不解析
  });

  it('z.preprocess 包裹的 schema 从 out 端内省', () => {
    const schema = z.preprocess(
      (v) => v,
      z.object({ steps: z.array(z.string()) }),
    );
    const r = coerceParamsBySchema(schema, { steps: '["a","b"]' });
    expect(r.fixes.length).toBe(1);
    expect(r.data).toEqual({ steps: ['a', 'b'] });
  });

  it('非法 JSON 字符串保持原值（交给 zod 报清晰错误）', () => {
    const schema = z.object({ steps: z.array(z.string()) });
    const r = coerceParamsBySchema(schema, { steps: '这不是JSON' });
    expect(r.fixes.length).toBe(0);
    expect((r.data as { steps: unknown }).steps).toBe('这不是JSON');
  });

  it('嵌套深层：数组内对象的 record 字段同样修复', () => {
    const schema = z.object({
      items: z.array(z.object({ m: z.record(z.string(), z.unknown()) })),
    });
    const r = coerceParamsBySchema(schema, { items: '[{"m":"{\\"k\\":1}"}]' });
    expect(r.fixes.length).toBe(2);
    expect(r.data).toEqual({ items: [{ m: { k: 1 } }] });
  });

  it('schema 外的多余字段不触碰（LLM 可能附带说明性字段）', () => {
    const schema = z.object({ query: z.string() });
    const value = { query: 'q', note: { x: 1 } };
    const r = coerceParamsBySchema(schema, value);
    expect(r.fixes.length).toBe(0);
    expect(r.data).toEqual(value);
  });
});

// ==================== safeParseToolParams 全局安检：四起生产案例形态复现 ====================

describe('safeParseToolParams 全局安检（生产案例形态复现）', () => {
  it('案例1 send_notification：attachments 数组被二次序列化为 JSON 字符串', () => {
    const schema = z.object({
      attachments: z
        .array(z.object({ filename: z.string(), url: z.string() }))
        .optional(),
    });
    const r = safeParseToolParams(schema, {
      attachments:
        '[{"filename":"x.pdf","url":"fc://document/Hz-u_P2h29lQOBpj"}]',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.attachments).toEqual([
        { filename: 'x.pdf', url: 'fc://document/Hz-u_P2h29lQOBpj' },
      ]);
    }
  });

  it('案例2 create_plan：steps JSON 字符串还原（goal 别名兜底由 plan-execute spec 覆盖）', () => {
    const schema = z.object({
      goal: z.string().min(1),
      steps: z.array(z.object({ description: z.string() })).min(1),
    });
    const r = safeParseToolParams(schema, {
      goal: '目标标题',
      steps: '[{"step":1,"description":"查询天气","tool":"get_weather"}]',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.steps).toHaveLength(1);
      expect(r.data.steps[0].description).toBe('查询天气');
    }
  });

  it('案例3 create_document：content 传对象', () => {
    const schema = z.object({
      title: z.string().min(1),
      content: z.string().min(1),
    });
    const r = safeParseToolParams(schema, {
      title: '新闻简报',
      content: { text: '简报正文', source: 'web' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.content).toBe('简报正文');
    }
  });

  it('案例4 generate_chart：echartsOption / data 传 JSON 字符串', () => {
    const schema = z.object({
      chartType: z.enum(['line', 'bar', 'pie']),
      echartsOption: z.record(z.string(), z.unknown()).optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    });
    const r = safeParseToolParams(schema, {
      chartType: 'line',
      echartsOption: '{"backgroundColor":"#0b1020","legend":{"top":30}}',
      data: '{"labels":["10-12"],"series":[{"name":"最高气温","values":[25]}]}',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.echartsOption).toEqual({
        backgroundColor: '#0b1020',
        legend: { top: 30 },
      });
      expect(r.data.data).toEqual({
        labels: ['10-12'],
        series: [{ name: '最高气温', values: [25] }],
      });
    }
  });

  it('校验失败路径不受安检影响（错误信息与旧版一致）', () => {
    const schema = z.object({ goal: z.string().min(1) });
    const r = safeParseToolParams(schema, { steps: '[]' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain('goal');
    }
  });
});
