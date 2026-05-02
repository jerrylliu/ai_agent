import { useState } from "react";
import { Send, MoreHorizontal, Search, Moon, Sun, Trash2, History, Plus, X, Smile, Image, FileText } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { useChat } from "../hooks/useChat";
import { useTheme } from "../hooks/useTheme";
import { formatTime, formatDate } from "../lib/utils";
import { API_BASE_URL } from "../lib/constants";
import MarkdownRenderer from "../components/MarkdownRenderer";

const ChatAgent: React.FC = () => {
  const [inputValue, setInputValue] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const {
    sessions,
    currentSessionId,
    messages,
    history,
    isTyping,
    isLoading,
    messagesEndRef,
    sendMessage,
    sendFile,
    updateMessage,
    deleteMessage,
    clearHistory,
    createNewSession,
    switchSession,
    deleteSession,
    toggleSessionPin,
  } = useChat();
  const { darkMode, toggleTheme } = useTheme();

  // 过滤会话列表
  const filteredSessions = sessions.filter(session => 
    session.title.toLowerCase().includes(searchKeyword.toLowerCase())
  );

  const handleSend = async () => {
    if (!inputValue.trim()) return;
    const userInput = inputValue;
    setInputValue("");
    await sendMessage(userInput);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleHistoryClick = (query: string) => {
    setInputValue(query);
  };

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('确定要删除这个会话吗？')) {
      deleteSession(sessionId);
    }
  };

  return (
    <div className="flex h-full bg-gray-50 dark:bg-gray-900">
      {/* 左侧会话列表 */}
      <div className="w-72 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">智能助手</h3>
            <Button variant="ghost" size="icon" onClick={toggleTheme}>
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
          </div>
          <div className="flex space-x-2 mb-4">
            <Button 
              onClick={createNewSession}
              className="flex-1 bg-primary hover:bg-primary/90 text-white"
            >
              <Plus className="h-4 w-4 mr-2" />
              新对话
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="搜索会话..."
              className="pl-10"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-medium text-gray-700 dark:text-gray-300 flex items-center">
              <History className="h-4 w-4 mr-2" />
              对话历史
            </h4>
            {history.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearHistory}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
          
          {/* 历史记录列表 */}
          {history.length > 0 && (
            <div className="mb-6">
              <h5 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-2 flex items-center">
                <History className="h-3 w-3 mr-1" />
                最近的问题
              </h5>
              <div className="space-y-2">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="p-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer transition-colors duration-200"
                    onClick={() => handleHistoryClick(item.query)}
                  >
                    <div className="line-clamp-1" dangerouslySetInnerHTML={{
                      __html: searchKeyword 
                        ? item.query.replace(new RegExp(`(${searchKeyword})`, 'gi'), '<mark style="background-color: #fef3c7; color: #92400e;">$1</mark>')
                        : item.query
                    }} />

                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {formatTime(item.timestamp)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* 会话列表 */}
          {isLoading ? (
            <div className="flex justify-center items-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : filteredSessions.length > 0 ? (
            <div className="space-y-2">
              {filteredSessions.map((session) => (
                <div
                  key={session.sessionId}
                  className={`p-3 rounded-lg cursor-pointer transition-all duration-200 relative ${session.sessionId === currentSessionId
                    ? 'bg-primary/10 dark:bg-primary/20 border border-primary/30 shadow-sm'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                  onClick={() => switchSession(session.sessionId)}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white mb-1 line-clamp-1">
                        {session.title}
                      </p>
                    </div>
                    <div className="flex space-x-1">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 text-gray-400 hover:text-blue-500"
                        onClick={(e) => {
                          e.stopPropagation();
                          // 实现会话标题编辑功能
                          const newTitle = prompt('请输入新的会话标题:', session.title);
                          if (newTitle && newTitle.trim()) {
                            // 调用更新会话标题的 API
                            fetch(`${API_BASE_URL}/sessions/${session.sessionId}`, {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ title: newTitle.trim() }),
                            }).then(() => {
                              // 重新加载会话列表
                              window.location.reload();
                            });
                          }
                        }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className={`h-6 w-6 ${session.isPinned ? 'text-yellow-500' : 'text-gray-400 hover:text-yellow-500'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSessionPin(session.sessionId);
                        }}
                      >
                        {session.isPinned ? (
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                          </svg>
                        )}
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 text-gray-400 hover:text-red-500"
                        onClick={(e) => handleDeleteSession(session.sessionId, e)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatDate(new Date(session.updatedAt))}
                  </p>
                </div>
              ))}
            </div>
          ) :
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              {searchKeyword ? (
                <>
                  <p>无匹配会话</p>
                  <Button 
                    onClick={() => setSearchKeyword("")}
                    className="mt-4 bg-primary hover:bg-primary/90 text-white"
                  >
                    清除搜索
                  </Button>
                </>
              ) : (
                <>
                  <p>暂无对话历史</p>
                  <Button 
                    onClick={createNewSession}
                    className="mt-4 bg-primary hover:bg-primary/90 text-white"
                  >
                    开始新对话
                  </Button>
                </>
              )}
            </div>
          }
        </div>
      </div>

      {/* 右侧聊天区域 */}
      <div className="flex-1 flex flex-col">
        {/* 头部 */}
        <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 py-4 px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <Avatar className="h-10 w-10">
                <AvatarImage src="https://neeko-copilot.bytedance.net/api/text2image?prompt=AI%20assistant%20avatar&size=512x512" />
                <AvatarFallback>AI</AvatarFallback>
              </Avatar>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">智能助手</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">在线</p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Button variant="ghost" size="sm" className="rounded-full">
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>

        {/* 消息区域 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`flex max-w-[80%] ${message.role === "user" ? "flex-row-reverse" : "flex-row"} space-x-3`}
              >
                <Avatar className="h-8 w-8 flex-shrink-0">
                  {message.role === "user" ? (
                    <>
                      <AvatarImage src="https://neeko-copilot.bytedance.net/api/text2image?prompt=user%20avatar&size=512x512" />
                      <AvatarFallback>用户</AvatarFallback>
                    </>
                  ) : (
                    <>
                      <AvatarImage src="https://neeko-copilot.bytedance.net/api/text2image?prompt=AI%20assistant%20avatar&size=512x512" />
                      <AvatarFallback>AI</AvatarFallback>
                    </>
                  )}
                </Avatar>
                <div className="flex flex-col">
                  <div className="relative">
                    <div
                      className={`rounded-lg p-3 shadow-sm transition-all duration-200 ${message.role === "user" 
                        ? "bg-primary text-white rounded-tr-none" 
                        : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white rounded-tl-none"
                      }`}
                    >
                      {message.role === "assistant" ? (
                        <MarkdownRenderer>{message.content.replace(/<think>[\s\S]*?<\/think>/gs, "")}</MarkdownRenderer>
                      ) : (
                        <p className="break-words">{message.content}</p>
                      )}
                    </div>
                    {message.role === "user" && (
                      <div className="top-1 right-1 flex space-x-1">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-6 w-6 text-gray-400 hover:text-blue-500"
                          onClick={(e) => {
                            e.stopPropagation();
                            // 实现消息编辑功能
                            const newContent = prompt('请输入新的消息内容:', message.content);
                            if (newContent && newContent.trim()) {
                              updateMessage(message.id, newContent.trim())
                                .then(() => {
                                  // 成功更新
                                })
                                .catch((error) => {
                                  alert('更新消息失败: ' + (error.message || '未知错误'));
                                });
                            }
                          }}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-6 w-6 text-gray-400 hover:text-red-500"
                          onClick={(e) => {
                            e.stopPropagation();
                            // 实现消息删除功能
                            if (confirm('确定要删除这条消息吗？')) {
                              deleteMessage(message.id)
                                .then(() => {
                                  // 成功删除
                                })
                                .catch((error) => {
                                  alert('删除消息失败: ' + (error.message || '未知错误'));
                                });
                            }
                          }}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center mt-1">
                    <p className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                      {formatTime(message.timestamp)}
                    </p>
                    {message.role === "user" && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">
                        ✓
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="flex justify-start">
              <div className="flex max-w-[80%] flex-row space-x-3">
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarImage src="https://neeko-copilot.bytedance.net/api/text2image?prompt=AI%20assistant%20avatar&size=512x512" />
                  <AvatarFallback>AI</AvatarFallback>
                </Avatar>
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 输入区域 */}
        <div className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-end space-x-2">
            <div className="flex space-x-1">
              <Button variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-gray-700">
                <Smile className="h-5 w-5" />
              </Button>
              <label className="cursor-pointer">
                <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    sendFile(file);
                  }
                }} />
                <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-gray-700">
                  <span>
                    <Image className="h-5 w-5" />
                  </span>
                </Button>
              </label>
              <label className="cursor-pointer">
                <input type="file" className="hidden" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    sendFile(file);
                  }
                }} />
                <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-gray-700">
                  <span>
                    <FileText className="h-5 w-5" />
                  </span>
                </Button>
              </label>
            </div>
            <div className="flex-1 relative">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="输入消息..."
                className="pr-24 py-3 rounded-full border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-primary focus:border-transparent"
              />
              {/* <Button
                variant="ghost"
                size="icon"
                className="absolute right-10 bottom-1/2 transform -translate-y-1/2 rounded-full"
              >
                <Mic className="h-5 w-5" />
              </Button> */}
            </div>
            <Button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              className="rounded-full bg-primary hover:bg-primary/90 text-white p-3 transition-all duration-200 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatAgent;
