/**
 * ============================================================
 * SessionList.tsx - 会话列表组件
 * ============================================================
 * 本组件是左侧边栏的核心区域，负责展示和管理所有会话，
 * 包含以下子模块：
 * 1. 对话历史标题栏：展开/收起控制、清空历史
 * 2. 最近问题区域：展示用户最近提问，点击可重新填入输入框
 * 3. 会话卡片列表：会话标题、编辑/置顶/删除操作、更新时间
 * 4. 空状态提示：无会话或无搜索结果时的占位显示
 *
 * 数据流向：
 *   父组件 ChatAgent → props（数据 + 回调）→ SessionList
 *   SessionList → props.onXxx() → 通知父组件执行操作
 * ============================================================
 */

import React from "react";
import { History, ChevronUp, ChevronDown, Trash2, X } from "lucide-react";
import { Button } from "../ui/button";
import { formatTime, formatDate } from "../../lib/utils";
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
}

// ==================== 组件主体 ====================

/**
 * SessionList - 会话列表组件
 *
 * 职责：
 * - 根据搜索关键词过滤并展示会话列表
 * - 展示最近问题历史，支持点击重新提问
 * - 提供会话操作（编辑标题、置顶、删除）
 * - 三种渲染状态：加载中 / 有数据 / 空状态
 */
const SessionList: React.FC<SessionListProps> = ({
  // 数据
  sessions,
  currentSessionId,
  history,
  // 搜索与状态
  searchKeyword,
  isLoading,
  showHistoryList,
  showRecentQuestions,
  // 回调
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
}) => {
  // ==================== 内部计算 ====================

  /**
   * 根据搜索关键词过滤会话列表
   * 支持不区分大小写的模糊匹配
   */
  const filteredSessions = sessions.filter((session) =>
    session.title.toLowerCase().includes(searchKeyword.toLowerCase())
  );

  // ==================== 事件处理函数 ====================

  /**
   * 删除会话处理
   * 阻止事件冒泡（避免触发卡片的 onClick 切换会话）
   * 弹出确认对话框后调用父组件的 onDeleteSession
   */
  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("确定要删除这个会话吗？")) {
      onDeleteSession(sessionId);
    }
  };

  /**
   * 编辑会话标题处理
   * 弹出输入框让用户输入新标题
   * 通过 props 回调通知父组件统一处理
   */
  const handleRenameSession = (sessionId: string, currentTitle: string) => {
    const newTitle = prompt("请输入新的会话标题:", currentTitle);
    if (newTitle && newTitle.trim()) {
      onRenameSession(sessionId, newTitle.trim());
    }
  };

  // ==================== JSX 渲染 ====================

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* ==================== 对话历史标题栏 ====================
          功能：
          - 左侧：显示"对话历史"标题和图标
          - 右侧：展开/收起按钮 + 清空历史按钮（仅在有历史时显示）
      */}
      <div className="flex items-center justify-between mb-4 cyberpunk-history">
        <h4 className="font-medium text-gray-700 dark:text-gray-300 flex items-center">
          <History className="h-4 w-4 mr-2" />
          对话历史
        </h4>
        <div className="flex items-center space-x-1">
          {/* 展开/收起按钮：根据 showHistoryList 切换上下箭头 */}
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
          {/* 清空历史按钮：仅在有历史记录时显示 */}
          {history.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onClearHistory}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ==================== 可展开/收起的列表容器 ====================
          使用 maxHeight + opacity 实现展开/收起动画
          - 展开时：maxHeight=500px, opacity=1
          - 收起时：maxHeight=0, opacity=0
          transition-all + duration-300 实现平滑过渡
      */}
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: showHistoryList ? "500px" : "0",
          opacity: showHistoryList ? 1 : 0,
        }}
      >
        {/* ==================== 最近问题区域 ====================
            功能：展示用户最近发送的问题，点击可重新填入输入框
            条件渲染：仅在有历史记录时显示
            数据来源：useChat() hook 中的 history 数组
        */}
        {history.length > 0 && (
          <div className="mb-6">
            {/* 最近问题标题栏 */}
            <div className="flex items-center justify-between mb-2 cyberpunk-recent">
              <h5 className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center">
                <History className="h-3 w-3 mr-1" />
                最近的问题
              </h5>
              {/* 展开/收起按钮 */}
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

            {/* 最近问题列表：可展开/收起的动画容器 */}
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
                    {/* 问题文本：有搜索关键词时高亮匹配部分 */}
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
                    {/* 问题时间戳 */}
                    <div className="text-xs text-gray-500 dark:text-gray-300 mt-1 cyberpunk-recent">
                      {formatTime(item.timestamp)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ==================== 会话列表渲染 ====================
            三种渲染状态：
            1. 加载中 → 旋转 loading 动画
            2. 有数据 → 渲染会话卡片列表
            3. 无数据 → 空状态提示（区分"无搜索结果"和"无会话"）
        */}
        {isLoading ? (
          /* 状态1：加载中 */
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredSessions.length > 0 ? (
          /* 状态2：有会话数据 */
          <div className="space-y-2">
            {filteredSessions.map((session) => (
              /* ==================== 单个会话卡片 ====================
                  结构：
                  - 整行可点击切换会话
                  - 左侧：会话标题（超长截断）
                  - 右侧：操作按钮组（编辑/置顶/删除）
                  - 底部：更新时间
                  样式：当前会话高亮（蓝色边框+背景），其他会话 hover 变灰
              */
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
                  {/* 会话标题：超长文本截断显示 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white mb-1 truncate cyberpunk-history">
                      {session.title}
                    </p>
                  </div>

                  {/* ==================== 会话操作按钮组 ====================
                      所有按钮都需要 e.stopPropagation() 阻止冒泡，
                      避免点击按钮时同时触发卡片的 onClick（切换会话）
                  */}
                  <div className="flex space-x-1">
                    {/* 编辑会话标题按钮 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-gray-400 hover:text-blue-500"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRenameSession(session.sessionId, session.title);
                      }}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-3 w-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                      </svg>
                    </Button>

                    {/* 置顶/取消置顶按钮：已置顶显示黄色勾选图标，未置顶显示上箭头 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-6 w-6 ${
                        session.isPinned
                          ? "text-yellow-500"
                          : "text-gray-400 hover:text-yellow-500"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin(session.sessionId);
                      }}
                    >
                      {session.isPinned ? (
                        /* 已置顶图标：圆形勾选 */
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-3 w-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      ) : (
                        /* 未置顶图标：上箭头 */
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-3 w-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 10l7-7m0 0l7 7m-7-7v18"
                          />
                        </svg>
                      )}
                    </Button>

                    {/* 删除会话按钮：带确认对话框 */}
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

                {/* 会话更新时间 */}
                <p className="text-xs text-gray-500 dark:text-gray-300 cyberpunk-history">
                  {formatDate(new Date(session.updatedAt))}
                </p>
              </div>
            ))}
          </div>
        ) : (
          /* 状态3：空状态提示 */
          <div className="text-center py-12 text-gray-500 dark:text-gray-300 cyberpunk-history">
            {searchKeyword ? (
              /* 有搜索关键词但无匹配结果 */
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
              /* 完全没有会话 */
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
    </div>
  );
};

export default SessionList;
