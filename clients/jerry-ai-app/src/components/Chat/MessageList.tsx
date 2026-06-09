import React, { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import ChatBubble from "./ChatBubble";
import type { Message } from "../../types/session";
import { DEFAULT_AI_AVATAR_URL } from "../../lib/constants";

interface MessageListProps {
  messages: Message[];
  isTyping: boolean;
  toolStatus: { status: string; label: string } | null;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  currentSessionId: string | null;
  feedbackState: Record<string, "positive" | "negative" | null>;
  onFeedbackStateChange: (state: Record<string, "positive" | "negative" | null>) => void;
  onCopyToast: (toast: { show: boolean; message: string; x: number; y: number }) => void;
  onFeedbackToast: (toast: { show: boolean; message: string; x: number; y: number }) => void;
  onUpdateMessage: (id: string, content: string) => Promise<void>;
  onDeleteMessage: (id: string) => void;
  onAlert: (message: string) => void;
  isSessionSwitchRef: React.MutableRefObject<boolean>;
  isAtBottomRef: React.MutableRefObject<boolean>;
}

const MessageList: React.FC<MessageListProps> = ({
  messages,
  isTyping,
  toolStatus,
  messagesEndRef,
  currentSessionId,
  feedbackState,
  onFeedbackStateChange,
  onCopyToast,
  onFeedbackToast,
  onUpdateMessage,
  onDeleteMessage,
  onAlert,
  isSessionSwitchRef,
  isAtBottomRef,
}) => {
  const chatListRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => chatListRef.current,
    estimateSize: (index) => {
      const msg = messages[index];
      if (!msg) return 100;
      if (msg.role === 'user') {
        const len = msg.content?.length || 0;
        if (len < 50) return 80;
        if (len < 200) return 120;
        return 180;
      }
      const len = msg.content?.length || 0;
      if (len < 50) return 120;
      if (len < 200) return 200;
      if (len < 500) return 350;
      if (len < 1000) return 500;
      if (len < 2000) return 700;
      if (len < 4000) return 1000;
      return 1400;
    },
    overscan: 15,
  });

  // 新消息时自动滚动到底部
  const prevMessageCountRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > 0 && messages.length > prevMessageCountRef.current) {
      if (isAtBottomRef.current) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(messages.length - 1, { align: 'end', behavior: 'smooth' });
        });
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // 会话切换时滚动到底部
  useEffect(() => {
    if (isSessionSwitchRef.current && messages.length > 0) {
      isSessionSwitchRef.current = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(messages.length - 1, { align: 'end', behavior: 'instant' });
          isAtBottomRef.current = true;
        });
      });
    }
  }, [messages]);

  // 监听滚动位置，判断用户是否在底部附近
  useEffect(() => {
    const scrollEl = chatListRef.current;
    if (!scrollEl) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 150;
    };

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div ref={chatListRef} className="flex-1 overflow-y-auto p-6 min-w-0" style={{ overflowX: 'hidden' }}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const message = messages[virtualItem.index];
          const prevMessage = virtualItem.index > 0 ? messages[virtualItem.index - 1] : undefined;
          return (
            <div
              key={message.id}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"} min-w-0`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
                paddingBottom: '16px',
              }}
            >
              <ChatBubble
                message={message}
                prevMessage={prevMessage}
                currentSessionId={currentSessionId}
                feedbackState={feedbackState}
                onFeedbackStateChange={onFeedbackStateChange}
                onCopyToast={onCopyToast}
                onFeedbackToast={onFeedbackToast}
                onUpdateMessage={onUpdateMessage}
                onDeleteMessage={onDeleteMessage}
                onAlert={onAlert}
              />
            </div>
          );
        })}
      </div>
      {/* AI正在输入动画 */}
      {isTyping && (
        <div className="flex justify-start">
          <div className="flex max-w-[80%] flex-row space-x-3">
            <Avatar className="h-8 w-8 flex-shrink-0">
              <AvatarImage src={DEFAULT_AI_AVATAR_URL} />
              <AvatarFallback>AI</AvatarFallback>
            </Avatar>
            <div className="bg-card border border-gray-200 dark:border-slate-600 rounded-lg p-3 cyberpunk-ai-msg">
              {toolStatus && toolStatus.status !== 'done' ? (
                <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>{toolStatus.label}{toolStatus.status === 'executing' ? '中...' : '...'}</span>
                </div>
              ) : (
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 消息列表底部锚点 */}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default MessageList;
