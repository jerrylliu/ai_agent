/**
 * GhostSuggestion - AI 幽灵补全 Tiptap 扩展
 *
 * 功能：
 *   - 编辑器内容变化后 800ms 防抖，取光标前 4000 字符发给后端 /ai/completion
 *   - 补全文本以灰色"幽灵文字"显示在光标后
 *   - Tab 接受补全（插入到文档），Esc 取消
 *   - 打字、移动光标、失焦时自动清除当前补全
 *
 * 实现方式：
 *   - 用 Tiptap Extension 包装一个 ProseMirror Plugin
 *   - Plugin state 存当前补全文本 + 装饰器（Decoration）渲染幽灵文字
 *   - keydown handler 拦截 Tab / Escape
 *   - 响应式：通过 onDelta 回调流式更新 state
 */

import { Extension } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { requestCompletion } from '@/lib/api';

/** Plugin 专用的 state key */
const ghostPluginKey = new PluginKey<GhostState>('ghostSuggestion');

interface GhostState {
  /** 当前补全文本（空字符串表示无补全） */
  suggestion: string;
  /** 补全起始位置（光标位置） */
  from: number;
}

/** 创建空的 GhostState */
function emptyState(): GhostState {
  return { suggestion: '', from: 0 };
}

/**
 * 每个编辑器实例独立的运行时状态
 * 用 WeakMap 避免 Tauri 多窗口下的模块级变量共享问题
 */
interface EditorRuntime {
  /** 防抖 timer */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** 当前请求的 AbortController */
  abortController: AbortController | null;
  /** 一次性抑制（acceptSuggestion 触发，下一次 update 后自动清除） */
  acceptSuppress: boolean;
  /** 持续性抑制（工具栏续写期间，setContinuing 控制） */
  continuing: boolean;
  /** 请求序号，每次 fetchSuggestion 递增，用于丢弃过期响应 */
  seq: number;
}

const runtimeMap = new WeakMap<EditorView, EditorRuntime>();

function getRuntime(view: EditorView): EditorRuntime {
  let rt = runtimeMap.get(view);
  if (!rt) {
    rt = { debounceTimer: null, abortController: null, acceptSuppress: false, continuing: false, seq: 0 };
    runtimeMap.set(view, rt);
  }
  return rt;
}

/**
 * 供外部调用：在工具栏续写期间持续抑制自动补全
 * 用法：setContinuing(editor.view, true) → 续写 → setContinuing(editor.view, false)
 */
export function setContinuing(view: EditorView, value: boolean): void {
  const rt = getRuntime(view);
  rt.continuing = value;
  if (value) {
    clearSuggestion(view);
    if (rt.debounceTimer) {
      clearTimeout(rt.debounceTimer);
      rt.debounceTimer = null;
    }
  }
}

/**
 * 获取光标前的纯文本（最多 maxChars 字符）
 */
function getTextBeforeCursor(view: EditorView, maxChars = 4000): string {
  const { from } = view.state.selection;
  const start = Math.max(0, from - maxChars);
  return view.state.doc.textBetween(start, from, '\n');
}

/**
 * 请求 AI 补全（非流式），一次性拿到完整文本后显示为幽灵文字
 *
 * 非流式优势：
 *   - abort 100% 可靠（fetch signal 在请求阶段一定生效）
 *   - 无 reader.read() hang 住的风险
 *   - 自动补全只需短文本（≤210字），等待 1-2 秒可接受
 */
function fetchSuggestion(view: EditorView): void {
  const rt = getRuntime(view);
  // 发送新请求前，中断上一个进行中的请求
  if (rt.abortController) {
    rt.abortController.abort();
    rt.abortController = null;
  }

  const context = getTextBeforeCursor(view);
  if (context.trim().length < 5) {
    clearSuggestionDisplay(view);
    return;
  }

  rt.abortController = new AbortController();
  const currentFrom = view.state.selection.from;
  // 递增序号，用于丢弃过期响应（用户打字后旧请求返回时 seq 不匹配）
  const currentSeq = ++rt.seq;

  requestCompletion(
    { mode: 'autocomplete', context },
    rt.abortController.signal,
  ).then((suggestion) => {
    // 序号校验：如果用户在等待期间又打了字（触发新 fetchSuggestion），seq 已变，丢弃
    if (currentSeq !== rt.seq) return;
    // 光标已移动 → 丢弃
    if (view.state.selection.from !== currentFrom) return;

    if (suggestion && suggestion.trim()) {
      const { state, dispatch } = view;
      dispatch(
        state.tr.setMeta(ghostPluginKey, {
          suggestion,
          from: currentFrom,
        }),
      );
    }
  }).catch(() => {
    // 出错静默处理（abort / 网络错误 / 超时）
  }).finally(() => {
    const rt = getRuntime(view);
    // 只清理当前请求的 abortController（序号匹配时）
    if (rt.abortController && currentSeq === rt.seq) {
      rt.abortController = null;
    }
  });
}

/**
 * 仅清除补全显示（不中断进行中的 LLM 请求）
 * 用户打字时调用：隐藏幽灵文字，但让 LLM 继续处理
 * 响应到达时 onDelta 会校验上下文，过期的响应会被丢弃
 */
function clearSuggestionDisplay(view: EditorView): void {
  const { state, dispatch } = view;
  const pluginState = ghostPluginKey.getState(state);
  if (pluginState && pluginState.suggestion) {
    dispatch(state.tr.setMeta(ghostPluginKey, emptyState()));
  }
}

/**
 * 清除补全并中断请求（用于 Escape、setContinuing 等主动取消场景）
 */
function clearSuggestion(view: EditorView): void {
  const rt = getRuntime(view);
  if (rt.abortController) {
    rt.abortController.abort();
    rt.abortController = null;
  }
  clearSuggestionDisplay(view);
}

/**
 * 接受补全：把幽灵文字插入到文档
 */
function acceptSuggestion(view: EditorView): void {
  const rt = getRuntime(view);
  const { state, dispatch } = view;
  const pluginState = ghostPluginKey.getState(state);
  if (!pluginState || !pluginState.suggestion) return;

  // 一次性抑制：插入文本会触发 docChanged → apply 返回 emptyState → update 触发防抖
  // 用 acceptSuppress 阻止这一次 update 的防抖请求
  rt.acceptSuppress = true;
  // 插入补全文本 + 清除 state 合并到单个 transaction（避免 stale state 导致 mismatched transaction）
  const tr = state.tr.insertText(pluginState.suggestion, pluginState.from);
  tr.setMeta(ghostPluginKey, emptyState());
  dispatch(tr);

  if (rt.abortController) {
    rt.abortController.abort();
    rt.abortController = null;
  }
}

export interface GhostSuggestionOptions {
  /** 防抖延迟（毫秒） */
  debounceMs: number;
  /** 是否启用 */
  enabled: boolean;
}

export const GhostSuggestion = Extension.create<GhostSuggestionOptions>({
  name: 'ghostSuggestion',

  addOptions() {
    return {
      debounceMs: 800,
      enabled: true,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin<GhostState>({
        key: ghostPluginKey,
        state: {
          init: () => emptyState(),
          apply(tr, oldState) {
            const meta = tr.getMeta(ghostPluginKey);
            if (meta !== undefined) return meta as GhostState;

            // 文档变化时清除补全（apply 阶段无法访问 runtime 的 suppressed，
            // 但通过 setMeta 已经处理了清除逻辑，这里只需对用户打字触发的
            // docChanged 做清除）
            if (tr.docChanged) {
              return emptyState();
            }

            return oldState;
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (!options.enabled) return false;

            const state = ghostPluginKey.getState(view.state);
            const hasSuggestion = !!state?.suggestion;

            // Tab：接受补全
            if (event.key === 'Tab' && hasSuggestion && !event.shiftKey) {
              event.preventDefault();
              acceptSuggestion(view);
              return true;
            }

            // Escape：取消补全
            if (event.key === 'Escape' && hasSuggestion) {
              event.preventDefault();
              clearSuggestion(view);
              return true;
            }

            return false;
          },
          decorations(state) {
            if (!options.enabled) return DecorationSet.empty;

            const pluginState = ghostPluginKey.getState(state);
            if (!pluginState || !pluginState.suggestion) return DecorationSet.empty;

            // 光标位置变了 → 不显示
            if (state.selection.from !== pluginState.from) return DecorationSet.empty;

            // 用 widget decoration 渲染幽灵文字
            const widget = Decoration.widget(pluginState.from, () => {
              const span = document.createElement('span');
              span.className = 'ghost-suggestion';
              span.textContent = pluginState.suggestion;
              span.style.opacity = '0.4';
              span.style.pointerEvents = 'none';
              span.style.color = 'var(--muted-foreground)';
              span.style.whiteSpace = 'pre-wrap';
              return span;
            }, { side: 1 });

            return DecorationSet.create(state.doc, [widget]);
          },
        },
        view(editorView: EditorView) {
          return {
            update(view: EditorView, prevState: EditorState) {
              if (!options.enabled) return;
              const rt = getRuntime(view);

              // 持续性抑制（工具栏续写中）→ 完全跳过
              if (rt.continuing) return;

              // 一次性抑制（接受补全后的插入）→ 跳过本次，清除标记
              if (rt.acceptSuppress) {
                rt.acceptSuppress = false;
                return;
              }

              // 只在文档变化或选区变化时触发防抖
              const docChanged = view.state.doc !== prevState.doc;
              const selectionChanged = view.state.selection !== prevState.selection;
              if (!docChanged && !selectionChanged) return;

              // 清除防抖定时器
              if (rt.debounceTimer) {
                clearTimeout(rt.debounceTimer);
                rt.debounceTimer = null;
              }

              // 仅清除补全显示（不中断进行中的 LLM 请求）
              // LLM 响应到达时通过 seq 校验，过期的响应会被丢弃
              // 新请求在 fetchSuggestion 中会中断旧请求
              clearSuggestionDisplay(view);

              // 只有文档变化才触发新的补全请求（单纯移动光标不触发）
              if (!docChanged) return;

              rt.debounceTimer = setTimeout(() => {
                rt.debounceTimer = null;
                fetchSuggestion(view);
              }, options.debounceMs);
            },
            destroy() {
              const rt = getRuntime(editorView);
              if (rt.debounceTimer) {
                clearTimeout(rt.debounceTimer);
                rt.debounceTimer = null;
              }
              if (rt.abortController) {
                rt.abortController.abort();
                rt.abortController = null;
              }
            },
          };
        },
      }),
    ];
  },
});
