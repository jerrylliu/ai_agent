/**
 * ============================================================
 * SessionList.tsx - 会话列表组件
 * ============================================================
 * 本组件是左侧边栏的核心区域，负责展示和管理所有会话，
 * 包含以下子模块：
 * 1. 对话历史标题栏：展开/收起控制、清空历史
 * 2. 最近问题区域：展示用户最近提问，点击可重新填入输入框
 * 3. 会话卡片列表：会话标题、操作菜单（重命名/复制/导出/置顶/删除）、更新时间
 * 4. 空状态提示：无会话或无搜索结果时的占位显示
 *
 * 数据流向：
 *   父组件 ChatAgent → props（数据 + 回调）→ SessionList
 *   SessionList → props.onXxx() → 通知父组件执行操作
 * ============================================================
 */

import React from "react";
import { History, ChevronUp, ChevronDown, Trash2, X, Copy, Download, MoreVertical, Pencil, Pin, PinOff, Check, FileText, FileJson, FileType } from "lucide-react";
import { Button } from "../ui/button";
import { formatTime, formatDate } from "../../lib/utils";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Session, HistoryItem } from "../../types/session";

// ==================== Props 接口定义 ====================

/**
 * SessionList 组件的属性接口
 *
 * 设计原则：子组件不直接操作父组件状态，所有状态变更
 * 均通过回调函数通知父组件执行（单向数据流）
 */
interface SessionListProps {
  // ==================== 数据类 Props ====================

  /** 所有会话列表，来源于 useChat() hook */
  sessions: Session[];

  /** 当前选中的会话 ID，用于高亮显示当前会话 */
  currentSessionId: string | null;

  /** 最近问题历史列表，来源于 useChat() hook */
  history: HistoryItem[];

  // ==================== 搜索与状态类 Props ====================

  /** 会话搜索关键词，由父组件 SidebarHeader 中的搜索框控制 */
  searchKeyword: string;

  /** 是否正在加载会话列表，控制 loading 动画显示 */
  isLoading: boolean;

  /** 对话历史列表是否展开，由父组件的 useState 控制 */
  showHistoryList: boolean;

  /** 最近问题列表是否展开，由父组件的 useState 控制 */
  showRecentQuestions: boolean;

  // ==================== 回调类 Props ====================
  // 所有回调均由父组件提供实现，子组件只负责调用

  /** 切换到指定会话 → 对应父组件的 switchSession() */
  onSwitchSession: (sessionId: string) => void;

  /** 删除指定会话 → 对应父组件的 deleteSession() */
  onDeleteSession: (sessionId: string) => void;

  /** 置顶/取消置顶会话 → 对应父组件的 toggleSessionPin() */
  onTogglePin: (sessionId: string) => void;

  /** 点击历史问题时触发 → 对应父组件的 handleHistoryClick()，将问题填入输入框 */
  onHistoryClick: (query: string) => void;

  /** 展开/收起对话历史 → 对应父组件的 setShowHistoryList() */
  onToggleHistoryList: () => void;

  /** 展开/收起最近问题 → 对应父组件的 setShowRecentQuestions() */
  onToggleRecentQuestions: () => void;

  /** 清空历史记录 → 对应父组件的 clearHistory() */
  onClearHistory: () => void;

  /** 清除搜索关键词 → 对应父组件的 setSearchKeyword("") */
  onClearSearch: () => void;

  /** 创建新会话 → 对应父组件的 createNewSession() */
  onCreateSession: () => void;

  /** 重命名会话标题 → 对应父组件的 renameSession() */
  onRenameSession: (sessionId: string, newTitle: string) => void;

  /** 复制会话 → 对应父组件的 duplicateSession() */
  onDuplicateSession: (sessionId: string) => void;

  /** 导出会话 → 对应父组件的 exportSession() */
  onExportSession: (sessionId: string, format: 'json' | 'markdown' | 'text') => void;
}

// ==================== 组件主体 ====================

const SessionList: React.FC<SessionListProps> = ({
  sessions,
  currentSessionId,
  history,
  searchKeyword,
  isLoading,
  showHistoryList,
  showRecentQuestions,
  onSwitchSession,
  onDeleteSession,
  onTogglePin,
  onHistoryClick,
  onToggleHistoryList,
  onToggleRecentQuestions,
  onClearHistory,
  onClearSearch,
  onCreateSession,
  onRenameSession,
  onDuplicateSession,
  onExportSession,
}) => {
  // 操作菜单展开状态（值为 sessionId 时显示该会话的菜单）
  const [menuSessionId, setMenuSessionId] = React.useState<string | null>(null);

  // 删除会话确认弹窗状态
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const [deleteTargetSessionId, setDeleteTargetSessionId] = React.useState<string | null>(null);

  // 导出子菜单展开状态
  const [showExportSubmenu, setShowExportSubmenu] = React.useState(false);

  // Toast 提示状态
  const [toast, setToast] = React.useState<{ show: boolean; message: string; success: boolean }>({
    show: false, message: '', success: true,
  });

  // 点击外部区域关闭菜单
  React.useEffect(() => {
    if (!menuSessionId) return;
    const handleClickOutside = () => {
      setMenuSessionId(null);
      setShowExportSubmenu(false);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [menuSessionId]);

  // Toast 自动消失
  React.useEffect(() => {
    if (!toast.show) return;
    const timer = setTimeout(() => setToast({ show: false, message: '', success: true }), 2000);
    return () => clearTimeout(timer);
  }, [toast.show]);

  const filteredSessions = sessions.filter((session) =>
    session.title.toLowerCase().includes(searchKeyword.toLowerCase())
  );

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTargetSessionId(sessionId);
    setDeleteConfirmOpen(true);
  };

  const executeDeleteSession = async () => {
    if (!deleteTargetSessionId) return;
    setDeleteConfirmOpen(false);
    try {
      await onDeleteSession(deleteTargetSessionId);
    } catch (err: any) {
      console.error('删除会话失败:', err);
    }
  };

  const handleRenameSession = (sessionId: string, currentTitle: string) => {
    const newTitle = prompt("请输入新的会话标题:", currentTitle);
    if (newTitle && newTitle.trim()) {
      onRenameSession(sessionId, newTitle.trim());
    }
  };

  // 关闭菜单
  const closeMenu = () => {
    setMenuSessionId(null);
    setShowExportSubmenu(false);
  };

  // 导出会话处理（带 Toast 反馈）
  const handleExport = async (sessionId: string, format: 'json' | 'markdown' | 'text') => {
    const formatName = format === 'markdown' ? 'Markdown' : format === 'json' ? 'JSON' : '纯文本';
    try {
      await onExportSession(sessionId, format);
      setToast({ show: true, message: `已导出为 ${formatName}`, success: true });
    } catch (err: any) {
      const errMsg = err?.message || '未知错误';
      console.error('[导出] SessionList catch:', errMsg, err);
      setToast({ show: true, message: `导出失败: ${errMsg}`, success: false });
    }
    closeMenu();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* ==================== 对话历史标题栏 ==================== */}
      <div className="flex items-center justify-between mb-4 cyberpunk-history">
        <h4 className="font-medium text-gray-700 dark:text-gray-300 flex items-center">
          <History className="h-4 w-4 mr-2" />
          对话历史
        </h4>
        <div className="flex items-center space-x-1">
          <button
            onClick={onToggleHistoryList}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
            title={showHistoryList ? "收起" : "展开"}
          >
            {showHistoryList ? (
              <ChevronUp className="h-4 w-4 text-gray-500" />
            ) : (
              <ChevronDown className="h-4 w-4 text-gray-500" />
            )}
          </button>
          {history.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onClearHistory}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ==================== 可展开/收起的列表容器 ==================== */}
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: showHistoryList ? "500px" : "0",
          opacity: showHistoryList ? 1 : 0,
        }}
      >
        {/* ==================== 最近问题区域 ==================== */}
        {history.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2 cyberpunk-recent">
              <h5 className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center">
                <History className="h-3 w-3 mr-1" />
                最近的问题
              </h5>
              <button
                onClick={onToggleRecentQuestions}
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                title={showRecentQuestions ? "收起" : "展开"}
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
              style={{
                maxHeight: showRecentQuestions ? "300px" : "0",
                opacity: showRecentQuestions ? 1 : 0,
              }}
            >
              <div className="space-y-2">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="p-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer transition-colors duration-200 cyberpunk-recent"
                    onClick={() => onHistoryClick(item.query)}
                  >
                    <div
                      className="line-clamp-1"
                      dangerouslySetInnerHTML={{
                        __html: searchKeyword
                          ? item.query.replace(
                              new RegExp(`(${searchKeyword})`, "gi"),
                              '<mark style="background-color: #fef3c7; color: #92400e;">$1</mark>'
                            )
                          : item.query,
                      }}
                    />
                    <div className="text-xs text-gray-500 dark:text-gray-300 mt-1 cyberpunk-recent">
                      {formatTime(item.timestamp)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ==================== 会话列表渲染 ==================== */}
        {isLoading ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredSessions.length > 0 ? (
          <div className="space-y-2">
            {filteredSessions.map((session) => (
              <div
                key={session.sessionId}
                className={`p-3 rounded-lg cursor-pointer transition-all duration-200 relative cyberpunk-history ${
                  session.sessionId === currentSessionId
                    ? "bg-primary/10 dark:bg-primary/20 border border-primary/30 shadow-sm"
                    : "hover:bg-gray-100 dark:hover:bg-slate-700"
                }`}
                onClick={() => onSwitchSession(session.sessionId)}
              >
                <div className="flex justify-between items-center min-w-0">
                  {/* 会话标题 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white mb-1 truncate cyberpunk-history">
                      {session.title}
                    </p>
                  </div>

                  {/* ==================== 省略号菜单按钮 ==================== */}
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowExportSubmenu(false);
                        setMenuSessionId(
                          menuSessionId === session.sessionId ? null : session.sessionId
                        );
                      }}
                      title="更多操作"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>

                    {/* ==================== 下拉菜单 ==================== */}
                    {menuSessionId === session.sessionId && (
                      <div
                        className="absolute right-0 top-6 z-50 bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-lg shadow-xl py-1 min-w-[160px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* 重命名 */}
                        <button
                          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-primary/10 dark:hover:bg-primary/20 flex items-center gap-2.5 transition-colors duration-150"
                          onClick={() => {
                            handleRenameSession(session.sessionId, session.title);
                            closeMenu();
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 flex-shrink-0" />
                          重命名
                        </button>

                        {/* 复制会话 */}
                        <button
                          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-primary/10 dark:hover:bg-primary/20 flex items-center gap-2.5 transition-colors duration-150"
                          onClick={async () => {
                            try {
                              await onDuplicateSession(session.sessionId);
                              setToast({ show: true, message: '会话复制成功', success: true });
                            } catch {
                              setToast({ show: true, message: '复制失败，请重试', success: false });
                            }
                            closeMenu();
                          }}
                        >
                          <Copy className="h-3.5 w-3.5 flex-shrink-0" />
                          复制会话
                        </button>

                        {/* 导出会话（内嵌展开子菜单） */}
                        <button
                          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-primary/10 dark:hover:bg-primary/20 flex items-center justify-between gap-2.5 transition-colors duration-150"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowExportSubmenu(!showExportSubmenu);
                          }}
                        >
                          <span className="flex items-center gap-2.5">
                            <Download className="h-3.5 w-3.5 flex-shrink-0" />
                            导出会话
                          </span>
                          <ChevronDown className={`h-3 w-3 text-gray-400 transition-transform duration-150 ${showExportSubmenu ? 'rotate-180' : ''}`} />
                        </button>

                        {/* 导出格式子菜单（内嵌展开） */}
                        {showExportSubmenu && (
                          <div className="bg-gray-50 dark:bg-slate-800/50 py-1">
                            <button
                              className="w-full text-left px-3 pl-8 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-primary/10 dark:hover:bg-primary/20 flex items-center gap-2.5 transition-colors duration-150"
                              onClick={() => handleExport(session.sessionId, 'markdown')}
                            >
                              <FileText className="h-3 w-3 flex-shrink-0 text-gray-400" />
                              Markdown
                            </button>
                            <button
                              className="w-full text-left px-3 pl-8 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-primary/10 dark:hover:bg-primary/20 flex items-center gap-2.5 transition-colors duration-150"
                              onClick={() => handleExport(session.sessionId, 'json')}
                            >
                              <FileJson className="h-3 w-3 flex-shrink-0 text-gray-400" />
                              JSON
                            </button>
                            <button
                              className="w-full text-left px-3 pl-8 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-primary/10 dark:hover:bg-primary/20 flex items-center gap-2.5 transition-colors duration-150"
                              onClick={() => handleExport(session.sessionId, 'text')}
                            >
                              <FileType className="h-3 w-3 flex-shrink-0 text-gray-400" />
                              纯文本
                            </button>
                          </div>
                        )}

                        {/* 置顶 */}
                        <div className="border-t border-gray-100 dark:border-slate-600 my-1" />
                        <button
                          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-primary/10 dark:hover:bg-primary/20 flex items-center gap-2.5 transition-colors duration-150"
                          onClick={() => {
                            onTogglePin(session.sessionId);
                            closeMenu();
                          }}
                        >
                          {session.isPinned ? (
                            <>
                              <PinOff className="h-3.5 w-3.5 flex-shrink-0" />
                              取消置顶
                            </>
                          ) : (
                            <>
                              <Pin className="h-3.5 w-3.5 flex-shrink-0" />
                              置顶会话
                            </>
                          )}
                        </button>

                        {/* 删除 */}
                        <div className="border-t border-gray-100 dark:border-slate-600 my-1" />
                        <button
                          className="w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2.5 transition-colors duration-150"
                          onClick={(e) => {
                            handleDeleteSession(session.sessionId, e);
                            closeMenu();
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
                          删除会话
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 会话更新时间 */}
                <p className="text-xs text-gray-500 dark:text-gray-300 cyberpunk-history">
                  {formatDate(new Date(session.updatedAt))}
                </p>
              </div>
            ))}
          </div>
        ) : (
          /* 空状态提示 */
          <div className="text-center py-12 text-gray-500 dark:text-gray-300 cyberpunk-history">
            {searchKeyword ? (
              <>
                <p>无匹配会话</p>
                <Button
                  onClick={onClearSearch}
                  className="mt-4 bg-primary hover:bg-primary/90 text-white"
                >
                  清除搜索
                </Button>
              </>
            ) : (
              <>
                <p>暂无对话历史</p>
                <Button
                  onClick={onCreateSession}
                  className="mt-4 bg-primary hover:bg-primary/90 text-white"
                >
                  开始新对话
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ==================== Toast 提示 ==================== */}
      {toast.show && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-white text-sm ${
            toast.success ? 'bg-green-600' : 'bg-red-500'
          }`}>
            {toast.success ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            {toast.message}
          </div>
        </div>
      )}

      {/* 删除会话确认弹窗 */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="删除会话"
        description="确定要删除这个会话吗？"
        confirmLabel="确认删除"
        variant="destructive"
        onConfirm={executeDeleteSession}
      />
    </div>
  );
};

export default SessionList;
