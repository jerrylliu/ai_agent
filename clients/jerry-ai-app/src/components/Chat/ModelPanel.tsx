import React from "react";
import { X, CheckCircle, Cpu, Cloud, Key, Settings, ChevronRight, ChevronLeft } from "lucide-react";

interface Model {
  id: string;
  name: string;
  provider: string;
  description: string;
}

interface ModelPanelProps {
  showModelPanel: boolean;
  onToggleModelPanel: () => void;
  currentModelId: string;
  availableModels: Model[];
  hasDeepseekApiKey: boolean;
  hasZhipuApiKey: boolean;
  onSwitchModel: (modelId: string) => Promise<{ success: boolean; message: string }>;
  onOpenApiKeyDialog: (provider: 'deepseek' | 'zhipu') => void;
  onAlert: (message: string) => void;
}

const ModelPanel: React.FC<ModelPanelProps> = ({
  showModelPanel,
  onToggleModelPanel,
  currentModelId,
  availableModels,
  hasDeepseekApiKey,
  hasZhipuApiKey,
  onSwitchModel,
  onOpenApiKeyDialog,
  onAlert,
}) => {
  return (
    <div className="absolute right-0 top-0 h-full z-20">
      {/* 右侧面板展开/收起按钮 */}
      <button
        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full z-20 w-7 h-14 flex items-center justify-center bg-card border border-r-0 border-gray-200 dark:border-slate-600 rounded-l-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors shadow-sm"
        onClick={onToggleModelPanel}
        title={showModelPanel ? '收起面板' : '展开模型设置'}
      >
        {showModelPanel ? (
          <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-300" />
        ) : (
          <ChevronLeft className="h-4 w-4 text-gray-500 dark:text-gray-300" />
        )}
      </button>

      {/* 模型面板主体 */}
      <div
        className={`h-full bg-card border-l border-gray-200 dark:border-slate-600 transition-all duration-300 ease-in-out overflow-hidden shadow-lg cyberpunk-border-glow ${showModelPanel ? 'w-64' : 'w-0'
          }`}
      >
        <div className="w-64 h-full flex flex-col">
          {/* 面板头部 */}
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-600 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Settings className="h-4 w-4 text-gray-600 dark:text-gray-300" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">模型设置</h3>
            </div>
            <button
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
              onClick={() => onToggleModelPanel()}
            >
              <X className="h-3.5 w-3.5 text-gray-400" />
            </button>
          </div>

          {/* 当前模型信息卡片 */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-600 bg-blue-50/50 dark:bg-blue-900/20">
            <p className="text-xs text-gray-500 dark:text-gray-300 mb-1 cyberpunk-model-current-label">当前模型</p>
            <div className="flex items-center space-x-2">
              {currentModelId.startsWith('ollama') ? (
                <Cpu className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0 cyberpunk-model-current-icon" />
              ) : (
                <Cloud className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0 cyberpunk-model-current-icon" />
              )}
              <span className="text-sm font-medium text-gray-900 dark:text-white truncate cyberpunk-model-current-name">
                {availableModels.find(m => m.id === currentModelId)?.name || currentModelId}
              </span>
            </div>
          </div>

          {/* 模型列表滚动区域 */}
          <div className="flex-1 overflow-y-auto">
            {/* 本地模型列表（Ollama） */}
            {availableModels.filter(m => m.provider === 'ollama').length > 0 && (
              <div className="px-3 py-2">
                <p className="text-xs font-medium text-gray-400 dark:text-gray-400 px-1 mb-1 flex items-center cyberpunk-model-group-label">
                  <Cpu className="h-3 w-3 mr-1" /> 本地模型
                </p>
                {availableModels.filter(m => m.provider === 'ollama').map(model => (
                  <button
                    key={model.id}
                    className={`w-full px-3 py-2.5 text-left rounded-lg mb-1 transition-colors ${currentModelId === model.id
                        ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                        : 'hover:bg-gray-50 dark:hover:bg-slate-700 border border-transparent'
                      }`}
                    onClick={async () => {
                      const result = await onSwitchModel(model.id);
                      if (!result.success) { onAlert(result.message); }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-900 dark:text-white cyberpunk-model-item-name">{model.name}</p>
                      {currentModelId === model.id && (
                        <CheckCircle className="h-4 w-4 text-blue-500 flex-shrink-0 cyberpunk-model-item-check" />
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-0.5 cyberpunk-model-item-desc">{model.description}</p>
                  </button>
                ))}
              </div>
            )}

            {/* DeepSeek 线上模型列表 */}
            {availableModels.filter(m => m.provider === 'deepseek').length > 0 && (
              <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-600">
                <p className="text-xs font-medium text-gray-400 dark:text-gray-400 px-1 mb-1 flex items-center cyberpunk-model-group-label">
                  <Cloud className="h-3 w-3 mr-1" /> DeepSeek 线上模型
                </p>
                {availableModels.filter(m => m.provider === 'deepseek').map(model => (
                  <button
                    key={model.id}
                    className={`w-full px-3 py-2.5 text-left rounded-lg mb-1 transition-colors ${currentModelId === model.id
                        ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                        : 'hover:bg-gray-50 dark:hover:bg-slate-700 border border-transparent'
                      }`}
                    onClick={async () => {
                      if (!hasDeepseekApiKey) {
                        onOpenApiKeyDialog('deepseek');
                        return;
                      }
                      const result = await onSwitchModel(model.id);
                      if (!result.success) { onAlert(result.message); }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-900 dark:text-white flex items-center cyberpunk-model-item-name">
                        {model.name}
                        {!hasDeepseekApiKey && (
                          <Key className="h-3 w-3 ml-1 text-yellow-500" />
                        )}
                      </p>
                      {currentModelId === model.id && (
                        <CheckCircle className="h-4 w-4 text-blue-500 flex-shrink-0 cyberpunk-model-item-check" />
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-0.5 cyberpunk-model-item-desc">{model.description}</p>
                  </button>
                ))}
              </div>
            )}

            {/* 智谱线上模型列表 */}
            {availableModels.filter(m => m.provider === 'zhipu').length > 0 && (
              <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-600">
                <p className="text-xs font-medium text-gray-400 dark:text-gray-400 px-1 mb-1 flex items-center cyberpunk-model-group-label">
                  <Cloud className="h-3 w-3 mr-1" /> 智谱线上模型
                </p>
                {availableModels.filter(m => m.provider === 'zhipu').map(model => (
                  <button
                    key={model.id}
                    className={`w-full px-3 py-2.5 text-left rounded-lg mb-1 transition-colors ${currentModelId === model.id
                        ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                        : 'hover:bg-gray-50 dark:hover:bg-slate-700 border border-transparent'
                      }`}
                    onClick={async () => {
                      if (!hasZhipuApiKey) {
                        onOpenApiKeyDialog('zhipu');
                        return;
                      }
                      const result = await onSwitchModel(model.id);
                      if (!result.success) { onAlert(result.message); }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-900 dark:text-white flex items-center cyberpunk-model-item-name">
                        {model.name}
                        {!hasZhipuApiKey && (
                          <Key className="h-3 w-3 ml-1 text-yellow-500" />
                        )}
                      </p>
                      {currentModelId === model.id && (
                        <CheckCircle className="h-4 w-4 text-blue-500 flex-shrink-0 cyberpunk-model-item-check" />
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-0.5 cyberpunk-model-item-desc">{model.description}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* API Key配置入口 */}
          {(!hasDeepseekApiKey || !hasZhipuApiKey) && (
            <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-600">
              {!hasDeepseekApiKey && (
                <button
                  className="w-full px-3 py-2 text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg flex items-center transition-colors cyberpunk-model-apikey-btn"
                  onClick={() => onOpenApiKeyDialog('deepseek')}
                >
                  <Key className="h-4 w-4 mr-2" />
                  配置 DeepSeek API Key
                </button>
              )}
              {!hasZhipuApiKey && (
                <button
                  className="w-full px-3 py-2 text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg flex items-center transition-colors cyberpunk-model-apikey-btn"
                  onClick={() => onOpenApiKeyDialog('zhipu')}
                >
                  <Key className="h-4 w-4 mr-2" />
                  配置智谱 API Key
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModelPanel;
