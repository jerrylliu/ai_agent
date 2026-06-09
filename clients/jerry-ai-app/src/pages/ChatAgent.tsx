/**
 * ChatAgent.tsx - 以太忆核聊天主页面
 *
 * 本文件是整个AI聊天应用的核心页面组件，负责整合所有子模块和状态管理。
 * 子组件已模块化到 components/Chat/ 目录下：
 * - HeaderContent: 聊天头部（AI信息、知识库状态、操作菜单）
 * - MessageList: 消息列表（虚拟滚动、消息渲染、AI输入动画）
 * - ChatBubble: 单条消息气泡（用户/AI消息、操作按钮、反馈按钮）
 * - ChatInput: 输入区域（文本输入、图片/文件上传、发送按钮）
 * - ModelPanel: 右侧模型设置面板（模型列表、API Key配置入口）
 * - ApiKeyDialog: API Key配置弹窗
 * - KbFeedbackToast: 知识库操作反馈提示
 * - MemorySummaryDialog: 记忆摘要弹窗
 * - TokenUsagePanel: Token用量面板
 * - EvaluationPanel: 准确率评估面板
 */

import { useState, useEffect, useRef } from "react";

import { ChevronRight, ChevronLeft, Check } from "lucide-react";

import { useChat } from "../hooks/useChat";
import { useTheme } from "../hooks/useTheme";
import { useAuth } from "../hooks/useAuth";

import { AuthDialog } from "../components/AuthDialog";
import { clearKnowledgeBase } from "../lib/api";
import { DocumentManager } from '../components/Document';
import { KnowledgeSourceManager } from '../components/KnowledgeSource';
import { ErrorBoundary } from '../components/ui/error-boundary';
import { SidebarHeader, SessionList, UserProfile } from '../components/Sidebar';
import SettingsDialog, { type AppSettings } from '../components/Settings/SettingsDialog';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

import {
  HeaderContent,
  MessageList,
  ChatInput,
  ModelPanel,
  ApiKeyDialog,
  KbFeedbackToast,
  MemorySummaryDialog,
  TokenUsagePanel,
  EvaluationPanel,
} from '../components/Chat';

const ChatAgent: React.FC = () => {
  // ==================== 本地状态管理 ====================
  const [inputValue, setInputValue] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
  const [apiKeyDialogProvider, setApiKeyDialogProvider] = useState<'deepseek' | 'zhipu'>('deepseek');
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showModelPanel, setShowModelPanel] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showHistoryList, setShowHistoryList] = useState(true);
  const [showRecentQuestions, setShowRecentQuestions] = useState(true);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [showMemorySummary, setShowMemorySummary] = useState(false);
  const [showTokenUsage, setShowTokenUsage] = useState(false);
  const [showEvaluation, setShowEvaluation] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDocumentManager, setShowDocumentManager] = useState(false);
  const [showKnowledgeSourceManager, setShowKnowledgeSourceManager] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [copyToast, setCopyToast] = useState<{ show: boolean; message: string; x: number; y: number }>({ show: false, message: '', x: 0, y: 0 });
  const [feedbackState, setFeedbackState] = useState<Record<string, 'positive' | 'negative' | null>>({});
  const [feedbackToast, setFeedbackToast] = useState<{ show: boolean; message: string; x: number; y: number }>({ show: false, message: '', x: 0, y: 0 });

  // 确认/提示弹窗状态
  const [deleteMsgConfirmOpen, setDeleteMsgConfirmOpen] = useState(false);
  const [deleteMsgTargetId, setDeleteMsgTargetId] = useState<string | null>(null);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');

  // 应用设置状态
  const [appSettings, setAppSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('app-settings');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { memoryEnabled: true, summaryEnabled: true, injectMemoryOnNewSession: true };
  });

  const handleSettingsChange = (newSettings: AppSettings) => {
    setAppSettings(newSettings);
    localStorage.setItem('app-settings', JSON.stringify(newSettings));
  };

  // DOM引用
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // 自定义Hooks
  const { user, isAuthenticated, login, register, logout, uploadAvatar } = useAuth();

  const {
    sessions,
    currentSessionId,
    messages,
    history,
    isTyping,
    isLoading,
    toolStatus,
    messagesEndRef,
    knowledgeBaseStatus,
    pendingImages,
    sendMessage,
    sendFile,
    clearPendingImages,
    removePendingImage,
    stopGeneration,
    checkKnowledgeBaseStatus,
    updateMessage,
    deleteMessage,
    clearHistory,
    createNewSession,
    switchSession,
    deleteSession,
    toggleSessionPin,
    renameSession,
    duplicateSession,
    exportSession,
    currentModelId,
    availableModels,
    hasDeepseekApiKey,
    hasZhipuApiKey,
    supportsVision,
    switchModel,
    configureApiKey,
  } = useChat(isAuthenticated, appSettings);

  // 虚拟滚动相关
  const isAtBottomRef = useRef(true);
  const isSessionSwitchRef = useRef(false);

  // 知识库操作反馈状态
  const [kbFeedback, setKbFeedback] = useState<{
    show: boolean;
    success: boolean;
    message: string;
  }>({ show: false, success: false, message: '' });

  // 删除消息执行函数
  const executeDeleteMessage = async () => {
    if (!deleteMsgTargetId) return;
    setDeleteMsgConfirmOpen(false);
    try {
      await deleteMessage(deleteMsgTargetId);
    } catch (error: any) {
      setAlertMessage('删除消息失败: ' + (error.message || '未知错误'));
      setAlertOpen(true);
    }
  };

  // 副作用: 组件挂载时检查知识库状态
  useEffect(() => {
    checkKnowledgeBaseStatus();
  }, []);

  // 副作用: 点击外部关闭"更多操作"菜单
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

  // 事件处理函数
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setKbFeedback({ show: true, success: false, message: '请选择图片文件（JPG/PNG/GIF/WebP）' });
      setTimeout(() => setKbFeedback(prev => ({ ...prev, show: false })), 3000);
      return;
    }
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

  const handleSend = async () => {
    if (!inputValue.trim() && pendingImages.length === 0) return;
    const userInput = inputValue;
    setInputValue("");
    await sendMessage(userInput, pendingImages);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleHistoryClick = (query: string) => {
    setInputValue(query);
  };

  const handleSwitchSession = (sessionId: string) => {
    isSessionSwitchRef.current = true;
    switchSession(sessionId);
  };

  const handleAlert = (message: string) => {
    setAlertMessage(message);
    setAlertOpen(true);
  };

  const handleDeleteMessage = (messageId: string) => {
    setDeleteMsgTargetId(messageId);
    setDeleteMsgConfirmOpen(true);
  };

  const { theme, cycleTheme, setTheme } = useTheme();

  // ==================== JSX 渲染区域 ====================
  return (
    <>
      <div className="flex h-full bg-background relative">
        {/* ==================== 左侧边栏区域 ==================== */}
        <div className="relative h-full">
          <button
            className={`absolute left-0 top-1/2 -translate-y-1/2 z-30 w-7 h-14 flex items-center justify-center bg-card border border-r-0 border-gray-200 dark:border-slate-600 rounded-r-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors shadow-sm ${showSidebar ? 'translate-x-0' : 'translate-x-0'
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
            className={`h-full bg-card border-r border-gray-200 dark:border-slate-600 transition-all duration-300 ease-in-out overflow-hidden shadow-lg cyberpunk-border-glow ${showSidebar ? 'w-72' : 'w-0'
              }`}
          >
            {showSidebar && (
              <div className="w-72 h-full flex flex-col">
                <SidebarHeader
                  createNewSession={createNewSession}
                  searchKeyword={searchKeyword}
                  setSearchKeyword={setSearchKeyword}
                  onToggleSidebar={() => setShowSidebar(!showSidebar)}
                />
                <SessionList
                  sessions={sessions}
                  currentSessionId={currentSessionId}
                  searchKeyword={searchKeyword}
                  isLoading={isLoading}
                  history={history}
                  showHistoryList={showHistoryList}
                  showRecentQuestions={showRecentQuestions}
                  onSwitchSession={handleSwitchSession}
                  onDeleteSession={deleteSession}
                  onTogglePin={toggleSessionPin}
                  onHistoryClick={handleHistoryClick}
                  onToggleHistoryList={() => setShowHistoryList(!showHistoryList)}
                  onToggleRecentQuestions={() => setShowRecentQuestions(!showRecentQuestions)}
                  onClearHistory={clearHistory}
                  onClearSearch={() => setSearchKeyword("")}
                  onCreateSession={createNewSession}
                  onRenameSession={renameSession}
                  onDuplicateSession={duplicateSession}
                  onExportSession={exportSession}
                />
                <UserProfile
                  isAuthenticated={isAuthenticated}
                  user={user}
                  avatarUploading={avatarUploading}
                  avatarInputRef={avatarInputRef}
                  onAvatarUpload={handleAvatarUpload}
                  onLogout={logout}
                  onOpenSettings={() => setShowSettings(true)}
                  onShowAuthDialog={() => setShowAuthDialog(true)}
                />
              </div>
            )}
          </div>
        </div>

        {/* ==================== 中间聊天区域 ==================== */}
        <div className="flex-1 flex flex-col min-w-0">
          <HeaderContent
            knowledgeBaseStatus={knowledgeBaseStatus}
            showMoreMenu={showMoreMenu}
            onToggleMoreMenu={() => setShowMoreMenu(!showMoreMenu)}
            onClearKnowledgeBase={clearKnowledgeBase}
            onCheckKnowledgeBaseStatus={checkKnowledgeBaseStatus}
            onKbFeedback={setKbFeedback}
            onOpenMemorySummary={() => setShowMemorySummary(true)}
            onOpenDocumentManager={() => setShowDocumentManager(true)}
            onOpenKnowledgeSourceManager={() => setShowKnowledgeSourceManager(true)}
            onOpenTokenUsage={() => setShowTokenUsage(true)}
            onOpenEvaluation={() => setShowEvaluation(true)}
          />

          <KbFeedbackToast feedback={kbFeedback} />

          <MessageList
            messages={messages}
            isTyping={isTyping}
            toolStatus={toolStatus}
            messagesEndRef={messagesEndRef}
            currentSessionId={currentSessionId}
            feedbackState={feedbackState}
            onFeedbackStateChange={setFeedbackState}
            onCopyToast={setCopyToast}
            onFeedbackToast={setFeedbackToast}
            onUpdateMessage={updateMessage}
            onDeleteMessage={handleDeleteMessage}
            onAlert={handleAlert}
            isSessionSwitchRef={isSessionSwitchRef}
            isAtBottomRef={isAtBottomRef}
          />

          <ChatInput
            inputValue={inputValue}
            onInputChange={setInputValue}
            onSend={handleSend}
            onKeyDown={handleKeyDown}
            isTyping={isTyping}
            onStopGeneration={stopGeneration}
            pendingImages={pendingImages}
            onClearPendingImages={clearPendingImages}
            onRemovePendingImage={removePendingImage}
            onSendFile={sendFile}
            supportsVision={supportsVision}
          />
        </div>

        {/* ==================== 右侧模型设置面板 ==================== */}
        <ModelPanel
          showModelPanel={showModelPanel}
          onToggleModelPanel={() => setShowModelPanel(!showModelPanel)}
          currentModelId={currentModelId}
          availableModels={availableModels}
          hasDeepseekApiKey={hasDeepseekApiKey}
          hasZhipuApiKey={hasZhipuApiKey}
          onSwitchModel={switchModel}
          onOpenApiKeyDialog={(provider) => {
            setApiKeyDialogProvider(provider);
            setShowApiKeyDialog(true);
          }}
          onAlert={handleAlert}
        />

        {/* ==================== API Key配置弹窗 ==================== */}
        <ApiKeyDialog
          open={showApiKeyDialog}
          provider={apiKeyDialogProvider}
          apiKeyInput={apiKeyInput}
          onApiKeyInputChange={setApiKeyInput}
          onClose={() => setShowApiKeyDialog(false)}
          onConfigureApiKey={configureApiKey}
          onAlert={handleAlert}
        />
      </div>

      {/* ==================== 弹窗组件 ==================== */}
      <AuthDialog
        isOpen={showAuthDialog}
        onClose={() => setShowAuthDialog(false)}
        onLogin={login}
        onRegister={register}
      />
      <MemorySummaryDialog
        open={showMemorySummary}
        onClose={() => setShowMemorySummary(false)}
        currentSessionId={currentSessionId}
      />
      <TokenUsagePanel
        open={showTokenUsage}
        onClose={() => setShowTokenUsage(false)}
      />
      <EvaluationPanel
        open={showEvaluation}
        onClose={() => setShowEvaluation(false)}
      />
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        theme={theme}
        onThemeChange={setTheme}
        settings={appSettings}
        onSettingsChange={handleSettingsChange}
      />
      {showDocumentManager && (
        <div className="fixed inset-0 z-50 bg-black/50">
          <div className="absolute right-0 top-0 bottom-0 w-full max-w-4xl bg-card shadow-2xl">
            <ErrorBoundary>
              <DocumentManager onClose={() => setShowDocumentManager(false)} onRefreshKnowledgeBase={checkKnowledgeBaseStatus} />
            </ErrorBoundary>
          </div>
        </div>
      )}
      {showKnowledgeSourceManager && (
        <div className="fixed inset-0 z-50 bg-black/50">
          <div className="absolute right-0 top-0 bottom-0 w-full max-w-4xl bg-card shadow-2xl">
            <ErrorBoundary>
              <KnowledgeSourceManager onClose={() => setShowKnowledgeSourceManager(false)} onContentChange={checkKnowledgeBaseStatus} />
            </ErrorBoundary>
          </div>
        </div>
      )}

      {/* 复制成功提示 Toast */}
      {copyToast.show && (
        <div
          className="fixed z-[100] animate-in fade-in slide-in-from-bottom-2 duration-300 pointer-events-none"
          style={{ left: copyToast.x, top: copyToast.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg shadow-lg bg-green-600 text-white text-xs whitespace-nowrap">
            <Check className="h-3 w-3" />
            {copyToast.message}
          </div>
        </div>
      )}
      {/* 反馈提示 Toast */}
      {feedbackToast.show && (
        <div
          className="fixed z-[100] animate-in fade-in slide-in-from-bottom-2 duration-300 pointer-events-none"
          style={{ left: feedbackToast.x, top: feedbackToast.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg shadow-lg bg-blue-600 text-white text-xs whitespace-nowrap">
            {feedbackToast.message}
          </div>
        </div>
      )}

      {/* 删除消息确认弹窗 */}
      <ConfirmDialog
        open={deleteMsgConfirmOpen}
        onOpenChange={setDeleteMsgConfirmOpen}
        title="删除消息"
        description="确定要删除这条消息吗？将同时删除AI的回复。"
        confirmLabel="确认删除"
        variant="destructive"
        onConfirm={executeDeleteMessage}
      />

      {/* 错误提示弹窗 */}
      <ConfirmDialog
        open={alertOpen}
        onOpenChange={setAlertOpen}
        title="提示"
        description={alertMessage}
        confirmLabel="确定"
        cancelLabel=""
        onConfirm={() => setAlertOpen(false)}
      />
    </>
  );
};

export default ChatAgent;
