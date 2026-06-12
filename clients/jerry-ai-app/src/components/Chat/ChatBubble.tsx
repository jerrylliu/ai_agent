import React from "react";
import { Button } from "../ui/button";
import { Database, ThumbsUp, ThumbsDown } from "lucide-react";
import MarkdownRenderer from "../MarkdownRenderer";
import { formatTime } from "../../lib/utils";
import type { Message } from "../../types/session";
import { submitFeedback } from "../../lib/api";

interface ChatBubbleProps {
  message: Message;
  prevMessage: Message | undefined;
  currentSessionId: string | null;
  feedbackState: Record<string, "positive" | "negative" | null>;
  onFeedbackStateChange: (state: Record<string, "positive" | "negative" | null>) => void;
  onCopyToast: (toast: { show: boolean; message: string; x: number; y: number }) => void;
  onFeedbackToast: (toast: { show: boolean; message: string; x: number; y: number }) => void;
  onUpdateMessage: (id: string, content: string) => Promise<void>;
  onDeleteMessage: (id: string) => void;
  onAlert: (message: string) => void;
}

const ChatBubble: React.FC<ChatBubbleProps> = ({
  message,
  prevMessage,
  currentSessionId,
  feedbackState,
  onFeedbackStateChange,
  onCopyToast,
  onFeedbackToast,
  onUpdateMessage,
  onDeleteMessage,
  onAlert,
}) => {
  return (
    <div
      className={`flex ${message.role === "user" ? "flex-row-reverse" : "flex-row"} gap-3`}
      style={{ maxWidth: '80%', minWidth: 0 }}
    >
      {/* 消息内容区域：气泡 + 元信息 */}
      <div className="flex flex-col min-w-0" style={{ maxWidth: '100%' }}>
        {/* 消息气泡容器 */}
        <div className="relative" style={{ maxWidth: '100%' }}>
          {/* 消息气泡 */}
          <div
            className={`rounded-lg p-3 shadow-sm transition-all duration-200 ${message.role === "user"
              ? "bg-primary text-white rounded-tr-none cyberpunk-user-msg"
              : "bg-card border border-gray-200 dark:border-slate-600 text-gray-900 dark:text-white rounded-tl-none cyberpunk-ai-msg"
              }`}
            style={{
              maxWidth: '100%',
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              minWidth: 0,
            }}
          >
            {/* AI消息：使用Markdown渲染 */}
            {message.role === "assistant" ? (
              <div className="min-w-0" style={{ maxWidth: '100%', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                <MarkdownRenderer>{message.content}</MarkdownRenderer>
              </div>
            ) : (
              /* 用户消息：支持图片预览 + Markdown渲染 */
              <>
                {message.images && message.images.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {message.images.map((imgUrl, imgIdx) => (
                      <img
                        key={imgIdx}
                        src={imgUrl}
                        alt={`图片 ${imgIdx + 1}`}
                        className="max-w-[200px] max-h-[200px] object-contain rounded"
                        style={{ cursor: 'pointer' }}
                        onClick={() => window.open(imgUrl, '_blank')}
                      />
                    ))}
                  </div>
                )}
                <MarkdownRenderer>{message.content}</MarkdownRenderer>
              </>
            )}
          </div>
          {/* 用户消息操作按钮 */}
          {message.role === "user" && (
            <div className="top-1 right-1 flex space-x-1">
              {/* 编辑消息按钮 */}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-gray-400 hover:text-blue-500"
                onClick={(e) => {
                  e.stopPropagation();
                  const newContent = prompt('请输入新的消息内容:', message.content);
                  if (newContent && newContent.trim()) {
                    onUpdateMessage(message.id, newContent.trim())
                      .then(() => { })
                      .catch((error) => {
                        onAlert('更新消息失败: ' + (error.message || '未知错误'));
                      });
                  }
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </Button>
              {/* 删除消息按钮 */}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-gray-400 hover:text-red-500"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteMessage(message.id);
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </Button>
            </div>
          )}
          {/* AI消息反馈按钮：点赞/点踩/复制 */}
          {message.role === "assistant" && (
            <div className="top-1 right-1 flex space-x-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                title="复制内容"
                onClick={async (e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  const rect = btn.getBoundingClientRect();
                  try {
                    const contentToCopy = message.content.replace(/<think[\s\S]*?<\/think>/gs, "");
                    await navigator.clipboard.writeText(contentToCopy);
                    onCopyToast({ show: true, message: '内容已复制', x: rect.left, y: rect.top - 8 });
                    setTimeout(() => onCopyToast({ show: false, message: '', x: 0, y: 0 }), 2000);
                  } catch {
                    onCopyToast({ show: true, message: '复制失败，请重试', x: rect.left, y: rect.top - 8 });
                    setTimeout(() => onCopyToast({ show: false, message: '', x: 0, y: 0 }), 2000);
                  }
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${feedbackState[message.id] === 'positive' ? 'text-green-500' : 'text-gray-400 hover:text-green-500'}`}
                title="有帮助"
                onClick={async (e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  const rect = btn.getBoundingClientRect();
                  try {
                    const result = await submitFeedback({
                      sessionId: currentSessionId || '',
                      userMessage: prevMessage?.role === 'user' ? prevMessage.content : '',
                      assistantMessage: message.content,
                      rating: 'positive',
                      usedKnowledgeBase: message.fromKnowledgeBase,
                    });
                    if (result.action === 'created') {
                      onFeedbackStateChange({ ...feedbackState, [message.id]: 'positive' });
                      onFeedbackToast({ show: true, message: '已点赞', x: rect.left, y: rect.top - 8 });
                    } else {
                      onFeedbackStateChange({ ...feedbackState, [message.id]: null });
                      onFeedbackToast({ show: true, message: '已取消点赞', x: rect.left, y: rect.top - 8 });
                    }
                    setTimeout(() => onFeedbackToast({ show: false, message: '', x: 0, y: 0 }), 1500);
                  } catch (err) {
                    console.error('提交反馈失败:', err);
                  }
                }}
              >
                <ThumbsUp className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${feedbackState[message.id] === 'negative' ? 'text-red-500' : 'text-gray-400 hover:text-red-500'}`}
                title="需改进"
                onClick={async (e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  const rect = btn.getBoundingClientRect();
                  try {
                    const result = await submitFeedback({
                      sessionId: currentSessionId || '',
                      userMessage: prevMessage?.role === 'user' ? prevMessage.content : '',
                      assistantMessage: message.content,
                      rating: 'negative',
                      usedKnowledgeBase: message.fromKnowledgeBase,
                    });
                    if (result.action === 'created') {
                      onFeedbackStateChange({ ...feedbackState, [message.id]: 'negative' });
                      onFeedbackToast({ show: true, message: '已点踩', x: rect.left, y: rect.top - 8 });
                    } else {
                      onFeedbackStateChange({ ...feedbackState, [message.id]: null });
                      onFeedbackToast({ show: true, message: '已取消点踩', x: rect.left, y: rect.top - 8 });
                    }
                    setTimeout(() => onFeedbackToast({ show: false, message: '', x: 0, y: 0 }), 1500);
                  } catch (err) {
                    console.error('提交反馈失败:', err);
                  }
                }}
              >
                <ThumbsDown className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
        {/* 消息元信息栏：知识库来源标记 + 时间戳 + 已读标记 */}
        <div className="flex items-center mt-1">
          {message.fromKnowledgeBase && (
            <span className="text-xs px-1.5 py-0.5 bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 rounded mr-2 flex items-center">
              <Database className="h-3 w-3 mr-0.5" />
              知识库
              {message.contextCount && message.contextCount > 0 && (
                <span className="ml-1 text-xs opacity-75">({message.contextCount}条)</span>
              )}
            </span>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-300 ml-2">
            {formatTime(message.timestamp)}
          </p>
          {message.role === "user" && (
            <span className="text-xs text-gray-400 dark:text-gray-400 ml-2">
              ✓
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatBubble;
