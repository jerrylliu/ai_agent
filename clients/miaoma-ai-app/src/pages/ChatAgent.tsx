/**
 * ============================================================
 * ChatAgent.tsx - 智能助手聊天主页面
 * ============================================================
 * 本文件是整个AI聊天应用的核心页面组件，包含以下主要功能模块：
 * 1. 左侧边栏：会话管理、对话历史、最近问题、用户信息
 * 2. 聊天区域：消息展示、AI/用户头像、消息操作（编辑/删除）
 * 3. 输入区域：文本输入、图片/文件上传、发送按钮
 * 4. 右侧边栏：模型切换设置（本地Ollama/线上DeepSeek）
 * 5. 知识库：文件上传、状态显示、清空操作
 * 6. 用户认证：登录/注册对话框、头像上传
 * 7. 主题切换：白天/黑夜/赛博朋克三种模式
 * ============================================================
 */

// ==================== React 核心钩子 ====================
// useState: 组件状态管理  useEffect: 副作用处理  useRef: DOM引用
import { useState, useEffect, useRef } from "react";

// ==================== Lucide 图标库 ====================
// 提供项目中所有UI图标，按功能分组：
// 发送/操作: Send, MoreHorizontal, Plus, X, Trash2
// 搜索/历史: Search, History
// 主题切换: Moon(黑夜), Sun(白天), Zap(赛博朋克)
// 表情/文件: Smile, Image, FileText, Upload
// 知识库: Database
// 状态提示: CheckCircle(成功), AlertCircle(错误)
// 模型类型: Cpu(本地), Cloud(线上), Key(API密钥), Settings(设置)
// 箭头图标: ChevronRight, ChevronLeft, ChevronUp, ChevronDown
// 用户操作: LogOut(退出), LogIn(登录)
import { Send, MoreHorizontal, Search, Moon, Sun, Trash2, History, Plus, X, Smile, Image, FileText, Database, Upload, CheckCircle, AlertCircle, Cpu, Cloud, Key, Settings, ChevronRight, ChevronLeft, ChevronUp, ChevronDown, LogOut, LogIn, Zap } from "lucide-react";

// ==================== UI 组件库 (shadcn/ui) ====================
// Button: 按钮组件，支持多种变体(default/ghost/outline等)和尺寸
// Input: 输入框组件，支持搜索、表单等场景
// Avatar/AvatarFallback/AvatarImage: 头像组件，显示用户/AI头像
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";

// ==================== 自定义 Hooks (业务逻辑层) ====================
// useChat: 聊天核心逻辑 - 会话管理、消息发送、历史记录、知识库状态
// useTheme: 主题管理 - 白天/黑夜/赛博朋克切换、CSS类名控制
// useAuth: 用户认证 - 登录状态、用户信息、头像上传、登出
import { useChat } from "../hooks/useChat";
import { useTheme } from "../hooks/useTheme";
import { useAuth } from "../hooks/useAuth";

// ==================== 自定义组件 ====================
// AuthDialog: 登录/注册弹窗对话框，支持邮箱/手机号注册和登录
// MarkdownRenderer: Markdown渲染器，将AI返回的Markdown格式文本渲染为HTML
import { AuthDialog } from "../components/AuthDialog";
import MarkdownRenderer from "../components/MarkdownRenderer";

// ==================== 工具函数和常量 ====================
// formatTime/formatDate: 时间格式化工具，用于消息时间戳和会话日期
// API_BASE_URL: 后端API基础地址常量
// clearKnowledgeBase: 清空知识库API调用函数
import { formatTime, formatDate } from "../lib/utils";
import { API_BASE_URL } from "../lib/constants";
import { clearKnowledgeBase } from "../lib/api";

// ==================== 组件主体：ChatAgent ====================
// 智能助手聊天页面的主组件，负责整合所有子模块和状态管理
const ChatAgent: React.FC = () => {

  // ==================== 本地状态管理 (useState) ====================
  // inputValue: 输入框当前文本内容
  // searchKeyword: 会话搜索关键词
  // showMoreMenu: 更多操作菜单（清空知识库）显示状态
  // showApiKeyDialog: DeepSeek API Key配置弹窗显示状态
  // apiKeyInput: API Key输入框内容
  // showModelPanel: 右侧模型设置面板显示状态
  // showSidebar: 左侧边栏显示/隐藏状态
  // showHistoryList: 对话历史列表展开/收起状态
  // showRecentQuestions: 最近问题列表展开/收起状态
  // showAuthDialog: 登录/注册弹窗显示状态
  // avatarUploading: 头像上传中状态（用于显示loading）
  const [inputValue, setInputValue] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showModelPanel, setShowModelPanel] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showHistoryList, setShowHistoryList] = useState(true);
  const [showRecentQuestions, setShowRecentQuestions] = useState(true);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);

  // ==================== DOM引用 (useRef) ====================
  // avatarInputRef: 头像文件上传input的DOM引用，用于触发文件选择
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // ==================== 自定义Hooks - 用户认证模块 ====================
  // user: 当前登录用户信息（用户名、邮箱、头像等）
  // isAuthenticated: 是否已登录
  // login/register: 登录/注册方法
  // logout: 退出登录方法
  // uploadAvatar: 上传头像方法
  const { user, isAuthenticated, login, register, logout, uploadAvatar } = useAuth();

  // ==================== 自定义Hooks - 聊天核心模块 ====================
  // sessions: 所有会话列表  currentSessionId: 当前选中会话ID
  // messages: 当前会话的消息列表  history: 最近问题历史
  // isTyping: AI是否正在输入（显示打字动画）  isLoading: 是否加载中
  // messagesEndRef: 消息列表底部DOM引用（用于自动滚动）
  // knowledgeBaseStatus: 知识库状态（ready/empty/error/unknown）
  // pendingImages: 待发送图片列表（预览状态）
  // sendMessage/sendFile: 发送消息/文件方法
  // clearPendingImages: 清除待发送图片
  // uploadToKnowledgeBase: 上传文件到知识库
  // checkKnowledgeBaseStatus: 检查知识库状态
  // updateMessage/deleteMessage: 更新/删除消息
  // clearHistory/createNewSession/switchSession/deleteSession: 会话管理
  // toggleSessionPin: 置顶/取消置顶会话
  // currentModelId/availableModels: 当前模型ID/可用模型列表
  // hasDeepseekApiKey: 是否已配置DeepSeek API Key
  // supportsVision: 当前模型是否支持图片输入
  // switchModel: 切换模型  configureApiKey: 配置API Key
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

  // ==================== 知识库操作反馈状态 ====================
  // 用于显示知识库上传/清空的成功或失败提示消息
  // show: 是否显示  success: 是否成功  message: 提示内容
  const [kbFeedback, setKbFeedback] = useState<{
    show: boolean;
    success: boolean;
    message: string;
  }>({ show: false, success: false, message: '' });

  // ==================== 副作用处理 (useEffect) ====================

  // 副作用1: 组件挂载时检查知识库状态
  // 页面加载后立即查询后端知识库的连接状态和文档数量
  useEffect(() => {
    checkKnowledgeBaseStatus();
  }, []);

  // 副作用2: 点击外部关闭"更多操作"菜单
  // 监听全局点击事件，当点击目标不在.more-menu容器内时，关闭菜单
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

  // ==================== 自定义Hooks - 主题管理 ====================
  // theme: 当前主题('light'|'dark'|'cyberpunk')
  // cycleTheme: 循环切换主题的方法（light→dark→cyberpunk→light）
  const { theme, cycleTheme } = useTheme();

  // ==================== 事件处理函数 ====================

  // 功能: 头像上传处理
  // 模块: 用户认证 - 头像管理
  // 流程: 1. 验证文件类型（仅图片） 2. 验证文件大小（最大20MB） 3. 调用uploadAvatar上传 4. 显示成功/失败提示
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 验证文件类型：只允许图片格式
    if (!file.type.startsWith('image/')) {
      setKbFeedback({ show: true, success: false, message: '请选择图片文件（JPG/PNG/GIF/WebP）' });
      setTimeout(() => setKbFeedback(prev => ({ ...prev, show: false })), 3000);
      return;
    }

    // 验证文件大小：最大20MB
    if (file.size > 20 * 1024 * 1024) {
      setKbFeedback({ show: true, success: false, message: '图片大小不能超过 20MB' });
      setTimeout(() => setKbFeedback(prev => ({ ...prev, show: false })), 3000);
      return;
    }

    setAvatarUploading(true);
    try {
      await uploadAvatar(file);
      setKbFeedback({ show: true, success: true, message: '头像更新成功' });
      setTimeout(() => setKbFeedback(prev => ({ ...prev, show: false })), 3000);
    } catch (err: any) {
      const msg = err?.message || '头像上传失败，请重试';
      setKbFeedback({ show: true, success: false, message: msg });
      setTimeout(() => setKbFeedback(prev => ({ ...prev, show: false })), 3000);
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) {
        avatarInputRef.current.value = '';
      }
    }
  };

  // 功能: 会话搜索过滤
  // 模块: 左侧边栏 - 会话管理
  // 根据搜索关键词过滤会话列表，支持不区分大小写的模糊匹配
  const filteredSessions = sessions.filter(session =>
    session.title.toLowerCase().includes(searchKeyword.toLowerCase())
  );

  // 功能: 发送消息
  // 模块: 聊天核心 - 消息发送
  // 流程: 1. 校验输入（文本或图片至少有一项） 2. 清空输入框 3. 调用sendMessage发送
  const handleSend = async () => {
    if (!inputValue.trim() && pendingImages.length === 0) return;
    const userInput = inputValue;
    setInputValue("");
    await sendMessage(userInput, pendingImages);
  };

  // 功能: 键盘事件处理（回车发送）
  // 模块: 聊天核心 - 输入交互
  // 按下Enter键发送消息，Shift+Enter换行
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 功能: 点击历史问题时填充到输入框
  // 模块: 左侧边栏 - 最近问题
  // 用户点击历史问题时，将该问题文本填入输入框，方便重新发送或修改
  const handleHistoryClick = (query: string) => {
    setInputValue(query);
  };

  // 功能: 删除会话
  // 模块: 左侧边栏 - 会话管理
  // 点击删除按钮后弹出确认对话框，确认后调用deleteSession删除
  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('确定要删除这个会话吗？')) {
      deleteSession(sessionId);
    }
  };

  // ==================== JSX 渲染区域 ====================
  // 页面整体采用三栏布局：左侧边栏 | 中间聊天区 | 右侧模型面板
  return (
    <>
    {/* 主容器：全屏flex布局，使用CSS变量bg-background适配主题 */}
    <div className="flex h-full bg-background relative">

      {/* ==================== 左侧边栏区域 ====================
          模块: 左侧边栏 - 整体容器
          功能: 包含会话搜索、对话历史、最近问题、用户信息
          交互: 可通过左侧按钮展开/收起，带动画过渡效果
      */}
      <div className="relative h-full">
        {/* 左侧边栏展开/收起按钮
            位置: 侧边栏右侧边缘中央
            样式: 圆角矩形按钮，带左右箭头图标切换
        */}
        <button
          className={`absolute left-0 top-1/2 -translate-y-1/2 z-30 w-7 h-14 flex items-center justify-center bg-card border border-r-0 border-gray-200 dark:border-slate-600 rounded-r-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors shadow-sm ${
            showSidebar ? 'translate-x-0' : 'translate-x-0'
          }`}
          style={{ left: showSidebar ? '288px' : '0px' }}
          onClick={() => setShowSidebar(!showSidebar)}
          title={showSidebar ? '收起侧边栏' : '展开侧边栏'}
        >
          {showSidebar ? (
            <ChevronLeft className="h-4 w-4 text-gray-500 dark:text-gray-300" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-300" />
          )}
        </button>

        <div
          className={`h-full bg-card border-r border-gray-200 dark:border-slate-600 transition-all duration-300 ease-in-out overflow-hidden shadow-lg cyberpunk-border-glow ${
            showSidebar ? 'w-72' : 'w-0'
          }`}
        >
          {showSidebar && (
            <div className="w-72 h-full flex flex-col">
              <div className="p-4 border-b border-gray-200 dark:border-slate-600">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white cyberpunk-header-title">智能助手</h3>
                  <Button variant="ghost" size="icon" onClick={cycleTheme} title={`当前：${theme === 'light' ? '白天' : theme === 'dark' ? '黑夜' : '赛博朋克'}，点击切换`}>
                    {theme === 'light' ? <Moon className="h-5 w-5" /> : theme === 'dark' ? <Zap className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
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
              {/* ==================== 左侧边栏 - 会话列表区域 ====================
                  模块: 左侧边栏 - 对话历史管理
                  功能: 展示所有会话列表，支持搜索过滤、展开/收起、删除会话
                  交互:
                    - 点击会话标题切换当前会话
                    - 点击置顶按钮置顶/取消置顶会话
                    - 点击删除按钮删除会话（需确认）
                    - 搜索框实时过滤会话
                  样式: 当前会话高亮显示，带动画过渡效果
              */}
              <div className="flex-1 overflow-y-auto p-4">
                {/* 对话历史标题栏：包含标题、展开/收起按钮、清空按钮 */}
                <div className="flex items-center justify-between mb-4 cyberpunk-history">
                  <h4 className="font-medium text-gray-700 dark:text-gray-300 flex items-center">
                    <History className="h-4 w-4 mr-2" />
                    对话历史
                  </h4>
                  <div className="flex items-center space-x-1">
                    <button
                      onClick={() => setShowHistoryList(!showHistoryList)}
                      className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                      title={showHistoryList ? '收起' : '展开'}
                    >
                      {showHistoryList ? (
                        <ChevronUp className="h-4 w-4 text-gray-500" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-gray-500" />
                      )}
                    </button>
                    {history.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={clearHistory}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>

                <div
                  className="overflow-hidden transition-all duration-300 ease-in-out"
                  style={{ maxHeight: showHistoryList ? '500px' : '0', opacity: showHistoryList ? 1 : 0 }}
                >
                  {/* ==================== 左侧边栏 - 最近问题区域 ====================
                      模块: 左侧边栏 - 最近问题历史
                      功能: 展示用户最近发送过的问题列表，方便快速重新提问
                      交互:
                        - 点击问题文本自动填充到输入框
                        - 支持展开/收起动画过渡
                      数据: 来源于 useChat hook 中的 history 数组
                  */}
                  {history.length > 0 && (
                    <div className="mb-6">
                      {/* 最近问题标题栏：包含标题、展开/收起按钮 */}
                      <div className="flex items-center justify-between mb-2 cyberpunk-recent">
                        <h5 className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center">
                          <History className="h-3 w-3 mr-1" />
                          最近的问题
                        </h5>
                        <button
                          onClick={() => setShowRecentQuestions(!showRecentQuestions)}
                          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                          title={showRecentQuestions ? '收起' : '展开'}
                        >
                          {showRecentQuestions ? (
                            <ChevronUp className="h-3 w-3 text-gray-400" />
                          ) : (
                            <ChevronDown className="h-3 w-3 text-gray-400" />
                          )}
                        </button>
                      </div>
                      <div
                        className="overflow-hidden transition-all duration-300 ease-in-out"
                        style={{ maxHeight: showRecentQuestions ? '300px' : '0', opacity: showRecentQuestions ? 1 : 0 }}
                      >
                        <div className="space-y-2">
                          {history.map((item) => (
                            <div
                              key={item.id}
                              className="p-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer transition-colors duration-200 cyberpunk-recent"
                              onClick={() => handleHistoryClick(item.query)}
                            >
                              <div className="line-clamp-1" dangerouslySetInnerHTML={{
                                __html: searchKeyword
                                  ? item.query.replace(new RegExp(`(${searchKeyword})`, 'gi'), '<mark style="background-color: #fef3c7; color: #92400e;">$1</mark>')
                                  : item.query
                              }} />

                              <div className="text-xs text-gray-500 dark:text-gray-300 mt-1 cyberpunk-recent">
                                {formatTime(item.timestamp)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 会话列表渲染：根据加载状态和过滤结果显示不同内容
                      - 加载中: 显示旋转loading动画
                      - 有会话: 渲染会话卡片列表，每个卡片包含标题、操作按钮、更新时间
                      - 无会话: 显示空状态提示，提供创建新会话按钮
                  */}
                  {isLoading ? (
                    <div className="flex justify-center items-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  ) : filteredSessions.length > 0 ? (
                    <div className="space-y-2">
                      {filteredSessions.map((session) => (
                      /* 单个会话卡片 */
                      <div
                        key={session.sessionId}
                        className={`p-3 rounded-lg cursor-pointer transition-all duration-200 relative cyberpunk-history ${session.sessionId === currentSessionId
                          ? 'bg-primary/10 dark:bg-primary/20 border border-primary/30 shadow-sm'
                          : 'hover:bg-gray-100 dark:hover:bg-slate-700'
                        }`}
                        onClick={() => switchSession(session.sessionId)}
                      >
                        <div className="flex justify-between items-center min-w-0">
                          <div className="flex-1 min-w-0">
                            {/* 会话标题：当前会话高亮显示 */}
                            <p className="text-sm font-medium text-gray-900 dark:text-white mb-1 truncate cyberpunk-history">
                              {session.title}
                            </p>
                          </div>
                          {/* 会话操作按钮组：编辑标题、置顶/取消置顶、删除 */}
                          <div className="flex space-x-1">
                            {/* 编辑会话标题按钮 */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-gray-400 hover:text-blue-500"
                              onClick={(e) => {
                                e.stopPropagation();
                                const newTitle = prompt('请输入新的会话标题:', session.title);
                                if (newTitle && newTitle.trim()) {
                                  fetch(`${API_BASE_URL}/sessions/${session.sessionId}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ title: newTitle.trim() }),
                                  }).then(() => {
                                    window.location.reload();
                                  });
                                }
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </Button>
                            {/* 置顶/取消置顶按钮 */}
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
                            {/* 删除会话按钮 */}
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
                        <p className="text-xs text-gray-500 dark:text-gray-300 cyberpunk-history">
                          {formatDate(new Date(session.updatedAt))}
                        </p>
                      </div>
                    ))}
                  </div>
                ) :
                  <div className="text-center py-12 text-gray-500 dark:text-gray-300 cyberpunk-history">
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

              {/* ==================== 左侧边栏 - 用户信息区域 ====================
                  模块: 用户认证 - 用户信息展示与操作
                  位置: 左侧边栏底部
                  功能:
                    - 已登录状态: 显示用户头像、用户名、邮箱、在线状态
                      - 点击头像可上传新头像（支持JPG/PNG/GIF/WebP，最大20MB）
                      - 主题切换按钮
                      - 退出登录按钮
                    - 未登录状态: 显示默认头像和登录提示
                      - 点击登录按钮打开登录/注册弹窗
                      - 主题切换按钮
                  交互: 头像悬停显示上传图标，点击触发文件选择
              */}
              <div className="flex-shrink-0 border-t border-gray-200 dark:border-slate-600 p-4">
                {isAuthenticated && user ? (
                  <>
                    {/* 已登录状态：用户头像、信息、操作按钮 */}
                    <div className="flex items-center space-x-3">
                      {/* 头像上传区域：点击触发文件选择，悬停显示上传图标 */}
                      <div className="relative group cursor-pointer" onClick={() => !avatarUploading && avatarInputRef.current?.click()}>
                        <Avatar className={`h-10 w-10 transition-opacity ${avatarUploading ? 'opacity-50' : ''}`}>
                          <AvatarImage src={user.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username || user.id}`} />
                          <AvatarFallback>{(user.username || user.email || '用户')[0].toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                          <Upload className="h-4 w-4 text-white" />
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 border-2 border-white dark:border-slate-800 rounded-full"></div>
                        <input
                          ref={avatarInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          className="hidden"
                          onChange={handleAvatarUpload}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate cyberpunk-username">{user.username || user.email || user.phone || '用户'}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-300 truncate cyberpunk-useremail">{user.email || user.phone || '在线'}</p>
                      </div>
                      <div className="flex items-center space-x-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => cycleTheme()} title={`当前：${theme === 'light' ? '白天' : theme === 'dark' ? '黑夜' : '赛博朋克'}，点击切换`}>
                          {theme === 'light' ? <Moon className="h-4 w-4" /> : theme === 'dark' ? <Zap className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => logout()} title="退出登录">
                          <LogOut className="h-4 w-4 text-gray-500" />
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* 未登录状态：默认头像、登录提示、操作按钮 */}
                    <div className="flex items-center space-x-3">
                      {/* 默认头像占位 */}
                      <div className="relative">
                        <Avatar className="h-10 w-10">
                          <AvatarFallback>?</AvatarFallback>
                        </Avatar>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white cyberpunk-unauth">未登录</p>
                        <p className="text-xs text-gray-500 dark:text-gray-300 cyberpunk-unauth">点击设置登录账号</p>
                      </div>
                      <div className="flex items-center space-x-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => cycleTheme()} title={`当前：${theme === 'light' ? '白天' : theme === 'dark' ? '黑夜' : '赛博朋克'}，点击切换`}>
                          {theme === 'light' ? <Moon className="h-4 w-4" /> : theme === 'dark' ? <Zap className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowAuthDialog(true)} title="登录/注册">
                          <LogIn className="h-4 w-4 text-gray-500" />
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ==================== 中间聊天区域 ====================
          模块: 聊天核心 - 主聊天界面
          布局: 垂直三栏结构
            1. 聊天头部：AI头像、名称、知识库状态、操作按钮
            2. 消息列表：用户/AI消息气泡、知识库标记、时间戳
            3. 输入区域：文本输入、图片/文件上传、发送按钮
      */}
      <div className="flex-1 flex flex-col">
        {/* ==================== 聊天头部区域 ====================
            模块: 聊天核心 - 头部信息栏
            功能:
              - 左侧: AI助手头像和名称、在线状态
              - 右侧: 知识库状态显示（文档数量/空/错误/检查中）
                     上传知识库文件按钮（支持txt/pdf/doc/docx）
                     更多操作菜单（清空知识库）
            交互: 点击上传按钮选择文件，点击更多按钮展开操作菜单
        */}
        <div className="bg-card border-b border-gray-200 dark:border-slate-600 py-4 px-6 cyberpunk-border-glow">
          <div className="flex items-center justify-between">
            {/* 左侧：AI助手信息 */}
            <div className="flex items-center space-x-3">
              <Avatar className="h-10 w-10">
                <AvatarImage src="https://neeko-copilot.bytedance.net/api/text2image?prompt=AI%20assistant%20avatar&size=512x512" />
                <AvatarFallback>AI</AvatarFallback>
              </Avatar>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white cyberpunk-header-title">智能助手</h2>
                <p className="text-sm text-gray-500 dark:text-gray-300 cyberpunk-header-online">在线</p>
              </div>
            </div>
            {/* 右侧：知识库状态与操作按钮 */}
            <div className="flex items-center space-x-2">
              {/* 知识库状态指示器：显示当前知识库的连接状态和文档数量
                  状态类型:
                    - ready: 正常连接，显示文档数量（绿色）
                    - empty: 知识库为空（黄色）
                    - error: 连接错误（红色）
                    - unknown: 正在检查中（灰色）
              */}
              <div className="flex items-center space-x-1 px-3 py-1 rounded-full bg-gray-100 dark:bg-slate-700">
                <Database className="h-4 w-4 text-gray-500 dark:text-gray-300 cyberpunk-header-kb-label" />
                <span className="text-xs text-gray-600 dark:text-gray-300 cyberpunk-header-kb-label">
                  知识库:
                </span>
                {knowledgeBaseStatus.status === 'ready' && knowledgeBaseStatus.stats && (
                  <span className="text-xs font-medium text-green-600 dark:text-green-400 cyberpunk-header-kb-count">
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
                  <span className="text-xs text-gray-500 dark:text-gray-300">检查中...</span>
                )}
              </div>
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".txt,.pdf,.doc,.docx,text/plain,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
                <Button asChild variant="ghost" size="sm" className="rounded-full cyberpunk-header-upload-btn">
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
                  <div className="absolute right-0 mt-2 w-48 bg-card border border-gray-200 dark:border-slate-600 rounded-lg shadow-lg z-50">
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

        {/* ==================== 知识库操作反馈提示 ====================
            模块: 知识库 - 操作状态反馈
            功能: 显示知识库上传/清空操作的成功或失败提示
            触发: 上传文件到知识库、清空知识库、上传头像后
            样式:
              - 成功: 绿色背景+边框，带CheckCircle图标
              - 失败: 红色背景+边框，带AlertCircle图标
            行为: 显示3秒后自动消失
        */}
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

        {/* ==================== 消息列表区域 ====================
            模块: 聊天核心 - 消息展示
            功能: 渲染当前会话的所有消息，包括用户消息和AI回复
            布局: 垂直排列，用户消息右对齐，AI消息左对齐
            单条消息结构:
              - 头像（用户/AI）
              - 消息气泡（带圆角和主题色）
              - 知识库标记（如来自知识库）
              - 时间戳
              - 用户消息操作按钮（编辑、删除）
            特殊处理:
              - AI消息：过滤掉<tool_call>和<think>标签内容
              - 用户消息：支持显示图片预览
              - 知识库来源：显示绿色"知识库"标签和引用文档数量
        */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4" style={{ maxWidth: '100%', wordBreak: 'break-all' }}>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              style={{ maxWidth: '100%' }}
            >
              {/* 单条消息容器：包含头像和消息内容 */}
              <div
                className={`flex ${message.role === "user" ? "flex-row-reverse" : "flex-row"} gap-3`}
                style={{ maxWidth: '80%', width: 'fit-content', flexShrink: 0 }}
              >
                {/* 消息头像：用户或AI */}
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
                {/* 消息内容区域：气泡 + 元信息 */}
                <div className="flex flex-col" style={{ maxWidth: 'calc(100% - 48px)', minWidth: 0 }}>
                  {/* 消息气泡容器 */}
                  <div className="relative" style={{ maxWidth: '100%' }}>
                    {/* 消息气泡：根据角色显示不同样式
                        用户: 主题色背景(bg-primary)、白色文字、右上角无圆角
                        AI: 卡片背景(bg-card)、边框、左上角无圆角
                    */}
                    <div
                      className={`rounded-lg p-3 shadow-sm transition-all duration-200 ${message.role === "user"
                        ? "bg-primary text-white rounded-tr-none cyberpunk-user-msg"
                        : "bg-card border border-gray-200 dark:border-slate-600 text-gray-900 dark:text-white rounded-tl-none cyberpunk-ai-msg"
                      }`}
                      style={{
                        maxWidth: '100%',
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                        whiteSpace: 'pre-wrap',
                        minWidth: 0,
                      }}
                    >
                      {/* AI消息：使用Markdown渲染，过滤内部思考标签 */}
                      {message.role === "assistant" ? (
                        <div style={{ maxWidth: '100%', overflow: 'hidden', wordBreak: 'break-word' }}>
                          <MarkdownRenderer>{message.content.replace(/<tool_call>[\s\S]*?<\/think>/gs, "")}</MarkdownRenderer>
                        </div>
                      ) : (
                        /* 用户消息：支持图片预览 + Markdown渲染 */
                        <>
                          {/* 用户发送的图片预览：点击可新窗口打开 */}
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
                    {/* 用户消息操作按钮：仅对用户消息显示
                        - 编辑按钮: 弹出prompt修改消息内容，调用updateMessage更新
                        - 删除按钮: 弹出确认对话框，调用deleteMessage删除
                    */}
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
                              updateMessage(message.id, newContent.trim())
                                .then(() => {})
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
                        {/* 删除消息按钮 */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-gray-400 hover:text-red-500"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm('确定要删除这条消息吗？')) {
                              deleteMessage(message.id)
                                .then(() => {})
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
                  {/* 消息元信息栏：知识库来源标记 + 时间戳 + 已读标记 */}
                  <div className="flex items-center mt-1">
                    {/* 知识库来源标记：仅当消息来自知识库检索时显示
                        显示绿色标签，包含Database图标和引用文档数量
                    */}
                    {message.fromKnowledgeBase && (
                      <span className="text-xs px-1.5 py-0.5 bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 rounded mr-2 flex items-center">
                        <Database className="h-3 w-3 mr-0.5" />
                        知识库
                        {message.contextCount && message.contextCount > 0 && (
                          <span className="ml-1 text-xs opacity-75">({message.contextCount}条)</span>
                        )}
                      </span>
                    )}
                    {/* 消息时间戳 */}
                    <p className="text-xs text-gray-500 dark:text-gray-300 ml-2">
                      {formatTime(message.timestamp)}
                    </p>
                    {/* 用户消息已读标记 */}
                    {message.role === "user" && (
                      <span className="text-xs text-gray-400 dark:text-gray-400 ml-2">
                        ✓
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {/* AI正在输入动画：当isTyping为true时显示
              显示三个跳动的圆点，模拟打字动画效果
              每个圆点有不同的animationDelay，形成波浪效果
          */}
          {isTyping && (
            <div className="flex justify-start">
              <div className="flex max-w-[80%] flex-row space-x-3">
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarImage src="https://neeko-copilot.bytedance.net/api/text2image?prompt=AI%20assistant%20avatar&size=512x512" />
                  <AvatarFallback>AI</AvatarFallback>
                </Avatar>
                <div className="bg-card border border-gray-200 dark:border-slate-600 rounded-lg p-3 cyberpunk-ai-msg">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* 消息列表底部锚点：用于自动滚动到底部 */}
          <div ref={messagesEndRef} />
        </div>

        {/* ==================== 输入区域 ====================
            模块: 聊天核心 - 消息输入与发送
            功能: 提供用户输入文本、上传图片/文件、发送消息的功能
            结构:
              1. 待发送图片预览区：显示已选择但尚未发送的图片
              2. 输入框区域：文本输入 + 功能按钮（表情、图片、文件）+ 发送按钮
            交互:
              - Enter键发送，Shift+Enter换行
              - 图片上传受当前模型能力限制（supportsVision控制）
        */}
        <div className="bg-card border-t border-gray-200 dark:border-slate-600 p-4">
          {/* 待发送图片预览区：显示用户已选择但尚未发送的图片缩略图 */}
          {pendingImages.length > 0 && (
            <div className="mb-3 p-3 bg-gray-50 dark:bg-slate-700/50 rounded-lg">
              {/* 预览区头部：图片数量 + 清除全部按钮 */}
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
              {/* 图片缩略图网格：悬停显示删除按钮 */}
              <div className="flex flex-wrap gap-2">
                {pendingImages.map((url, index) => (
                  <div key={index} className="relative group">
                    <img
                      src={url}
                      alt={`待发送图片 ${index + 1}`}
                      className="h-16 w-16 object-cover rounded-lg border border-gray-200 dark:border-slate-500"
                    />
                    {/* 悬停删除按钮 */}
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
          {/* 输入框与功能按钮区域 */}
          <div className="flex items-end space-x-2">
            {/* 左侧功能按钮组：表情、图片上传、文件上传 */}
            <div className="flex space-x-1">
              {/* 表情按钮（预留功能） */}
              <Button variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-slate-700">
                <Smile className="h-5 w-5" />
              </Button>

              {/* 图片上传按钮：受模型视觉能力限制
                  当当前模型不支持图片时，按钮变灰且禁用
                  点击触发文件选择，选择后调用sendFile处理
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
                <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 cyberpunk-icon-glow" title={!supportsVision ? '当前模型不支持图片' : '上传图片'}>
                  <span>
                    <Image className="h-5 w-5" />
                  </span>
                </Button>
              </label>

              {/* 文件上传按钮：通用文件上传，不限于图片 */}
              <label className="cursor-pointer">
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      sendFile(file);
                    }
                  }}
                />
                <Button asChild variant="ghost" size="icon" className="rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 cyberpunk-icon-glow">
                  <span>
                    <FileText className="h-5 w-5" />
                  </span>
                </Button>
              </label>
            </div>
            {/* 文本输入框：支持多行，Enter发送，Shift+Enter换行 */}
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="输入消息..."
              className="pr-24 py-3 rounded-full border-gray-300 dark:border-slate-500 focus:ring-2 focus:ring-primary focus:border-transparent cyberpunk-input-glow"
            />
            {/* 发送按钮：当输入为空且没有待发送图片时禁用 */}
            <Button
              onClick={handleSend}
              disabled={(!inputValue.trim() && pendingImages.length === 0) || isTyping}
              className="rounded-full bg-primary hover:bg-primary/90 text-white p-3 transition-all duration-200 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      {/* ==================== 右侧模型设置面板 ====================
          模块: 模型管理 - 模型切换与配置
          位置: 页面右侧，绝对定位覆盖在聊天区域上方
          功能:
            1. 显示当前使用的模型（本地Ollama或线上DeepSeek）
            2. 本地模型列表：展示所有可用的Ollama本地模型
            3. 线上模型列表：展示所有可用的DeepSeek线上模型
            4. API Key配置：当未配置DeepSeek API Key时显示配置入口
          交互:
            - 点击模型项切换当前使用的模型
            - 点击展开/收起按钮控制面板显示
            - 未配置API Key时点击线上模型弹出配置对话框
      */}
      <div className="absolute right-0 top-0 h-full z-20">
        {/* 右侧面板展开/收起按钮：位于面板左侧边缘 */}
        <button
          className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full z-20 w-7 h-14 flex items-center justify-center bg-card border border-r-0 border-gray-200 dark:border-slate-600 rounded-l-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors shadow-sm"
          onClick={() => setShowModelPanel(!showModelPanel)}
          title={showModelPanel ? '收起面板' : '展开模型设置'}
        >
          {showModelPanel ? (
            <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-300" />
          ) : (
            <ChevronLeft className="h-4 w-4 text-gray-500 dark:text-gray-300" />
          )}
        </button>

        {/* 模型面板主体：带动画宽度过渡 */}
        <div
          className={`h-full bg-card border-l border-gray-200 dark:border-slate-600 transition-all duration-300 ease-in-out overflow-hidden shadow-lg cyberpunk-border-glow ${
            showModelPanel ? 'w-64' : 'w-0'
          }`}
        >
          <div className="w-64 h-full flex flex-col">
            {/* 面板头部：标题 + 关闭按钮 */}
            <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-600 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Settings className="h-4 w-4 text-gray-600 dark:text-gray-300" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">模型设置</h3>
              </div>
              <button
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                onClick={() => setShowModelPanel(false)}
              >
                <X className="h-3.5 w-3.5 text-gray-400" />
              </button>
            </div>

            {/* 当前模型信息卡片：显示正在使用的模型名称和类型图标 */}
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

            {/* 模型列表滚动区域：按提供商分组显示 */}
            <div className="flex-1 overflow-y-auto">
              {/* 本地模型列表（Ollama）：展示所有本地部署的模型 */}
              {availableModels.filter(m => m.provider === 'ollama').length > 0 && (
                <div className="px-3 py-2">
                  <p className="text-xs font-medium text-gray-400 dark:text-gray-400 px-1 mb-1 flex items-center cyberpunk-model-group-label">
                    <Cpu className="h-3 w-3 mr-1" /> 本地模型
                  </p>
                  {availableModels.filter(m => m.provider === 'ollama').map(model => (
                    <button
                      key={model.id}
                      className={`w-full px-3 py-2.5 text-left rounded-lg mb-1 transition-colors ${
                        currentModelId === model.id
                          ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                          : 'hover:bg-gray-50 dark:hover:bg-slate-700 border border-transparent'
                      }`}
                      onClick={async () => {
                        const result = await switchModel(model.id);
                        if (!result.success) alert(result.message);
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

              {/* 线上模型列表（DeepSeek）：展示所有线上API模型
                  未配置API Key的模型显示Key图标，点击时弹出配置对话框
              */}
              {availableModels.filter(m => m.provider === 'deepseek').length > 0 && (
                <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-600">
                  <p className="text-xs font-medium text-gray-400 dark:text-gray-400 px-1 mb-1 flex items-center cyberpunk-model-group-label">
                    <Cloud className="h-3 w-3 mr-1" /> 线上模型
                  </p>
                  {availableModels.filter(m => m.provider === 'deepseek').map(model => (
                    <button
                      key={model.id}
                      className={`w-full px-3 py-2.5 text-left rounded-lg mb-1 transition-colors ${
                        currentModelId === model.id
                          ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
                          : 'hover:bg-gray-50 dark:hover:bg-slate-700 border border-transparent'
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
                        <p className="text-sm text-gray-900 dark:text-white flex items-center cyberpunk-model-item-name">
                          {model.name}
                          {/* 未配置API Key时显示黄色Key图标提示 */}
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
            </div>

            {/* DeepSeek API Key配置入口：当未配置时显示在面板底部 */}
            {!hasDeepseekApiKey && (
              <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-600">
                <button
                  className="w-full px-3 py-2 text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg flex items-center transition-colors cyberpunk-model-apikey-btn"
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

      {/* ==================== DeepSeek API Key配置弹窗 ====================
          模块: 模型管理 - API密钥配置
          触发: 点击"配置 DeepSeek API Key"按钮或点击未配置Key的线上模型
          功能: 输入并保存DeepSeek API Key，用于调用线上模型
          交互:
            - 点击遮罩层或取消按钮关闭弹窗
            - 输入框支持密码类型显示（隐藏输入内容）
            - 保存按钮在输入为空时禁用
            - 保存成功后自动关闭弹窗，失败时alert提示
      */}
      {showApiKeyDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 cyberpunk-apikey-dialog-bg" onClick={() => setShowApiKeyDialog(false)}>
          <div className="bg-card rounded-lg p-6 w-96 shadow-xl cyberpunk-apikey-dialog-card" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 cyberpunk-apikey-dialog-title">配置 DeepSeek API Key</h3>
            <p className="text-sm text-gray-500 dark:text-gray-300 mb-4 cyberpunk-apikey-dialog-desc">
              使用 DeepSeek 线上模型需要 API Key，
              <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">点击获取</a>
            </p>
            <input
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 cyberpunk-apikey-dialog-input"
            />
            <div className="flex justify-end space-x-2">
              <Button variant="ghost" size="sm" onClick={() => setShowApiKeyDialog(false)} className="cyberpunk-apikey-dialog-cancel">取消</Button>
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white cyberpunk-apikey-dialog-save"
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

      {/* ==================== 登录/注册弹窗组件 ====================
          模块: 用户认证 - 登录/注册对话框
          组件: AuthDialog（位于src/components/AuthDialog.tsx）
          触发: 点击左侧边栏的登录按钮或"点击设置登录账号"区域
          功能: 提供用户登录和注册表单，支持邮箱/手机号
          属性:
            - isOpen: 控制弹窗显示/隐藏
            - onClose: 关闭弹窗回调
            - onLogin: 登录成功回调（调用useAuth的login方法）
            - onRegister: 注册成功回调（调用useAuth的register方法）
      */}
      <AuthDialog
        isOpen={showAuthDialog}
        onClose={() => setShowAuthDialog(false)}
        onLogin={login}
        onRegister={register}
      />
    </>
  );
};

export default ChatAgent;
