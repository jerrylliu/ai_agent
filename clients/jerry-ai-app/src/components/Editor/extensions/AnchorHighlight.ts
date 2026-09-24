/**
 * AnchorHighlight - 引用锚点高亮 Tiptap 扩展
 *
 * 功能：
 *   - 给文档中指定区间的块级节点套上高亮样式（引用定位命中后的视觉反馈）
 *   - 到点自动清除，无需调用方管理定时器
 *
 * 为什么必须用 Decoration 而不是直接 classList.add：
 *   ProseMirror 接管编辑器 DOM，任何"从外部偷偷加到节点上的 class"都会被
 *   它的 DOMObserver 在下一次重绘时回滚掉（表现为：滚动定位成功，但高亮看不见）。
 *   Decoration 是 ProseMirror 官方提供的 DOM 修饰通道，由它自己写入 className，
 *   因此每次重绘都会重新应用，不会被抹掉。
 *
 * 实现方式与 GhostSuggestion 保持一致：Tiptap Extension 包装 ProseMirror Plugin，
 * 对外暴露普通函数（不走 addCommands，规避命令类型声明的复杂度）。
 */

import { Extension } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

/** 高亮样式类名，样式定义见 src/new.css 的 .citation-anchor-highlight */
export const ANCHOR_HIGHLIGHT_CLASS = 'citation-anchor-highlight';

/** Plugin 专用的 state key */
const anchorPluginKey = new PluginKey<AnchorRange | null>('anchorHighlight');

/** 被高亮的文档区间（闭开区间，与 ProseMirror 位置语义一致） */
interface AnchorRange {
  from: number;
  to: number;
}

/**
 * 每个编辑器实例独立的自动清除 timer。
 * 用 WeakMap 避免 Tauri 多窗口下的模块级变量共享问题（同 GhostSuggestion）。
 */
const timerMap = new WeakMap<EditorView, ReturnType<typeof setTimeout> | null>();

/** 清除该 view 上待执行的自动清除 timer（不清除高亮本身） */
function clearTimer(view: EditorView): void {
  const timer = timerMap.get(view);
  if (timer) {
    clearTimeout(timer);
    timerMap.set(view, null);
  }
}

/**
 * 高亮文档中 [from, to) 区间的块级节点，durationMs 后自动清除。
 *
 * @param view 编辑器 view 实例
 * @param from 区间起点（块节点起始位置）
 * @param to 区间终点（from + node.nodeSize）
 * @param durationMs 高亮持续时长，应与 new.css 中动画总时长一致
 * @returns 是否成功打上高亮；false 表示区间非法（越界或为空）
 */
export function highlightAnchor(
  view: EditorView,
  from: number,
  to: number,
  durationMs: number,
): boolean {
  // 边界校验：Decoration.node 对越界/空区间会抛 RangeError，
  // 这里提前拦掉，让调用方可以降级为"只定位不高亮"
  const docSize = view.state.doc.content.size;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || to > docSize || from >= to) return false;

  clearTimer(view);
  view.dispatch(view.state.tr.setMeta(anchorPluginKey, { from, to } satisfies AnchorRange));

  const timer = setTimeout(() => {
    timerMap.set(view, null);
    clearAnchorHighlight(view);
  }, durationMs);
  timerMap.set(view, timer);
  return true;
}

/** 立即清除当前高亮（编辑器销毁时由 plugin 的 destroy 钩子调用） */
export function clearAnchorHighlight(view: EditorView): void {
  clearTimer(view);
  if (!anchorPluginKey.getState(view.state)) return;
  view.dispatch(view.state.tr.setMeta(anchorPluginKey, null));
}

export interface AnchorHighlightOptions {
  /** 高亮默认持续时长（毫秒），调用 highlightAnchor 时可覆盖 */
  durationMs: number;
}

export const AnchorHighlight = Extension.create<AnchorHighlightOptions>({
  name: 'anchorHighlight',

  addOptions() {
    return {
      // 与 new.css 中 .citation-anchor-highlight 的动画总时长一致（1s × 5 次）
      durationMs: 5000,
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<AnchorRange | null>({
        key: anchorPluginKey,
        state: {
          init: () => null,
          apply(tr, oldRange) {
            const meta = tr.getMeta(anchorPluginKey);
            if (meta !== undefined) return (meta ?? null) as AnchorRange | null;
            // 文档变化时把区间映射到新位置，保证用户继续编辑时高亮跟着内容走；
            // 映射后区间坍缩（如整篇被 setContent 替换）则自动清除
            if (!oldRange || !tr.docChanged) return oldRange;
            const from = tr.mapping.map(oldRange.from, 1);
            const to = tr.mapping.map(oldRange.to, -1);
            return from >= to ? null : { from, to };
          },
        },
        props: {
          decorations(state) {
            const range = anchorPluginKey.getState(state);
            if (!range) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.node(range.from, range.to, { class: ANCHOR_HIGHLIGHT_CLASS }),
            ]);
          },
        },
        view(editorView: EditorView) {
          return {
            destroy() {
              clearTimer(editorView);
            },
          };
        },
      }),
    ];
  },
});
