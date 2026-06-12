import React, { useEffect, useState, useCallback } from 'react';
import { X, Moon, Sun, Zap, Brain, FileText, MessageSquare, Database, Gauge, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Input } from '../ui/input';
import type { ThemeMode } from '../../hooks/useTheme';

import type { AppSettings } from '../../stores/settings-store';
import {
  getCacheConfig,
  updateCacheConfig,
  getCacheStats,
  clearCache,
  getRateLimiterConfig,
  updateRateLimiterConfig,
  getRateLimiterStatus,
} from '../../lib/api';
import type { CacheConfig, CacheStats, RateLimiterConfig, RateLimiterStatus } from '../../lib/api';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onClose,
  theme,
  onThemeChange,
  settings,
  onSettingsChange,
}) => {
  // 缓存配置状态
  const [cacheConfig, setCacheConfig] = useState<CacheConfig | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheLoading, setCacheLoading] = useState(false);

  // 限流配置状态
  const [rateLimiterConfig, setRateLimiterConfig] = useState<RateLimiterConfig | null>(null);
  const [rateLimiterStatus, setRateLimiterStatus] = useState<RateLimiterStatus | null>(null);
  const [rateLimiterLoading, setRateLimiterLoading] = useState(false);

  // 编辑中的缓存配置（本地暂存）
  const [editCache, setEditCache] = useState<Partial<CacheConfig>>({});
  // 编辑中的限流配置（本地暂存）
  const [editRateLimiter, setEditRateLimiter] = useState<Partial<RateLimiterConfig>>({});

  // 加载缓存和限流配置
  const loadConfig = useCallback(async () => {
    try {
      const [cc, cs, rc, rs] = await Promise.all([
        getCacheConfig(),
        getCacheStats(),
        getRateLimiterConfig(),
        getRateLimiterStatus(),
      ]);
      setCacheConfig(cc);
      setCacheStats(cs);
      setRateLimiterConfig(rc);
      setRateLimiterStatus(rs);
      setEditCache({});
      setEditRateLimiter({});
    } catch {
      // 静默处理，不影响设置面板打开
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadConfig();
    }
  }, [open, loadConfig]);

  if (!open) return null;

  const handleSettingChange = (key: keyof AppSettings, value: boolean) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  // 保存缓存配置
  const handleSaveCacheConfig = async () => {
    if (Object.keys(editCache).length === 0) return;
    setCacheLoading(true);
    try {
      await updateCacheConfig(editCache);
      await loadConfig();
    } catch {
      // 错误已由 api.ts 处理
    } finally {
      setCacheLoading(false);
    }
  };

  // 清空缓存
  const handleClearCache = async () => {
    setCacheLoading(true);
    try {
      await clearCache();
      await loadConfig();
    } catch {
      // 错误已由 api.ts 处理
    } finally {
      setCacheLoading(false);
    }
  };

  // 保存限流配置
  const handleSaveRateLimiterConfig = async () => {
    if (Object.keys(editRateLimiter).length === 0) return;
    setRateLimiterLoading(true);
    try {
      await updateRateLimiterConfig(editRateLimiter);
      await loadConfig();
    } catch {
      // 错误已由 api.ts 处理
    } finally {
      setRateLimiterLoading(false);
    }
  };

  const themeOptions: { mode: ThemeMode; icon: React.ReactNode; label: string }[] = [
    { mode: 'light', icon: <Sun className="h-4 w-4" />, label: '白天' },
    { mode: 'dark', icon: <Moon className="h-4 w-4" />, label: '黑夜' },
    { mode: 'cyberpunk', icon: <Zap className="h-4 w-4" />, label: '赛博朋克' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 遮罩层 */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* 对话框主体 */}
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[480px] max-h-[85vh] flex flex-col overflow-hidden cyberpunk-ms-dialog-card">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground cyberpunk-ms-title">设置</h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* 主题切换 */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-foreground cyberpunk-ms-text">主题模式</h3>
            <div className="flex gap-2">
              {themeOptions.map(({ mode, icon, label }) => (
                <Button
                  key={mode}
                  variant={theme === mode ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 flex items-center justify-center gap-1.5"
                  onClick={() => onThemeChange(mode)}
                >
                  {icon}
                  <span>{label}</span>
                </Button>
              ))}
            </div>
          </div>

          {/* 分隔线 */}
          <div className="border-t border-border" />

          {/* 记忆与摘要设置 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground cyberpunk-ms-text">记忆与摘要</h3>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Brain className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm text-foreground cyberpunk-ms-text">启用记忆功能</p>
                  <p className="text-xs text-muted-foreground cyberpunk-ms-subtext">AI 会从对话中提取关键信息存入记忆库</p>
                </div>
              </div>
              <Switch
                checked={settings.memoryEnabled}
                onCheckedChange={(v) => handleSettingChange('memoryEnabled', v)}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm text-foreground cyberpunk-ms-text">启用摘要功能</p>
                  <p className="text-xs text-muted-foreground cyberpunk-ms-subtext">AI 会自动为对话生成摘要总结</p>
                </div>
              </div>
              <Switch
                checked={settings.summaryEnabled}
                onCheckedChange={(v) => handleSettingChange('summaryEnabled', v)}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm text-foreground cyberpunk-ms-text">新会话注入记忆</p>
                  <p className="text-xs text-muted-foreground cyberpunk-ms-subtext">新建会话时自动将记忆库内容注入对话上下文</p>
                </div>
              </div>
              <Switch
                checked={settings.injectMemoryOnNewSession}
                onCheckedChange={(v) => handleSettingChange('injectMemoryOnNewSession', v)}
                disabled={!settings.memoryEnabled}
              />
            </div>
          </div>

          {/* 分隔线 */}
          <div className="border-t border-border" />

          {/* 缓存配置 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-foreground cyberpunk-ms-text">缓存配置</h3>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadConfig}
                  className="h-7 px-2"
                  title="刷新"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearCache}
                  disabled={cacheLoading}
                  className="h-7 px-2 text-destructive hover:text-destructive"
                  title="清空缓存"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* 缓存统计 */}
            {cacheStats && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">命中</p>
                  <p className="text-sm font-medium">{cacheStats.hits}</p>
                </div>
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">未命中</p>
                  <p className="text-sm font-medium">{cacheStats.misses}</p>
                </div>
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">命中率</p>
                  <p className="text-sm font-medium">{(cacheStats.hitRate * 100).toFixed(1)}%</p>
                </div>
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">条目数</p>
                  <p className="text-sm font-medium">{cacheStats.size}/{cacheStats.maxSize}</p>
                </div>
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">内存</p>
                  <p className="text-sm font-medium">{cacheStats.memoryUsageKB}KB</p>
                </div>
              </div>
            )}

            {/* 缓存参数 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm text-foreground">最大条目数</p>
                  <p className="text-xs text-muted-foreground">缓存最多保存多少条检索结果</p>
                </div>
                <Input
                  type="number"
                  min={10}
                  max={1000}
                  className="w-24 h-8 text-sm"
                  value={editCache.maxEntries ?? cacheConfig?.maxEntries ?? 200}
                  onChange={(e) => setEditCache({ ...editCache, maxEntries: Number(e.target.value) })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm text-foreground">单条大小上限 (KB)</p>
                  <p className="text-xs text-muted-foreground">超过此大小的结果不缓存，防止内存膨胀</p>
                </div>
                <Input
                  type="number"
                  min={10}
                  max={1024}
                  className="w-24 h-8 text-sm"
                  value={editCache.maxItemSizeKB ?? cacheConfig?.maxItemSizeKB ?? 50}
                  onChange={(e) => setEditCache({ ...editCache, maxItemSizeKB: Number(e.target.value) })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm text-foreground">过期时间 (分钟)</p>
                  <p className="text-xs text-muted-foreground">缓存条目的存活时间，过期自动失效</p>
                </div>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  className="w-24 h-8 text-sm"
                  value={editCache.defaultTTLMinutes ?? cacheConfig?.defaultTTLMinutes ?? 5}
                  onChange={(e) => setEditCache({ ...editCache, defaultTTLMinutes: Number(e.target.value) })}
                />
              </div>
            </div>

            {Object.keys(editCache).length > 0 && (
              <Button
                size="sm"
                className="w-full"
                onClick={handleSaveCacheConfig}
                disabled={cacheLoading}
              >
                {cacheLoading ? '保存中...' : '保存缓存配置'}
              </Button>
            )}
          </div>

          {/* 分隔线 */}
          <div className="border-t border-border" />

          {/* 限流配置 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-foreground cyberpunk-ms-text">限流配置</h3>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={loadConfig}
                className="h-7 px-2"
                title="刷新"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* 限流状态 */}
            {rateLimiterStatus && (
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">快速池</p>
                  <p className="text-sm font-medium">
                    {rateLimiterStatus.fastPool.running}/{rateLimiterStatus.fastPool.max}
                    {rateLimiterStatus.fastPool.queueLength > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">
                        等待{rateLimiterStatus.fastPool.queueLength}
                      </span>
                    )}
                  </p>
                </div>
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">流式池</p>
                  <p className="text-sm font-medium">
                    {rateLimiterStatus.streamingPool.running}/{rateLimiterStatus.streamingPool.max}
                    {rateLimiterStatus.streamingPool.queueLength > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">
                        等待{rateLimiterStatus.streamingPool.queueLength}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* 限流参数 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm text-foreground">快速池并发数</p>
                  <p className="text-xs text-muted-foreground">查询改写、重排序等短时操作的最大并发</p>
                </div>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  className="w-24 h-8 text-sm"
                  value={editRateLimiter.fastPoolMax ?? rateLimiterConfig?.fastPoolMax ?? 10}
                  onChange={(e) => setEditRateLimiter({ ...editRateLimiter, fastPoolMax: Number(e.target.value) })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm text-foreground">流式池并发数</p>
                  <p className="text-xs text-muted-foreground">主对话 SSE 流式生成的最大并发</p>
                </div>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  className="w-24 h-8 text-sm"
                  value={editRateLimiter.streamingPoolMax ?? rateLimiterConfig?.streamingPoolMax ?? 5}
                  onChange={(e) => setEditRateLimiter({ ...editRateLimiter, streamingPoolMax: Number(e.target.value) })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm text-foreground">等待超时 (毫秒)</p>
                  <p className="text-xs text-muted-foreground">请求排队等待的最大时间，超时则拒绝</p>
                </div>
                <Input
                  type="number"
                  min={1000}
                  max={60000}
                  step={1000}
                  className="w-24 h-8 text-sm"
                  value={editRateLimiter.tokenWaitTimeout ?? rateLimiterConfig?.tokenWaitTimeout ?? 10000}
                  onChange={(e) => setEditRateLimiter({ ...editRateLimiter, tokenWaitTimeout: Number(e.target.value) })}
                />
              </div>
            </div>

            {Object.keys(editRateLimiter).length > 0 && (
              <Button
                size="sm"
                className="w-full"
                onClick={handleSaveRateLimiterConfig}
                disabled={rateLimiterLoading}
              >
                {rateLimiterLoading ? '保存中...' : '保存限流配置'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsDialog;
