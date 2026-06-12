/**
 * utils/index.test.ts
 *
 * 工具函数 `cn()` 单元测试
 * - 测试 ClassValue 合并和 Tailwind 冲突覆写
 */

import { describe, it, expect } from 'vitest';
import { cn } from './index';

describe('cn', () => {
  /* ====================================================================
   * 单一输入
   * ==================================================================*/
  describe('单一输入', () => {
    it('应返回单个字符串', () => {
      expect(cn('foo')).toBe('foo');
    });

    it('空字符串应返回空', () => {
      expect(cn('')).toBe('');
    });

    it('undefined 应被忽略并返回空', () => {
      expect(cn(undefined)).toBe('');
    });

    it('null 应被忽略并返回空', () => {
      expect(cn(null)).toBe('');
    });

    it('false 应被忽略并返回空', () => {
      expect(cn(false)).toBe('');
    });

    it('class 含前后空白应被 trim', () => {
      expect(cn('  foo  bar  ')).toBe('foo bar');
    });
  });

  /* ====================================================================
   * 多输入合并
   * ==================================================================*/
  describe('多输入合并', () => {
    it('应合并多个字符串', () => {
      expect(cn('foo', 'bar')).toBe('foo bar');
    });

    it('应处理条件类名 (mixed types)', () => {
      expect(cn('base', false && 'hidden', 'active')).toBe('base active');
    });

    it('应处理 condition 表达式', () => {
      const isActive = true;
      const isDisabled = false;
      expect(cn('btn', isActive && 'btn-active', isDisabled && 'btn-disabled')).toBe(
        'btn btn-active',
      );
    });

    it('应处理数组输入', () => {
      expect(cn(['foo', 'bar'], 'baz')).toBe('foo bar baz');
    });

    it('应处理嵌套数组', () => {
      expect(cn(['foo', ['bar', ['baz']]])).toBe('foo bar baz');
    });

    it('混合字符串、数组和条件值', () => {
      expect(cn('base', ['flex', false && 'grid'], true && 'active')).toBe('base flex active');
    });
  });

  /* ====================================================================
   * Tailwind 冲突覆写
   * ==================================================================*/
  describe('Tailwind 冲突覆写 (tailwind-merge)', () => {
    it('后面的 padding 应覆写前面的', () => {
      expect(cn('p-4', 'p-6')).toBe('p-6');
    });

    it('后面的 text color 应覆写前面的', () => {
      expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    });

    it('后面的 bg 应覆写前面的', () => {
      expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500');
    });

    it('非冲突类名应保留', () => {
      expect(cn('flex', 'p-4', 'text-center')).toBe('flex p-4 text-center');
    });

    it('尺寸类应正确覆写 (w-*, h-*)', () => {
      expect(cn('w-4 h-4', 'w-6')).toBe('h-4 w-6');
    });

    it('应正确覆写 font-weight', () => {
      expect(cn('font-normal', 'font-bold')).toBe('font-bold');
    });
  });

  /* ====================================================================
   * 边界情况
   * ==================================================================*/
  describe('边界情况', () => {
    it('全部为 falsy 时应返回空字符串', () => {
      expect(cn(false, null, undefined, '')).toBe('');
    });

    it('clsx 不负责去重，相同类名会保留', () => {
      // clsx 仅负责拼接类名，去重由 tailwind-merge 在冲突类名层面处理
      expect(cn('foo', 'foo', 'bar')).toBe('foo foo bar');
    });

    it('超大输入应正常工作', () => {
      const classes = Array.from({ length: 100 }, (_, i) => `class-${i}`);
      const result = cn(...classes);
      // 应包含所有类名
      classes.forEach((cls) => {
        expect(result).toContain(cls);
      });
    });

    it('无参数调用应返回空字符串', () => {
      expect(cn()).toBe('');
    });
  });
});
