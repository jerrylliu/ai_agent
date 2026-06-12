/**
 * fundamentals/tools/calculate.spec.ts
 *
 * calculate 数学计算工具单元测试
 * 覆盖：正常计算／表达式为空／安全校验拦截／无效表达式
 */

import { executeCalculate, calculateSchema } from './calculate';

describe('calculate 工具', () => {
  describe('calculateSchema', () => {
    it('应定义正确的函数名', () => {
      expect(calculateSchema.function.name).toBe('calculate');
    });

    it('parameters 应要求 expression 必填', () => {
      expect(calculateSchema.function.parameters.required).toContain('expression');
    });
  });

  describe('executeCalculate', () => {
    it('应正确计算简单加减乘除', async () => {
      const r = await executeCalculate({ expression: '1 + 2' });
      expect(r.result).toBe('3');
      expect(r.error).toBeUndefined();
    });

    it('应正确计算乘法', async () => {
      const r = await executeCalculate({ expression: '123 * 456' });
      expect(r.result).toBe('56088');
      expect(r.error).toBeUndefined();
    });

    it('应正确计算幂运算', async () => {
      const r = await executeCalculate({ expression: '2 ^ 8' });
      expect(r.result).toBe('256');
      expect(r.error).toBeUndefined();
    });

    it('应正确计算 sqrt', async () => {
      const r = await executeCalculate({ expression: 'sqrt(16)' });
      expect(r.result).toBe('4');
    });

    it('应正确计算三角函数', async () => {
      const r = await executeCalculate({ expression: 'sin(0)' });
      expect(r.result).toBe('0');
    });

    it('表达式为空时应返回错误', async () => {
      const r = await executeCalculate({ expression: '' });
      expect(r.error).toBe('表达式不能为空');
    });

    it('expression 为 undefined 时应返回错误', async () => {
      const r = await executeCalculate({ expression: undefined as any });
      expect(r.error).toBe('表达式不能为空');
    });

    it('应拦截 require 关键字', async () => {
      const r = await executeCalculate({ expression: 'require("fs")' });
      expect(r.error).toContain('不允许的内容');
    });

    it('应拦截 import 关键字', async () => {
      const r = await executeCalculate({ expression: 'import("module")' });
      expect(r.error).toContain('不允许的内容');
    });

    it('应拦截 eval', async () => {
      const r = await executeCalculate({ expression: 'eval("1+1")' });
      expect(r.error).toContain('不允许的内容');
    });

    it('应拦截 process', async () => {
      const r = await executeCalculate({ expression: 'process.exit()' });
      expect(r.error).toContain('不允许的内容');
    });

    it('无效表达式应返回计算失败', async () => {
      const r = await executeCalculate({ expression: '1/0' });
      // 1/0 在 mathjs 中返回 Infinity
      expect(r.result).toBe('Infinity');
    });

    it('语法错误表达式应返回错误', async () => {
      const r = await executeCalculate({ expression: '+++' });
      expect(r.error).toContain('计算失败');
    });

    it('结果应包含 summary', async () => {
      const r = await executeCalculate({ expression: '3 * 4' });
      expect(r.summary).toContain('12');
      expect(r.expression).toBe('3 * 4');
    });

    it('浮点数计算应正确', async () => {
      const r = await executeCalculate({ expression: '0.1 + 0.2' });
      // mathjs 默认使用 IEEE 754 双精度浮点
      expect(r.result).toBe('0.30000000000000004');
    });
  });
});
