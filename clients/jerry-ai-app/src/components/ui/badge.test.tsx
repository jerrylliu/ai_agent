/**
 * components/ui/badge.test.tsx
 *
 * Badge 组件单元测试
 * - 渲染与 children
 * - variant 变体
 * - asChild 模式
 * - data 属性
 * - className 透传
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './badge';

describe('Badge', () => {
  /* ====================================================================
   * 基础渲染
   * ==================================================================*/
  describe('基础渲染', () => {
    it('应渲染 span 元素', () => {
      render(<Badge>标签</Badge>);
      const el = screen.getByText('标签');
      expect(el.tagName).toBe('SPAN');
    });

    it('应渲染 children 文本内容', () => {
      render(<Badge>新功能</Badge>);
      expect(screen.getByText('新功能')).toBeInTheDocument();
    });

    it('应渲染 children 中的复杂内容', () => {
      render(
        <Badge>
          <span>图标</span>
          文字
        </Badge>,
      );
      expect(screen.getByText('图标')).toBeInTheDocument();
      expect(screen.getByText('文字')).toBeInTheDocument();
    });

    it('空 children 应正常渲染', () => {
      const { container } = render(<Badge />);
      expect(container.firstChild).toBeInTheDocument();
    });
  });

  /* ====================================================================
   * variant 变体
   * ==================================================================*/
  describe('variant 变体', () => {
    it('默认 varint 应为 default', () => {
      render(<Badge>默认</Badge>);
      expect(screen.getByText('默认')).toHaveAttribute('data-variant', 'default');
    });

    it('secondary variant', () => {
      render(<Badge variant="secondary">次要</Badge>);
      expect(screen.getByText('次要')).toHaveAttribute('data-variant', 'secondary');
    });

    it('destructive variant', () => {
      render(<Badge variant="destructive">危险</Badge>);
      expect(screen.getByText('危险')).toHaveAttribute('data-variant', 'destructive');
    });

    it('outline variant', () => {
      render(<Badge variant="outline">轮廓</Badge>);
      expect(screen.getByText('轮廓')).toHaveAttribute('data-variant', 'outline');
    });

    it('ghost variant', () => {
      render(<Badge variant="ghost">幽灵</Badge>);
      expect(screen.getByText('幽灵')).toHaveAttribute('data-variant', 'ghost');
    });

    it('link variant', () => {
      render(<Badge variant="link">链接</Badge>);
      expect(screen.getByText('链接')).toHaveAttribute('data-variant', 'link');
    });
  });

  /* ====================================================================
   * data 属性
   * ==================================================================*/
  describe('data 属性', () => {
    it('应包含 data-slot="badge"', () => {
      render(<Badge>test</Badge>);
      expect(screen.getByText('test')).toHaveAttribute('data-slot', 'badge');
    });

    it('应包含 data-variant 属性', () => {
      render(<Badge variant="default">test</Badge>);
      expect(screen.getByText('test')).toHaveAttribute('data-variant');
    });
  });

  /* ====================================================================
   * 附加属性
   * ==================================================================*/
  describe('附加属性', () => {
    it('className 应追加到元素', () => {
      render(<Badge className="extra-class">test</Badge>);
      expect(screen.getByText('test')).toHaveClass('extra-class');
    });

    it('应透传原生 HTML 属性', () => {
      render(<Badge id="my-badge" title="tooltip">test</Badge>);
      const el = screen.getByText('test');
      expect(el).toHaveAttribute('id', 'my-badge');
      expect(el).toHaveAttribute('title', 'tooltip');
    });

    it('应支持 aria 属性', () => {
      render(<Badge aria-label="状态标签">test</Badge>);
      expect(screen.getByLabelText('状态标签')).toBeInTheDocument();
    });

    it('应支持 style 属性', () => {
      render(<Badge style={{ color: 'red' }}>test</Badge>);
      // React 将 color: 'red' 序列化为 rgb(255, 0, 0)
      expect(screen.getByText('test')).toHaveStyle({ color: 'rgb(255, 0, 0)' });
    });
  });

  /* ====================================================================
   * asChild 模式
   * ==================================================================*/
  describe('asChild 模式', () => {
    it('asChild=true 时应渲染为子元素的组件', () => {
      render(
        <Badge asChild>
          <a href="/link">链接标签</a>
        </Badge>,
      );
      const el = screen.getByText('链接标签');
      expect(el.tagName).toBe('A');
      expect(el).toHaveAttribute('data-slot', 'badge');
    });

    it('asChild=false 时默认为 span', () => {
      render(<Badge>test</Badge>);
      expect(screen.getByText('test').tagName).toBe('SPAN');
    });
  });
});
