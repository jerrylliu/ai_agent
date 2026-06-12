/**
 * components/ui/confirm-dialog.test.tsx
 *
 * ConfirmDialog 组件单元测试
 * 覆盖：默认文案 / 自定义按钮文案 / destructive 样式 / onConfirm 触发 / 取消关闭
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

// Mock alert-dialog（shadcn Radix 组件）
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open, onOpenChange }: any) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children, className }: any) => (
    <p className={className}>{children}</p>
  ),
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: any) => (
    <button data-testid="cancel-btn">{children}</button>
  ),
  AlertDialogAction: ({ children, variant, onClick }: any) => (
    <button data-testid="confirm-btn" data-variant={variant || 'default'} onClick={onClick}>
      {children}
    </button>
  ),
}));

describe('ConfirmDialog', () => {
  const makeProps = (overrides: any = {}) => ({
    open: true,
    onOpenChange: vi.fn(),
    title: '确认删除',
    description: '此操作不可撤销',
    onConfirm: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ====================================================================
   * 渲染
   * ==================================================================*/
  it('open=true 时应渲染对话框', () => {
    render(<ConfirmDialog {...makeProps()} />);
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
  });

  it('open=false 时不应渲染', () => {
    render(<ConfirmDialog {...makeProps({ open: false })} />);
    expect(screen.queryByTestId('alert-dialog')).toBeNull();
  });

  it('应显示标题和描述', () => {
    render(<ConfirmDialog {...makeProps()} />);
    expect(screen.getByText('确认删除')).toBeInTheDocument();
    expect(screen.getByText('此操作不可撤销')).toBeInTheDocument();
  });

  it('应显示默认按钮文案', () => {
    render(<ConfirmDialog {...makeProps()} />);
    expect(screen.getByText('确定')).toBeInTheDocument();
    expect(screen.getByText('取消')).toBeInTheDocument();
  });

  /* ====================================================================
   * 自定义文案
   * ==================================================================*/
  it('应支持自定义按钮文案', () => {
    render(<ConfirmDialog {...makeProps({ confirmLabel: '是的', cancelLabel: '算了' })} />);
    expect(screen.getByText('是的')).toBeInTheDocument();
    expect(screen.getByText('算了')).toBeInTheDocument();
  });

  /* ====================================================================
   * 点击确认
   * ==================================================================*/
  it('点击确认按钮应调用 onConfirm', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...makeProps({ onConfirm })} />);
    await userEvent.click(screen.getByText('确定'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /* ====================================================================
   * destructive 样式
   * ==================================================================*/
  it('variant=destructive 时确认按钮应有 destructive 样式', () => {
    render(<ConfirmDialog {...makeProps({ variant: 'destructive' })} />);
    const btn = screen.getByTestId('confirm-btn');
    expect(btn.getAttribute('data-variant')).toBe('destructive');
  });

  /* ====================================================================
   * 描述区支持换行
   * ==================================================================*/
  it('description 应包含 whitespace-pre-line 样式', () => {
    render(<ConfirmDialog {...makeProps({ description: '行1\n行2' })} />);
    // 使用文本匹配函数（textContent 包含换行符）
    const desc = screen.getByText((content, element) => {
      return element?.className?.includes('whitespace-pre-line') || false;
    });
    expect(desc).toBeInTheDocument();
  });
});
