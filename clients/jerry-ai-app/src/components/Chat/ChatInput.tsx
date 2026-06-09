import React, { useRef } from "react";
import { Send, X, Smile, Image, FileText } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
}) => {
  const imageInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="bg-card border-t border-gray-200 dark:border-slate-600 p-4">
      {/* 待发送图片预览区 */}
      {pendingImages.length > 0 && (
        <div className="mb-3 p-3 bg-gray-50 dark:bg-slate-700/50 rounded-lg">
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
      {/* 输入框与功能按钮区域 */}
      <div className="flex items-end space-x-2">
        {/* 左侧功能按钮组 */}
        <div className="flex space-x-1">
          {/* 表情按钮（预留功能） */}
          <Button variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-slate-700">
            <Smile className="h-5 w-5" />
          </Button>

          {/* 图片上传按钮 */}
          <label className={`cursor-pointer ${!supportsVision ? 'opacity-40 pointer-events-none' : ''}`}>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              disabled={!supportsVision}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  onSendFile(file);
                }
                e.target.value = '';
              }}
            />
            <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 cyberpunk-icon-glow" title={!supportsVision ? '当前模型不支持图片' : '上传图片'}>
              <span>
                <Image className="h-5 w-5" />
              </span>
            </Button>
          </label>

          {/* 文件上传按钮 */}
          <label className="cursor-pointer">
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  onSendFile(file);
                }
                e.target.value = '';
              }}
            />
            <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 cyberpunk-icon-glow">
              <span>
                <FileText className="h-5 w-5" />
              </span>
            </Button>
          </label>
        </div>
        {/* 文本输入框 */}
        <Input
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入消息..."
          className="pr-24 py-3 rounded-full border-gray-300 dark:border-slate-500 focus:ring-2 focus:ring-primary focus:border-transparent cyberpunk-input-glow"
        />
        {/* 发送/停止按钮 */}
        {isTyping ? (
          <Button
            onClick={onStopGeneration}
            className="rounded-full bg-red-500 hover:bg-red-600 text-white p-3 transition-all duration-200"
            title="停止生成"
          >
            <div className="h-5 w-5 flex items-center justify-center">
              <div className="h-3 w-3 bg-white rounded-sm" />
            </div>
          </Button>
        ) : (
          <Button
            onClick={onSend}
            disabled={!inputValue.trim() && pendingImages.length === 0}
            className="rounded-full bg-primary hover:bg-primary/90 text-white p-3 transition-all duration-200 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            <Send className="h-5 w-5" />
          </Button>
        )}
      </div>
    </div>
  );
};

export default ChatInput;
