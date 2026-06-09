import React, { useRef, useState } from "react";
import { Send, X, Plus, Image, FileText } from "lucide-react";
import { Button } from "../ui/button";

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

  const rows = compact ? 1 : 2;

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
      <div className="relative rounded-3xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-lg shadow-gray-200/50 dark:shadow-slate-900/50 cyberpunk-welcome-input">
        {/* 上方：文本输入区域 */}
        <textarea
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="请输入..."
          rows={rows}
          className={`w-full resize-none bg-transparent px-5 text-sm text-foreground placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none ${compact ? 'pt-3 pb-1' : 'pt-4 pb-2'}`}
        />

        {/* 下方：功能按钮栏 */}
        <div className={`flex items-center justify-between px-3 ${compact ? 'pb-2' : 'pb-3'}`}>
          {/* 左侧：+号按钮及弹出菜单 */}
          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowPlusMenu(!showPlusMenu)}
              className="rounded-full h-8 w-8 hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400 cyberpunk-plus-btn"
            >
              <Plus className="h-5 w-5" />
            </Button>

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

          {/* 右侧：发送/停止按钮 */}
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
    </>
  );
};

export default ChatInput;
