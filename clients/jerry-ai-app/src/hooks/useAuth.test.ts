/**
 * hooks/useAuth.test.ts
 *
 * useAuth hook 单元测试
 * - 认证状态管理
 * - 登录/注册/登出 流程
 * - token 持久化与验证
 * - 用户资料更新
 * - 密码修改和头像上传
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as api from '../lib/api';
import { useAuth } from './useAuth';

/* =====================================================================
 * 测试辅助：mock API 模块
 * ==================================================================*/
const mockUser = {
  id: 1,
  email: 'test@example.com',
  phone: null,
  username: 'tester',
  avatar: null,
  isActive: true,
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

function mockApiFunction<T extends (...args: any[]) => any>(
  fn: T,
  response: Awaited<ReturnType<T>>,
) {
  return vi.spyOn(api, fn.name as any).mockResolvedValue(response);
}

describe('useAuth', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ====================================================================
   * 初始化
   * ==================================================================*/
  describe('初始化', () => {
    it('无 token 时 isAuthenticated 应为 false', async () => {
      // mock verifyToken 不调用时直接跳过
      const { result } = renderHook(() => useAuth());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
      expect(result.current.token).toBeNull();
    });

    it('初始状态应处于加载中', () => {
      // 需要 token 存在才会触发 verifyToken，模拟永不 resolve
      localStorage.setItem('miaoma_auth_token', 'token');
      const verifySpy = vi.spyOn(api, 'verifyToken').mockImplementation(
        () => new Promise(() => {}), // never resolves
      );

      const { result } = renderHook(() => useAuth());
      expect(result.current.isLoading).toBe(true);

      verifySpy.mockRestore();
    });

    it('有有效 token 时应自动验证', async () => {
      localStorage.setItem('miaoma_auth_token', 'valid-token');
      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: true,
        user: mockUser,
      });

      const { result } = renderHook(() => useAuth());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user).toEqual(mockUser);
      expect(result.current.token).toBe('valid-token');
    });

    it('有无效 token 时应清除并标记未认证', async () => {
      localStorage.setItem('miaoma_auth_token', 'expired-token');
      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: false,
        user: null as any,
      });

      const { result } = renderHook(() => useAuth());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isAuthenticated).toBe(false);
      expect(localStorage.getItem('miaoma_auth_token')).toBeNull();
    });

    it('验证 token 失败时应清除 token', async () => {
      localStorage.setItem('miaoma_auth_token', 'bad-token');
      vi.spyOn(api, 'verifyToken').mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useAuth());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isAuthenticated).toBe(false);
      expect(localStorage.getItem('miaoma_auth_token')).toBeNull();
    });
  });

  /* ====================================================================
   * login
   * ==================================================================*/
  describe('login', () => {
    it('成功登录应设置 user 和 token', async () => {
      vi.spyOn(api, 'login').mockResolvedValue({
        success: true,
        message: '登录成功',
        user: mockUser,
        token: 'login-token-123',
      });

      const { result } = renderHook(() => useAuth());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const loginResult: any = await act(() =>
        result.current.login('test@test.com', 'password'),
      );

      expect(loginResult.success).toBe(true);
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.token).toBe('login-token-123');
      expect(result.current.user).toEqual(mockUser);
      expect(localStorage.getItem('miaoma_auth_token')).toBe('login-token-123');
    });

    it('登录失败应不设置认证状态', async () => {
      vi.spyOn(api, 'login').mockResolvedValue({
        success: false,
        message: '密码错误',
        user: null as any,
        token: '',
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const loginResult = await act(() =>
        result.current.login('test@test.com', 'wrong'),
      );

      expect(loginResult.success).toBe(false);
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.token).toBeNull();
    });

    it('应使用 account 和 password 调用 API', async () => {
      const loginSpy = vi.spyOn(api, 'login').mockResolvedValue({
        success: true,
        message: 'OK',
        user: mockUser,
        token: 't',
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.login('admin@test.com', 'secret123'));

      expect(loginSpy).toHaveBeenCalledWith({
        account: 'admin@test.com',
        password: 'secret123',
      });
    });
  });

  /* ====================================================================
   * register
   * ==================================================================*/
  describe('register', () => {
    it('注册成功后应自动登录', async () => {
      vi.spyOn(api, 'register').mockResolvedValue({
        success: true,
        message: '注册成功',
        user: { ...mockUser, username: 'newbie' },
        token: 'reg-token',
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() =>
        result.current.register({
          email: 'new@test.com',
          password: 'pass123',
          username: 'newbie',
        }),
      );

      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.token).toBe('reg-token');
      expect(result.current.user?.username).toBe('newbie');
    });
  });

  /* ====================================================================
   * logout
   * ==================================================================*/
  describe('logout', () => {
    it('登出应清除 user 和 token', async () => {
      localStorage.setItem('miaoma_auth_token', 't');
      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: true,
        user: mockUser,
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.isAuthenticated).toBe(true);

      act(() => result.current.logout());

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
      expect(result.current.token).toBeNull();
      expect(localStorage.getItem('miaoma_auth_token')).toBeNull();
    });
  });

  /* ====================================================================
   * refreshProfile
   * ==================================================================*/
  describe('refreshProfile', () => {
    it('应刷新用户信息', async () => {
      localStorage.setItem('miaoma_auth_token', 't');
      const updatedUser = { ...mockUser, username: 'updated' };

      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: true,
        user: mockUser,
      });
      vi.spyOn(api, 'getProfile').mockResolvedValue(updatedUser);

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.refreshProfile());

      expect(result.current.user?.username).toBe('updated');
    });

    it('未登录时不发请求', async () => {
      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: false,
        user: null as any,
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.refreshProfile());
      // 无 token 应直接返回，不报错
      expect(result.current.user).toBeNull();
    });
  });

  /* ====================================================================
   * updateProfile
   * ==================================================================*/
  describe('updateProfile', () => {
    it('更新成功后应更新本地 user', async () => {
      localStorage.setItem('miaoma_auth_token', 't');
      const updatedUser = { ...mockUser, avatar: 'new-avatar.jpg' };

      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: true,
        user: mockUser,
      });
      vi.spyOn(api, 'updateProfile').mockResolvedValue({
        success: true,
        message: 'OK',
        user: updatedUser,
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(() => result.current.updateProfile({ avatar: 'new-avatar.jpg' }));

      expect(result.current.user?.avatar).toBe('new-avatar.jpg');
    });

    it('未登录时应抛出异常', async () => {
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        act(() => result.current.updateProfile({ username: 'x' })),
      ).rejects.toThrow('未登录');
    });
  });

  /* ====================================================================
   * changePassword
   * ==================================================================*/
  describe('changePassword', () => {
    it('应调用 API 修改密码', async () => {
      localStorage.setItem('miaoma_auth_token', 't');
      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: true,
        user: mockUser,
      });
      const changeSpy = vi.spyOn(api, 'changePassword').mockResolvedValue({
        success: true,
        message: '密码已修改',
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const res = await act(() =>
        result.current.changePassword('oldPwd', 'newPwd'),
      );

      expect(changeSpy).toHaveBeenCalledWith('t', {
        oldPassword: 'oldPwd',
        newPassword: 'newPwd',
      });
      expect(res.success).toBe(true);
    });
  });

  /* ====================================================================
   * uploadAvatar
   * ==================================================================*/
  describe('uploadAvatar', () => {
    it('应上传头像并更新 user', async () => {
      localStorage.setItem('miaoma_auth_token', 't');
      const updatedUser = { ...mockUser, avatar: '/avatars/1.png' };

      vi.spyOn(api, 'verifyToken').mockResolvedValue({
        success: true,
        valid: true,
        user: mockUser,
      });
      vi.spyOn(api, 'uploadAvatar').mockResolvedValue({
        success: true,
        message: 'OK',
        user: updatedUser,
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const file = new File(['data'], 'avatar.png', { type: 'image/png' });
      const res = await act(() => result.current.uploadAvatar(file));

      expect(res.success).toBe(true);
      expect(result.current.user?.avatar).toBe('/avatars/1.png');
    });
  });
});
