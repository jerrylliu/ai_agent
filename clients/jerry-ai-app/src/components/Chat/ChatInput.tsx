import React, { useRef, useState } from "react";
import { Send, X, Plus, Image, FileText, ImageIcon, Mic, MicOff, Loader2, CloudOff } from "lucide-react";
import { Button } from "../ui/button";
import { useSettingsStore } from "../../stores/settings-store";
import { useSpeechRecognition, type RecordingStatus } from "../../hooks/useSpeechRecognition";

interface ChatInputProps {
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  isTyping: boolean;
  onStopGeneration: () => void;
  pendingImages: string[];
  onClearPendingImages: () => void;
  onRemovePendingImage: (index: number) => void;
  onSendFile: (file: File) => void;
  supportsVision: boolean;
  /** 底部紧凑模式：更小的 textarea 和 padding */
  compact?: boolean;
}

/** 图片生成模型切换按钮 */
const ImageModelToggle: React.FC = () => {
  const { imageModel, updateSetting } = useSettingsStore();
  const isPro = imageModel === 'wan2.7-image-pro';

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => updateSetting('imageModel', isPro ? 'wan2.7-image' : 'wan2.7-image-pro')}
      className={`rounded-full h-7 px-2 text-xs font-medium transition-all duration-200 ${
        isPro
          ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/50'
          : 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50'
      }`}
      title={`当前图片模型：${isPro ? 'Pro（高品质）' : '标准（快速）'}，点击切换`}
    >
      <ImageIcon className="h-3 w-3 mr-1" />
      {isPro ? 'Pro' : '标准'}
    </Button>
  );
};

/** 麦克风按钮（基于状态机的 UI） */
const MicButton: React.FC<{
  status: RecordingStatus;
  audioLevel: number;
  interimText: string;
  error: string | null;
  isUsingLocalFallback: boolean;
  onStart: () => void;
  onStop: () => void;
}> = ({ status, audioLevel, interimText, error, isUsingLocalFallback, onStart, onStop }) => {
  const isRecording = status === 'recording';
  const isConnecting = status === 'connecting';

  const handleClick = () => {
    if (isRecording) {
      onStop();
    } else if (status === 'idle' || status === 'error') {
      onStart();
    }
  };

  // 根据状态选择图标 / 颜色
  const renderIcon = () => {
    if (isConnecting) return <Loader2 className="h-4 w-4 animate-spin" />;
    if (isRecording) return <MicOff className="h-4 w-4" />;
    return <Mic className="h-4 w-4" />;
  };

  const buttonClass = isRecording
    ? 'bg-red-100 dark:bg-red-900/30 text-red-500 hover:bg-red-200 dark:hover:bg-red-900/50'
    : isConnecting
    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-500'
    : 'hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400';

  const title = isConnecting ? '连接中...' : isRecording ? '停止录音' : '语音输入';

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={handleClick}
        disabled={isConnecting}
        className={`rounded-full h-8 w-8 transition-all duration-200 ${buttonClass}`}
        title={title}
      >
        {renderIcon()}
      </Button>
      {/* 录音中波形指示 */}
      {isRecording && (
        <div className="absolute -top-1 -right-1">
          <div
            className="w-3 h-3 rounded-full bg-red-500 animate-pulse"
            style={{ transform: `scale(${0.8 + audioLevel * 0.6})` }}
          />
        </div>
      )}
      {/* 中间结果气泡 */}
      {isRecording && interimText && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 max-w-[200px] truncate bg-gray-800 text-gray-200 text-xs px-3 py-1.5 rounded-lg shadow-lg z-30">
          {interimText}
          <span className="inline-block w-0.5 h-3 bg-gray-400 ml-0.5 animate-pulse" />
        </div>
      )}
      {/* 本地兜底提示 */}
      {isRecording && isUsingLocalFallback && (
        <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5">
          <CloudOff className="h-2.5 w-2.5" />
          本地识别
        </div>
      )}
      {/* 错误提示 */}
      {error && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap bg-red-600 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg z-30">
          {error}
        </div>
      )}
    </div>
  );
};

const ChatInput: React.FC<ChatInputProps> = ({
  inputValue,
  onInputChange,
  onSend,
  onKeyDown,
  isTyping,
  onStopGeneration,
  pendingImages,
  onClearPendingImages,
  onRemovePendingImage,
  onSendFile,
  supportsVision,
  compact = false,
}) => {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);

  // 用 ref 保持最新 inputValue / onInputChange，避免 useEffect 因父组件 inline 函数频繁重跑
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const onInputChangeRef = useRef(onInputChange);
  onInputChangeRef.current = onInputChange;

  // 语音识别：录音开始前的输入框内容（作为基准 = 用户原本输入的文字）
  const baseTextRef = useRef('');

  // 语音识别 Hook（onFinal 仅作通知用，不写输入框，避免双写竞态）
  const speech = useSpeechRecognition();

  // 单一数据源：录音中及停止后短期内，把 baseText + finalText + interimText 同步到输入框
  // 注意：依赖只用 finalText / interimText / status，不依赖 onInputChange
  React.useEffect(() => {
    if (speech.status === 'recording') {
      const composed = baseTextRef.current + speech.finalText + speech.interimText;
      if (composed !== inputValueRef.current) {
        onInputChangeRef.current(composed);
      }
    }
    // idle 状态下如果 finalText 有更新（后端 final 静默替换），也同步到输入框
    if (speech.status === 'idle' && baseTextRef.current) {
      const composed = baseTextRef.current + speech.finalText;
      if (composed !== inputValueRef.current) {
        onInputChangeRef.current(composed);
      }
    }
  }, [speech.finalText, speech.interimText, speech.status]);

  // 监听录音状态：开始时记录基准文本（每次都重新记录，避免残留）
  const prevStatusRef = useRef(speech.status);
  React.useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = speech.status;
    // 从「非录音」→「录音」的瞬间（包括 idle/error → connecting → recording），
    // 在 connecting 时就记录基准，避免 connecting 期间 inputValue 被其他事件改变
    if (prev !== 'connecting' && curr === 'connecting') {
      baseTextRef.current = inputValueRef.current;
    }
    // idle 后延迟清空基准（等后端 final 静默替换完成）
    if (curr === 'idle' && prev !== 'idle') {
      setTimeout(() => {
        baseTextRef.current = '';
      }, 2000);
    }
    prevStatusRef.current = curr;
  }, [speech.status]);

  const rows = compact ? 1 : 2;

  // 计算"已确认部分"的长度，用于在 textarea 上面叠加灰色 interim
  const confirmedLength = baseTextRef.current.length;
  const showInterimOverlay = speech.isRecording && speech.interimText && inputValue.length > confirmedLength;

  return (
    <>
      {/* 待发送图片预览区 */}
      {pendingImages.length > 0 && (
        <div className="mb-3 p-3 bg-gray-50 dark:bg-slate-700/50 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600 dark:text-gray-300">
              待发送图片 ({pendingImages.length})
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearPendingImages}
              className="h-6 text-xs text-gray-500 hover:text-red-500"
            >
              <X className="h-3 w-3 mr-1" />
              清除全部
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {pendingImages.map((url, index) => (
              <div key={index} className="relative group">
                <img
                  src={url}
                  alt={`待发送图片 ${index + 1}`}
                  className="h-16 w-16 object-cover rounded-lg border border-gray-200 dark:border-slate-500"
                />
                <button
                  onClick={() => onRemovePendingImage(index)}
                  className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full h-5 w-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 输入框容器 */}
      <div
        className={`relative rounded-3xl border bg-white dark:bg-slate-800 shadow-lg shadow-gray-200/50 dark:shadow-slate-900/50 cyberpunk-welcome-input transition-all duration-300 ${
          speech.isRecording
            ? 'border-red-300 dark:border-red-700 shadow-red-200/30 dark:shadow-red-900/30'
            : 'border-gray-200 dark:border-slate-600'
        }`}
      >
        {/* 上方：文本输入区域 */}
        <div className="relative">
          <textarea
            value={inputValue}
            onChange={(e) => {
              // 录音中禁止手动编辑（避免与语音同步冲突）
              if (speech.status === 'recording') {
                return;
              }
              onInputChange(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={speech.isRecording ? '正在聆听...' : '请输入...'}
            rows={rows}
            readOnly={speech.status === 'recording'}
            className={`relative w-full resize-none bg-transparent px-5 text-sm text-foreground placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none ${
              compact ? 'pt-3 pb-1' : 'pt-4 pb-2'
            } ${speech.isRecording ? 'cursor-not-allowed' : ''}`}
            style={
              showInterimOverlay
                ? { caretColor: '#ef4444' }
                : undefined
            }
          />
          {/* 录音状态浮层提示 */}
          {speech.isRecording && (
            <div className="absolute top-2 right-3 flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400 pointer-events-none">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              REC
            </div>
          )}
        </div>

        {/* 下方：功能按钮栏 */}
        <div className={`flex items-center justify-between px-3 ${compact ? 'pb-2' : 'pb-3'}`}>
          {/* 左侧：+号按钮及弹出菜单 */}
          <div className="relative flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowPlusMenu(!showPlusMenu)}
              className="rounded-full h-8 w-8 hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400 cyberpunk-plus-btn"
            >
              <Plus className="h-5 w-5" />
            </Button>

            {/* 图片模型切换按钮 */}
            <ImageModelToggle />

            {/* +号弹出菜单 */}
            {showPlusMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowPlusMenu(false)}
                />
                <div className="absolute left-0 bottom-full mb-2 z-20 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-600 shadow-xl py-1 min-w-[140px] cyberpunk-plus-menu">
                  {/* 上传图片 */}
                  <label
                    className={`flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer ${!supportsVision ? 'opacity-40 pointer-events-none' : ''}`}
                    onClick={() => setShowPlusMenu(false)}
                  >
                    <Image className="h-4 w-4" />
                    <span>上传图片</span>
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={!supportsVision}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) onSendFile(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {/* 上传文档 */}
                  <label
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer"
                    onClick={() => setShowPlusMenu(false)}
                  >
                    <FileText className="h-4 w-4" />
                    <span>上传文档</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) onSendFile(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </>
            )}
          </div>

          {/* 右侧：麦克风 + 发送/停止按钮 */}
          <div className="flex items-center gap-1">
            <MicButton
              status={speech.status}
              audioLevel={speech.audioLevel}
              interimText={speech.interimText}
              error={speech.error}
              isUsingLocalFallback={speech.isUsingLocalFallback}
              onStart={speech.start}
              onStop={speech.stop}
            />
            {isTyping ? (
              <Button
                onClick={onStopGeneration}
                className="rounded-full bg-red-500 hover:bg-red-600 text-white h-8 w-8 p-0 transition-all duration-200"
                title="停止生成"
              >
                <div className="h-3 w-3 bg-white rounded-sm" />
              </Button>
            ) : (
              <Button
                onClick={onSend}
                disabled={!inputValue.trim() && pendingImages.length === 0}
                className="rounded-full bg-primary hover:bg-primary/90 text-white h-8 w-8 p-0 transition-all duration-200 disabled:bg-gray-300 dark:disabled:bg-slate-600 disabled:cursor-not-allowed cyberpunk-send-btn"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default ChatInput;
