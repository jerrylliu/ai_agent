/**
 * ChatAgent.tsx - 以太忆核聊天主页面
 *
 * 本文件是整个AI聊天应用的核心页面组件，负责整合所有子模块和状态管理。
 * 状态管理已迁移到 Zustand stores：
 * - useUIStore: UI 开关、输入状态、面板状态
 * - useSettingsStore: 应用设置（persist 中间件自动同步 localStorage）
 * - useToastStore: Toast/反馈状态
 * - useConfirmStore: 确认弹窗状态
 *
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

import { useEffect, useRef, useState } from "react";

import { ChevronRight, ChevronLeft, Check, Bot } from "lucide-react";

import { useChat } from "../hooks/useChat";
import { useTheme } from "../hooks/useTheme";
import { useAuth } from "../hooks/useAuth";

import { AuthDialog } from "../components/AuthDialog";
import { clearKnowledgeBase, respondToConfirmation } from "../lib/api";
import { DocumentManager } from '../components/Document';
import { KnowledgeSourceManager } from '../components/KnowledgeSource';
import { ErrorBoundary } from '../components/ui/error-boundary';
import { SidebarHeader, SessionList, UserProfile } from '../components/Sidebar';
import { FavoriteDocumentsPanel } from '../components/FavoriteDocumentsPanel';
import { FavoriteDocProvider } from '../contexts/FavoriteDocContext';
import SettingsDialog from '../components/Settings/SettingsDialog';
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
  ToolUsagePanel,
  EvaluationPanel,
} from '../components/Chat';

import { useUIStore } from '../stores/ui-store';
import { useSettingsStore } from '../stores/settings-store';
import { useToastStore } from '../stores/toast-store';
import { useConfirmStore } from '../stores/confirm-store';
import { useShallow } from 'zustand/react/shallow';

const ChatAgent: React.FC = () => {
  // ==================== Zustand 状态管理 ====================
  const {
    inputValue, setInputValue,
    searchKeyword, setSearchKeyword,
    showMoreMenu, setShowMoreMenu,
    showApiKeyDialog, setShowApiKeyDialog,
    apiKeyDialogProvider, setApiKeyDialogProvider,
    apiKeyInput, setApiKeyInput,
    showModelPanel, setShowModelPanel,
    showSidebar, setShowSidebar,
    showHistoryList, setShowHistoryList,
    showRecentQuestions, setShowRecentQuestions,
    showAuthDialog, setShowAuthDialog,
    showMemorySummary, setShowMemorySummary,
    showTokenUsage, setShowTokenUsage,
    showToolUsage, setShowToolUsage,
    showEvaluation, setShowEvaluation,
    showSettings, setShowSettings,
    showDocumentManager, setShowDocumentManager,
    showKnowledgeSourceManager, setShowKnowledgeSourceManager,
    avatarUploading, setAvatarUploading,
    inputMode, setInputMode,
  } = useUIStore(useShallow((state) => ({
    inputValue: state.inputValue,
    setInputValue: state.setInputValue,
    searchKeyword: state.searchKeyword,
    setSearchKeyword: state.setSearchKeyword,
    showMoreMenu: state.showMoreMenu,
    setShowMoreMenu: state.setShowMoreMenu,
    showApiKeyDialog: state.showApiKeyDialog,
    setShowApiKeyDialog: state.setShowApiKeyDialog,
    apiKeyDialogProvider: state.apiKeyDialogProvider,
    setApiKeyDialogProvider: state.setApiKeyDialogProvider,
    apiKeyInput: state.apiKeyInput,
    setApiKeyInput: state.setApiKeyInput,
    showModelPanel: state.showModelPanel,
    setShowModelPanel: state.setShowModelPanel,
    showSidebar: state.showSidebar,
    setShowSidebar: state.setShowSidebar,
    showHistoryList: state.showHistoryList,
    setShowHistoryList: state.setShowHistoryList,
    showRecentQuestions: state.showRecentQuestions,
    setShowRecentQuestions: state.setShowRecentQuestions,
    showAuthDialog: state.showAuthDialog,
    setShowAuthDialog: state.setShowAuthDialog,
    showMemorySummary: state.showMemorySummary,
    setShowMemorySummary: state.setShowMemorySummary,
    showTokenUsage: state.showTokenUsage,
    setShowTokenUsage: state.setShowTokenUsage,
    showToolUsage: state.showToolUsage,
    setShowToolUsage: state.setShowToolUsage,
    showEvaluation: state.showEvaluation,
    setShowEvaluation: state.setShowEvaluation,
    showSettings: state.showSettings,
    setShowSettings: state.setShowSettings,
    showDocumentManager: state.showDocumentManager,
    setShowDocumentManager: state.setShowDocumentManager,
    showKnowledgeSourceManager: state.showKnowledgeSourceManager,
    setShowKnowledgeSourceManager: state.setShowKnowledgeSourceManager,
    avatarUploading: state.avatarUploading,
    setAvatarUploading: state.setAvatarUploading,
    inputMode: state.inputMode,
    setInputMode: state.setInputMode,
  })));

  const { memoryEnabled, summaryEnabled, injectMemoryOnNewSession, imageModel, updateSettings } = useSettingsStore();
  // 传递给 useChat 的 appSettings 对象
  const appSettings = { memoryEnabled, summaryEnabled, injectMemoryOnNewSession, imageModel };
  const toast = useToastStore();
  const confirm = useConfirmStore();

  // 侧边栏 Tab：会话列表 / 我的收藏
  const [showFavoritesTab, setShowFavoritesTab] = useState(false);

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
    isMessagesLoading,
    toolStatuses,
    messagesEndRef,
    knowledgeBaseStatus,
    pendingImages,
    sessionHasContent,
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
  } = useChat(isAuthenticated, appSettings, (event) => {
    // 收到工具确认请求时，加入确认队列
    confirm.showToolConfirmation(event);
  });

  // 虚拟滚动相关
  const isAtBottomRef = useRef(true);
  const isSessionSwitchRef = useRef(false);

  // 删除消息执行函数
  const executeDeleteMessage = async () => {
    const targetId = confirm.deleteMsgTargetId;
    if (!targetId) return;
    confirm.cancelDeleteMessage(); // 关闭弹窗并清空 targetId，防止竞态
    try {
      await deleteMessage(targetId);
    } catch (error: any) {
      confirm.showAlert('删除消息失败: ' + (error.message || '未知错误'));
    }
  };

  // 工具调用确认处理函数
  // 用 ref 保存当前确认的 ID，避免 closeToolConfirmation 后状态丢失
  const pendingToolConfirmIdRef = useRef<string | null>(null);

  // 当队列头部变化时，同步更新 ref
  const currentConfirmation = confirm.currentToolConfirmation();
  if (currentConfirmation && pendingToolConfirmIdRef.current !== currentConfirmation.id) {
    pendingToolConfirmIdRef.current = currentConfirmation.id;
  }

  const handleToolConfirmation = async (confirmed: boolean) => {
    const confirmId = pendingToolConfirmIdRef.current;
    if (!confirmId) return;
    pendingToolConfirmIdRef.current = null;
    confirm.closeToolConfirmation(); // 移除队列头部，下一个自动显示
    try {
      const result = await respondToConfirmation(confirmId, confirmed);
      if (!result.success) {
        confirm.showAlert('确认响应失败，该请求可能已超时，请重试');
      }
    } catch (error: any) {
      confirm.showAlert('确认响应失败: ' + (error.message || '网络错误'));
    }
  };

  // 标记是否由按钮触发的确认，防止 onOpenChange 重复调用
  const toolConfirmTriggeredRef = useRef(false);

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
      toast.setKbFeedback({ show: true, success: false, message: '请选择图片文件（JPG/PNG/GIF/WebP）' });
      setTimeout(() => toast.hideKbFeedback(), 3000);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.setKbFeedback({ show: true, success: false, message: '图片大小不能超过 20MB' });
      setTimeout(() => toast.hideKbFeedback(), 3000);
      return;
    }
    setAvatarUploading(true);
    try {
      await uploadAvatar(file);
      toast.setKbFeedback({ show: true, success: true, message: '头像更新成功' });
      setTimeout(() => toast.hideKbFeedback(), 3000);
    } catch (err: any) {
      const msg = err?.message || '头像上传失败，请重试';
      toast.setKbFeedback({ show: true, success: false, message: msg });
      setTimeout(() => toast.hideKbFeedback(), 3000);
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
    confirm.showAlert(message);
  };

  const handleDeleteMessage = (messageId: string) => {
    confirm.confirmDeleteMessage(messageId);
  };

  const { theme, setTheme } = useTheme();

  // 输入框位置模式：center = 欢迎页居中，bottom = 对话底部
  useEffect(() => {
    if (sessionHasContent.has(currentSessionId) || isMessagesLoading) {
      setInputMode('bottom');
    } else {
      setInputMode('center');
    }
  }, [currentSessionId, sessionHasContent, isMessagesLoading]);

  // ==================== JSX 渲染区域 ====================
  return (
    <FavoriteDocProvider>
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

                {/* Tab 切换栏：会话 / 我的收藏 */}
                <div className="flex border-b border-border mx-3">
                  <button
                    type="button"
                    onClick={() => setShowFavoritesTab(false)}
                    className={`flex-1 py-2 text-xs font-medium transition-colors text-center ${
                      !showFavoritesTab
                        ? 'text-foreground border-b-2 border-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    会话
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowFavoritesTab(true)}
                    className={`flex-1 py-2 text-xs font-medium transition-colors text-center ${
                      showFavoritesTab
                        ? 'text-foreground border-b-2 border-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    我的收藏
                  </button>
                </div>

                {/* 会话列表 / 收藏列表 */}
                {showFavoritesTab ? (
                  <FavoriteDocumentsPanel />
                ) : (
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
                )}

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
          {/* 头部始终显示 */}
          <HeaderContent
            knowledgeBaseStatus={knowledgeBaseStatus}
            showMoreMenu={showMoreMenu}
            onToggleMoreMenu={() => setShowMoreMenu(!showMoreMenu)}
            onClearKnowledgeBase={clearKnowledgeBase}
            onCheckKnowledgeBaseStatus={checkKnowledgeBaseStatus}
            onKbFeedback={toast.setKbFeedback}
            onOpenMemorySummary={() => setShowMemorySummary(true)}
            onOpenDocumentManager={() => setShowDocumentManager(true)}
            onOpenKnowledgeSourceManager={() => setShowKnowledgeSourceManager(true)}
            onOpenTokenUsage={() => setShowTokenUsage(true)}
            onOpenToolUsage={() => setShowToolUsage(true)}
            onOpenEvaluation={() => setShowEvaluation(true)}
          />

          <KbFeedbackToast feedback={toast.kbFeedback} />

          {/* 输入框动画容器 */}
          <div className="flex-1 relative min-h-0">
            {/* 消息列表 */}
            {messages.length > 0 && (
              <div className="absolute inset-0 bottom-[90px] flex flex-col overflow-hidden">
                <MessageList
                  messages={messages}
                  isTyping={isTyping}
                  toolStatuses={toolStatuses}
                  messagesEndRef={messagesEndRef}
                  currentSessionId={currentSessionId}
                  feedbackState={toast.feedbackState}
                  onFeedbackStateChange={toast.setFeedbackState}
                  onCopyToast={(t) => t.show ? toast.showCopyToast(t.message, t.x, t.y) : toast.hideCopyToast()}
                  onFeedbackToast={(t) => t.show ? toast.showFeedbackToast(t.message, t.x, t.y) : toast.hideFeedbackToast()}
                  onUpdateMessage={updateMessage}
                  onDeleteMessage={handleDeleteMessage}
                  onAlert={handleAlert}
                  isSessionSwitchRef={isSessionSwitchRef}
                  isAtBottomRef={isAtBottomRef}
                />
              </div>
            )}

            {/* 标题 + 输入框：同一个绝对定位容器，一起从居中移动到底部 */}
            <div
              className="absolute left-1/2 max-w-[750px] transition-[top,width] duration-500 ease-in-out pointer-events-none"
              style={{
                width: inputMode === 'center' ? '80%' : '95%',
                top: inputMode === 'center' ? '43%' : 'calc(100% - 180px)',
                transform: inputMode === 'center' ? 'translate(-50%, -50%)' : 'translate(-50%, 0)',
              }}
            >
              {/* 欢迎标题：底部时淡出 */}
              <div
                className="flex items-center justify-center gap-1 mb-10 transition-opacity duration-500 ease-in-out"
                style={{ opacity: inputMode === 'center' ? 1 : 0 }}
              >
                <Bot className="h-8 w-8 text-primary cyberpunk-header-title" />
                <h2 className="text-2xl font-medium text-foreground cyberpunk-useremail">你好，我是以太忆核</h2>
              </div>

              <div className="pointer-events-auto">
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
                  compact={inputMode === 'bottom'}
                />
              </div>
            </div>
          </div>
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
      <ToolUsagePanel
        open={showToolUsage}
        onClose={() => setShowToolUsage(false)}
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
        onSettingsChange={updateSettings}
      />
      {showDocumentManager && (
        <div className="fixed inset-0 z-50 bg-black/50" style={{ top: '25px' }}>
          <div className="absolute inset-0 bg-card shadow-2xl">
            <ErrorBoundary>
              <DocumentManager onClose={() => setShowDocumentManager(false)} onRefreshKnowledgeBase={checkKnowledgeBaseStatus} />
            </ErrorBoundary>
          </div>
        </div>
      )}
      {showKnowledgeSourceManager && (
        <div className="fixed inset-0 z-50 bg-black/50" style={{ top: '25px' }}>
          <div className="absolute inset-0 bg-card shadow-2xl">
            <ErrorBoundary>
              <KnowledgeSourceManager onClose={() => setShowKnowledgeSourceManager(false)} onContentChange={checkKnowledgeBaseStatus} />
            </ErrorBoundary>
          </div>
        </div>
      )}

      {/* 复制成功提示 Toast */}
      {toast.copyToast.show && (
        <div
          className="fixed z-[100] animate-in fade-in slide-in-from-bottom-2 duration-300 pointer-events-none"
          style={{ left: toast.copyToast.x, top: toast.copyToast.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg shadow-lg bg-green-600 text-white text-xs whitespace-nowrap">
            <Check className="h-3 w-3" />
            {toast.copyToast.message}
          </div>
        </div>
      )}
      {/* 反馈提示 Toast */}
      {toast.feedbackToast.show && (
        <div
          className="fixed z-[100] animate-in fade-in slide-in-from-bottom-2 duration-300 pointer-events-none"
          style={{ left: toast.feedbackToast.x, top: toast.feedbackToast.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg shadow-lg bg-blue-600 text-white text-xs whitespace-nowrap">
            {toast.feedbackToast.message}
          </div>
        </div>
      )}

      {/* 删除消息确认弹窗 */}
      <ConfirmDialog
        open={confirm.deleteMsgConfirmOpen}
        onOpenChange={(open) => { if (!open) confirm.closeDeleteConfirm(); }}
        title="删除消息"
        description="确定要删除这条消息吗？将同时删除AI的回复。"
        confirmLabel="确认删除"
        variant="destructive"
        onConfirm={executeDeleteMessage}
      />

      {/* 错误提示弹窗 */}
      <ConfirmDialog
        open={confirm.alertOpen}
        onOpenChange={(open) => { if (!open) confirm.closeAlert(); }}
        title="提示"
        description={confirm.alertMessage}
        confirmLabel="确定"
        cancelLabel=""
        onConfirm={() => confirm.closeAlert()}
      />

      {/* 工具调用确认弹窗（队列模式：逐个显示，处理完一个自动显示下一个） */}
      <ConfirmDialog
        open={confirm.toolConfirmationQueue.length > 0}
        onOpenChange={(open) => {
          if (!open && !toolConfirmTriggeredRef.current) {
            handleToolConfirmation(false);
          }
          toolConfirmTriggeredRef.current = false;
        }}
        title="工具调用确认"
        description={
          currentConfirmation
            ? `${currentConfirmation.message}\n\n工具：${currentConfirmation.toolName}\n操作：${currentConfirmation.paramsSummary}\n风险等级：${currentConfirmation.riskLevel === 'high' ? '高' : currentConfirmation.riskLevel === 'medium' ? '中' : '低'}`
            : ''
        }
        confirmLabel="确认执行"
        cancelLabel="拒绝"
        variant={currentConfirmation?.riskLevel === 'high' ? 'destructive' : undefined}
        onConfirm={() => {
          toolConfirmTriggeredRef.current = true;
          handleToolConfirmation(true);
        }}
      />
    </FavoriteDocProvider>
  );
};

export default ChatAgent;
