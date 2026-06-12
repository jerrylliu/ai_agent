import React from "react";
import { Button } from "../ui/button";

interface ApiKeyDialogProps {
  open: boolean;
  provider: 'deepseek' | 'zhipu';
  apiKeyInput: string;
  onApiKeyInputChange: (value: string) => void;
  onClose: () => void;
  onConfigureApiKey: (provider: 'deepseek' | 'zhipu', key: string) => Promise<{ success: boolean; message: string }>;
  onAlert: (message: string) => void;
}

const ApiKeyDialog: React.FC<ApiKeyDialogProps> = ({
  open,
  provider,
  apiKeyInput,
  onApiKeyInputChange,
  onClose,
  onConfigureApiKey,
  onAlert,
}) => {
  if (!open) return null;

  const providerName = provider === 'deepseek' ? 'DeepSeek' : '智谱';
  const providerUrl = provider === 'deepseek'
    ? 'https://platform.deepseek.com/api_keys'
    : 'https://open.bigmodel.cn/usercenter/apikeys';
  const placeholder = provider === 'deepseek' ? 'sk-...' : '请输入智谱 API Key';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 cyberpunk-apikey-dialog-bg" onClick={onClose}>
      <div className="bg-card rounded-lg p-6 w-96 shadow-xl cyberpunk-apikey-dialog-card" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 cyberpunk-apikey-dialog-title">
          配置 {providerName} API Key
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-300 mb-4 cyberpunk-apikey-dialog-desc">
          使用 {providerName} 线上模型需要 API Key，
          <a
            href={providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:underline"
          >
            点击获取
          </a>
        </p>
        <input
          type="password"
          value={apiKeyInput}
          onChange={e => onApiKeyInputChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 cyberpunk-apikey-dialog-input"
        />
        <div className="flex justify-end space-x-2">
          <Button variant="ghost" size="sm" onClick={onClose} className="cyberpunk-apikey-dialog-cancel">取消</Button>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white cyberpunk-apikey-dialog-save"
            disabled={!apiKeyInput.trim()}
            onClick={async () => {
              const trimmedKey = apiKeyInput.trim();
              // 检查 API Key 是否包含非 ASCII 字符（会导致 ByteString 错误）
              const nonAsciiMatch = trimmedKey.match(/[^\x00-\x7F]/g);
              if (nonAsciiMatch) {
                onAlert(`API Key 包含非 ASCII 字符（可能复制时带入了中文引号或空格），请检查后重新输入`);
                return;
              }
              const result = await onConfigureApiKey(provider, trimmedKey);
              if (result.success) {
                onClose();
                onApiKeyInputChange('');
              } else {
                onAlert(result.message);
              }
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ApiKeyDialog;
