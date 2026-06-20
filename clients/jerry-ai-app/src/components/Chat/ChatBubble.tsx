import React, { useState, useCallback, useEffect } from "react";
import { Button } from "../ui/button";
import { Database, ThumbsUp, ThumbsDown, Pencil, FileText, Download, FileCode, FileType } from "lucide-react";
import MarkdownRenderer from "./MarkdownRenderer";
import { FileCard } from "./FileCard";
import { PopupMenu, type PopupMenuItem } from "../ui/popup-menu";
import { formatTime } from "../../lib/utils";
import type { Message, MessageAttachment, MessageDocumentCard } from "../../types/session";
import { submitFeedback, getDocumentVersions, exportVersion, getDocumentByTitle } from "../../lib/api";
import { openEditorWithContent } from "../../lib/window";

/* ============== 用户文档卡片辅助函数 ============== */

/** 按文件扩展名返回图标颜色和格式标签（与 FileCard 的 getFormatStyle 对齐） */
function getDocFormatStyle(fileName: string): { color: string; bg: string; label: string } {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'pdf':
      return { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950/40', label: 'PDF' };
    case 'docx':
    case 'doc':
      return { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/40', label: 'Word' };
    case 'xlsx':
    case 'xls':
      return { color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-950/40', label: 'Excel' };
    case 'txt':
      return { color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900', label: 'TXT' };
    case 'md':
      return { color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950/40', label: 'MD' };
    default:
      return { color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900', label: ext.toUpperCase() || 'FILE' };
  }
}

function formatDocSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 下载用户上传的原始文件 */
async function downloadUserDoc(fileUrl: string, fileName: string): Promise<void> {
  // Tauri 环境：用系统保存对话框
  if (!!(window as any).__TAURI_INTERNALS__) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const ext = fileName.split('.').pop()?.toLowerCase() || 'file';
    const filePath = await save({
      defaultPath: fileName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!filePath) return;
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`下载失败：${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    await writeFile(filePath, buf);
    return;
  }
  // 浏览器环境：fetch → blob → a.download
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`下载失败：${resp.status}`);
  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
}

/** 下载 Blob 到本地（跨环境兼容） */
async function downloadBlob(blob: Blob, fileName: string): Promise<void> {
  // Tauri 环境
  if (!!(window as any).__TAURI_INTERNALS__) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const ext = fileName.split('.').pop()?.toLowerCase() || 'file';
    const filePath = await save({
      defaultPath: fileName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!filePath) return;
    const buf = new Uint8Array(await blob.arrayBuffer());
    await writeFile(filePath, buf);
    return;
  }
  // 浏览器环境
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
}

/**
 * 按指定格式下载文档最新版本内容
 * 按文件名查后端文档（编辑保存后后端会按文件名创建文档）：
 * - 找到 → 查最新版本 → 导出为 md/txt/docx（包含编辑后的内容）
 * - 没找到 → 回退到下载原始文件
 */
async function downloadLatestContent(
  card: MessageDocumentCard,
  format: 'md' | 'txt' | 'docx',
): Promise<void> {
  // 优先用 card.documentId，没有则按文件名查后端
  let documentId = card.documentId;

  if (!documentId) {
    const title = card.fileName.replace(/\.[^/.]+$/, '');
    try {
      const doc = await getDocumentByTitle(title);
      if (doc && doc.id) {
        documentId = doc.id;
      }
    } catch {
      // 查不到文档，回退到原始文件下载
      await downloadUserDoc(card.fileUrl, card.fileName);
      return;
    }
  }

  if (!documentId) {
    await downloadUserDoc(card.fileUrl, card.fileName);
    return;
  }

  // 查最新版本并导出
  const versions = await getDocumentVersions(documentId);
  if (versions.length === 0) {
    // 版本数据还没准备好，回退原始文件
    await downloadUserDoc(card.fileUrl, card.fileName);
    return;
  }

  // 取版本号最大的（最新版本）
  const latest = versions.sort((a, b) => b.versionNumber - a.versionNumber)[0];
  const blob = await exportVersion(documentId, latest.id, format);

  // 生成文件名：用原始文件名去扩展名 + 目标格式
  const baseName = card.fileName.replace(/\.[^/.]+$/, '');
  await downloadBlob(blob, `${baseName}.${format}`);
}

/** 单个用户文档卡片（套用 FileCard 视觉结构，但不显示过期/收藏/删除） */
function UserDocumentCard({ card }: { card: MessageDocumentCard }) {
  const style = getDocFormatStyle(card.fileName);
  const [downloading, setDownloading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  /** 按格式下载（含最新编辑内容），统一的 loading 和错误处理 */
  const handleDownloadByFormat = useCallback(async (format: 'md' | 'txt' | 'docx') => {
    if (downloading) return;
    setErrorMsg(null);
    setDownloading(true);
    try {
      await downloadLatestContent(card, format);
    } catch (err: any) {
      console.error('下载文档失败：', err);
      setErrorMsg(`下载失败：${err?.message || err}`);
    } finally {
      setDownloading(false);
    }
  }, [downloading, card]);

  // 下载菜单项：始终提供 md/txt/docx（含最新编辑内容）+ 原文件
  const downloadMenuItems: PopupMenuItem[] = [
    {
      id: 'dl-md',
      label: '下载最新内容 (Markdown)',
      icon: <FileCode className="h-3.5 w-3.5" />,
      onClick: () => { void handleDownloadByFormat('md'); },
    },
    {
      id: 'dl-txt',
      label: '下载最新内容 (纯文本)',
      icon: <FileText className="h-3.5 w-3.5" />,
      onClick: () => { void handleDownloadByFormat('txt'); },
    },
    {
      id: 'dl-docx',
      label: '下载最新内容 (Word)',
      icon: <FileType className="h-3.5 w-3.5" />,
      onClick: () => { void handleDownloadByFormat('docx'); },
    },
    {
      id: 'dl-raw',
      label: '下载原文件',
      icon: <Download className="h-3.5 w-3.5" />,
      onClick: async () => {
        setErrorMsg(null);
        setDownloading(true);
        try {
          await downloadUserDoc(card.fileUrl, card.fileName);
        } catch (err: any) {
          setErrorMsg(`下载失败：${err?.message || err}`);
        } finally {
          setDownloading(false);
        }
      },
    },
  ];

  return (
    <div className="my-2 rounded-xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden">
      <div className="flex items-stretch">
        {/* 左侧图标块 + 中间元信息 → 点击下载原文件 */}
        <div
          className="flex flex-1 min-w-0 items-stretch cursor-pointer group hover:bg-muted/30 dark:hover:bg-muted/10"
          onClick={() => { void downloadUserDoc(card.fileUrl, card.fileName); }}
          title="点击下载原文件"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void downloadUserDoc(card.fileUrl, card.fileName); } }}
        >
          {/* 图标 */}
          <div className={`flex items-center justify-center px-4 ${style.bg}`}>
            <FileText className={`h-8 w-8 ${style.color}`} aria-hidden="true" />
          </div>
          {/* 元信息 */}
          <div className="flex-1 min-w-0 px-4 py-3">
            <div className="font-medium text-sm truncate" title={card.fileName}>
              {card.fileName}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`px-1.5 py-0.5 rounded ${style.bg} ${style.color} font-medium`}>
                {style.label}
              </span>
              <span>·</span>
              <span>{formatDocSize(card.sizeBytes)}</span>
              {card.charCount > 0 && (
                <>
                  <span>·</span>
                  <span>{card.charCount} 字</span>
                </>
              )}
              {card.truncated && (
                <>
                  <span>·</span>
                  <span className="text-amber-500" title="文档过长，仅发送前 5 万字给 AI。建议上传到文档管理并发布到知识库以获得全文检索能力。">
                    已截取前 5 万字（原文共 {card.totalChars ?? '未知'} 字）
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        {/* 右侧操作按钮 */}
        <div className="flex items-center gap-1 pr-2" onClick={(e) => e.stopPropagation()}>
          {/* 在编辑器中打开 */}
          {card.contentJson != null && (
            <button
              type="button"
              onClick={() => { void openEditorWithContent(card.contentJson, card.fileName, card.documentId); }}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              title="在编辑器中打开"
            >
              <Pencil className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">编辑</span>
            </button>
          )}
          {/* 下载：格式选择菜单 */}
          <PopupMenu items={downloadMenuItems} label="下载选项" />
        </div>
      </div>
      {/* 错误提示条 */}
      {errorMsg && (
        <div className="flex items-start gap-2 px-4 py-2 text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-t border-red-200 dark:border-red-900">
          <span className="flex-1">{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-300 font-medium"
            aria-label="关闭错误提示"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

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
  // 局部管理 attachments 的变更（删除/收藏），不需要冒泡到 useChat
  const [localAttachments, setLocalAttachments] = useState<MessageAttachment[] | undefined>(message.attachments);

  // 当 SSE 流式推送 file_card 事件后，useChat 更新 message.attachments，
  // 但 ChatBubble 是同一实例（key 不变），需主动同步新 key 到 localAttachments
  useEffect(() => {
    if (!message.attachments) {
      setLocalAttachments(undefined);
      return;
    }
    setLocalAttachments(prev => {
      const prevMap = new Map((prev || []).map(a => [a.key, a]));
      return message.attachments!.map(att => {
        const existing = prevMap.get(att.key);
        return existing ? { ...att, favorited: existing.favorited } : att;
      });
    });
  }, [message.attachments]);

  const handleAttachmentDelete = useCallback((key: string) => {
    setLocalAttachments(prev => prev?.filter(a => a.key !== key));
  }, []);

  const handleAttachmentFavoriteChange = useCallback((key: string, favorited: boolean) => {
    setLocalAttachments(prev =>
      prev?.map(a => a.key === key ? { ...a, favorited } : a),
    );
  }, []);

  const attachments = localAttachments;

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
                {/* 文件附件卡片（generate_document 等工具产物） */}
                {attachments && attachments.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {attachments.map((att) => (
                      <FileCard
                        key={att.key}
                        attachment={att}
                        onDelete={handleAttachmentDelete}
                        onFavoriteChange={handleAttachmentFavoriteChange}
                      />
                    ))}
                  </div>
                )}
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
                {/* 文档卡片：用户上传文档发送时附加（套用 FileCard 视觉结构） */}
                {message.documentCards && message.documentCards.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {message.documentCards.map((card) => (
                      <UserDocumentCard key={card.id} card={card} />
                    ))}
                  </div>
                )}
                {/* 兼容旧字段：documentContentJson（已废弃，保留防止历史消息丢失按钮） */}
                {!message.documentCards && message.documentContentJson && (
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => {
                        void openEditorWithContent(
                          message.documentContentJson,
                          message.documentFileName || '未命名文档',
                        );
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                      在编辑器中打开
                    </Button>
                    {message.documentFileName && (
                      <span className="text-xs opacity-70 truncate max-w-[200px]">
                        {message.documentFileName}
                      </span>
                    )}
                  </div>
                )}
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
