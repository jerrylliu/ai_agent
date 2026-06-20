/**
 * GhostSuggestion 扩展测试
 *
 * 验证修复后的防抖逻辑（非流式版本）：
 *   1. 编辑器内容变化后 800ms 触发 requestCompletion
 *   2. 连续打字只触发一次请求（防抖）
 *   3. setContinuing(true) 期间不触发自动补全
 *   4. acceptSuggestion 后不会立即触发新的补全请求（acceptSuppress）
 *   5. 非流式响应显示为幽灵文字
 *   6. Tab 接受补全 → 文本插入文档
 *   7. Escape 清除补全
 *   8. seq 校验：过期响应被丢弃
 *   9. 新请求发送时才中断旧请求
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { GhostSuggestion, setContinuing } from './GhostSuggestion';

// ==================== Mock requestCompletion ====================

// 当前挂起的 resolve，测试用例通过调用它模拟非流式响应
let pendingResolve: ((text: string) => void) | null = null;

vi.mock('@/lib/api', () => ({
  requestCompletion: vi.fn((
    _payload: { mode: string; context: string; instruction?: string },
    _signal?: AbortSignal,
  ): Promise<string> => {
    // 直接返回 Promise（不用 async 包装，减少微任务层级）
    return new Promise<string>((resolve) => {
      pendingResolve = resolve;
    });
  }),
}));

import { requestCompletion } from '@/lib/api';

const mockedRequestCompletion = vi.mocked(requestCompletion);

// ==================== 测试用编辑器组件 ====================

function TestEditor({ onReady }: { onReady: (editor: ReturnType<typeof useEditor>) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      GhostSuggestion.configure({
        enabled: true,
        debounceMs: 800,
      }),
    ],
    content: '',
    immediatelyRender: false,
  });

  if (editor) {
    onReady(editor);
  }

  return <EditorContent editor={editor} />;
}

// ==================== 辅助函数 ====================

function getGhostState(editor: NonNullable<ReturnType<typeof useEditor>>) {
  const pluginState = editor.view.state.plugins
    .find((p) => (p.spec.key as any)?.key === 'ghostSuggestion$')
    ?.getState(editor.view.state);
  return pluginState as { suggestion: string; from: number } | undefined;
}

// ==================== 测试用例 ====================

describe('GhostSuggestion 防抖逻辑（非流式）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockedRequestCompletion.mockClear();
    pendingResolve = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('内容变化后 800ms 触发补全请求', () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('你好世界，这是一段测试文本');

    expect(mockedRequestCompletion).not.toHaveBeenCalled();

    vi.advanceTimersByTime(799);
    expect(mockedRequestCompletion).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockedRequestCompletion).toHaveBeenCalledTimes(1);
    expect(mockedRequestCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'autocomplete' }),
      expect.any(AbortSignal),
    );
  });

  it('连续打字只触发一次请求（防抖）', () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('你好世界，');
    vi.advanceTimersByTime(200);
    editor.commands.insertContent('这是');
    vi.advanceTimersByTime(200);
    editor.commands.insertContent('一段');
    vi.advanceTimersByTime(200);
    editor.commands.insertContent('测试');

    expect(mockedRequestCompletion).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(mockedRequestCompletion).toHaveBeenCalledTimes(1);
  });

  it('setContinuing(true) 期间不触发自动补全', () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    setContinuing(editor.view, true);

    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(1000);
    expect(mockedRequestCompletion).not.toHaveBeenCalled();

    setContinuing(editor.view, false);
    editor.commands.insertContent('继续输入');
    vi.advanceTimersByTime(800);
    expect(mockedRequestCompletion).toHaveBeenCalledTimes(1);
  });

  it('非流式响应显示为幽灵文字', async () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(800);

    expect(mockedRequestCompletion).toHaveBeenCalled();
    expect(pendingResolve).not.toBeNull();

    // 模拟非流式响应返回
    pendingResolve!('，这是补全内容');
    // flush 微任务（Promise.then 回调）
    await Promise.resolve();

    const state = getGhostState(editor);
    expect(state?.suggestion).toBe('，这是补全内容');
  });

  it('Tab 接受补全 → 文本插入文档', async () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(800);

    pendingResolve!('，这是补全内容');
    await Promise.resolve();
    expect(getGhostState(editor)?.suggestion).toBe('，这是补全内容');

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
    editor.view.dom.dispatchEvent(tabEvent);

    const docText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
    expect(docText).toContain('这是补全内容');
    expect(getGhostState(editor)?.suggestion).toBe('');
  });

  it('Escape 清除补全', async () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(800);

    pendingResolve!('，这是补全内容');
    await Promise.resolve();
    expect(getGhostState(editor)?.suggestion).toBe('，这是补全内容');

    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    editor.view.dom.dispatchEvent(escEvent);

    expect(getGhostState(editor)?.suggestion).toBe('');
  });

  it('接受补全后不会立即触发新的补全请求（acceptSuppress）', () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(800);

    pendingResolve!('，补全');
    expect(mockedRequestCompletion).toHaveBeenCalledTimes(1);

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
    editor.view.dom.dispatchEvent(tabEvent);

    vi.advanceTimersByTime(1000);
    expect(mockedRequestCompletion).toHaveBeenCalledTimes(1);
  });

  it('光标移动后丢弃补全响应', () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(800);

    expect(pendingResolve).not.toBeNull();

    // 移动光标到文档开头
    editor.commands.setTextSelection(0);

    // 此时响应返回 → 应被丢弃（光标位置已变）
    pendingResolve!('，补全内容');

    const state = getGhostState(editor);
    expect(state?.suggestion).toBe('');
  });

  it('打字后旧请求的过期响应通过 seq 校验丢弃', async () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(800);

    expect(mockedRequestCompletion).toHaveBeenCalledTimes(1);
    expect(pendingResolve).not.toBeNull();
    const firstResolve = pendingResolve;

    // 用户继续打字 → 触发防抖
    editor.commands.insertContent('继续');

    // 防抖结束后发送新请求 → 旧请求被中断
    vi.advanceTimersByTime(800);
    expect(mockedRequestCompletion).toHaveBeenCalledTimes(2);

    // 旧请求 resolve（模拟 abort 后仍返回的极端情况）
    // seq 已不匹配，应被丢弃
    firstResolve!('，过期补全');
    await Promise.resolve();

    const state = getGhostState(editor);
    expect(state?.suggestion).toBe('');

    // 新请求 resolve → 正常显示
    pendingResolve!('，新补全');
    await Promise.resolve();
    const state2 = getGhostState(editor);
    expect(state2?.suggestion).toBe('，新补全');
  });

  it('新请求发送时中断旧请求', () => {
    let editorRef: NonNullable<ReturnType<typeof useEditor>> | null = null;
    render(<TestEditor onReady={(e) => { editorRef = e; }} />);

    const editor = editorRef!;
    editor.commands.insertContent('这是一段测试文本');
    vi.advanceTimersByTime(800);

    expect(mockedRequestCompletion).toHaveBeenCalledTimes(1);
    const firstSignal = mockedRequestCompletion.mock.calls[0][1] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    // 用户继续打字 → 旧请求未被中断（仅清除显示）
    editor.commands.insertContent('继续');
    expect(firstSignal.aborted).toBe(false);

    // 防抖结束后发送新请求 → 旧请求被中断
    vi.advanceTimersByTime(800);
    expect(mockedRequestCompletion).toHaveBeenCalledTimes(2);
    expect(firstSignal.aborted).toBe(true);
  });
});
