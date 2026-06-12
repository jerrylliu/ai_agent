/**
 * components/ui/avatar.test.tsx
 *
 * Avatar 组件单元测试
 * 覆盖：Avatar/AvatarImage/AvatarFallback/AvatarBadge/AvatarGroup/AvatarGroupCount
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
} from './avatar';

describe('Avatar', () => {
  /* ====================================================================
   * Avatar 根组件
   * ==================================================================*/
  it('应渲染 Avatar 根组件', () => {
    render(
      <Avatar>
        <AvatarFallback>U</AvatarFallback>
      </Avatar>,
    );
    const root = screen.getByText('U').closest('[data-slot="avatar"]');
    expect(root).toBeInTheDocument();
  });

  it('默认 size 样式', () => {
    render(
      <Avatar>
        <AvatarFallback>A</AvatarFallback>
      </Avatar>,
    );
    const root = screen.getByText('A').closest('[data-slot="avatar"]')!;
    expect(root.className).toContain('size-8');
  });

  it('size=sm 应包含对应 data 属性', () => {
    render(
      <Avatar size="sm">
        <AvatarFallback>S</AvatarFallback>
      </Avatar>,
    );
    const root = screen.getByText('S').closest('[data-slot="avatar"]')!;
    expect(root.getAttribute('data-size')).toBe('sm');
  });

  it('size=lg 应包含对应 data 属性', () => {
    render(
      <Avatar size="lg">
        <AvatarFallback>L</AvatarFallback>
      </Avatar>,
    );
    const root = screen.getByText('L').closest('[data-slot="avatar"]')!;
    expect(root.getAttribute('data-size')).toBe('lg');
  });

  it('应合并自定义 className', () => {
    render(
      <Avatar className="custom-avatar">
        <AvatarFallback>C</AvatarFallback>
      </Avatar>,
    );
    const root = screen.getByText('C').closest('[data-slot="avatar"]')!;
    expect(root.className).toContain('custom-avatar');
  });

  /* ====================================================================
   * AvatarImage
   * ==================================================================*/
  describe('AvatarImage', () => {
    it('应渲染 AvatarImage 不报错', () => {
      // Radix AvatarImage 在 jsdom 中（无真实图片加载）可能不产出 DOM
      // 验证渲染不抛错即可
      const { container } = render(
        <Avatar>
          <AvatarImage src="test.jpg" alt="alt text" />
          <AvatarFallback>FB</AvatarFallback>
        </Avatar>,
      );
      // fallback 正常渲染证明组件挂载成功
      expect(screen.getByText('FB')).toBeInTheDocument();
    });
  });

  /* ====================================================================
   * AvatarFallback
   * ==================================================================*/
  it('应渲染 AvatarFallback 文本', () => {
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>,
    );
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('AvatarFallback 应包含 data-slot="avatar-fallback"', () => {
    render(
      <Avatar>
        <AvatarFallback data-testid="fb">F</AvatarFallback>
      </Avatar>,
    );
    expect(screen.getByTestId('fb').getAttribute('data-slot')).toBe('avatar-fallback');
  });

  /* ====================================================================
   * AvatarBadge
   * ==================================================================*/
  it('应渲染 AvatarBadge', () => {
    render(<AvatarBadge data-testid="badge">+</AvatarBadge>);
    expect(screen.getByTestId('badge')).toBeInTheDocument();
    expect(screen.getByTestId('badge').getAttribute('data-slot')).toBe('avatar-badge');
  });

  /* ====================================================================
   * AvatarGroup
   * ==================================================================*/
  it('应渲染 AvatarGroup', () => {
    render(
      <AvatarGroup data-testid="group">
        <Avatar><AvatarFallback>A</AvatarFallback></Avatar>
        <Avatar><AvatarFallback>B</AvatarFallback></Avatar>
      </AvatarGroup>,
    );
    expect(screen.getByTestId('group').getAttribute('data-slot')).toBe('avatar-group');
  });

  /* ====================================================================
   * AvatarGroupCount
   * ==================================================================*/
  it('应渲染 AvatarGroupCount', () => {
    render(<AvatarGroupCount data-testid="count">+5</AvatarGroupCount>);
    expect(screen.getByTestId('count')).toBeInTheDocument();
    expect(screen.getByTestId('count').getAttribute('data-slot')).toBe('avatar-group-count');
    expect(screen.getByText('+5')).toBeInTheDocument();
  });
});
