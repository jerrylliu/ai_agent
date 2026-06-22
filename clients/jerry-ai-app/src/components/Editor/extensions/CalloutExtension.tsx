/**
 * CalloutExtension - Callout 提示块节点
 *
 * 职责：
 *   - 提供带颜色边框和图标的提示块（info / success / warning / error）
 *   - 视觉风格与项目 ChatBubble 系统提示样式对齐
 *   - 支持嵌套段落、列表等块级内容
 *
 * 设计要点：
 *   - 使用 renderHTML 纯 HTML 渲染（非 ReactNodeView），避免 NodeView 复杂性
 *   - 通过 data-type 属性控制样式，CSS 在编辑器全局样式中定义
 *   - parseHTML 支持 div[data-callout] 解析，保证持久化后可恢复
 *   - 不允许嵌套 Callout（group: 'block' 但 content 不含 callout）
 */

import { Node, mergeAttributes, type Editor } from '@tiptap/react';

/** Callout 类型 */
export type CalloutType = 'info' | 'success' | 'warning' | 'error';

/** 所有合法的 Callout 类型 */
export const CALLOUT_TYPES: CalloutType[] = ['info', 'success', 'warning', 'error'];

/** 类型配置：图标 emoji、样式类名 */
export const CALLOUT_CONFIG: Record<CalloutType, { icon: string; containerClass: string }> = {
  info: {
    icon: 'ℹ️',
    containerClass: 'callout-info',
  },
  success: {
    icon: '✅',
    containerClass: 'callout-success',
  },
  warning: {
    icon: '⚠️',
    containerClass: 'callout-warning',
  },
  error: {
    icon: '❌',
    containerClass: 'callout-error',
  },
};

/**
 * Callout 节点扩展
 *
 * schema:
 *   - group: block
 *   - content: block+（可放段落、列表等，但不能嵌套 callout）
 *   - defining: true（防止与其他块级节点合并）
 *   - isolating: true（限制内容操作不溢出到节点外）
 */
export const CalloutExtension = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      type: {
        default: 'info' as CalloutType,
        parseHTML: (element) => {
          const type = element.getAttribute('data-type') || 'info';
          return CALLOUT_TYPES.includes(type as CalloutType) ? type : 'info';
        },
        renderHTML: (attributes) => ({
          'data-type': attributes.type as CalloutType,
        }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-callout]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const type = (HTMLAttributes['data-type'] as CalloutType) || 'info';
    const config = CALLOUT_CONFIG[type] || CALLOUT_CONFIG.info;

    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-callout': '',
        'data-type': type,
        class: `callout-block ${config.containerClass}`,
      }),
      ['div', { class: 'callout-icon' }, config.icon],
      ['div', { class: 'callout-content' }, 0],
    ];
  },
});

/**
 * 插入 Callout 块的辅助函数
 * 在工具栏中直接调用，避免 addCommands 的类型复杂度
 */
export function insertCallout(editor: Editor, type: CalloutType = 'info'): void {
  if (!CALLOUT_TYPES.includes(type)) {
    console.warn('[CalloutExtension] 无效的 Callout 类型，已降级为 info', { received: type });
    type = 'info';
  }
  const ok = editor.chain().focus().insertContent({
    type: 'callout',
    attrs: { type },
    content: [{ type: 'paragraph' }],
  }).run();
  if (!ok) {
    console.error('[CalloutExtension] insertContent 返回 false，插入失败', { type });
  }
}
