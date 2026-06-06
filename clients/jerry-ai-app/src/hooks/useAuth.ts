import { useState, useEffect, useCallback } from 'react';
import {
  login as loginApi,
  register as registerApi,
  getProfile,
  verifyToken,
  updateProfile as updateProfileApi,
  changePassword as changePasswordApi,
  uploadAvatar as uploadAvatarApi,
} from '../lib/api';
import type { UserInfo } from '../lib/api';

const TOKEN_KEY = 'miaoma_auth_token';

export function useAuth() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) {
      verifyToken(savedToken)
        .then((res) => {
          if (res.valid && res.user) {
            setToken(savedToken);
            setUser(res.user);
          } else {
            localStorage.removeItem(TOKEN_KEY);
          }
        })
        .catch(() => {
          localStorage.removeItem(TOKEN_KEY);
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = useCallback(async (account: string, password: string) => {
    const res = await loginApi({ account, password });
    if (res.success) {
      setToken(res.token);
      setUser(res.user);
      localStorage.setItem(TOKEN_KEY, res.token);
    }
    return res;
  }, []);

  const register = useCallback(async (body: {
    email?: string;
    phone?: string;
    password: string;
    username?: string;
  }) => {
    const res = await registerApi(body);
    if (res.success) {
      setToken(res.token);
      setUser(res.user);
      localStorage.setItem(TOKEN_KEY, res.token);
    }
    return res;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!token) return;
    try {
      const profile = await getProfile(token);
      setUser(profile);
    } catch {}
  }, [token]);

  const updateProfile = useCallback(async (body: { username?: string; avatar?: string }) => {
    if (!token) throw new Error('未登录');
    const res = await updateProfileApi(token, body);
    if (res.success && res.user) {
      setUser(res.user);
    }
    return res;
  }, [token]);

  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    if (!token) throw new Error('未登录');
    return changePasswordApi(token, { oldPassword, newPassword });
  }, [token]);

  const uploadAvatar = useCallback(async (file: File) => {
    if (!token) throw new Error('未登录');
    const res = await uploadAvatarApi(token, file);
    if (res.success && res.user) {
      setUser(res.user);
    }
    return res;
  }, [token]);

  return {
    user,
    token,
    isLoading,
    isAuthenticated: !!user && !!token,
    login,
    register,
    logout,
    refreshProfile,
    updateProfile,
    changePassword,
    uploadAvatar,
  };
}
