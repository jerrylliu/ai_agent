/**
 * fundamentals/llm-json-parser.spec.ts
 */

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { z } from 'zod';
import { extractJsonText, parseLlmJson, parseToolResultJson } from './llm-json-parser';

describe('extractJsonText', () => {
  it('应能从 ```json``` 围栏中抽出对象', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('应能从 ``` 无语言围栏中抽出对象', () => {
    expect(extractJsonText('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('应能从纯文本里裸抽对象', () => {
    expect(extractJsonText('LLM 说：{"a":1} 完')).toBe('{"a":1}');
  });

  it('应能裸抽数组', () => {
    expect(extractJsonText('结果是 [1,2,3] 哦')).toBe('[1,2,3]');
  });

  it('对象优先于数组（取最前出现）', () => {
    expect(extractJsonText('{"a":[1,2]}')).toBe('{"a":[1,2]}');
  });

  it('找不到 JSON 应返回 null', () => {
    expect(extractJsonText('hello world')).toBeNull();
    expect(extractJsonText('')).toBeNull();
  });
});

describe('parseLlmJson', () => {
  const schema = z.object({ a: z.number(), b: z.string().optional() });

  it('合法 LLM 输出应解析成功', () => {
    const r = parseLlmJson('```json\n{"a":1,"b":"x"}\n```', schema, {
      module: 'test',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.a).toBe(1);
  });

  it('字段类型不符应失败并附 reason', () => {
    const r = parseLlmJson('{"a":"not-a-number"}', schema, { module: 'test' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reason).toContain('schema-mismatch');
  });

  it('非法 JSON（不完整）应失败', () => {
    // 截断的 {"a":1, 没有 }，extractJsonText 直接找不到合法边界
    const r = parseLlmJson('{"a":1,', schema, { module: 'test' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reason).toBe('no-json-found');
  });

  it('JSON 边界完整但内容损坏应失败', () => {
    // {"a":1,} 末尾多了逗号，边界完整但 JSON.parse 会失败
    const r = parseLlmJson('{"a":1,}', schema, { module: 'test' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reason).toBe('invalid-json');
  });

  it('完全无 JSON 应失败', () => {
    const r = parseLlmJson('hello', schema, { module: 'test' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reason).toBe('no-json-found');
  });
});

describe('parseToolResultJson', () => {
  const schema = z.object({ ok: z.boolean(), msg: z.string().optional() });

  it('合法 Tool JSON 应成功', () => {
    const r = parseToolResultJson('{"ok":true,"msg":"x"}', schema, {
      module: 'test',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ok).toBe(true);
  });

  it('空字符串应失败', () => {
    const r = parseToolResultJson('', schema, { module: 'test' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reason).toBe('empty-input');
  });

  it('非法 JSON 应失败', () => {
    const r = parseToolResultJson('not-json', schema, { module: 'test' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reason).toBe('invalid-json');
  });

  it('字段类型不符应失败', () => {
    const r = parseToolResultJson('{"ok":"yes"}', schema, { module: 'test' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reason).toContain('schema-mismatch');
  });

  it('多余字段（passthrough 场景）应通过', () => {
    const looseSchema = z.looseObject({ ok: z.boolean() });
    const r = parseToolResultJson('{"ok":true,"extra":1}', looseSchema, {
      module: 'test',
    });
    expect(r.success).toBe(true);
  });
});
