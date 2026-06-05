import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { Button } from "../ui/button";
import { MoreHorizontal, Database, Trash2, Brain, FileText, Layers, Bell, BarChart3, Star } from "lucide-react";
interface KbFeedback {
    show: boolean;
    success: boolean;
    message: string;
}

interface HeaderContentProps {
    knowledgeBaseStatus: {
        status: string;
        stats?: { documentCount: number; uploadedDocumentCount: number; knowledgeSourcePageCount: number };
        hasContentUpdate?: boolean;
    };
    showMoreMenu: boolean;
    onToggleMoreMenu: () => void;
    onClearKnowledgeBase: () => Promise<{ success: boolean; message: string }>;
    onCheckKnowledgeBaseStatus: () => void;
    onKbFeedback: (feedback: KbFeedback) => void;
    onOpenMemorySummary?: () => void;
    onOpenDocumentManager?: () => void;
    onOpenKnowledgeSourceManager?: () => void;
    onOpenTokenUsage?: () => void;
    onOpenEvaluation?: () => void;
}

const HeaderContent: React.FC<HeaderContentProps> = (props) => {
    const { knowledgeBaseStatus, showMoreMenu, onToggleMoreMenu, onClearKnowledgeBase, onCheckKnowledgeBaseStatus, onKbFeedback, onOpenMemorySummary, onOpenDocumentManager, onOpenKnowledgeSourceManager, onOpenTokenUsage, onOpenEvaluation } = props;
    const handleClearKnowledgeBase = async () => {
        onToggleMoreMenu();
        if (confirm('确定要清空整个知识库吗？此操作不可恢复。')) {
            try {
                const result = await onClearKnowledgeBase();
                onKbFeedback({
                    show: true,
                    success: result.success,
                    message: result.message,
                });
                onCheckKnowledgeBaseStatus();
                setTimeout(() => onKbFeedback({ show: false, success: result.success, message: result.message }), 3000);
            } catch (error: any) {
                onKbFeedback({
                    show: true,
                    success: false,
                    message: error.message || '清空失败',
                });
                setTimeout(() => onKbFeedback({ show: false, success: false, message: error.message || '清空失败' }), 3000);
            }
        }
    };
    return (
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
                                {knowledgeBaseStatus.stats.knowledgeSourcePageCount > 0 && (
                                    <span className="text-gray-400 dark:text-gray-500 font-normal">
                                        {' '}(含{knowledgeBaseStatus.stats.knowledgeSourcePageCount}页知识源)
                                    </span>
                                )}
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
                        {knowledgeBaseStatus.hasContentUpdate && (
                            <button
                                className="ml-1 flex items-center justify-center w-5 h-5 rounded-full bg-orange-100 dark:bg-orange-900/40 hover:bg-orange-200 dark:hover:bg-orange-800/50 transition-colors cyberpunk-update-badge"
                                title="知识源内容有更新，点击查看"
                                onClick={() => onOpenKnowledgeSourceManager?.()}
                            >
                                <Bell className="h-3 w-3 text-orange-600 dark:text-orange-400 animate-pulse cyberpunk-update-icon" />
                            </button>
                        )}
                    </div>
                    <div className="relative more-menu">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full"
                            onClick={() => onToggleMoreMenu()}
                        >
                            <MoreHorizontal className="h-5 w-5" />
                        </Button>
                        {showMoreMenu && (
                            <div className="absolute right-0 mt-2 w-48 bg-card border border-gray-200 dark:border-slate-600 rounded-lg shadow-lg z-50">
                                <button
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center cyberpunk-menu-item"
                                    onClick={() => {
                                        onToggleMoreMenu();
                                        onOpenDocumentManager?.();
                                    }}
                                >
                                    <FileText className="h-4 w-4 mr-2" />
                                    文档管理
                                </button>
                                <button
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center cyberpunk-menu-item"
                                    onClick={() => {
                                        onToggleMoreMenu();
                                        onOpenKnowledgeSourceManager?.();
                                    }}
                                >
                                    <Layers className="h-4 w-4 mr-2" />
                                    知识源管理
                                </button>
                                <button
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center cyberpunk-menu-item"
                                    onClick={() => {
                                        onToggleMoreMenu();
                                        onOpenMemorySummary?.();
                                    }}
                                >
                                    <Brain className="h-4 w-4 mr-2" />
                                    记忆与摘要
                                </button>
                                <button
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center cyberpunk-menu-item"
                                    onClick={() => {
                                        onToggleMoreMenu();
                                        onOpenTokenUsage?.();
                                    }}
                                >
                                    <BarChart3 className="h-4 w-4 mr-2" />
                                    Token 用量
                                </button>
                                <button
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center cyberpunk-menu-item"
                                    onClick={() => {
                                        onToggleMoreMenu();
                                        onOpenEvaluation?.();
                                    }}
                                >
                                    <Star className="h-4 w-4 mr-2" />
                                    准确率评估
                                </button>
                                <button
                                    className="w-full px-4 py-2 text-left text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 flex items-center"
                                    onClick={() => handleClearKnowledgeBase()}
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
    )}
export default HeaderContent;