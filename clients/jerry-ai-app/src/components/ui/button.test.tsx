/**
 * components/ui/button.test.tsx
 *
 * Button 组件单元测试
 * - 渲染类型与内容
 * - variant/size 变体
 * - disabled 状态
 * - onClick 事件
 * - data 属性
 * - asChild 模式
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './button';

describe('Button', () => {
  /* ====================================================================
   * 基础渲染
   * ==================================================================*/
  describe('基础渲染', () => {
    it('应渲染 button 元素', () => {
      render(<Button>按钮</Button>);
      expect(screen.getByText('按钮').tagName).toBe('BUTTON');
    });

    it('应渲染 children 内容', () => {
      render(<Button>提交</Button>);
      expect(screen.getByText('提交')).toBeInTheDocument();
    });

    it('应包含 data-slot="button"', () => {
      render(<Button>test</Button>);
      expect(screen.getByText('test')).toHaveAttribute('data-slot', 'button');
    });

    it('默认 variant 应为 default', () => {
      render(<Button>test</Button>);
      expect(screen.getByText('test')).toHaveAttribute('data-variant', 'default');
    });

    it('默认 size 应为 default', () => {
      render(<Button>test</Button>);
      expect(screen.getByText('test')).toHaveAttribute('data-size', 'default');
    });
  });

  /* ====================================================================
   * variant 变体
   * ==================================================================*/
  describe('variant', () => {
    it('destructive variant', () => {
      render(<Button variant="destructive">删除</Button>);
      expect(screen.getByText('删除')).toHaveAttribute(
        'data-variant',
        'destructive',
      );
    });

    it('outline variant', () => {
      render(<Button variant="outline">取消</Button>);
      expect(screen.getByText('取消')).toHaveAttribute('data-variant', 'outline');
    });

    it('secondary variant', () => {
      render(<Button variant="secondary">次要</Button>);
      expect(screen.getByText('次要')).toHaveAttribute(
        'data-variant',
        'secondary',
      );
    });

    it('ghost variant', () => {
      render(<Button variant="ghost">幽灵</Button>);
      expect(screen.getByText('幽灵')).toHaveAttribute('data-variant', 'ghost');
    });

    it('link variant', () => {
      render(<Button variant="link">链接</Button>);
      expect(screen.getByText('链接')).toHaveAttribute('data-variant', 'link');
    });
  });

  /* ====================================================================
   * size
   * ==================================================================*/
  describe('size', () => {
    it('xs size', () => {
      render(<Button size="xs">小</Button>);
      expect(screen.getByText('小').tagName).toBe('BUTTON');
    });

    it('sm size', () => {
      render(<Button size="sm">小</Button>);
      expect(screen.getByText('小').tagName).toBe('BUTTON');
    });

    it('lg size', () => {
      render(<Button size="lg">大</Button>);
      expect(screen.getByText('大').tagName).toBe('BUTTON');
    });

    it('icon size 应正确设置 data-size', () => {
      render(<Button size="icon">Icon</Button>);
      expect(screen.getByText('Icon')).toHaveAttribute('data-size', 'icon');
    });
  });

  /* ====================================================================
   * onClick 事件
   * ==================================================================*/
  describe('事件', () => {
    it('点击应触发 onClick', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>点击</Button>);
      fireEvent.click(screen.getByText('点击'));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('disabled 时应不触发 onClick', () => {
      const handleClick = vi.fn();
      render(
        <Button disabled onClick={handleClick}>
          禁用
        </Button>,
      );
      fireEvent.click(screen.getByText('禁用'));
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  /* ====================================================================
   * disabled
   * ==================================================================*/
  describe('disabled', () => {
    it('disabled 属性应生效', () => {
      render(<Button disabled>禁用</Button>);
      expect(screen.getByText('禁用')).toBeDisabled();
    });

    it('默认不应 disabled', () => {
      render(<Button>正常</Button>);
      expect(screen.getByText('正常')).toBeEnabled();
    });
  });

  /* ====================================================================
   * className
   * ==================================================================*/
  describe('className', () => {
    it('自定义 className 应合并', () => {
      render(<Button className="my-custom-class">test</Button>);
      expect(screen.getByText('test')).toHaveClass('my-custom-class');
    });
  });

  /* ====================================================================
   * asChild
   * ==================================================================*/
  describe('asChild', () => {
    it('asChild=true 应渲染子元素', () => {
      render(
        <Button asChild>
          <a href="/page">链接按钮</a>
        </Button>,
      );
      const el = screen.getByText('链接按钮');
      expect(el.tagName).toBe('A');
      expect(el).toHaveAttribute('data-slot', 'button');
      expect(el).toHaveAttribute('href', '/page');
    });
  });

  /* ====================================================================
   * type 属性
   * ==================================================================*/
  describe('type 属性', () => {
    it('可设置 button 类型', () => {
      render(<Button type="button">按钮</Button>);
      expect(screen.getByText('按钮')).toHaveAttribute('type', 'button');
    });

    it('可设置 submit 类型', () => {
      render(<Button type="submit">提交</Button>);
      expect(screen.getByText('提交')).toHaveAttribute('type', 'submit');
    });

    it('可设置 reset 类型', () => {
      render(<Button type="reset">重置</Button>);
      expect(screen.getByText('重置')).toHaveAttribute('type', 'reset');
    });
  });
});
