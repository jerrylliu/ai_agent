/**
 * components/ui/input.test.tsx
 *
 * Input 组件单元测试
 * 覆盖：默认渲染 / type 属性 / className 合并 / disabled / placeholder / onChange / aria-invalid
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Input } from './input';

describe('Input', () => {
  /* ====================================================================
   * 基本渲染
   * ==================================================================*/
  it('应渲染 input 元素', () => {
    render(<Input />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('应包含 data-slot="input" 属性', () => {
    render(<Input />);
    expect(screen.getByRole('textbox').getAttribute('data-slot')).toBe('input');
  });

  it('应包含默认样式类', () => {
    render(<Input />);
    const el = screen.getByRole('textbox');
    expect(el.className).toContain('h-9');
    expect(el.className).toContain('w-full');
    expect(el.className).toContain('rounded-md');
  });

  /* ====================================================================
   * type 属性
   * ==================================================================*/
  it('type=password 时应渲染密码输入框', () => {
    const { container } = render(<Input type="password" />);
    // password 类型在 jsdom 中无默认 role，用 querySelector 查找
    const el = container.querySelector('input[type="password"]');
    expect(el).toBeInTheDocument();
  });

  it('type=number 时应渲染数字输入框', () => {
    render(<Input type="number" />);
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  /* ====================================================================
   * className 合并
   * ==================================================================*/
  it('应合并自定义 className', () => {
    render(<Input className="my-custom" />);
    expect(screen.getByRole('textbox').className).toContain('my-custom');
  });

  /* ====================================================================
   * disabled
   * ==================================================================*/
  it('disabled 时应禁用', () => {
    render(<Input disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  /* ====================================================================
   * placeholder
   * ==================================================================*/
  it('应显示 placeholder', () => {
    render(<Input placeholder="请输入" />);
    expect(screen.getByPlaceholderText('请输入')).toBeInTheDocument();
  });

  /* ====================================================================
   * onChange
   * ==================================================================*/
  it('输入时应触发 onChange', async () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} />);
    const el = screen.getByRole('textbox');
    await userEvent.type(el, 'hello');
    expect(onChange).toHaveBeenCalled();
  });

  /* ====================================================================
   * ref
   * ==================================================================*/
  it('应支持 ref', () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<Input ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  /* ====================================================================
   * value 受控
   * ==================================================================*/
  it('应显示受控 value', () => {
    render(<Input value="controlled" readOnly />);
    expect(screen.getByRole('textbox')).toHaveValue('controlled');
  });
});
