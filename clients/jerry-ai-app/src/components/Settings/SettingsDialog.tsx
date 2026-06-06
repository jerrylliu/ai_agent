import React from 'react';
import { X, Moon, Sun, Zap, Brain, FileText, MessageSquare } from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import type { ThemeMode } from '../../hooks/useTheme';

export interface AppSettings {
  memoryEnabled: boolean;
  summaryEnabled: boolean;
  injectMemoryOnNewSession: boolean;
}

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
  if (!open) return null;

  const handleSettingChange = (key: keyof AppSettings, value: boolean) => {
    onSettingsChange({ ...settings, [key]: value });
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
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[420px] max-h-[80vh] flex flex-col overflow-hidden cyberpunk-ms-dialog-card">
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

            {/* 启用记忆功能 */}
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

            {/* 启用摘要功能 */}
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

            {/* 新会话注入记忆 */}
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
        </div>
      </div>
    </div>
  );
};

export default SettingsDialog;
