import { useState, useEffect } from "react";
import { Send, MoreHorizontal, Search, Moon, Sun, Trash2, History, Plus, X, Smile, Image, FileText, Database, Upload, CheckCircle, AlertCircle, Cpu, Cloud, Key, Settings, ChevronRight, ChevronLeft } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { useChat } from "../hooks/useChat";
import { useTheme } from "../hooks/useTheme";
import { formatTime, formatDate } from "../lib/utils";
import { API_BASE_URL } from "../lib/constants";
import { clearKnowledgeBase } from "../lib/api";
import MarkdownRenderer from "../components/MarkdownRenderer";

const ChatAgent: React.FC = () => {
  const [inputValue, setInputValue] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showModelPanel, setShowModelPanel] = useState(false);
  const {
    sessions,
    currentSessionId,
    messages,
    history,
    isTyping,
    isLoading,
    messagesEndRef,
    knowledgeBaseStatus,
    pendingImages,
    sendMessage,
    sendFile,
    clearPendingImages,
    uploadToKnowledgeBase,
    checkKnowledgeBaseStatus,
    updateMessage,
    deleteMessage,
    clearHistory,
    createNewSession,
    switchSession,
    deleteSession,
    toggleSessionPin,
    currentModelId,
    availableModels,
    hasDeepseekApiKey,
    supportsVision,
    switchModel,
    configureApiKey,
  } = useChat();

  const [kbFeedback, setKbFeedback] = useState<{
    show: boolean;
    success: boolean;
    message: string;
  }>({ show: false, success: false, message: '' });

  useEffect(() => {
    checkKnowledgeBaseStatus();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.more-menu')) {
        setShowMoreMenu(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, []);

  const { darkMode, toggleTheme } = useTheme();

  // 过滤会话列表
  const filteredSessions = sessions.filter(session => 
    session.title.toLowerCase().includes(searchKeyword.toLowerCase())
  );

  const handleSend = async () => {
    if (!inputValue.trim() && pendingImages.length === 0) return;
    const userInput = inputValue;
    setInputValue("");
    await sendMessage(userInput, pendingImages);
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
      <div className="w-72 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col flex-shrink-0">
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
                  <div className="flex justify-between items-center min-w-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white mb-1 truncate">
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
              <div className="flex items-center space-x-1 px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700">
                <Database className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                <span className="text-xs text-gray-600 dark:text-gray-300">
                  知识库:
                </span>
                {knowledgeBaseStatus.status === 'ready' && knowledgeBaseStatus.stats && (
                  <span className="text-xs font-medium text-green-600 dark:text-green-400">
                    {knowledgeBaseStatus.stats.documentCount} 个文档
                  </span>
                )}
                {knowledgeBaseStatus.status === 'empty' && (
                  <span className="text-xs text-yellow-600 dark:text-yellow-400">空</span>
                )}
                {knowledgeBaseStatus.status === 'error' && (
                  <span className="text-xs text-red-600 dark:text-red-400">错误</span>
                )}
                {knowledgeBaseStatus.status === 'unknown' && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">检查中...</span>
                )}
              </div>
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".txt,.pdf,.doc,.docx"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const result = await uploadToKnowledgeBase(file);
                      setKbFeedback({
                        show: true,
                        success: result.success,
                        message: result.message,
                      });
                      setTimeout(() => setKbFeedback(prev => ({ ...prev, show: false })), 3000);
                    }
                  }}
                />
                <Button asChild variant="ghost" size="sm" className="rounded-full">
                  <span>
                    <Upload className="h-4 w-4 mr-1" />
                    上传知识库
                  </span>
                </Button>
              </label>
              <div className="relative more-menu">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setShowMoreMenu(!showMoreMenu)}
                >
                  <MoreHorizontal className="h-5 w-5"/>
                </Button>
                {showMoreMenu && (
                  <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
                    <button
                      className="w-full px-4 py-2 text-left text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 flex items-center"
                      onClick={async () => {
                        setShowMoreMenu(false);
                        if (confirm('确定要清空整个知识库吗？此操作不可恢复。')) {
                          try {
                            const result = await clearKnowledgeBase();
                            setKbFeedback({
                              show: true,
                              success: result.success,
                              message: result.message,
                            });
                            checkKnowledgeBaseStatus();
                          } catch (error: any) {
                            setKbFeedback({
                              show: true,
                              success: false,
                              message: error.message || '清空失败',
                            });
                          }
                          setTimeout(() => setKbFeedback(prev => ({ ...prev, show: false })), 3000);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      清空知识库
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 知识库上传反馈 */}
        {kbFeedback.show && (
          <div className={`mx-6 mt-4 p-3 rounded-lg flex items-center space-x-2 ${
            kbFeedback.success
              ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
          }`}>
            {kbFeedback.success ? (
              <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            )}
            <span className={`text-sm ${
              kbFeedback.success
                ? 'text-green-700 dark:text-green-300'
                : 'text-red-700 dark:text-red-300'
            }`}>
              {kbFeedback.message}
            </span>
          </div>
        )}

        {/* 消息区域 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4" style={{ maxWidth: '100%', wordBreak: 'break-all' }}>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              style={{ maxWidth: '100%' }}
            >
              <div
                className={`flex ${message.role === "user" ? "flex-row-reverse" : "flex-row"} space-x-3`}
                style={{ maxWidth: '80%', width: 'fit-content', flexShrink: 0 }}
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
                <div className="flex flex-col" style={{ maxWidth: 'calc(100% - 48px)', minWidth: 0 }}>
                  <div className="relative" style={{ maxWidth: '100%' }}>
                    <div
                      className={`rounded-lg p-3 shadow-sm transition-all duration-200 ${message.role === "user" 
                        ? "bg-primary text-white rounded-tr-none" 
                        : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white rounded-tl-none"
                      }`}
                      style={{ 
                        maxWidth: '100%',
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                        whiteSpace: 'pre-wrap',
                        minWidth: 0,
                      }}
                    >
                      {message.role === "assistant" ? (
                        <div style={{ maxWidth: '100%', overflow: 'hidden', wordBreak: 'break-word' }}>
                          <MarkdownRenderer>{message.content.replace(/<think>[\s\S]*?<\/think>/gs, "")}</MarkdownRenderer>
                        </div>
                      ) : (
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
                    {message.fromKnowledgeBase && (
                      <span className="text-xs px-1.5 py-0.5 bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 rounded mr-2 flex items-center">
                        <Database className="h-3 w-3 mr-0.5" />
                        知识库
                        {message.contextCount && message.contextCount > 0 && (
                          <span className="ml-1 text-xs opacity-75">({message.contextCount}条)</span>
                        )}
                      </span>
                    )}
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
          {/* 待发送图片预览 */}
          {pendingImages.length > 0 && (
            <div className="mb-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  待发送图片 ({pendingImages.length})
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearPendingImages}
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
                      className="h-16 w-16 object-cover rounded-lg border border-gray-200 dark:border-gray-600"
                    />
                    <button
                      onClick={() => clearPendingImages()}
                      className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full h-5 w-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-end space-x-2">
            <div className="flex space-x-1">
              {/* 表情选择按钮（预留功能，暂未实现） */}
              <Button variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-gray-700">
                <Smile className="h-5 w-5" />
              </Button>

              {/* ============================================
                  图片上传按钮
                  将图片添加到待发送列表
              */}
              <label className={`cursor-pointer ${!supportsVision ? 'opacity-40 pointer-events-none' : ''}`}>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={!supportsVision}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      sendFile(file);
                    }
                  }}
                />
                <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title={!supportsVision ? '当前模型不支持图片' : '上传图片'}>
                  <span>
                    <Image className="h-5 w-5" />
                  </span>
                </Button>
              </label>

              {/* ============================================
                  文件上传按钮
                  与图片上传按钮类似，但有一下区别：
                  1. accept 未指定，可以选择任意类型的文件
                  2. 图标使用 FileText（文件图标）而非 Image（图片图标）
              */}
              <label className="cursor-pointer">
                <input
                  type="file"                  // 文件输入框类型
                  className="hidden"            // 隐藏原生的文件选择框
                  onChange={(e) => {           // 文件选择改变时触发
                    const file = e.target.files?.[0]; // 获取选择的第一个文件
                    if (file) {                // 确保文件存在
                      sendFile(file);          // 调用 sendFile 函数上传文件
                    }
                  }}
                />
                <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-gray-700">
                  <span>
                    <FileText className="h-5 w-5" />  {/* 文件图标 */}
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
              disabled={!inputValue.trim() && pendingImages.length === 0}
              className="rounded-full bg-primary hover:bg-primary/90 text-white p-3 transition-all duration-200 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      {/* 右侧可折叠模型管理面板 */}
      <div className="relative flex-shrink-0">
        {/* 折叠/展开切换按钮 */}
        <button
          className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full z-20 w-7 h-14 flex items-center justify-center bg-white dark:bg-gray-800 border border-r-0 border-gray-200 dark:border-gray-700 rounded-l-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors shadow-sm"
          onClick={() => setShowModelPanel(!showModelPanel)}
          title={showModelPanel ? '收起面板' : '展开模型设置'}
        >
          {showModelPanel ? (
            <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-400" />
          ) : (
            <ChevronLeft className="h-4 w-4 text-gray-500 dark:text-gray-400" />
          )}
        </button>

        {/* 面板内容 */}
        <div
          className={`h-full bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 transition-all duration-300 ease-in-out overflow-hidden ${
            showModelPanel ? 'w-64' : 'w-0'
          }`}
        >
          <div className="w-64 h-full flex flex-col">
            {/* 面板头部 */}
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Settings className="h-4 w-4 text-gray-600 dark:text-gray-300" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">模型设置</h3>
              </div>
              <button
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                onClick={() => setShowModelPanel(false)}
              >
                <X className="h-3.5 w-3.5 text-gray-400" />
              </button>
            </div>

            {/* 当前模型 */}
            <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 bg-blue-50/50 dark:bg-blue-900/20">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">当前模型</p>
              <div className="flex items-center space-x-2">
                {currentModelId.startsWith('ollama') ? (
                  <Cpu className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                ) : (
                  <Cloud className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                )}
                <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {availableModels.find(m => m.id === currentModelId)?.name || currentModelId}
                </span>
              </div>
            </div>

            {/* 模型列表 */}
            <div className="flex-1 overflow-y-auto">
              {availableModels.filter(m => m.provider === 'ollama').length > 0 && (
                <div className="px-3 py-2">
                  <p className="text-xs font-medium text-gray-400 dark:text-gray-500 px-1 mb-1 flex items-center">
                    <Cpu className="h-3 w-3 mr-1" /> 本地模型
                  </p>
                  {availableModels.filter(m => m.provider === 'ollama').map(model => (
                    <button
                      key={model.id}
                      className={`w-full px-3 py-2.5 text-left rounded-lg mb-1 transition-colors ${
                        currentModelId === model.id
                          ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700 border border-transparent'
                      }`}
                      onClick={async () => {
                        const result = await switchModel(model.id);
                        if (!result.success) alert(result.message);
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-gray-900 dark:text-white">{model.name}</p>
                        {currentModelId === model.id && (
                          <CheckCircle className="h-4 w-4 text-blue-500 flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{model.description}</p>
                    </button>
                  ))}
                </div>
              )}

              {availableModels.filter(m => m.provider === 'deepseek').length > 0 && (
                <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700">
                  <p className="text-xs font-medium text-gray-400 dark:text-gray-500 px-1 mb-1 flex items-center">
                    <Cloud className="h-3 w-3 mr-1" /> 线上模型
                  </p>
                  {availableModels.filter(m => m.provider === 'deepseek').map(model => (
                    <button
                      key={model.id}
                      className={`w-full px-3 py-2.5 text-left rounded-lg mb-1 transition-colors ${
                        currentModelId === model.id
                          ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700 border border-transparent'
                      }`}
                      onClick={async () => {
                        if (!hasDeepseekApiKey) {
                          setShowApiKeyDialog(true);
                          return;
                        }
                        const result = await switchModel(model.id);
                        if (!result.success) alert(result.message);
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-gray-900 dark:text-white flex items-center">
                          {model.name}
                          {!hasDeepseekApiKey && (
                            <Key className="h-3 w-3 ml-1 text-yellow-500" />
                          )}
                        </p>
                        {currentModelId === model.id && (
                          <CheckCircle className="h-4 w-4 text-blue-500 flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{model.description}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* API Key 配置 */}
            {!hasDeepseekApiKey && (
              <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700">
                <button
                  className="w-full px-3 py-2 text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg flex items-center transition-colors"
                  onClick={() => setShowApiKeyDialog(true)}
                >
                  <Key className="h-4 w-4 mr-2" />
                  配置 DeepSeek API Key
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* API Key 对话框 */}
      {showApiKeyDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowApiKeyDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">配置 DeepSeek API Key</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              使用 DeepSeek 线上模型需要 API Key，
              <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">点击获取</a>
            </p>
            <input
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
            />
            <div className="flex justify-end space-x-2">
              <Button variant="ghost" size="sm" onClick={() => setShowApiKeyDialog(false)}>取消</Button>
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white"
                disabled={!apiKeyInput.trim()}
                onClick={async () => {
                  const result = await configureApiKey('deepseek', apiKeyInput.trim());
                  if (result.success) {
                    setShowApiKeyDialog(false);
                    setApiKeyInput('');
                  } else {
                    alert(result.message);
                  }
                }}
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatAgent;
