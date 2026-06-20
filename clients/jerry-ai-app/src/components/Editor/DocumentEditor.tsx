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

import { useEffect } from 'react';
import { useEditor, EditorContent, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { GhostSuggestion } from './extensions/GhostSuggestion';
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
      // AI 幽灵补全（只读模式下禁用）
      GhostSuggestion.configure({
        enabled: !readOnly,
      }),
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

  // 把 editor 实例向上传递（用于工具栏）
  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  return (
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
  );
}

export type { Editor, JSONContent };
