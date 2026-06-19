/**
 * fundamentals/tools/calculate.schema.spec.ts
 *
 * calculate 工具的 zod schema → OpenAI Function Calling Schema 转换测试
 * 验证：
 * 1. 顶层结构（type: 'function'、name、description）
 * 2. parameters 中的 type / properties / required
 * 3. 中文 description 是否保留
 * 4. zod 校验对非法输入的拦截
 */

// 隔离 logger 以避免链式触发 config 校验
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { calculateSchema, calculateParamsSchema } from './calculate';

describe('calculateSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(calculateSchema.type).toBe('function');
    expect(calculateSchema.function.name).toBe('calculate');
    expect(typeof calculateSchema.function.description).toBe('string');
    expect(calculateSchema.function.description).toContain('数学计算');
  });

  it('parameters 应是 type: object 且 expression 必填', () => {
    const params = calculateSchema.function.parameters as any;
    expect(params.type).toBe('object');
    expect(params.properties.expression.type).toBe('string');
    expect(params.required).toEqual(['expression']);
  });

  it('expression 字段应有中文 description', () => {
    const params = calculateSchema.function.parameters as any;
    expect(params.properties.expression.description).toContain('数学表达式');
  });
});

describe('calculateParamsSchema 校验', () => {
  it('合法 expression 应通过', () => {
    const r = calculateParamsSchema.safeParse({ expression: '1 + 2' });
    expect(r.success).toBe(true);
  });

  it('空 expression 应被拦截', () => {
    const r = calculateParamsSchema.safeParse({ expression: '' });
    expect(r.success).toBe(false);
  });

  it('缺失 expression 字段应被拦截', () => {
    const r = calculateParamsSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('expression 类型错误应被拦截', () => {
    const r = calculateParamsSchema.safeParse({ expression: 123 });
    expect(r.success).toBe(false);
  });
});
