/**
 * SelectionToolbar - 选中文字浮动工具栏
 *
 * 职责：
 *   - 编辑器选中文字时，在选区上方显示浮动工具栏
 *   - 提供三个 AI 改写操作：润色 / 翻译 / 改写
 *   - 点击后调用后端 /ai/completion (mode=rewrite)，流式输出替换选中文字
 *   - 处理中可点击取消
 *
 * 设计要点：
 *   - 使用 fixed 定位 + coordsAtPos 计算位置，兼容 Tauri 多窗口
 *   - mousedown preventDefault 防止点击工具栏时编辑器失焦
 *   - 复用 EditorToolbar 的 toast 反馈模式
 *   - 处理期间通过 setGhostContinuing 抑制幽灵补全
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PenLine, Languages, Sparkles, Square, CheckCircle2, AlertCircle } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { requestCompletionStream } from '@/lib/api';
import { setContinuing as setGhostContinuing } from './extensions/GhostSuggestion';
import { cn } from '@/utils/index';

export interface SelectionToolbarProps {
  editor: Editor | null;
}

/** 改写操作类型 */
type RewriteAction = 'polish' | 'translate' | 'rewrite';

/** 操作配置：图标、标签、发送给后端的指令 */
const ACTION_CONFIG: Record<RewriteAction, { label: string; icon: typeof PenLine; instruction: string }> = {
  polish: {
    label: '润色',
    icon: PenLine,
    instruction: '润色这段文字，使其更流畅、更专业，保持原意不变',
  },
  translate: {
    label: '翻译',
    icon: Languages,
    instruction: '将这段文字翻译成英文，保持原意',
  },
  rewrite: {
    label: '改写',
    icon: Sparkles,
    instruction: '改写这段文字，用不同的表达方式，保持原意不变',
  },
};

const ACTION_ORDER: RewriteAction[] = ['polish', 'translate', 'rewrite'];

export function SelectionToolbar({ editor }: SelectionToolbarProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [processing, setProcessing] = useState(false);
  const [activeAction, setActiveAction] = useState<RewriteAction | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 内联 toast（与 EditorToolbar 保持一致的反馈模式）
  const [toast, setToast] = useState<{ show: boolean; success: boolean; message: string }>({
    show: false, success: false, message: '',
  });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (success: boolean, message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ show: true, success, message });
    toastTimerRef.current = setTimeout(() => {
      setToast({ show: false, success: false, message: '' });
      toastTimerRef.current = null;
    }, 2500);
  };

  // 监听选区变化，计算工具栏位置
  useEffect(() => {
    if (!editor) return;

    const updatePosition = () => {
      const { state } = editor;
      const { empty } = state.selection;

      // 空选区或正在处理中 → 隐藏工具栏（处理中保持隐藏，由 toast 反馈进度）
      if (empty || processing) {
        setVisible(false);
        return;
      }

      // 获取选区在视口中的坐标
      const { from, to } = state.selection;
      const startCoords = editor.view.coordsAtPos(from);
      const endCoords = editor.view.coordsAtPos(to);

      // 工具栏定位在选区上方居中
      const top = Math.min(startCoords.top, endCoords.top) - 48;
      const left = (startCoords.left + endCoords.right) / 2;

      setPosition({ top, left });
      setVisible(true);
    };

    editor.on('selectionUpdate', updatePosition);

    return () => {
      editor.off('selectionUpdate', updatePosition);
    };
  }, [editor, processing]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  /**
   * 执行改写操作：取选中文字 → 调用后端 rewrite → 流式替换
   * 处理中再次点击 → 中断请求
   */
  const handleAction = useCallback(async (action: RewriteAction) => {
    if (!editor) return;

    // 处理中点击 → 取消
    if (processing) {
      if (abortRef.current) abortRef.current.abort();
      setProcessing(false);
      setActiveAction(null);
      setGhostContinuing(editor.view, false);
      abortRef.current = null;
      showToast(true, '已停止生成');
      return;
    }

    const { state } = editor;
    const { from, to, empty } = state.selection;
    if (empty) return;

    const selectedText = state.doc.textBetween(from, to, '\n');
    if (!selectedText.trim()) return;

    const config = ACTION_CONFIG[action];
    setProcessing(true);
    setActiveAction(action);
    setVisible(false); // 隐藏工具栏，由 toast 反馈
    setGhostContinuing(editor.view, true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      // 先删除选中文字，光标停留在起始位置
      editor.chain().focus().deleteRange({ from, to }).run();

      await requestCompletionStream(
        { mode: 'rewrite', context: selectedText, instruction: config.instruction },
        (delta) => {
          // 流式插入：用当前 selection.from 避免位置不匹配
          editor.chain().focus().command(({ tr, state: s }) => {
            tr.insertText(delta, s.selection.from);
            return true;
          }).run();
        },
        ac.signal,
      );
      showToast(true, `${config.label}完成`);
    } catch (err) {
      const isAbort = (err as Error)?.name === 'AbortError' || ac.signal.aborted;
      if (!isAbort) {
        const errMsg = (err as Error)?.message || `${config.label}失败，请重试`;
        showToast(false, errMsg);
      }
    } finally {
      setProcessing(false);
      setActiveAction(null);
      setGhostContinuing(editor.view, false);
      abortRef.current = null;
    }
  }, [editor, processing]);

  if (!editor) return null;

  return (
    <>
      {/* 浮动工具栏（仅在有选区且非处理中时显示） */}
      {visible && !processing && (
        <div
          className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
            transform: 'translateX(-50%)',
          }}
          // 防止点击工具栏时编辑器失焦
          onMouseDown={(e) => e.preventDefault()}
        >
          {ACTION_ORDER.map((action) => {
            const config = ACTION_CONFIG[action];
            const Icon = config.icon;
            return (
              <Button
                key={action}
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-xs"
                onClick={() => void handleAction(action)}
                title={config.label}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{config.label}</span>
              </Button>
            );
          })}
        </div>
      )}

      {/* 处理中浮标（显示当前操作 + 取消按钮） */}
      {processing && activeAction && (
        <div
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-border bg-popover px-4 py-2.5 shadow-lg"
        >
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-foreground">
              {ACTION_CONFIG[activeAction].label}中...
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => void handleAction(activeAction)}
          >
            <Square className="h-3 w-3" />
            <span>停止</span>
          </Button>
        </div>
      )}

      {/* toast 反馈 */}
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
    </>
  );
}
