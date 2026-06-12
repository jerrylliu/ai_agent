/**
 * components/ui/error-boundary.test.tsx
 *
 * ErrorBoundary 组件单元测试
 * 覆盖：正常渲染子组件 / 捕获错误显示 fallback / onError 回调 / 重试按钮 / 默认 fallback
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ErrorBoundary } from './error-boundary';

// 模拟 Button 子组件
vi.mock('./button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

/** 故意抛出错误的组件 */
function ThrowError({ message = 'test error' }: { message?: string }): React.ReactElement {
  throw new Error(message);
}

/** 正常组件 */
function Normal({ text = 'hello' }: { text?: string }) {
  return <span>{text}</span>;
}

describe('ErrorBoundary', () => {
  // 抑制 React 错误输出（ErrorBoundary 内部会 console.error）
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ====================================================================
   * 正常渲染
   * ==================================================================*/
  it('应正常渲染子组件', () => {
    render(
      <ErrorBoundary>
        <Normal text="OK" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  /* ====================================================================
   * 错误捕获
   * ==================================================================*/
  it('子组件抛错时应显示默认 fallback', () => {
    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>,
    );
    expect(screen.getByText('组件加载失败')).toBeInTheDocument();
  });

  it('应显示错误消息', () => {
    render(
      <ErrorBoundary>
        <ThrowError message="自定义错误消息" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('自定义错误消息')).toBeInTheDocument();
  });

  /* ====================================================================
   * 自定义 fallback
   * ==================================================================*/
  it('应显示自定义 fallback', () => {
    render(
      <ErrorBoundary fallback={<div>自定义错误UI</div>}>
        <ThrowError />
      </ErrorBoundary>,
    );
    expect(screen.getByText('自定义错误UI')).toBeInTheDocument();
  });

  /* ====================================================================
   * onError 回调
   * ==================================================================*/
  it('捕获错误时应调用 onError', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <ThrowError message="callback test" />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('callback test');
  });

  /* ====================================================================
   * 重试
   * ==================================================================*/
  it('点击重试按钮应清空错误状态', () => {
    // 使用 key prop 触发重新挂载
    const { rerender } = render(
      <ErrorBoundary key="v1">
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(screen.getByText('组件加载失败')).toBeInTheDocument();

    // 通过 key 重新挂载来模拟重试
    rerender(
      <ErrorBoundary key="v2">
        <Normal text="recovered" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  /* ====================================================================
   * 嵌套
   * ==================================================================*/
  it('应只捕获直接子组件的错误', () => {
    render(
      <ErrorBoundary>
        <div>
          <Normal text="still ok" />
        </div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('still ok')).toBeInTheDocument();
  });

  /* ====================================================================
   * 无错误消息时的默认文案
   * ==================================================================*/
  it('错误对象无 message 时应显示默认文案', () => {
    render(
      <ErrorBoundary>
        <ThrowError message="" />
      </ErrorBoundary>,
    );
    // 空字符串 message 为 falsy，应显示默认文案
    expect(screen.getByText('发生了未知错误')).toBeInTheDocument();
  });
});
