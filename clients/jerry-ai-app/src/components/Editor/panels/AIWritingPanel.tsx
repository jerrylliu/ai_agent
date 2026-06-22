/**
 * AIWritingPanel - AI 写作面板
 *
 * 职责：
 *   - 提供基于全文的 AI 快捷指令：润色 / 总结 / 翻译 / 续写大纲
 *   - 支持自定义指令输入
 *   - 流式输出到面板预览区，用户可"插入到光标"或"替换全文"
 *
 * 设计要点：
 *   - 复用后端 /ai/completion (SSE) 接口，不新建后端端点
 *   - 生成期间通过 setGhostContinuing 抑制幽灵补全，避免冲突
 *   - 不引入 markdown 解析器（marked 未安装），AI 输出按换行拆分为段落插入
 *   - 与 KnowledgePanel 共用右侧面板区域，通过 Tabs 切换
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sparkles, PenLine, FileText, Languages, ListTree,
  Square, Copy, CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requestCompletionStream, type CompletionMode } from '@/lib/api';
import { setContinuing as setGhostContinuing } from '../extensions/GhostSuggestion';
import { cn } from '@/utils/index';

export interface AIWritingPanelProps {
  /** 编辑器实例 */
  editor: Editor | null;
}

/** 快捷指令类型 */
type QuickAction = 'polish' | 'summarize' | 'translate' | 'outline';

/** 快捷指令配置 */
const QUICK_ACTIONS: Record<QuickAction, {
  label: string;
  icon: typeof PenLine;
  mode: CompletionMode;
  instruction: string;
}> = {
  polish: {
    label: '润色',
    icon: PenLine,
    mode: 'rewrite',
    instruction: '润色全文，使其更流畅、更专业，保持原意不变',
  },
  summarize: {
    label: '总结',
    icon: FileText,
    mode: 'rewrite',
    instruction: '用 200 字以内总结全文要点',
  },
  translate: {
    label: '翻译',
    icon: Languages,
    mode: 'rewrite',
    instruction: '将全文翻译成英文，保持原意',
  },
  outline: {
    label: '续写',
    icon: ListTree,
    mode: 'continue',
    instruction: '',
  },
};

const QUICK_ACTION_ORDER: QuickAction[] = ['polish', 'summarize', 'translate', 'outline'];

/** 生成状态 */
type GenStatus = 'idle' | 'generating' | 'done' | 'error';

export function AIWritingPanel({ editor }: AIWritingPanelProps) {
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<GenStatus>('idle');
  const [activeAction, setActiveAction] = useState<QuickAction | null>(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // 输出区滚动容器（用于自动滚动到底）
  const outputRef = useRef<HTMLDivElement>(null);

  // 内联 toast
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

  /**
   * 从编辑器提取全文纯文本
   * 递归遍历 Tiptap JSONContent，块级节点之间补换行
   */
  const extractFullText = useCallback((node: JSONContent): string => {
    if (!node) return '';
    if (node.type === 'text') return node.text ?? '';
    const blockTypes = new Set([
      'paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'taskItem',
    ]);
    const childTexts = (node.content ?? []).map(extractFullText);
    const joined = childTexts.join('');
    return blockTypes.has(node.type ?? '') ? joined + '\n' : joined;
  }, []);

  /**
   * 执行 AI 写作请求
   * @param mode 补全模式
   * @param instruction 指令（rewrite 模式用）
   * @param actionLabel 用于 toast 反馈的标签
   */
  const runGeneration = useCallback(async (
    mode: CompletionMode,
    instruction: string,
    actionLabel: string,
  ) => {
    if (!editor) {
      console.warn('[AIWritingPanel] runGeneration 跳过：editor 为空');
      return;
    }

    // 生成中再次点击 → 取消
    if (status === 'generating') {
      console.log('[AIWritingPanel] 用户取消生成', { actionLabel });
      if (abortRef.current) abortRef.current.abort();
      setStatus('idle');
      setActiveAction(null);
      setGhostContinuing(editor.view, false);
      abortRef.current = null;
      showToast(true, '已停止生成');
      return;
    }
    // 获取全文
    const fullText = extractFullText(editor.getJSON()).trim();
    if (!fullText) {
      console.warn('[AIWritingPanel] 文档为空，无法执行 AI 写作', { actionLabel });
      showToast(false, '文档为空，无法执行 AI 写作');
      return;
    }

    console.log('[AIWritingPanel] 开始 AI 写作', {
      actionLabel,
      mode,
      instructionLength: instruction.length,
      contextLength: fullText.length,
    });

    setStatus('generating');
    setOutput('');
    setErrorMsg('');
    setGhostContinuing(editor.view, true);

    const ac = new AbortController();
    abortRef.current = ac;
    const startTime = Date.now();
    let deltaCount = 0;
    let totalLength = 0;

    try {
      await requestCompletionStream(
        { mode, context: fullText, instruction: instruction || undefined },
        (delta) => {
          deltaCount += 1;
          totalLength += delta.length;
          setOutput((prev) => prev + delta);
        },
        ac.signal,
      );
      console.log('[AIWritingPanel] AI 写作完成', {
        actionLabel,
        deltaCount,
        totalLength,
        durationMs: Date.now() - startTime,
      });
      setStatus('done');
      setActiveAction(null);
      showToast(true, `${actionLabel}完成`);
    } catch (err) {
      const isAbort = (err as Error)?.name === 'AbortError' || ac.signal.aborted;
      if (isAbort) {
        console.log('[AIWritingPanel] AI 写作被中断', {
          actionLabel,
          deltaCount,
          totalLength,
          durationMs: Date.now() - startTime,
        });
      } else {
        const errMsg = (err as Error)?.message || `${actionLabel}失败`;
        console.error('[AIWritingPanel] AI 写作失败', {
          actionLabel,
          error: errMsg,
          deltaCount,
          totalLength,
          durationMs: Date.now() - startTime,
        });
        setStatus('error');
        setActiveAction(null);
        setErrorMsg(errMsg);
        showToast(false, errMsg);
      }
    } finally {
      // 注意：catch 分支 isAbort 时不重置 status，因为停止按钮已主动设置过；
      // 这里仅清理副作用资源
      setGhostContinuing(editor.view, false);
      abortRef.current = null;
    }
  }, [editor, status, extractFullText]);

  /** 自动滚动输出区到底 */
  useEffect(() => {
    if (status === 'generating' && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, status]);

  /** 点击快捷指令 */
  const handleQuickAction = useCallback((action: QuickAction) => {
    const config = QUICK_ACTIONS[action];
    console.log('[AIWritingPanel] 点击快捷指令', { action, label: config.label });
    setActiveAction(action);
    void runGeneration(config.mode, config.instruction, config.label);
  }, [runGeneration]);

  /** 执行自定义指令 */
  const handleCustomExecute = useCallback(() => {
    const trimmed = customInstruction.trim();
    if (!trimmed) {
      console.warn('[AIWritingPanel] 自定义指令为空，跳过');
      return;
    }
    console.log('[AIWritingPanel] 执行自定义指令', { instructionLength: trimmed.length });
    setActiveAction(null);
    void runGeneration('rewrite', trimmed, '自定义指令');
  }, [customInstruction, runGeneration]);

  /** 将文本按换行拆分为 Tiptap 段落数组 */
  const textToParagraphs = useCallback((text: string): JSONContent[] => {
    const lines = text.split('\n').filter((line) => line.trim());
    if (lines.length === 0) {
      return [{ type: 'paragraph' }];
    }
    return lines.map((line) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    }));
  }, []);

  /** 插入到光标位置 */
  const handleInsertAtCursor = useCallback(() => {
    if (!editor || !output) {
      console.warn('[AIWritingPanel] 插入到光标失败：editor 或 output 为空');
      return;
    }
    const paragraphs = textToParagraphs(output);
    console.log('[AIWritingPanel] 插入到光标', { paragraphCount: paragraphs.length, outputLength: output.length });
    editor.chain().focus().insertContent(paragraphs).run();
    showToast(true, '已插入到光标位置');
  }, [editor, output, textToParagraphs]);

  /** 替换全文（破坏性操作，需二次确认） */
  const handleReplaceAll = useCallback(() => {
    if (!editor || !output) {
      console.warn('[AIWritingPanel] 替换全文失败：editor 或 output 为空');
      return;
    }
    // 二次确认：避免误操作覆盖现有文档
    const confirmed = window.confirm(
      '此操作将覆盖当前文档的全部内容，且无法撤销（保存后将永久丢失原内容）。\n\n确定要替换全文吗？',
    );
    if (!confirmed) {
      console.log('[AIWritingPanel] 用户取消替换全文');
      return;
    }
    const paragraphs = textToParagraphs(output);
    console.log('[AIWritingPanel] 替换全文', { paragraphCount: paragraphs.length, outputLength: output.length });
    const doc: JSONContent = {
      type: 'doc',
      content: paragraphs,
    };
    editor.commands.setContent(doc);
    showToast(true, '已替换全文');
  }, [editor, output, textToParagraphs]);

  /** 复制到剪贴板 */
  const handleCopy = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      console.log('[AIWritingPanel] 复制到剪贴板成功', { length: output.length });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showToast(true, '已复制到剪贴板');
    } catch (err) {
      console.error('[AIWritingPanel] 复制到剪贴板失败', err);
      showToast(false, '复制失败');
    }
  }, [output]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const isGenerating = status === 'generating';

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 标题 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Sparkles className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">AI 写作</span>
      </div>

      {/* 快捷指令 */}
      <div className="p-3 border-b border-border space-y-2">
        <div className="text-xs text-muted-foreground">快捷指令</div>
        <div className="grid grid-cols-4 gap-1.5">
          {QUICK_ACTION_ORDER.map((action) => {
            const config = QUICK_ACTIONS[action];
            const Icon = config.icon;
            const isActive = activeAction === action && isGenerating;
            return (
              <Button
                key={action}
                variant="outline"
                size="sm"
                className="h-auto flex-col gap-1 py-2 text-xs"
                disabled={isGenerating && !isActive}
                onClick={() => handleQuickAction(action)}
              >
                <Icon className="h-4 w-4" />
                <span>{config.label}</span>
              </Button>
            );
          })}
        </div>

        {/* 自定义指令 */}
        <div className="text-xs text-muted-foreground pt-1">自定义指令</div>
        <div className="flex gap-1.5">
          <Input
            value={customInstruction}
            onChange={(e) => setCustomInstruction(e.target.value)}
            placeholder="例如：把全文改成口语化"
            className="h-8 text-sm"
            disabled={isGenerating}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomExecute();
            }}
          />
          <Button
            variant="default"
            size="sm"
            className="h-8 shrink-0"
            disabled={isGenerating || !customInstruction.trim()}
            onClick={handleCustomExecute}
          >
            执行
          </Button>
        </div>
      </div>

      {/* 生成结果区 */}
      <div className="flex-1 overflow-y-auto p-3">
        {status === 'idle' && !output && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-8">
            <Sparkles className="h-8 w-8 opacity-40" />
            <span className="text-xs">选择快捷指令或输入自定义指令</span>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center justify-center h-full text-destructive gap-2 py-8">
            <AlertCircle className="h-8 w-8 opacity-60" />
            <span className="text-xs">{errorMsg}</span>
          </div>
        )}

        {output && (
          <div className="space-y-3">
            {/* 流式输出区域（生成期间自动滚动到底） */}
            <div
              ref={outputRef}
              className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed whitespace-pre-wrap max-h-[50vh] overflow-y-auto"
            >
              {output}
              {isGenerating && (
                <Loader2 className="inline-block h-3 w-3 ml-1 animate-spin text-muted-foreground" />
              )}
            </div>

            {/* 操作按钮 */}
            {!isGenerating && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={handleInsertAtCursor}
                  disabled={!editor}
                >
                  <PenLine className="h-3 w-3" />
                  插入到光标
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={handleReplaceAll}
                  disabled={!editor}
                >
                  <FileText className="h-3 w-3" />
                  替换全文
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copied ? '已复制' : '复制'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 生成中停止按钮 */}
      {isGenerating && (
        <div className="p-3 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5"
            onClick={() => {
              console.log('[AIWritingPanel] 用户点击停止按钮');
              if (abortRef.current) abortRef.current.abort();
              setStatus('done');
              setActiveAction(null);
              if (editor) setGhostContinuing(editor.view, false);
              abortRef.current = null;
              showToast(true, '已停止生成');
            }}
          >
            <Square className="h-3.5 w-3.5" />
            停止生成
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
    </div>
  );
}
