import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { X, Mail, Phone, User, Lock, Eye, EyeOff } from 'lucide-react';
import { API_ENDPOINTS } from '../lib/constants';

interface AuthDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: (account: string, password: string) => Promise<any>;
  onRegister: (body: { email?: string; phone?: string; password: string; username?: string }) => Promise<any>;
}

export function AuthDialog({ isOpen, onClose, onLogin, onRegister }: AuthDialogProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [loginAccount, setLoginAccount] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [regUsername, setRegUsername] = useState('');

  const [resetAccount, setResetAccount] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);

  if (!isOpen) return null;

  const handleLogin = async () => {
    setError('');
    if (!loginAccount.trim()) {
      setError('请输入邮箱、手机号或用户名');
      return;
    }
    if (!loginPassword) {
      setError('请输入密码');
      return;
    }
    setLoading(true);
    try {
      await onLogin(loginAccount, loginPassword);
      resetForm();
      onClose();
    } catch (err: any) {
      setError(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    setError('');
    if (!regEmail.trim() && !regPhone.trim()) {
      setError('邮箱或手机号至少填写一项');
      return;
    }
    if (regPassword.length < 6) {
      setError('密码长度至少6位');
      return;
    }
    if (regPassword !== regConfirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      await onRegister({
        email: regEmail.trim() || undefined,
        phone: regPhone.trim() || undefined,
        password: regPassword,
        username: regUsername.trim() || undefined,
      });
      resetForm();
      onClose();
    } catch (err: any) {
      setError(err.message || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    setError('');
    if (!resetAccount.trim()) {
      setError('请输入邮箱、手机号或用户名');
      return;
    }
    if (resetPassword.length < 6) {
      setError('新密码长度至少6位');
      return;
    }
    if (resetPassword !== resetConfirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(API_ENDPOINTS.AUTH_RESET_PASSWORD, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: resetAccount.trim(), newPassword: resetPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '重置失败');
      setResetSuccess(true);
    } catch (err: any) {
      setError(err.message || '重置密码失败');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setLoginAccount('');
    setLoginPassword('');
    setRegEmail('');
    setRegPhone('');
    setRegPassword('');
    setRegConfirmPassword('');
    setRegUsername('');
    setResetAccount('');
    setResetPassword('');
    setResetConfirmPassword('');
    setResetSuccess(false);
    setError('');
    setShowPassword(false);
  };

  const switchMode = (newMode: 'login' | 'register' | 'reset') => {
    setMode(newMode);
    setError('');
    setShowPassword(false);
    setResetSuccess(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-card rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative px-6 pt-6 pb-4">
          <button
            onClick={onClose}
            className="absolute right-4 top-4 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            {mode === 'login' ? '欢迎回来' : mode === 'register' ? '创建账号' : '重置密码'}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
            {mode === 'login' ? '登录你的账号以继续' : mode === 'register' ? '注册一个新账号' : '输入账号和新密码即可重置'}
          </p>
        </div>

        <div className="px-6">
          {mode !== 'reset' && (
            <div className="flex bg-gray-100 dark:bg-slate-700 rounded-lg p-1">
              <button
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all duration-200 ${
                  mode === 'login'
                    ? 'bg-white dark:bg-slate-600 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
                onClick={() => switchMode('login')}
              >
                登录
              </button>
              <button
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all duration-200 ${
                  mode === 'register'
                    ? 'bg-white dark:bg-slate-600 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
                onClick={() => switchMode('register')}
              >
                注册
              </button>
            </div>
          )}
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {mode === 'login' ? (
            <>
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">邮箱 / 手机号 / 用户名</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="请输入邮箱、手机号或用户名"
                    className="pl-10"
                    value={loginAccount}
                    onChange={(e) => setLoginAccount(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="请输入密码"
                    className="pl-10 pr-10"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4 text-gray-400" />
                    ) : (
                      <Eye className="h-4 w-4 text-gray-400" />
                    )}
                  </button>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => switchMode('reset')}
                  >
                    忘记密码？
                  </button>
                </div>
              </div>
            </>
          ) : mode === 'register' ? (
            <>
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">邮箱</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    type="email"
                    placeholder="请输入邮箱（选填）"
                    className="pl-10"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">手机号</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    type="tel"
                    placeholder="请输入手机号（选填）"
                    className="pl-10"
                    value={regPhone}
                    onChange={(e) => setRegPhone(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-400">邮箱和手机号至少填写一项</p>
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">用户名</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="请输入用户名（注册后可设置）"
                    className="pl-10"
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="请输入密码（至少6位）"
                    className="pl-10 pr-10"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4 text-gray-400" />
                    ) : (
                      <Eye className="h-4 w-4 text-gray-400" />
                    )}
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">确认密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="请再次输入密码"
                    className="pl-10"
                    value={regConfirmPassword}
                    onChange={(e) => setRegConfirmPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                  />
                </div>
              </div>
            </>
          ) : (
            /* 重置密码表单 */
            resetSuccess ? (
              <div className="py-4 text-center">
                <div className="text-green-500 text-4xl mb-3">&#10003;</div>
                <p className="text-base font-medium text-gray-900 dark:text-white">密码重置成功</p>
                <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">请使用新密码登录</p>
                <Button
                  className="mt-4 bg-primary hover:bg-primary/90 text-white"
                  onClick={() => switchMode('login')}
                >
                  去登录
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">账号</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder="请输入邮箱、手机号或用户名"
                      className="pl-10"
                      value={resetAccount}
                      onChange={(e) => setResetAccount(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">新密码</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="请输入新密码（至少6位）"
                      className="pl-10 pr-10"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4 text-gray-400" />
                      ) : (
                        <Eye className="h-4 w-4 text-gray-400" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">确认新密码</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="请再次输入新密码"
                      className="pl-10"
                      value={resetConfirmPassword}
                      onChange={(e) => setResetConfirmPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleReset()}
                    />
                  </div>
                </div>
              </>
            )
          )}
        </div>

        <div className="px-6 pb-6 pt-2">
          {mode === 'reset' && !resetSuccess ? (
            <div className="space-y-3">
              <Button
                className="w-full bg-primary hover:bg-primary/90 text-white h-11 text-base font-medium"
                onClick={handleReset}
                disabled={loading}
              >
                {loading ? (
                  <div className="flex items-center justify-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                    重置中...
                  </div>
                ) : (
                  '重置密码'
                )}
              </Button>
              <button
                type="button"
                className="w-full text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                onClick={() => switchMode('login')}
              >
                返回登录
              </button>
            </div>
          ) : mode !== 'reset' ? (
            <Button
              className="w-full bg-primary hover:bg-primary/90 text-white h-11 text-base font-medium"
              onClick={mode === 'login' ? handleLogin : handleRegister}
              disabled={loading}
            >
              {loading ? (
                <div className="flex items-center justify-center">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                  {mode === 'login' ? '登录中...' : '注册中...'}
                </div>
              ) : (
                mode === 'login' ? '登录' : '注册'
              )}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
