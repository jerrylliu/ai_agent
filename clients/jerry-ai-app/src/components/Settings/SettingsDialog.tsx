import React, { useEffect, useState, useCallback, useRef } from 'react';
import { X, Moon, Sun, Zap, Brain, FileText, MessageSquare, Database, Gauge, Trash2, RefreshCw, PenLine, Cpu } from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Input } from '../ui/input';
import type { ThemeMode } from '../../hooks/useTheme';

import type { AppSettings } from '../../stores/settings-store';
import type { UseUpdateCheckResult } from '../../hooks/useUpdateCheck';
import {
  getCacheConfig,
  updateCacheConfig,
  getCacheStats,
  clearCache,
  getRateLimiterConfig,
  updateRateLimiterConfig,
  getRateLimiterStatus,
  getEmbeddingConfig,
  testEmbeddingConfig,
  saveEmbeddingConfig,
  toggleLocalEmbedding,
  rebuildEmbeddingIndex,
  getRebuildProgress,
} from '../../lib/api';
import type {
  CacheConfig,
  CacheStats,
  RateLimiterConfig,
  RateLimiterStatus,
  EmbeddingConfigResponse,
  EmbeddingMode,
  CloudEmbeddingProvider,
  SaveEmbeddingConfigPayload,
  ReindexProgress,
} from '../../lib/api';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  /** 版本更新检测（由 ChatAgent 持有的同一实例传入，弹窗状态全局唯一） */
  updateCheck: UseUpdateCheckResult;
}

// 根据进度快照生成重建结束后的提示文案：源文件丢失需要单独强调，
// 否则用户会误以为是 ChromaDB / 嵌入服务的问题而排查错误方向。
// 定义为模块级函数，避免每次渲染新建引用污染 useCallback 依赖导致轮询重启
const buildReindexDoneStatus = (progress: ReindexProgress): { ok: boolean; text: string } => {
  if (progress.failed === 0) {
    return { ok: true, text: `重建完成：成功 ${progress.done} 个文档` };
  }
  const lost = progress.errors.filter((e) => e.reason === 'source-unavailable').length;
  const base = `重建完成：成功 ${progress.done} 个，失败 ${progress.failed} 个`;
  if (lost > 0) {
    return { ok: false, text: `${base}（其中 ${lost} 个因源文件丢失无法重建，需删除后重新上传）` };
  }
  return { ok: false, text: base };
};

// 跳转工信部备案系统：Tauri 环境用系统浏览器打开，浏览器环境新开标签页
const openBeianSite = async (): Promise<void> => {
  const url = 'https://beian.miit.gov.cn/';
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onClose,
  theme,
  onThemeChange,
  settings,
  onSettingsChange,
  updateCheck,
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

  // 知识库嵌入配置状态（本地优先总开关 + 云端兜底）
  const [embeddingCfg, setEmbeddingCfg] = useState<EmbeddingConfigResponse['config'] | null>(null);
  const [embeddingSwitching, setEmbeddingSwitching] = useState(false);
  const [embeddingTesting, setEmbeddingTesting] = useState<EmbeddingMode | null>(null);
  const [embeddingSaving, setEmbeddingSaving] = useState(false);
  const [embeddingRebuilding, setEmbeddingRebuilding] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // 全量重建进度快照（后台执行，前端轮询更新）
  const [reindexProgress, setReindexProgress] = useState<ReindexProgress | null>(null);
  // 进度轮询定时器句柄（组件卸载 / 面板关闭时清理）
  const reindexPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 编辑中的嵌入配置字段（本地暂存，保存时提交）
  const [editOllama, setEditOllama] = useState({ baseUrl: '', model: '' });
  const [editCloud, setEditCloud] = useState({
    provider: 'siliconflow' as CloudEmbeddingProvider,
    baseUrl: '',
    model: '',
    apiKey: '',
  });

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

    // 嵌入配置独立加载：失败只影响嵌入区块，不阻塞其他设置项
    try {
      const ec = await getEmbeddingConfig();
      setEmbeddingCfg(ec.config);
      setEditOllama({
        baseUrl: ec.config.ollama.baseUrl,
        model: ec.config.ollama.model,
      });
      // apiKey 不回显（后端不返回密文），留空表示沿用已保存的 Key
      setEditCloud({
        provider: ec.config.cloud.provider,
        baseUrl: ec.config.cloud.baseUrl,
        model: ec.config.cloud.model,
        apiKey: '',
      });
      setEmbeddingStatus(null);
    } catch {
      // 后端未启动或接口异常时保持空态
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadConfig();
    }
  }, [open, loadConfig]);

  // ==================== 全量重建进度轮询 ====================

  // 停止进度轮询并清理定时器
  const stopReindexPolling = useCallback(() => {
    if (reindexPollRef.current) {
      clearInterval(reindexPollRef.current);
      reindexPollRef.current = null;
    }
  }, []);

  // 轮询一次进度：后台完成（running=false）时停止轮询并给出完成/失败提示
  const pollReindexOnce = useCallback(async () => {
    try {
      const { progress } = await getRebuildProgress();
      setReindexProgress(progress);
      if (!progress) return;
      if (progress.running) {
        setEmbeddingRebuilding(true);
        return;
      }
      stopReindexPolling();
      setEmbeddingRebuilding(false);
      setEmbeddingStatus(buildReindexDoneStatus(progress));
    } catch {
      // 轮询失败（后端重启 / 网络抖动）静默跳过，等待下一次轮询
    }
  }, [stopReindexPolling]);

  // 启动进度轮询：立即拉一次，再每 1.5s 轮询，直到后台完成
  const startReindexPolling = useCallback(() => {
    stopReindexPolling();
    void pollReindexOnce();
    reindexPollRef.current = setInterval(() => {
      void pollReindexOnce();
    }, 1500);
  }, [pollReindexOnce, stopReindexPolling]);

  // 面板打开时：若后端仍有重建在进行（上次关闭面板后后台继续跑），恢复轮询；
  // 面板关闭 / 组件卸载时停止轮询，避免定时器泄漏
  useEffect(() => {
    if (!open) {
      stopReindexPolling();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { progress } = await getRebuildProgress();
        if (cancelled) return;
        setReindexProgress(progress);
        if (progress?.running) {
          setEmbeddingRebuilding(true);
          startReindexPolling();
        }
      } catch {
        // 后端未启动时静默
      }
    })();
    return () => {
      cancelled = true;
      stopReindexPolling();
    };
  }, [open, startReindexPolling, stopReindexPolling]);

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

  // ==================== 知识库嵌入模型（本地优先总开关 + 云端兜底） ====================

  // 组装保存 / 验证用的配置（apiKey 为空时不提交，后端沿用已保存的 Key；localEnabled 由总开关单独管理）
  const buildEmbeddingPayload = (): SaveEmbeddingConfigPayload => ({
    ollama: {
      baseUrl: editOllama.baseUrl.trim(),
      model: editOllama.model.trim(),
    },
    cloud: {
      provider: editCloud.provider,
      baseUrl: editCloud.baseUrl.trim(),
      model: editCloud.model.trim(),
      ...(editCloud.apiKey ? { apiKey: editCloud.apiKey } : {}),
    },
  });

  // 本地总开关：开=本地优先（不可用自动降级云端），关=只用云端；后端验证后切换
  const handleToggleLocal = async (checked: boolean) => {
    if (!embeddingCfg || embeddingSwitching || checked === embeddingCfg.localEnabled) return;
    setEmbeddingSwitching(true);
    setEmbeddingStatus(null);
    try {
      const result = await toggleLocalEmbedding(checked);
      if (result.success && result.config) {
        setEmbeddingCfg(result.config);
        setEmbeddingStatus({ ok: true, text: result.message ?? (checked ? '已开启本地优先' : '已切换为仅云端') });
      } else {
        setEmbeddingStatus({ ok: false, text: result.message ?? '切换失败' });
      }
    } catch {
      setEmbeddingStatus({ ok: false, text: '切换失败，请检查后端服务是否运行' });
    } finally {
      setEmbeddingSwitching(false);
    }
  };

  // 选择供应商：内置供应商自动填充端点和默认模型，custom 保留手填值
  const handleProviderChange = (provider: CloudEmbeddingProvider) => {
    const preset = embeddingCfg?.presets?.[provider];
    setEditCloud((prev) => ({
      ...prev,
      provider,
      baseUrl: preset?.baseUrl ?? prev.baseUrl,
      model: preset?.defaultModel ?? prev.model,
    }));
  };

  // 连接测试：真实生成一次向量验证指定路径（ollama / cloud），不保存
  const handleTestEmbedding = async (mode: EmbeddingMode) => {
    if (embeddingTesting || embeddingSaving) return;
    setEmbeddingTesting(mode);
    setEmbeddingStatus(null);
    try {
      const payload = buildEmbeddingPayload();
      const result = await testEmbeddingConfig({ mode, ollama: payload.ollama, cloud: payload.cloud });
      if (result.success) {
        setEmbeddingStatus({
          ok: true,
          text: `连接成功（向量维度 ${result.dimensions ?? '-'}，耗时 ${result.latencyMs ?? '-'}ms）`,
        });
      } else {
        setEmbeddingStatus({ ok: false, text: `连接失败：${result.error ?? '未知错误'}` });
      }
    } catch {
      setEmbeddingStatus({ ok: false, text: '连接测试失败，请检查后端服务是否运行' });
    } finally {
      setEmbeddingTesting(null);
    }
  };

  // 保存配置：后端先按总开关语义验证可能生效的路径，全部不可用则拒绝保存
  const handleSaveEmbeddingConfig = async () => {
    if (embeddingSaving || embeddingTesting) return;
    setEmbeddingSaving(true);
    setEmbeddingStatus(null);
    try {
      const result = await saveEmbeddingConfig(buildEmbeddingPayload());
      if (result.success && result.config) {
        setEmbeddingCfg(result.config);
        // 保存成功后清空 Key 输入框（后端不回显，已配置状态由 hasApiKey 体现）
        setEditCloud((prev) => ({ ...prev, apiKey: '' }));
        setEmbeddingStatus({ ok: true, text: result.message ?? '配置已保存并生效' });
      } else {
        setEmbeddingStatus({ ok: false, text: result.message ?? '保存失败' });
      }
    } catch {
      setEmbeddingStatus({ ok: false, text: '保存失败，请检查后端服务是否运行' });
    } finally {
      setEmbeddingSaving(false);
    }
  };

  // 重建索引：把数据库文档按当前生效模型重新向量化（换模型后老数据必做）。
  // 后端 enqueue 后在后台异步执行，前端轮询进度快照展示进度条与完成/失败提示。
  const handleRebuildIndex = async () => {
    if (embeddingRebuilding) return;
    setEmbeddingRebuilding(true);
    setEmbeddingStatus(null);
    try {
      const result = await rebuildEmbeddingIndex();
      if (result.success) {
        // 无进度快照（后端旧版本 / 未启动执行器）时退回普通入队提示
        if (!result.progress) {
          setEmbeddingStatus({
            ok: true,
            text: result.message ?? `已加入重建队列（${result.enqueued ?? 0} 个文档）`,
          });
          setEmbeddingRebuilding(false);
          return;
        }
        setReindexProgress(result.progress);
        // running=false 表示后台已同步跑完（如无文档 total=0），无需轮询
        if (!result.progress.running) {
          setEmbeddingRebuilding(false);
          if (result.progress.failed > 0) {
            setEmbeddingStatus({
              ok: false,
              text: `重建完成：成功 ${result.progress.done} 个，失败 ${result.progress.failed} 个`,
            });
          } else {
            setEmbeddingStatus({
              ok: true,
              text: `重建完成：成功 ${result.progress.done} 个文档`,
            });
          }
          return;
        }
        // 后台仍在执行：启动轮询，完成时由 pollReindexOnce 给出提示
        setEmbeddingStatus({
          ok: true,
          text: result.message ?? `已开始重建（共 ${result.progress.total} 个文档）`,
        });
        startReindexPolling();
      } else {
        setEmbeddingStatus({ ok: false, text: result.message ?? '重建失败' });
        setEmbeddingRebuilding(false);
      }
    } catch {
      setEmbeddingStatus({ ok: false, text: '重建失败，请检查后端服务是否运行' });
      setEmbeddingRebuilding(false);
    }
  };

  const cloudProviderOptions: { value: CloudEmbeddingProvider; label: string }[] = [
    { value: 'siliconflow', label: embeddingCfg?.presets?.siliconflow?.label ?? '硅基流动' },
    { value: 'custom', label: '自定义端点' },
  ];

  // 云端模型下拉选项：内置供应商用预设列表，custom 为空（手填）；当前值不在列表中时补进去
  const cloudModelOptions: { value: string; label: string }[] = (() => {
    const models = embeddingCfg?.presets?.[editCloud.provider]?.models ?? [];
    if (models.length === 0) return [];
    const current = editCloud.model.trim();
    if (current && !models.some((m) => m.value === current)) {
      return [{ value: current, label: current }, ...models];
    }
    return models;
  })();

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

          {/* 编辑器设置 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground cyberpunk-ms-text">编辑器</h3>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PenLine className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm text-foreground cyberpunk-ms-text">AI 自动补全</p>
                  <p className="text-xs text-muted-foreground cyberpunk-ms-subtext">编辑器中输入停顿后自动生成幽灵补全文字（关闭可节省 token）</p>
                </div>
              </div>
              <Switch
                checked={settings.autoCompleteEnabled}
                onCheckedChange={(v) => handleSettingChange('autoCompleteEnabled', v)}
              />
            </div>
          </div>

          {/* 分隔线 */}
          <div className="border-t border-border" />

          {/* 知识库嵌入模型（本地优先总开关 + 云端兜底） */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <div>
                  <h3 className="text-sm font-medium text-foreground cyberpunk-ms-text">知识库嵌入模型</h3>
                  <p className="text-xs text-muted-foreground cyberpunk-ms-subtext">
                    生效：{embeddingCfg
                      ? `${embeddingCfg.mode === 'ollama' ? '本地 Ollama' : '云端嵌入'}（${embeddingCfg.activeModel}）`
                      : '加载中...'}
                  </p>
                </div>
              </div>
              {/* 本地总开关：开=本地优先（不可用自动降级云端），关=只用云端；切换时后端先验证 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">仅云端</span>
                <Switch
                  checked={embeddingCfg?.localEnabled ?? false}
                  disabled={!embeddingCfg || embeddingSwitching || embeddingSaving}
                  onCheckedChange={handleToggleLocal}
                />
                <span className="text-xs text-muted-foreground">本地优先</span>
              </div>
            </div>

            {/* 本地已开启但探测不可用时的降级提示 */}
            {embeddingCfg && embeddingCfg.localEnabled && embeddingCfg.mode === 'cloud' && embeddingCfg.fallbackReason && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                本地嵌入暂不可用，已自动降级为云端：{embeddingCfg.fallbackReason}
              </p>
            )}

            {/* 本地 Ollama 配置：总开关关闭时禁用（只用云端） */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">本地 Ollama</p>
              <Input
                placeholder="服务地址，如 http://localhost:11434"
                className="h-8 text-sm"
                value={editOllama.baseUrl}
                disabled={!embeddingCfg?.localEnabled}
                onChange={(e) => setEditOllama((prev) => ({ ...prev, baseUrl: e.target.value }))}
              />
              <Input
                placeholder="嵌入模型名称，如 bge-m3"
                className="h-8 text-sm"
                value={editOllama.model}
                disabled={!embeddingCfg?.localEnabled}
                onChange={(e) => setEditOllama((prev) => ({ ...prev, model: e.target.value }))}
              />
            </div>

            {/* 云端嵌入配置：供应商预设自动填充地址与模型，模型可从预设下拉选择 */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">云端嵌入</p>
              <select
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={editCloud.provider}
                onChange={(e) => handleProviderChange(e.target.value as CloudEmbeddingProvider)}
              >
                {cloudProviderOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Input
                placeholder="端点地址，如 https://api.siliconflow.cn/v1"
                className="h-8 text-sm"
                value={editCloud.baseUrl}
                onChange={(e) => setEditCloud((prev) => ({ ...prev, baseUrl: e.target.value }))}
              />
              {cloudModelOptions.length > 0 ? (
                <select
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={editCloud.model}
                  onChange={(e) => setEditCloud((prev) => ({ ...prev, model: e.target.value }))}
                >
                  {cloudModelOptions.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  placeholder="嵌入模型名称，如 BAAI/bge-m3"
                  className="h-8 text-sm"
                  value={editCloud.model}
                  onChange={(e) => setEditCloud((prev) => ({ ...prev, model: e.target.value }))}
                />
              )}
              <Input
                type="password"
                placeholder={embeddingCfg?.cloud.hasApiKey ? 'API Key 已配置（输入新值可替换）' : 'API Key'}
                className="h-8 text-sm"
                value={editCloud.apiKey}
                onChange={(e) => setEditCloud((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
            </div>

            {/* 操作结果提示 */}
            {embeddingStatus && (
              <p className={`text-xs ${embeddingStatus.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
                {embeddingStatus.text}
              </p>
            )}

            {/* 连接测试（不保存）与保存按钮 */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => handleTestEmbedding('ollama')}
                disabled={embeddingTesting !== null || embeddingSaving || !embeddingCfg?.localEnabled}
              >
                {embeddingTesting === 'ollama' ? '测试中...' : '测试本地'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => handleTestEmbedding('cloud')}
                disabled={embeddingTesting !== null || embeddingSaving}
              >
                {embeddingTesting === 'cloud' ? '测试中...' : '测试云端'}
              </Button>
              <Button
                size="sm"
                className="flex-1"
                onClick={handleSaveEmbeddingConfig}
                disabled={embeddingSaving || embeddingTesting !== null || !embeddingCfg}
              >
                {embeddingSaving ? '保存中...' : '保存配置'}
              </Button>
            </div>

            {/* 换模型后的老数据提示 + 重建索引入口（不自动触发，由用户手动执行） */}
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 space-y-2">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                提示：本地 bge-m3 与云端 BAAI/bge-m3 向量空间一致，切换无需重建；但若知识库曾用其他模型（如
                bge-large-zh-v1.5）构建，需点击「重建索引」重新生成全部向量，否则检索质量会下降。
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleRebuildIndex}
                disabled={embeddingRebuilding || !embeddingCfg}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1 ${embeddingRebuilding ? 'animate-spin' : ''}`} />
                {embeddingRebuilding ? '重建中...' : '重建索引'}
              </Button>

              {/* 全量重建进度条（后端后台执行，前端轮询进度快照更新） */}
              {reindexProgress && reindexProgress.total > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {reindexProgress.running
                        ? `重建中（第 ${reindexProgress.round}/${reindexProgress.maxRound} 轮）`
                        : '重建结束'}
                      {' · 成功 '}
                      {reindexProgress.done}
                      {reindexProgress.failed > 0 ? ` · 失败 ${reindexProgress.failed}` : ''}
                    </span>
                    <span className="text-muted-foreground">
                      {Math.min(
                        100,
                        Math.round(
                          ((reindexProgress.done + reindexProgress.failed) / reindexProgress.total) * 100,
                        ),
                      )}
                      %
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        !reindexProgress.running && reindexProgress.failed === 0
                          ? 'bg-emerald-500'
                          : 'bg-amber-500'
                      }`}
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round(
                            ((reindexProgress.done + reindexProgress.failed) / reindexProgress.total) * 100,
                          ),
                        )}%`,
                      }}
                    />
                  </div>
                  {/* 末轮重试后仍失败的条目详情（仅在重建结束且有失败时展示）。
                      按失败原因分组：源文件丢失是永久性失败，必须醒目提示用户删除后重新上传 */}
                  {!reindexProgress.running && reindexProgress.errors.length > 0 && (() => {
                    const lostErrors = reindexProgress.errors.filter(
                      (e) => e.reason === 'source-unavailable',
                    );
                    const otherErrors = reindexProgress.errors.filter(
                      (e) => e.reason !== 'source-unavailable',
                    );
                    return (
                      <div className="space-y-1 pt-1">
                        {lostErrors.length > 0 && (
                          <>
                            <p className="text-xs font-medium text-destructive">
                              以下 {lostErrors.length} 个文档因源文件丢失无法重建，请删除该文档后重新上传：
                            </p>
                            <ul className="max-h-24 space-y-0.5 overflow-y-auto">
                              {lostErrors.map((e) => (
                                <li key={e.opId} className="text-xs text-destructive">
                                  · {e.documentTitle || `文档 #${e.versionId}`}：{e.error}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        {otherErrors.length > 0 && (
                          <>
                            <p className="text-xs text-destructive">
                              以下 {otherErrors.length} 个文档重试 {reindexProgress.maxRound} 次后仍失败：
                            </p>
                            <ul className="max-h-24 space-y-0.5 overflow-y-auto">
                              {otherErrors.map((e) => (
                                <li key={e.opId} className="text-xs text-muted-foreground">
                                  · {e.documentTitle || `文档 #${e.versionId}`}：{e.error}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
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

          {/* ==================== 关于 ==================== */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-foreground cyberpunk-ms-text">关于</h3>
            <div className="rounded-md bg-muted/50 px-3 py-2.5 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">以太忆核</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Aether Memory Core{updateCheck.currentVersion ? ` · v${updateCheck.currentVersion}` : ' · v0.1.2'}
                </p>
              </div>
              <Cpu className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
            {/* 检查更新：与主页共用同一检测状态，发现新版本时全局弹窗已由 ChatAgent 渲染 */}
            <button
              type="button"
              onClick={() => void updateCheck.checkForUpdate(true)}
              disabled={updateCheck.checking}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {updateCheck.checking ? '正在检查更新…' : '检查更新'}
            </button>
            {updateCheck.manualFeedback && (
              <p className="text-xs text-muted-foreground leading-relaxed">
                {updateCheck.manualFeedback}
              </p>
            )}
            <button
              type="button"
              onClick={openBeianSite}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              陕ICP备2026025350号-1
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsDialog;
