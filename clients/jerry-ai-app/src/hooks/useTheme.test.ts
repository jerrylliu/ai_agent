/**
 * hooks/useTheme.test.ts
 *
 * useTheme hook 单元测试
 * - 主题状态管理
 * - 主题切换与循环
 * - localStorage 持久化
 * - document class 更新
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  /* ====================================================================
   * 初始化
   * ==================================================================*/
  describe('初始化', () => {
    it('默认主题应为 light（无 localStorage 值时）', () => {
      const { result } = renderHook(() => useTheme());
      expect(result.current.theme).toBe('light');
    });

    it('应从 localStorage 读取已保存的主题', () => {
      localStorage.setItem('app-theme-mode', 'dark');
      const { result } = renderHook(() => useTheme());
      expect(result.current.theme).toBe('dark');
    });

    it('应从 localStorage 读取 cyberpunk 主题', () => {
      localStorage.setItem('app-theme-mode', 'cyberpunk');
      const { result } = renderHook(() => useTheme());
      expect(result.current.theme).toBe('cyberpunk');
    });

    it('localStorage 中有非法值时应回退到 light', () => {
      localStorage.setItem('app-theme-mode', 'invalid_theme');
      const { result } = renderHook(() => useTheme());
      expect(result.current.theme).toBe('light');
    });
  });

  /* ====================================================================
   * setTheme
   * ==================================================================*/
  describe('setTheme', () => {
    it('应能切换到 dark 主题', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme('dark'));
      expect(result.current.theme).toBe('dark');
    });

    it('应能切换到 cyberpunk 主题', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme('cyberpunk'));
      expect(result.current.theme).toBe('cyberpunk');
    });

    it('应能切换回 light 主题', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme('dark'));
      act(() => result.current.setTheme('light'));
      expect(result.current.theme).toBe('light');
    });

    it('切换主题应持久化到 localStorage', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme('cyberpunk'));
      expect(localStorage.getItem('app-theme-mode')).toBe('cyberpunk');
    });
  });

  /* ====================================================================
   * cycleTheme
   * ==================================================================*/
  describe('cycleTheme', () => {
    it('light → dark', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.cycleTheme());
      expect(result.current.theme).toBe('dark');
    });

    it('dark → cyberpunk', () => {
      localStorage.setItem('app-theme-mode', 'dark');
      const { result } = renderHook(() => useTheme());
      act(() => result.current.cycleTheme());
      expect(result.current.theme).toBe('cyberpunk');
    });

    it('cyberpunk → light', () => {
      localStorage.setItem('app-theme-mode', 'cyberpunk');
      const { result } = renderHook(() => useTheme());
      act(() => result.current.cycleTheme());
      expect(result.current.theme).toBe('light');
    });

    it('连续循环 3 次应回到初始主题', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.cycleTheme());
      act(() => result.current.cycleTheme());
      act(() => result.current.cycleTheme());
      expect(result.current.theme).toBe('light');
    });

    it('每次切换都应更新 localStorage', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.cycleTheme());
      expect(localStorage.getItem('app-theme-mode')).toBe('dark');
      act(() => result.current.cycleTheme());
      expect(localStorage.getItem('app-theme-mode')).toBe('cyberpunk');
    });
  });

  /* ====================================================================
   * 派生状态
   * ==================================================================*/
  describe('派生状态 (derived)', () => {
    it('light 主题: darkMode=false, cyberpunkMode=false, isDark=false', () => {
      const { result } = renderHook(() => useTheme());
      expect(result.current.darkMode).toBe(false);
      expect(result.current.cyberpunkMode).toBe(false);
      expect(result.current.isDark).toBe(false);
    });

    it('dark 主题: darkMode=true, cyberpunkMode=false, isDark=true', () => {
      localStorage.setItem('app-theme-mode', 'dark');
      const { result } = renderHook(() => useTheme());
      expect(result.current.darkMode).toBe(true);
      expect(result.current.cyberpunkMode).toBe(false);
      expect(result.current.isDark).toBe(true);
    });

    it('cyberpunk 主题: darkMode=false, cyberpunkMode=true, isDark=true', () => {
      localStorage.setItem('app-theme-mode', 'cyberpunk');
      const { result } = renderHook(() => useTheme());
      expect(result.current.darkMode).toBe(false);
      expect(result.current.cyberpunkMode).toBe(true);
      expect(result.current.isDark).toBe(true);
    });
  });

  /* ====================================================================
   * document class 同步
   * ==================================================================*/
  describe('document class 同步', () => {
    it('light 主题不应添加额外 class', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme('light'));
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.classList.contains('cyberpunk')).toBe(false);
    });

    it('dark 主题应添加 dark class', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme('dark'));
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('cyberpunk')).toBe(false);
    });

    it('cyberpunk 主题应添加 dark 和 cyberpunk class', () => {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme('cyberpunk'));
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('cyberpunk')).toBe(true);
    });

    it('从 cyberpunk 切换到 light 应清除所有 class', () => {
      localStorage.setItem('app-theme-mode', 'cyberpunk');
      const { result } = renderHook(() => useTheme());
      // cyberpunk 应已设置了 class
      expect(document.documentElement.classList.contains('cyberpunk')).toBe(true);

      act(() => result.current.setTheme('light'));
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.classList.contains('cyberpunk')).toBe(false);
    });
  });
});
