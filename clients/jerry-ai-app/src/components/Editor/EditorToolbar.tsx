/**
 * EditorToolbar - 富文本编辑器工具栏
 *
 * 职责：
 *   - 提供常用富文本格式按钮：标题/加粗/斜体/删除线/列表/引用/代码块/撤销重做
 *   - 通过 Tiptap Editor 实例的 chain().focus().xxx().run() API 操作
 *   - 按钮 active 状态由 editor.isActive(...) 判定
 *
 * 设计要点：
 *   - 使用项目已有的 Button 组件（ghost variant + icon-sm size），保持视觉一致
 *   - 不引入额外 Tooltip 依赖（项目暂无 Tooltip 组件），用 title 属性兜底
 *   - active 状态用 bg-accent + text-accent-foreground，匹配 shadcn 风格
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bold, Italic, Strikethrough, Code,
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks,
  Quote, Code2, Minus,
  Undo2, Redo2,
  Sparkles, Square,
  CheckCircle2, AlertCircle,
  MessageSquareWarning, Info, CheckCircle, AlertTriangle, XCircle,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { requestCompletionStream } from '@/lib/api';
import { setContinuing as setGhostContinuing } from './extensions/GhostSuggestion';
import { CALLOUT_TYPES, type CalloutType, insertCallout } from './extensions/CalloutExtension';
import { cn } from '@/utils/index';

export interface EditorToolbarProps {
  editor: Editor | null;
  className?: string;
}

interface ToolButtonProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}

function ToolButton({ onClick, active, disabled, title, children }: ToolButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'shrink-0',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      {children}
    </Button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-border cyberpunk-editor-divider" aria-hidden />;
}

/** Callout 类型的图标 / 标签 / 颜色映射 */
const CALLOUT_ICON_MAP: Record<CalloutType, { icon: typeof Info; label: string; color: string }> = {
  info: { icon: Info, label: '信息', color: 'text-blue-500' },
  success: { icon: CheckCircle, label: '成功', color: 'text-green-500' },
  warning: { icon: AlertTriangle, label: '警告', color: 'text-amber-500' },
  error: { icon: XCircle, label: '错误', color: 'text-red-500' },
};

export function EditorToolbar({ editor, className }: EditorToolbarProps) {
  // 用一个 tick 触发重渲染，避免 isActive 状态滞后
  // Tiptap 的 selectionUpdate / transaction 事件需要订阅才能感知
  const [, setTick] = useState(0);
  const [continuing, setContinuing] = useState(false);
  const continueAbortRef = useRef<AbortController | null>(null);
  // Callout 下拉菜单
  const [calloutOpen, setCalloutOpen] = useState(false);
  const calloutContainerRef = useRef<HTMLDivElement | null>(null);
  const calloutBtnRef = useRef<HTMLButtonElement | null>(null);
  const calloutMenuRef = useRef<HTMLDivElement | null>(null);
  const [calloutPos, setCalloutPos] = useState<{ top: number; left: number } | null>(null);

  // 内联 toast 状态（不依赖全局 toast store，确保编辑器独立窗口也能显示）
  const [toast, setToast] = useState<{ show: boolean; success: boolean; message: string }>({
    show: false, success: false, message: '',
  });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 显示 toast 反馈（2.5 秒后自动隐藏） */
  const showToast = (success: boolean, message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ show: true, success, message });
    toastTimerRef.current = setTimeout(() => {
      setToast({ show: false, success: false, message: '' });
      toastTimerRef.current = null;
    }, 2500);
  };

  /**
   * 手动触发续写：取光标前 4000 字符 → SSE 流式输出 → 直接插入编辑器
   * 续写中再次点击 → 中断请求，提示已停止
   */
  const handleContinue = async () => {
    if (!editor) return;

    // 续写中再次点击 → 取消续写
    if (continuing) {
      if (continueAbortRef.current) {
        continueAbortRef.current.abort();
      }
      // 直接恢复状态，不依赖 finally
      // 防止 SSE 流 hang 住时 abort 无法触发 catch/finally，导致 continuing 卡死
      setContinuing(false);
      setGhostContinuing(editor.view, false);
      continueAbortRef.current = null;
      showToast(true, '已停止生成');
      return;
    }

    setContinuing(true);
    // 抑制 GhostSuggestion 的自动补全（续写过程中频繁插入会触发防抖）
    setGhostContinuing(editor.view, true);

    const ac = new AbortController();
    continueAbortRef.current = ac;

    const { from } = editor.state.selection;
    const start = Math.max(0, from - 4000);
    const context = editor.state.doc.textBetween(start, from, '\n');

    try {
      await requestCompletionStream(
        { mode: 'continue', context },
        (delta) => {
          // 在当前光标位置插入 delta，每次插入后光标自动后移
          // 不手动计算位置，用当前 state.selection.from 避免流式 delta 快速返回时
          // pos 与 doc 不匹配 → RangeError: Position X out of range
          editor.chain().focus().command(({ tr, state }) => {
            tr.insertText(delta, state.selection.from);
            return true;
          }).run();
        },
        ac.signal,
      );
    } catch (err) {
      // abort 是用户主动取消，已在上面提示；其他错误在这里提示
      const isAbort = (err as Error)?.name === 'AbortError' || ac.signal.aborted;
      if (!isAbort) {
        // 显示具体错误信息，方便排查
        const errMsg = (err as Error)?.message || '续写失败，请重试';
        showToast(false, errMsg);
      }
    } finally {
      setContinuing(false);
      setGhostContinuing(editor.view, false);
      continueAbortRef.current = null;
    }
  };

  // 组件卸载时清除 toast 定时器
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => setTick(t => t + 1);
    editor.on('selectionUpdate', onUpdate);
    editor.on('transaction', onUpdate);
    return () => {
      editor.off('selectionUpdate', onUpdate);
      editor.off('transaction', onUpdate);
    };
  }, [editor]);

  // Callout 下拉打开时，监听 scroll/resize 更新菜单位置（Portal fixed 定位不跟随按钮）
  useEffect(() => {
    if (!calloutOpen || !calloutBtnRef.current) return;
    const updatePos = () => {
      if (!calloutBtnRef.current) return;
      const rect = calloutBtnRef.current.getBoundingClientRect();
      setCalloutPos({ top: rect.bottom + 4, left: rect.left });
    };
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [calloutOpen]);

  // Callout 下拉外部点击关闭
  // 注意：下拉菜单通过 Portal 渲染到 document.body，不在 calloutContainerRef 内部
  // 所以需要同时检查 calloutContainerRef（按钮）和 calloutMenuRef（Portal 菜单）
  useEffect(() => {
    if (!calloutOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inContainer = calloutContainerRef.current?.contains(target);
      const inMenu = calloutMenuRef.current?.contains(target);
      if (!inContainer && !inMenu) {
        setCalloutOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [calloutOpen]);

  if (!editor) {
    return (
      <div className={cn('flex items-center gap-0.5 px-3 py-1.5 border-b border-border bg-muted/30 cyberpunk-editor-toolbar', className)}>
        <span className="text-xs text-muted-foreground">编辑器加载中...</span>
      </div>
    );
  }

  const can = editor.can();

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 px-3 py-1.5 border-b border-border bg-muted/30 overflow-x-auto cyberpunk-editor-toolbar',
        className,
      )}
    >
      {/* 撤销 / 重做 */}
      <ToolButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!can.chain().focus().undo().run()}
        title="撤销 (Ctrl+Z)"
      >
        <Undo2 className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!can.chain().focus().redo().run()}
        title="重做 (Ctrl+Shift+Z)"
      >
        <Redo2 className="h-4 w-4" />
      </ToolButton>

      <Divider />

      {/* 标题 */}
      <ToolButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive('heading', { level: 1 })}
        title="一级标题"
      >
        <Heading1 className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive('heading', { level: 2 })}
        title="二级标题"
      >
        <Heading2 className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive('heading', { level: 3 })}
        title="三级标题"
      >
        <Heading3 className="h-4 w-4" />
      </ToolButton>

      <Divider />

      {/* 行内样式 */}
      <ToolButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title="加粗 (Ctrl+B)"
      >
        <Bold className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title="斜体 (Ctrl+I)"
      >
        <Italic className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title="删除线"
      >
        <Strikethrough className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive('code')}
        title="行内代码"
      >
        <Code className="h-4 w-4" />
      </ToolButton>

      <Divider />

      {/* 列表 */}
      <ToolButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
        title="无序列表"
      >
        <List className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
        title="有序列表"
      >
        <ListOrdered className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={editor.isActive('taskList')}
        title="任务列表"
      >
        <ListChecks className="h-4 w-4" />
      </ToolButton>

      <Divider />

      {/* 块级 */}
      <ToolButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive('blockquote')}
        title="引用块"
      >
        <Quote className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive('codeBlock')}
        title="代码块"
      >
        <Code2 className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="分割线"
      >
        <Minus className="h-4 w-4" />
      </ToolButton>

      <Divider />

      {/* Callout 提示块 */}
      <div ref={calloutContainerRef} className="relative shrink-0">
        <Button
          ref={calloutBtnRef}
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            if (!calloutOpen && calloutBtnRef.current) {
              const rect = calloutBtnRef.current.getBoundingClientRect();
              setCalloutPos({ top: rect.bottom + 4, left: rect.left });
            }
            setCalloutOpen(v => !v);
          }}
          title="提示块"
          className={cn(
            'shrink-0',
            editor.isActive('callout') && 'bg-accent text-accent-foreground',
          )}
        >
          <MessageSquareWarning className="h-4 w-4" />
        </Button>
        {calloutOpen && calloutPos && createPortal(
          <div
            ref={calloutMenuRef}
            style={{ position: 'fixed', top: calloutPos.top, left: calloutPos.left }}
            className="z-50 w-32 rounded-lg border border-border bg-popover p-1 shadow-lg"
          >
            {CALLOUT_TYPES.map((type) => {
              const config = CALLOUT_ICON_MAP[type];
              const Icon = config.icon;
              return (
                <button
                  key={type}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors"
                  onClick={() => {
                    console.log('[EditorToolbar] 插入 Callout', { type });
                    insertCallout(editor, type);
                    setCalloutOpen(false);
                  }}
                >
                  <Icon className={cn('h-3.5 w-3.5', config.color)} />
                  <span>{config.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
      </div>

      <Divider />

      {/* AI 续写 / 续写中点击可取消 */}
      <ToolButton
        onClick={() => void handleContinue()}
        title={continuing ? '取消续写' : 'AI 续写'}
      >
        {continuing ? (
          <Square className="h-4 w-4" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
      </ToolButton>

      {/* 续写反馈 toast（fixed 定位，不依赖外部容器） */}
      {toast.show && (
        <div
          className={cn(
            'fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg px-4 py-2.5 shadow-lg',
            'animate-in fade-in slide-in-from-bottom-2 duration-200',
            toast.success
              ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800',
          )}
        >
          {toast.success ? (
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
          )}
          <span
            className={cn(
              'text-sm',
              toast.success
                ? 'text-green-700 dark:text-green-300'
                : 'text-red-700 dark:text-red-300',
            )}
          >
            {toast.message}
          </span>
        </div>
      )}
    </div>
  );
}
