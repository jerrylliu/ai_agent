/**
 * components/ui/card.test.tsx
 *
 * Card 复合组件单元测试
 * - Card 容器
 * - CardHeader / CardTitle / CardDescription
 * - CardContent
 * - CardFooter
 * - CardAction
 * - data 属性
 * - className 透传
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from './card';

describe('Card', () => {
  /* ====================================================================
   * Card 容器
   * ==================================================================*/
  describe('Card', () => {
    it('应渲染 div 元素', () => {
      render(<Card>内容</Card>);
      expect(screen.getByText('内容').tagName).toBe('DIV');
    });

    it('应有 data-slot="card"', () => {
      render(<Card>test</Card>);
      expect(screen.getByText('test')).toHaveAttribute('data-slot', 'card');
    });

    it('应透传 className', () => {
      render(<Card className="my-card">test</Card>);
      expect(screen.getByText('test')).toHaveClass('my-card');
    });
  });

  /* ====================================================================
   * CardHeader
   * ==================================================================*/
  describe('CardHeader', () => {
    it('应渲染 div 元素', () => {
      render(<CardHeader>头部</CardHeader>);
      expect(screen.getByText('头部').tagName).toBe('DIV');
    });

    it('应有 data-slot="card-header"', () => {
      render(<CardHeader>test</CardHeader>);
      expect(screen.getByText('test')).toHaveAttribute(
        'data-slot',
        'card-header',
      );
    });
  });

  /* ====================================================================
   * CardTitle
   * ==================================================================*/
  describe('CardTitle', () => {
    it('应渲染 div 元素', () => {
      render(<CardTitle>标题</CardTitle>);
      expect(screen.getByText('标题').tagName).toBe('DIV');
    });

    it('应有 data-slot="card-title"', () => {
      render(<CardTitle>test</CardTitle>);
      expect(screen.getByText('test')).toHaveAttribute(
        'data-slot',
        'card-title',
      );
    });
  });

  /* ====================================================================
   * CardDescription
   * ==================================================================*/
  describe('CardDescription', () => {
    it('应渲染 div 元素', () => {
      render(<CardDescription>描述</CardDescription>);
      expect(screen.getByText('描述').tagName).toBe('DIV');
    });

    it('应有 data-slot="card-description"', () => {
      render(<CardDescription>test</CardDescription>);
      expect(screen.getByText('test')).toHaveAttribute(
        'data-slot',
        'card-description',
      );
    });
  });

  /* ====================================================================
   * CardContent
   * ==================================================================*/
  describe('CardContent', () => {
    it('应渲染 div 元素', () => {
      render(<CardContent>内容</CardContent>);
      expect(screen.getByText('内容').tagName).toBe('DIV');
    });

    it('应有 data-slot="card-content"', () => {
      render(<CardContent>test</CardContent>);
      expect(screen.getByText('test')).toHaveAttribute(
        'data-slot',
        'card-content',
      );
    });
  });

  /* ====================================================================
   * CardFooter
   * ==================================================================*/
  describe('CardFooter', () => {
    it('应渲染 div 元素', () => {
      render(<CardFooter>底部</CardFooter>);
      expect(screen.getByText('底部').tagName).toBe('DIV');
    });

    it('应有 data-slot="card-footer"', () => {
      render(<CardFooter>test</CardFooter>);
      expect(screen.getByText('test')).toHaveAttribute(
        'data-slot',
        'card-footer',
      );
    });
  });

  /* ====================================================================
   * CardAction
   * ==================================================================*/
  describe('CardAction', () => {
    it('应渲染 div 元素', () => {
      render(<CardAction>操作</CardAction>);
      expect(screen.getByText('操作').tagName).toBe('DIV');
    });

    it('应有 data-slot="card-action"', () => {
      render(<CardAction>test</CardAction>);
      expect(screen.getByText('test')).toHaveAttribute(
        'data-slot',
        'card-action',
      );
    });
  });

  /* ====================================================================
   * 组合渲染
   * ==================================================================*/
  describe('组合渲染', () => {
    it('应渲染完整的 Card 结构', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>卡片标题</CardTitle>
            <CardDescription>这是卡片描述</CardDescription>
          </CardHeader>
          <CardContent>
            <p>卡片正文内容</p>
          </CardContent>
          <CardFooter>
            <span>底部操作</span>
          </CardFooter>
        </Card>,
      );

      expect(screen.getByText('卡片标题')).toBeInTheDocument();
      expect(screen.getByText('这是卡片描述')).toBeInTheDocument();
      expect(screen.getByText('卡片正文内容')).toBeInTheDocument();
      expect(screen.getByText('底部操作')).toBeInTheDocument();
    });
  });
});
