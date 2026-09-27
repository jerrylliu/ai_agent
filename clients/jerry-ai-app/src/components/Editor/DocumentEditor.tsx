/**
 * DocumentEditor - 富文本编辑器核心容器
 *
 * 职责：
 *   - 基于 Tiptap 3 + StarterKit 渲染可编辑文档
 *   - 接收 `value`（JSON 内容）与 `onChange`，由父组件管理持久化
 *   - 暴露 `onReady` 回调，把 Editor 实例交给父组件做工具栏 / 命令调用
 *
 * 设计要点：
 *   - immediatelyRender: false 避免 Tauri WebView 热更新时的 hydration 问题
 *   - 文档切换时通过 setContent + queueMicrotask 同步内容，避免状态竞争
 *   - 编辑区样式跟随项目主题（暗色 / 亮色），通过 prose 类与自定义 CSS 控制
 *   - 不在此处写持久化逻辑，保持组件纯展示
 */

import { useEffect, useState } from 'react';
import { useEditor, EditorContent, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {
  GhostSuggestion,
  setEnabled as setGhostEnabled,
  getGhostState,
  acceptGhostSuggestion,
  clearGhostSuggestion,
} from './extensions/GhostSuggestion';
import { CalloutExtension } from './extensions/CalloutExtension';
import { AnchorHighlight } from './extensions/AnchorHighlight';
import { useSettingsStore } from '@/stores/settings-store';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/index';

export interface DocumentEditorProps {
  /** 编辑器内容 (Tiptap JSONContent)，受控 */
  value: JSONContent | null;
  /** 内容变化回调 */
  onChange: (json: JSONContent) => void;
  /** 是否只读 */
  readOnly?: boolean;
  /** 占位符文本 */
  placeholder?: string;
  /** 编辑器准备就绪后的回调，把 editor 实例传出去 */
  onReady?: (editor: Editor) => void;
  /** 自定义类名 */
  className?: string;
}

const DEFAULT_PLACEHOLDER = '开始书写，AI 将为你提供帮助...';

/** 空文档（避免 setContent(null) 报错） */
const EMPTY_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

export function DocumentEditor({
  value,
  onChange,
  readOnly = false,
  placeholder = DEFAULT_PLACEHOLDER,
  onReady,
  className,
}: DocumentEditorProps) {
  // 读取自动补全开关设置（响应式：设置变化时自动同步到编辑器）
  const autoCompleteEnabled = useSettingsStore((s) => s.autoCompleteEnabled);
  const isMobile = useIsMobile();

  // 移动端幽灵补全可接受状态：软键盘没有 Tab/Esc，需要渲染"接受/取消"浮动按钮。
  // 通过 transaction 事件跟踪插件状态（补全文本出现/清除/光标移开都会派发事务），
  // 只在可见性变化时 setState，避免高频事务反复重渲染
  const [ghostVisible, setGhostVisible] = useState(false);
  const [ghostText, setGhostText] = useState('');

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        // StarterKit 已包含 heading / bold / italic / list / codeBlock / blockquote 等
        // 关闭部分内置项的话在这里覆盖
      }),
      Placeholder.configure({
        placeholder,
        emptyEditorClass: 'is-editor-empty',
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      // AI 幽灵补全（只读模式下禁用；运行时开关由 useEffect + setGhostEnabled 控制）
      GhostSuggestion.configure({
        enabled: !readOnly,
      }),
      // Callout 提示块节点
      CalloutExtension,
      // 引用锚点定位命中后的段落高亮
      AnchorHighlight,
    ],
    content: value ?? EMPTY_DOC,
    onUpdate: ({ editor: e }) => {
      onChange(e.getJSON());
    },
  });

  // 文档切换：当外部 value 变化（如切换到另一个文档）时同步内容
  // 注意：用 queueMicrotask 推迟到下一个微任务，避免与 onUpdate 的状态竞争
  useEffect(() => {
    if (!editor) return;
    const incoming = value ?? EMPTY_DOC;
    // 只在内容真正不一致时才 setContent，避免无谓的光标重置
    const current = editor.getJSON();
    if (JSON.stringify(current) === JSON.stringify(incoming)) return;
    queueMicrotask(() => {
      editor.commands.setContent(incoming, { emitUpdate: false });
    });
  }, [editor, value]);

  // 只读状态切换
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // 自动补全开关变化时，运行时同步启用/禁用幽灵补全
  // （不重建编辑器，通过 setEnabled 直接控制 ProseMirror 插件行为）
  useEffect(() => {
    if (!editor) return;
    setGhostEnabled(editor.view, !readOnly && autoCompleteEnabled);
  }, [editor, readOnly, autoCompleteEnabled]);

  // 把 editor 实例向上传递（用于工具栏）
  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  // 幽灵补全状态跟踪（editor 就绪后）：见上方 ghostVisible/ghostText 说明
  useEffect(() => {
    if (!editor) return;
    const syncGhost = () => {
      const st = getGhostState(editor.view);
      const visible =
        !!st?.suggestion && editor.state.selection.from === st.from;
      setGhostVisible((prev) => (prev === visible ? prev : visible));
      setGhostText((prev) =>
        prev === (st?.suggestion ?? '') ? prev : (st?.suggestion ?? ''),
      );
    };
    syncGhost();
    editor.on('transaction', syncGhost);
    return () => {
      editor.off('transaction', syncGhost);
    };
  }, [editor]);

  return (
    <>
      <div
        className={cn(
          'tiptap-editor-container w-full h-full overflow-y-auto',
          'px-6 py-4 cyberpunk-editor-container',
          className,
        )}
      >
        <EditorContent
          editor={editor}
          className={cn(
            // Tailwind Typography 让默认 markdown-like 样式得当
            'prose prose-sm md:prose-base max-w-none',
            'dark:prose-invert',
            // 赛博朋克模式标识，用于 CSS 覆盖 prose 样式
            'cyberpunk-editor-content',
            // 聚焦时去掉默认描边
            '[&_.ProseMirror]:outline-none',
            '[&_.ProseMirror]:min-h-[60vh]',
            // 占位符样式
            '[&_.ProseMirror_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]',
            '[&_.ProseMirror_.is-editor-empty:first-child]:before:text-gray-400',
            '[&_.ProseMirror_.is-editor-empty:first-child]:before:float-left',
            '[&_.ProseMirror_.is-editor-empty:first-child]:before:pointer-events-none',
            '[&_.ProseMirror_.is-editor-empty:first-child]:before:h-0',
          )}
        />
      </div>

      {/* 移动端幽灵补全操作条：软键盘没有 Tab/Esc，提供"接受/取消"按钮。
          固定定位在键盘上方（--safe-keyboard 由安卓原生 insets 桥注入）；
          onMouseDown preventDefault 防止点击按钮时编辑器失焦、软键盘收起 */}
      {isMobile && !readOnly && editor && ghostVisible && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-50 flex max-w-[92vw] items-center gap-2 rounded-full border border-border bg-popover text-popover-foreground shadow-lg px-3 py-1.5 bottom-[calc(var(--safe-bottom)+var(--safe-keyboard)+16px)]"
          data-testid="ghost-accept-bar"
        >
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {ghostText}
          </span>
          <Button
            size="sm"
            className="h-7 shrink-0 px-3"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (editor && acceptGhostSuggestion(editor.view)) {
                setGhostVisible(false);
              }
            }}
          >
            接受
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (editor) clearGhostSuggestion(editor.view);
              setGhostVisible(false);
            }}
          >
            取消
          </Button>
        </div>
      )}
    </>
  );
}

export type { Editor, JSONContent };
