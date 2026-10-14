/**
 * AIWritingPanel - AI 写作面板
 *
 * 职责：
 *   - 提供基于全文的 AI 快捷指令：润色 / 总结 / 翻译 / 续写大纲
 *   - 支持自定义指令输入
 *   - 流式输出到面板预览区，用户可"插入到光标"或"替换全文"
 *   - 表格文档的自定义指令自动分流为"AI 表格指令"（M2 指令下推）：
 *     服务端 LLM 解析意图 + 代码精确执行，报告确认后应用回表格
 *
 * 设计要点：
 *   - 复用后端 /ai/completion (SSE) 接口做普通写作；表格指令走
 *     POST /documents/table-ops（非流式，结果需确认应用）
 *   - 生成期间通过 setGhostContinuing 抑制幽灵补全，避免冲突
 *   - 不引入 markdown 解析器（marked 未安装），AI 输出按换行拆分为段落插入
 *   - 与 KnowledgePanel 共用右侧面板区域，通过 Tabs 切换
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sparkles, PenLine, FileText, Languages, ListTree,
  Square, Copy, CheckCircle2, AlertCircle, Loader2,
  Table2, RotateCcw, Wand2, Lightbulb, Brain, Zap, ArrowRight, HelpCircle,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  requestCompletionStream,
  runTableOps,
  confirmTableOps,
  startSemanticFillTask,
  getSemanticFillStatus,
  cancelSemanticFillTask,
  batchCreateTableRules,
  type CompletionMode,
  type TableOpsReportItem,
  type TableOpsProgressEvent,
  type SemanticFillMappingResult,
  type SemanticFillBatchQuote,
  type SemanticFillTaskStatus,
  type SemanticFillSuggestRule,
  type ClarifyPayload,
  type ClarifyStrategy,
  type ClarifyStrategyOption,
} from '@/lib/api';
import {
  docContainsTable,
  isSheetStructuredText,
  sheetTextToTableDoc,
  tableDocToSheetText,
} from '@/lib/table-convert';
import { setContinuing as setGhostContinuing } from '../extensions/GhostSuggestion';
import { cn } from '@/utils/index';

export interface AIWritingPanelProps {
  /** 编辑器实例 */
  editor: Editor | null;
  /**
   * 已保存文档的 ID（可选）：传入后 AI 表格指令/语义填充的执行结果
   * 先过该文档的启用表格规则（功能 5 规则门禁），违规整体拒绝；
   * 同时语义填充的规则提议才能入库（未保存文档没有规则归属）
   */
  documentId?: number;
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

/** 分批填充任务 ID 本地持久化 key：刷新页面后凭此重连任务进度（方案定稿；服务重启任务作废） */
const SEMANTIC_FILL_TASK_KEY = 'miaoma_semantic_fill_task';

export function AIWritingPanel({ editor, documentId }: AIWritingPanelProps) {
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<GenStatus>('idle');
  const [activeAction, setActiveAction] = useState<QuickAction | null>(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // ==================== AI 表格指令状态（M2 指令下推） ====================
  /**
   * 当前文档是否含表格（决定自定义指令走普通写作还是表格指令路径 + 提示条显隐）。
   * 用 state + editor 'update' 订阅而非 useMemo([editor])——memo 只在 editor
   * 实例变化时重算，用户手动插入/删除表格后 hint 与路由判定会停留在旧值。
   */
  const [hasTable, setHasTable] = useState(false);
  useEffect(() => {
    if (!editor) {
      setHasTable(false);
      return;
    }
    const update = () => setHasTable(docContainsTable(editor.getJSON()));
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);
  /** 表格指令执行中 */
  const [tableRunning, setTableRunning] = useState(false);
  /**
   * 表格指令执行结果（待用户确认应用）。
   * baseSheetText 为执行时的表格快照，用于并发编辑守卫；null = 刷新重连等
   * 拿不到快照的场景（应用时直接走二次确认）。
   * semanticFill 为语义填充映射路径结果（有值时展示映射明细与规则提议卡片）。
   */
  const [tableResult, setTableResult] = useState<{
    sheetText: string;
    baseSheetText: string | null;
    report: TableOpsReportItem[];
    semanticFill?: SemanticFillMappingResult;
    /** ReAct 循环的整体结果总结（模型产出，展示在报告顶部） */
    summary?: string;
  } | null>(null);
  /** 表格指令失败信息 */
  const [tableError, setTableError] = useState('');
  /**
   * ReAct 循环实时过程（SSE progress 事件累积）：模型判断 / 正在执行的操作 /
   * 执行观察。执行中实时滚动，完成后保留在报告上方（用户能看到 AI 用了哪些命令）
   */
  const [tableSteps, setTableSteps] = useState<TableOpsProgressEvent[]>([]);

  // ==================== clarify 反问确认状态（两阶段交互） ====================
  /**
   * 待确认的反问载荷（null = 无）。confirm 时必须原样回传（含 baseSheetText
   * 执行基底与 hash），服务端据此 TOCTOU 校验与确定性编译
   */
  const [clarify, setClarify] = useState<ClarifyPayload | null>(null);
  /** clarify 确认执行中（SSE 过程复用 tableSteps 展示） */
  const [clarifyRunning, setClarifyRunning] = useState(false);
  /** 每列用户选定的策略（fill-source 多列分组按列单选；其他场景单组） */
  const [clarifySelections, setClarifySelections] = useState<Record<string, ClarifyStrategy | null>>({});
  /** fill-constant 自定义值输入（column → 用户输入，空时回落到策略自带 value） */
  const [constantInputs, setConstantInputs] = useState<Record<string, string>>({});
  /** 最近一次表格指令原文（confirm 转 AI 映射预览时作映射提示） */
  const lastTableInstructionRef = useRef('');

  // ==================== 语义填充分批任务状态（功能 4） ====================
  /** 分批报价（path=batch，待用户确认后创建任务）；baseSheetText/instruction 供 start 复用 */
  const [fillQuote, setFillQuote] = useState<{
    quote: SemanticFillBatchQuote;
    baseSheetText: string;
    instruction: string;
  } | null>(null);
  /** 分批任务信息（running 展示进度；终态由 consumeTerminalFillTask 转入确认流后清空） */
  const [fillTask, setFillTask] = useState<SemanticFillTaskStatus | null>(null);
  /** 任务发起时的表格快照（应用守卫用）；刷新重连时为 null */
  const fillBaseRef = useRef<string | null>(null);
  /** 进度轮询定时器（终态/卸载时清理） */
  const fillPollTimerRef = useRef<number | null>(null);
  /** 轮询函数自引用句柄（setTimeout 递归轮询用） */
  const pollFillTaskRef = useRef<(taskId: string) => void>(() => {});
  /** 轮询会话令牌：新轮询开始即递增，旧会话不再续期（防重复定时器） */
  const pollSessionRef = useRef(0);
  /** 刷新重连 effect 只执行一次的守卫（deps 回调意外变化时避免重复拉取） */
  const fillReconnectDoneRef = useRef(false);
  /** AI 规则提议入库中（防重复提交） */
  const [suggestRuleSaving, setSuggestRuleSaving] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // 输出区滚动容器（用于自动滚动到底）
  const outputRef = useRef<HTMLDivElement>(null);

  // 内联 toast
  const [toast, setToast] = useState<{ show: boolean; success: boolean; message: string }>({
    show: false, success: false, message: '',
  });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 用 useCallback 固定引用：语义填充的轮询/重连回调依赖它做依赖稳定性（避免 effect 反复重跑）
  const showToast = useCallback((success: boolean, message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ show: true, success, message });
    toastTimerRef.current = setTimeout(() => {
      setToast({ show: false, success, message: '' });
      toastTimerRef.current = null;
    }, 2500);
  }, []);

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

  // ==================== AI 表格指令（M2 指令下推） ====================

  /**
   * 执行 AI 表格指令：编辑器表格 → sheet 文本 → 服务端解析+精确执行 → 报告待确认。
   * 失败（网络/解析/引用校验）一律在此兜底展示，不影响编辑器内容。
   */
  const handleTableOpsExecute = useCallback(async () => {
    if (!editor) return;
    const trimmed = customInstruction.trim();
    if (!trimmed) return;

    // 分批填充任务进行中时不接受新表格指令（服务端也有并发上限，这里提前拦截给明确提示）
    if (fillTask && fillTask.status === 'running') {
      showToast(false, '有填充任务进行中，请等待完成或取消后再执行新指令');
      return;
    }

    // 序列化当前表格数据（含未保存编辑，与用户所见一致）
    const sheetText = tableDocToSheetText(editor.getJSON());
    if (!sheetText) {
      console.warn('[AIWritingPanel] 表格数据序列化失败，无法执行表格指令');
      showToast(false, '无法提取表格数据，请重试');
      return;
    }

    // 结构守卫（宁可不执行，不可执行坏）：
    //   1. apply 路径（sheetTextToTableDoc）只认 `Sheet:` 标题结构——手动插入的
    //      散表（无标题）转回时会被降级为段落，表格结构被破坏，必须拦截；
    //   2. 混合文档中表格之间的散文行会被执行器当作数据行读写，语义不符
    //      （与 M1 xlsx 导出"散行归 Sheet1"一致，但 AI 指令会真正改动它们）
    if (!isSheetStructuredText(sheetText)) {
      console.warn('[AIWritingPanel] 非 sheet 结构化文本，拦截表格指令', { length: sheetText.length });
      showToast(false, 'AI 表格指令仅支持 Excel 上传生成的表格文档，当前文档结构不符合');
      return;
    }

    console.log('[AIWritingPanel] 执行 AI 表格指令', {
      instructionLength: trimmed.length,
      sheetTextLength: sheetText.length,
    });

    setTableRunning(true);
    setTableError('');
    setTableResult(null);
    setTableSteps([]);
    setFillQuote(null);
    setClarify(null);
    setClarifySelections({});
    setConstantInputs({});
    lastTableInstructionRef.current = trimmed;

    try {
      const result = await runTableOps(
        {
          instruction: trimmed,
          sheetText,
          // 已保存文档传入后执行结果过规则门禁（功能 5）；未保存文档无规则可查
          ...(documentId !== undefined ? { documentId } : {}),
        },
        // ReAct 循环逐轮进度（"正在使用加法求和计算……"）实时上屏
        (event) => setTableSteps((prev) => [...prev, event]),
      );
      if (!result.ok) {
        // 业务级失败（指令无法理解/引用不存在/护栏拦截/规则门禁拒绝）：服务端已返回可读原因
        const msg = result.message ?? '表格指令执行失败';
        console.warn('[AIWritingPanel] 表格指令被拒绝', { message: msg });
        setTableError(msg);
        showToast(false, msg);
        return;
      }

      // clarify 反问（两阶段交互第一阶段）：指令的数据依赖参数不明，服务端
      // 未修改任何数据——渲染确认卡，用户选定策略后走 confirmTableOps
      if (result.clarify) {
        setClarify(result.clarify);
        setClarifySelections({});
        setConstantInputs({});
        showToast(true, 'AI 需要你确认处理策略，请在下方选择');
        return;
      }

      // 语义填充分批报价：服务端未执行，转入报价确认态——用户确认后才创建任务
      if (result.semanticFill && result.semanticFill.path === 'batch') {
        setFillQuote({ quote: result.semanticFill, baseSheetText: sheetText, instruction: trimmed });
        showToast(true, '该列取值较杂，请确认分批填充方案');
        return;
      }

      // ok 必有 sheetText 与 report（类型上 optional，运行时由后端保证，仍做兜底）
      const nextText = result.sheetText ?? '';
      if (!nextText) {
        setTableError('服务端返回内容为空，请重试');
        showToast(false, '服务端返回内容为空，请重试');
        return;
      }
      setTableResult({
        sheetText: nextText,
        baseSheetText: sheetText,
        report: result.report ?? [],
        semanticFill:
          result.semanticFill && result.semanticFill.path === 'mapping'
            ? result.semanticFill
            : undefined,
        summary: result.summary,
      });
      showToast(true, '执行完成，请确认后应用');
    } catch (err) {
      const msg = (err as Error)?.message || '表格指令执行失败';
      console.error('[AIWritingPanel] 表格指令请求失败', err);
      setTableError(msg);
      showToast(false, msg);
    } finally {
      setTableRunning(false);
    }
  }, [editor, customInstruction, documentId, fillTask]);

  /** 应用表格指令结果：新文本转回表格节点替换编辑器内容（Ctrl+Z 可撤销） */
  const handleApplyTableOps = useCallback(() => {
    if (!editor || !tableResult) return;
    try {
      // 并发编辑守卫：执行结果基于执行时的表格快照，若用户在等待确认期间
      // 又改了表格，直接应用会覆盖那些修改——需二次确认。
      // baseSheetText 为 null（刷新重连拿不到快照）时无法比对，一律走二次确认
      const currentText = tableDocToSheetText(editor.getJSON());
      if (currentText !== null && currentText !== tableResult.baseSheetText) {
        const confirmed = window.confirm(
          '表格在指令执行后又被手动修改过，应用结果将覆盖这些修改。\n\n确定要应用吗？',
        );
        if (!confirmed) return;
      }

      const { doc: newDoc, degraded } = sheetTextToTableDoc(tableResult.sheetText);
      if (degraded) {
        // 转换层自检失败降级为纯文本——不强写进编辑器，避免用户表格被降级
        showToast(false, '结果未能转换为表格，已放弃应用，请重试');
        setTableResult(null);
        return;
      }
      editor.commands.setContent(newDoc);
      setTableResult(null);
      setTableError('');
      showToast(true, '已应用到表格，Ctrl+Z 可撤销');
    } catch (err) {
      console.error('[AIWritingPanel] 应用表格指令结果失败', err);
      showToast(false, '应用失败：结果内容无法解析');
    }
  }, [editor, tableResult]);

  /** 放弃表格指令结果 */
  const handleDiscardTableOps = useCallback(() => {
    setTableResult(null);
    setTableError('');
  }, []);

  // ==================== clarify 反问确认（两阶段交互第二阶段入口） ====================

  /** 放弃 clarify 反问（不执行任何操作，表格保持不变） */
  const handleClarifyDismiss = useCallback(() => {
    setClarify(null);
    setClarifySelections({});
    setConstantInputs({});
  }, []);

  /**
   * 提交 clarify 确认：收集各列选定的策略 → confirmTableOps（服务端编译为
   * 确定性 ops，全程无 LLM）→ 结果转回表格指令确认流（tableResult）。
   * AI 映射策略会二次返回 clarify（语义填充预览），此时更新载荷再走一轮确认。
   */
  const handleClarifyConfirm = useCallback(async () => {
    if (!clarify) return;

    // 渲染分组：fill-source 多列按列分组；其余场景顶层选项合并为一组
    const groups = clarify.columns?.length
      ? clarify.columns
      : clarify.options?.length
        ? [{ column: clarify.kind, gapCount: clarify.affectedCount ?? 0, candidates: clarify.options }]
        : [];

    // 收集策略：每列已选项；fill-constant 用输入框的值覆盖策略自带 value
    const strategies: ClarifyStrategy[] = [];
    for (const g of groups) {
      const s = clarifySelections[g.column];
      if (!s) continue;
      if (s.type === 'fill-constant') {
        const value = (constantInputs[g.column] ?? s.value ?? '').trim();
        if (!value) {
          showToast(false, `列「${g.column}」选择了固定值填充，请先填写要填充的值`);
          return;
        }
        strategies.push({ ...s, value });
      } else {
        strategies.push(s);
      }
    }
    if (strategies.length === 0) {
      showToast(false, '请先选择处理策略');
      return;
    }

    // TOCTOU 校验基于编辑器**实时文本**（含未保存的手改）：
    //   - 无前缀 op（baseOps 空）：实时文本就是执行基底，服务端 hash 比对直接
    //     拦截卡片停留期间的编辑（与是否保存无关）；
    //   - 有前缀 op（ReAct 中途反问）：执行基底必须是中间态 baseSheetText
    //     （编辑器里没有），实时文本经 liveSheetText 附带，服务端凭
    //     originSheetTextHash 校验原文未变。
    const liveText = tableDocToSheetText(editor?.getJSON() ?? { type: 'doc', content: [] }) ?? '';
    const hasPrefixOps = (clarify.baseOps?.length ?? 0) > 0;
    const baseText = hasPrefixOps ? (clarify.baseSheetText ?? '') : liveText;
    if (!baseText) {
      showToast(false, hasPrefixOps ? '执行基底丢失，请重新发起指令' : '未能读取表格内容，请重新发起指令');
      return;
    }

    setClarifyRunning(true);
    setTableError('');
    setTableResult(null);
    setTableSteps([]);

    try {
      const result = await confirmTableOps(
        {
          sheetText: baseText,
          sheetTextHash: clarify.baseSheetTextHash ?? '',
          // 实时文本：服务端凭 originSheetTextHash 检测卡片停留期间的编辑
          ...(clarify.originSheetTextHash !== undefined ? { liveSheetText: liveText } : {}),
          clarify,
          strategies,
          // 原始指令（AI 映射策略转语义填充预览时作映射提示）
          instruction: lastTableInstructionRef.current || clarify.question,
          ...(documentId !== undefined ? { documentId } : {}),
        },
        (event) => setTableSteps((prev) => [...prev, event]),
      );
      if (!result.ok) {
        const msg = result.message ?? '确认执行失败';
        console.warn('[AIWritingPanel] clarify 确认被拒绝', { message: msg });
        setTableError(msg);
        showToast(false, msg);
        return;
      }

      // AI 映射策略 → 语义填充预览（二次确认）：更新载荷再走一轮确认
      if (result.clarify) {
        setClarify(result.clarify);
        setClarifySelections({});
        setConstantInputs({});
        showToast(true, '已生成 AI 映射预览，请确认后继续');
        return;
      }

      const nextText = result.sheetText ?? '';
      // 全部选择"跳过/保留空缺"：表格不变，直接收尾
      if (!nextText || nextText === baseText) {
        setClarify(null);
        setClarifySelections({});
        setConstantInputs({});
        showToast(true, result.message ?? '已按你的选择跳过，表格保持不变');
        return;
      }
      setClarify(null);
      setClarifySelections({});
      setConstantInputs({});
      setTableResult({
        sheetText: nextText,
        baseSheetText: baseText,
        report: result.report ?? [],
        summary: result.summary,
      });
      showToast(true, '执行完成，请确认后应用');
    } catch (err) {
      const msg = (err as Error)?.message || '确认执行失败';
      console.error('[AIWritingPanel] clarify 确认请求失败', err);
      setTableError(msg);
      showToast(false, msg);
    } finally {
      setClarifyRunning(false);
    }
  }, [clarify, clarifySelections, constantInputs, documentId, editor, showToast]);

  // ==================== 语义填充分批任务（功能 4） ====================

  /** 停止进度轮询（清定时器） */
  const stopFillPolling = useCallback(() => {
    if (fillPollTimerRef.current !== null) {
      clearTimeout(fillPollTimerRef.current);
      fillPollTimerRef.current = null;
    }
  }, []);

  /**
   * 消费终态任务：清理轮询与本地持久化，转入确认应用流或报错。
   * 有 filledText（done，或 failed/cancelled 但已有部分完成批次）→ 进 tableResult 确认流；
   * 无 filledText → 仅展示错误/取消提示
   */
  const consumeTerminalFillTask = useCallback(
    (t: SemanticFillTaskStatus) => {
      stopFillPolling();
      localStorage.removeItem(SEMANTIC_FILL_TASK_KEY);
      setFillTask(null);
      if (t.filledText) {
        const report: TableOpsReportItem[] = [
          {
            type: 'semanticFill',
            targetSheet: '',
            message:
              t.status === 'done'
                ? `分批填充完成：${t.completedBatches}/${t.batchCount} 批，共填充 ${t.appliedRows} 个单元格`
                : `任务${t.status === 'cancelled' ? '已取消' : '失败'}：已完成 ${t.completedBatches}/${t.batchCount} 批、填充 ${t.appliedRows} 个单元格，可应用已完成的部分`,
          },
        ];
        if (t.error) {
          report.push({ type: 'semanticFill', targetSheet: '', message: `原因：${t.error}` });
        }
        setTableResult({
          sheetText: t.filledText,
          // fillBaseRef 为任务发起时的快照；刷新重连场景为 null → 应用守卫走二次确认
          baseSheetText: fillBaseRef.current,
          report,
        });
        showToast(true, '填充完成，请确认后应用');
      } else if (t.status === 'cancelled') {
        setTableError('任务已取消，未产生可应用的填充结果');
        showToast(false, '任务已取消，未产生可应用的填充结果');
      } else {
        const msg = t.error || '填充任务失败';
        setTableError(msg);
        showToast(false, msg);
      }
    },
    [showToast, stopFillPolling],
  );

  /**
   * 轮询填充任务进度：running 则 2s 后续轮；终态转 consumeTerminalFillTask；
   * 网络抖动 3s 后重试（任务仍在服务端执行，不轻易终止轮询）。
   * 任务不存在（found:false）= 服务已重启/任务过期 → 清本地 key 并提示重新发起
   */
  const pollFillTask = useCallback(
    (taskId: string) => {
      // 会话令牌：新轮询开始即作废旧会话，旧会话的续期定时器全部失效（防重复轮询）
      const session = ++pollSessionRef.current;
      stopFillPolling();
      void (async () => {
        try {
          const res = await getSemanticFillStatus(taskId);
          if (!res.found || !res.task) {
            localStorage.removeItem(SEMANTIC_FILL_TASK_KEY);
            setFillTask(null);
            showToast(false, '填充任务已失效（服务可能已重启），请重新发起填充');
            return;
          }
          const t = res.task;
          if (t.status === 'running') {
            setFillTask({ ...t });
            if (pollSessionRef.current === session) {
              fillPollTimerRef.current = window.setTimeout(() => pollFillTaskRef.current(taskId), 2000);
            }
            return;
          }
          consumeTerminalFillTask(t);
        } catch (err) {
          console.error('[AIWritingPanel] 轮询填充任务失败，稍后重试', err);
          if (pollSessionRef.current === session) {
            fillPollTimerRef.current = window.setTimeout(() => pollFillTaskRef.current(taskId), 3000);
          }
        }
      })();
    },
    [consumeTerminalFillTask, showToast, stopFillPolling],
  );

  // 轮询函数自引用（setTimeout 递归轮询用）
  useEffect(() => {
    pollFillTaskRef.current = pollFillTask;
  }, [pollFillTask]);

  /** 确认分批报价 → 创建填充任务并开始轮询 */
  const handleStartFillTask = useCallback(async () => {
    if (!fillQuote) return;
    // 兜底：已有任务在跑时不重复创建（服务端也有并发上限）
    if (fillTask && fillTask.status === 'running') {
      showToast(false, '有填充任务进行中，请等待完成或取消后再发起新任务');
      return;
    }
    try {
      const res = await startSemanticFillTask({
        instruction: fillQuote.instruction,
        sheetText: fillQuote.baseSheetText,
        targetColumn: fillQuote.quote.targetColumn,
        hintColumns: fillQuote.quote.hintColumns,
        // 多 sheet/跨表场景原样回传（报价时后端已带出），否则任务会落到第一张表
        ...(fillQuote.quote.targetSheet !== undefined
          ? { targetSheet: fillQuote.quote.targetSheet }
          : {}),
        ...(fillQuote.quote.referenceSheet !== undefined
          ? { referenceSheet: fillQuote.quote.referenceSheet }
          : {}),
        // 已保存文档传入后任务终态结果过规则门禁（功能 5）；未保存文档无规则可查
        ...(documentId !== undefined ? { documentId } : {}),
      });
      // 记录任务发起时的表格快照供应用守卫比对；刷新重连场景拿不到即为 null
      fillBaseRef.current = fillQuote.baseSheetText;
      setFillQuote(null);
      setFillTask({
        taskId: res.taskId,
        status: 'running',
        targetColumn: res.targetColumn,
        hintColumns: res.hintColumns,
        emptyCount: res.emptyCount,
        batchCount: res.batchCount,
        completedBatches: 0,
        progress: 0,
        appliedRows: 0,
        cancelRequested: false,
      });
      // 持久化任务 ID：刷新页面后凭此重连进度（服务重启任务作废）
      localStorage.setItem(SEMANTIC_FILL_TASK_KEY, res.taskId);
      pollFillTask(res.taskId);
      showToast(true, `填充任务已开始，共 ${res.batchCount} 批`);
    } catch (err) {
      const msg = (err as Error)?.message || '创建填充任务失败';
      console.error('[AIWritingPanel] 创建分批填充任务失败', err);
      setTableError(msg);
      showToast(false, msg);
    }
  }, [fillQuote, fillTask, documentId, pollFillTask, showToast]);

  /** 请求取消任务（协作式：当前批完成后停止，已完成批次结果保留可应用） */
  const handleCancelFillTask = useCallback(async () => {
    if (!fillTask || fillTask.status !== 'running') return;
    try {
      await cancelSemanticFillTask(fillTask.taskId);
      setFillTask((prev) => (prev ? { ...prev, cancelRequested: true } : prev));
      showToast(true, '已请求取消，当前批完成后停止');
    } catch (err) {
      const msg = (err as Error)?.message || '取消填充任务失败';
      console.error('[AIWritingPanel] 请求取消填充任务失败', err);
      showToast(false, msg);
    }
  }, [fillTask, showToast]);

  /**
   * 确认 AI 规则提议：入库为 allowedValues 校验规则（source=ai），
   * 成功后从当前结果中移除提议（防重复入库），映射明细保留
   */
  const handleSaveSuggestRule = useCallback(async () => {
    const suggestRule: SemanticFillSuggestRule | undefined = tableResult?.semanticFill?.suggestRule;
    if (!suggestRule || !documentId) return;
    setSuggestRuleSaving(true);
    try {
      const res = await batchCreateTableRules(documentId, [
        {
          name: suggestRule.name,
          type: 'allowedValues',
          params: { column: suggestRule.column, values: suggestRule.values },
          // 绑定本次填充的目标工作表（多 sheet 文档里列可能在第二个 sheet）
          ...(suggestRule.targetSheet ? { targetSheet: suggestRule.targetSheet } : {}),
        },
      ]);
      if (res.failed.length > 0) {
        const first = res.failed[0];
        showToast(false, `规则入库失败：${first.name}（${first.reason}）`);
        return;
      }
      setTableResult((prev) =>
        prev && prev.semanticFill
          ? { ...prev, semanticFill: { ...prev.semanticFill, suggestRule: undefined } }
          : prev,
      );
      showToast(true, '已存为表格规则，今后违反该白名单的 AI 结果将被拒绝');
    } catch (err) {
      const msg = (err as Error)?.message || '规则入库失败';
      console.error('[AIWritingPanel] AI 规则提议入库失败', err);
      showToast(false, msg);
    } finally {
      setSuggestRuleSaving(false);
    }
  }, [tableResult, documentId, showToast]);

  /**
   * 刷新重连：凭本地持久化的任务 ID 尝试恢复填充任务进度（只执行一次）。
   * running → 恢复轮询（快照丢失，应用时走二次确认）；
   * 终态有结果 → 直接转入确认流；查询失败保留 key 下次再试
   */
  useEffect(() => {
    if (fillReconnectDoneRef.current) return;
    fillReconnectDoneRef.current = true;
    const savedTaskId = localStorage.getItem(SEMANTIC_FILL_TASK_KEY);
    if (!savedTaskId) return;
    void (async () => {
      try {
        const res = await getSemanticFillStatus(savedTaskId);
        if (res.found && res.task) {
          const t = res.task;
          if (t.status === 'running') {
            fillBaseRef.current = null;
            setFillTask({ ...t });
            // 1s 后恢复轮询（错开挂载高峰）
            fillPollTimerRef.current = window.setTimeout(() => pollFillTaskRef.current(savedTaskId), 1000);
            return;
          }
          consumeTerminalFillTask(t);
          return;
        }
        // 任务已不存在（过期清理/服务重启）：清 key
        localStorage.removeItem(SEMANTIC_FILL_TASK_KEY);
      } catch (err) {
        // 查询失败（网络问题等）：保留 key，下次刷新再试，不打扰用户
        console.warn('[AIWritingPanel] 重连填充任务失败，保留任务 ID 下次重试', err);
      }
    })();
  }, [consumeTerminalFillTask]);

  // ==================== 指令入口 ====================

  /** 点击快捷指令 */
  const handleQuickAction = useCallback((action: QuickAction) => {
    const config = QUICK_ACTIONS[action];
    console.log('[AIWritingPanel] 点击快捷指令', { action, label: config.label });
    setActiveAction(action);
    void runGeneration(config.mode, config.instruction, config.label);
  }, [runGeneration]);

  /**
   * 执行自定义指令——按文档类型智能分流：
   *   - 含表格文档 → AI 表格指令（LLM 解析意图 + 代码精确执行，报告确认后应用）
   *   - 普通文档   → 原有 rewrite 流式改写
   * 路由用实时判定（非 hasTable state）——state 靠 editor 'update' 事件刷新，
   * 极端时序下可能滞后一拍，路由判定以执行瞬间的文档内容为准
   */
  const handleCustomExecute = useCallback(() => {
    const trimmed = customInstruction.trim();
    if (!trimmed) {
      console.warn('[AIWritingPanel] 自定义指令为空，跳过');
      return;
    }
    if (editor && docContainsTable(editor.getJSON())) {
      console.log('[AIWritingPanel] 文档含表格，走表格指令路径');
      void handleTableOpsExecute();
      return;
    }
    console.log('[AIWritingPanel] 执行自定义指令', { instructionLength: trimmed.length });
    // 走普通改写路径前清掉可能残留的表格指令结果/错误，避免面板显示过期状态
    setTableResult(null);
    setTableError('');
    setActiveAction(null);
    void runGeneration('rewrite', trimmed, '自定义指令');
  }, [customInstruction, editor, handleTableOpsExecute, runGeneration]);

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

  // 组件卸载时清理（填充任务不中断：服务端继续跑，taskId 留在本地刷新后重连）
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (fillPollTimerRef.current !== null) clearTimeout(fillPollTimerRef.current);
    };
  }, []);

  const isGenerating = status === 'generating';
  /** 分批填充任务进行中（禁用新指令输入，避免并发编辑冲突） */
  const fillTaskRunning = fillTask?.status === 'running';

  // ==================== clarify 反问卡渲染分组 ====================
  /** fill-source 多列按列分组；其余场景顶层选项合并为一组（列名用场景 kind 占位） */
  const clarifyGroups: Array<{ column: string; gapCount: number; candidates: ClarifyStrategyOption[] }> =
    clarify
      ? clarify.columns?.length
        ? clarify.columns
        : clarify.options?.length
          ? [{ column: clarify.kind, gapCount: clarify.affectedCount ?? 0, candidates: clarify.options }]
          : []
      : [];

  // ==================== ReAct 过程行（执行中实时 / 失败与完成后保留展示共用） ====================
  const tableStepsList =
    tableSteps.length > 0 ? (
      <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1.5 max-h-56 overflow-y-auto">
        <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
          执行过程
          {tableRunning && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
        {tableSteps.map((step) => (
          <div key={step.seq} className="flex items-start gap-2 text-xs leading-relaxed">
            {step.phase === 'thought' && (
              <Brain className="h-3.5 w-3.5 text-violet-500 shrink-0 mt-0.5" />
            )}
            {step.phase === 'action' && (
              <Zap className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
            )}
            {step.phase === 'observation' && (
              <ArrowRight className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
            )}
            <span className={step.phase === 'action' ? 'text-foreground' : 'text-muted-foreground'}>
              {step.text}
            </span>
          </div>
        ))}
      </div>
    ) : null;

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

        {/* 自定义指令（含表格文档时自动分流为 AI 表格指令） */}
        <div className="text-xs text-muted-foreground pt-1">自定义指令</div>
        {hasTable && (
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5">
            <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              已识别表格文档，指令将作用于表格数据（求和/筛选/排序等，结果确认后应用）
            </span>
          </div>
        )}
        <div className="flex gap-1.5">
          <Input
            value={customInstruction}
            onChange={(e) => setCustomInstruction(e.target.value)}
            placeholder={
              hasTable
                ? '例如：把销售员3号的所有销售额加起来，追加为新的一行'
                : '例如：把全文改成口语化'
            }
            className="h-8 text-sm"
            disabled={isGenerating || tableRunning || fillTaskRunning || clarifyRunning}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomExecute();
            }}
          />
          <Button
            variant="default"
            size="sm"
            className="h-8 shrink-0"
            disabled={isGenerating || tableRunning || fillTaskRunning || clarifyRunning || !customInstruction.trim()}
            onClick={handleCustomExecute}
          >
            {tableRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '执行'}
          </Button>
        </div>
      </div>

      {/* 生成结果区 */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* AI 表格指令：执行中（收到首个进度事件前显示转圈，之后实时滚动过程行） */}
        {tableRunning && tableStepsList}
        {tableRunning && tableSteps.length === 0 && (
          <div className="flex flex-col items-center justify-center text-muted-foreground gap-2 py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-xs">正在解析指令并计算表格数据…</span>
          </div>
        )}

        {/* 语义填充：过程行保留（报价阶段的"正在构建语义填充方案……"等步骤） */}
        {fillTask && tableStepsList}
        {/* 语义填充：分批任务进度（功能 4；终态由 consumeTerminalFillTask 转入确认流后消失） */}
        {fillTask && (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Wand2 className="h-4 w-4 text-violet-500 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs leading-relaxed">
                <div className="font-medium text-foreground">
                  语义填充进行中：目标列「{fillTask.targetColumn}」
                </div>
                <div className="text-muted-foreground">
                  第 {fillTask.completedBatches}/{fillTask.batchCount} 批 · 已填充 {fillTask.appliedRows}/{fillTask.emptyCount} 个单元格
                </div>
              </div>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-violet-500 transition-all"
                style={{ width: `${Math.round(fillTask.progress * 100)}%` }}
              />
            </div>
            {fillTask.cancelRequested ? (
              <div className="text-xs text-muted-foreground">正在取消…当前批完成后停止，已完成部分可应用</div>
            ) : (
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => void handleCancelFillTask()}>
                <Square className="h-3 w-3" />
                取消任务
              </Button>
            )}
          </div>
        )}

        {/* 语义填充：报价确认态保留过程行（任务创建后由上方 fillTask 分支接管） */}
        {fillQuote && !fillTask && tableStepsList}
        {/* 语义填充：分批报价确认（功能 4；用户确认后才创建任务） */}
        {fillQuote && !fillTask && (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Wand2 className="h-4 w-4 text-violet-500 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs leading-relaxed">
                <div className="font-medium text-foreground">该列取值较杂，建议分批填充</div>
                <div className="text-muted-foreground">
                  目标列「{fillQuote.quote.targetColumn}」共 {fillQuote.quote.emptyCount} 个空缺单元格，
                  依据列（{fillQuote.quote.hintColumns.join('、')}）去重后有 {fillQuote.quote.distinctCount} 个取值，
                  超出单次映射上限，将分 {fillQuote.quote.batchCount} 批（每批 {fillQuote.quote.batchRows} 行）调用 AI 推断填充。
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="default" size="sm" className="h-7 gap-1 text-xs" onClick={() => void handleStartFillTask()}>
                <Wand2 className="h-3 w-3" />
                开始填充
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setFillQuote(null)}>
                <RotateCcw className="h-3 w-3" />
                放弃
              </Button>
            </div>
          </div>
        )}

        {/* AI 表格指令：clarify 反问确认（两阶段交互；确认执行中实时滚动过程行） */}
        {(clarify || clarifyRunning) && tableStepsList}
        {clarify && !clarifyRunning && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <HelpCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-xs font-medium text-foreground leading-relaxed">{clarify.question}</div>
            </div>

            {/* join-key：候选键对信息（重合率越高关联越可靠；具体策略在下方选项卡选择） */}
            {clarify.kind === 'join-key' && clarify.keyCandidates && clarify.keyCandidates.length > 0 && (
              <div className="rounded-md border border-border bg-background/60 p-2 space-y-1">
                <div className="text-xs text-muted-foreground">候选关联键（百分比 = 目标表键值在来源表中的覆盖率）</div>
                {clarify.keyCandidates.map((c) => (
                  <div key={c.targetKeyColumn} className="flex items-center justify-between text-xs">
                    <span className="text-foreground">{c.label}</span>
                    <span className={cn('font-medium', c.overlapRate >= 0.6 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400')}>
                      {Math.round(c.overlapRate * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* condition：目标列值分布（帮助理解全列更新的影响面） */}
            {clarify.kind === 'condition' && clarify.valueDistribution && clarify.valueDistribution.length > 0 && (
              <div className="rounded-md border border-border bg-background/60 p-2 space-y-1">
                <div className="text-xs text-muted-foreground">该列取值分布</div>
                <div className="flex flex-wrap gap-1.5">
                  {clarify.valueDistribution.map((v) => (
                    <span key={v.value} className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
                      {v.value || '(空)'} × {v.count}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* formula-preview / destructive-preview：确定性预览表（数据已由后端算好，非 AI 猜测） */}
            {clarify.previewHeaders && clarify.previewHeaders.length > 0 && clarify.previewRows && clarify.previewRows.length > 0 && (
              <div className="rounded-md border border-border bg-background/60 p-2 space-y-1 overflow-x-auto">
                <div className="text-xs text-muted-foreground">
                  预览（前 {clarify.previewRows.length} 行{clarify.affectedCount !== undefined ? `，预计影响 ${clarify.affectedCount} 处` : ''}）
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      {clarify.previewHeaders.map((h) => (
                        <th key={h} className="px-1.5 py-1 text-left font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {clarify.previewRows.map((row, ri) => (
                      <tr key={ri} className="border-b border-border/40 last:border-0">
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-1.5 py-1 text-foreground whitespace-nowrap">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 策略选项：fill-source 多列按列单选；其余场景单组（选项由后端分析器确定性产出） */}
            {clarifyGroups.length > 0 && (
              <div className="space-y-2">
                {clarifyGroups.map((g) => {
                  const selected = clarifySelections[g.column] ?? null;
                  return (
                    <div key={g.column} className="rounded-md border border-border bg-background/60 p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-foreground">
                          {clarify.columns?.length ? `列「${g.column}」` : '处理策略'}
                        </span>
                        {g.gapCount > 0 && <span className="text-xs text-muted-foreground">{g.gapCount} 个空缺</span>}
                      </div>
                      <div className="space-y-1">
                        {g.candidates.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setClarifySelections((prev) => ({ ...prev, [g.column]: opt.strategy }))}
                            className={cn(
                              'w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                              selected === opt.strategy
                                ? 'border-amber-500 bg-amber-500/10'
                                : 'border-border hover:border-amber-500/50 hover:bg-muted/40',
                            )}
                          >
                            <span className="font-medium text-foreground">{opt.label}</span>
                            {opt.description && (
                              <span className="block text-muted-foreground">{opt.description}</span>
                            )}
                          </button>
                        ))}
                      </div>
                      {/* 固定值填充：选中后显示输入框（预填策略建议值，可改） */}
                      {selected?.type === 'fill-constant' && (
                        <Input
                          value={constantInputs[g.column] ?? selected.value ?? ''}
                          onChange={(e) => setConstantInputs((prev) => ({ ...prev, [g.column]: e.target.value }))}
                          placeholder="填写要统一填充的值"
                          className="h-7 text-xs"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <Button variant="default" size="sm" className="h-7 gap-1 text-xs" onClick={() => void handleClarifyConfirm()}>
                <CheckCircle2 className="h-3 w-3" />
                确认执行
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={handleClarifyDismiss}>
                <RotateCcw className="h-3 w-3" />
                放弃
              </Button>
            </div>
          </div>
        )}

        {/* AI 表格指令：执行失败（过程行保留，便于看清 AI 做了什么失败在哪） */}
        {!tableRunning && tableError && tableStepsList}
        {!tableRunning && tableError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <span className="text-xs text-destructive leading-relaxed">{tableError}</span>
            </div>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={handleDiscardTableOps}>
              <RotateCcw className="h-3 w-3" />
              清除
            </Button>
          </div>
        )}

        {/* AI 表格指令：执行过程 + 执行报告 + 确认应用 */}
        {!tableRunning && tableResult && (
          <div className="space-y-3">
            {tableStepsList}
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 max-h-[50vh] overflow-y-auto">
              {tableResult.summary && (
                <div className="flex items-start gap-2 text-xs leading-relaxed pb-1 border-b border-border/60">
                  <Sparkles className="h-3.5 w-3.5 text-violet-500 shrink-0 mt-0.5" />
                  <span className="text-foreground">{tableResult.summary}</span>
                </div>
              )}
              <div className="text-xs font-medium text-foreground">执行报告</div>
              {tableResult.report.map((item, idx) => (
                <div key={idx} className="flex items-start gap-2 text-xs leading-relaxed">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                  <span className="text-muted-foreground">
                    {item.targetSheet ? `「${item.targetSheet}」` : ''}
                    {item.message}
                  </span>
                </div>
              ))}
              {tableResult.report.length === 0 && (
                <div className="text-xs text-muted-foreground">操作已执行（无明细报告）</div>
              )}
            </div>

            {/* 语义填充映射明细 + AI 规则提议（功能 4 映射路径） */}
            {tableResult.semanticFill && (
              <div className="space-y-2">
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5 max-h-[40vh] overflow-y-auto">
                  <div className="text-xs font-medium text-foreground">
                    填充映射明细（依据值 → 填充值，共 {tableResult.semanticFill.mapping.length} 条，已刷全表 {tableResult.semanticFill.appliedRows} 行）
                  </div>
                  {tableResult.semanticFill.mapping.slice(0, 50).map((m, idx) => (
                    <div key={`${m.from}-${idx}`} className="text-xs text-muted-foreground">
                      「{m.from || '(空)'}」→「{m.to}」
                    </div>
                  ))}
                  {tableResult.semanticFill.mapping.length > 50 && (
                    <div className="text-xs text-muted-foreground">
                      …其余 {tableResult.semanticFill.mapping.length - 50} 条略
                    </div>
                  )}
                </div>
                {tableResult.semanticFill.suggestRule && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <Lightbulb className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                      <div className="space-y-1 text-xs leading-relaxed">
                        <div className="font-medium text-foreground">AI 规则提议</div>
                        <div className="text-muted-foreground">
                          「{tableResult.semanticFill.suggestRule.name}」：列「{tableResult.semanticFill.suggestRule.column}」的取值限定为
                          {tableResult.semanticFill.suggestRule.values.join('、')}。存为规则后，AI 表格指令的结果若违反该白名单将被整体拒绝。
                        </div>
                      </div>
                    </div>
                    {documentId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        disabled={suggestRuleSaving}
                        onClick={() => void handleSaveSuggestRule()}
                      >
                        {suggestRuleSaving ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Lightbulb className="h-3 w-3" />
                        )}
                        存为规则
                      </Button>
                    ) : (
                      <div className="text-xs text-muted-foreground">文档保存后才能将提议存为规则</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <Button variant="default" size="sm" className="h-7 gap-1 text-xs" onClick={handleApplyTableOps} disabled={!editor}>
                <CheckCircle2 className="h-3 w-3" />
                应用到表格
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={handleDiscardTableOps}>
                <RotateCcw className="h-3 w-3" />
                放弃
              </Button>
            </div>
          </div>
        )}

        {status === 'idle' && !output && !tableRunning && !tableError && !tableResult && !fillQuote && !fillTask && !clarify && !clarifyRunning && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-8">
            <Sparkles className="h-8 w-8 opacity-40" />
            <span className="text-xs">{hasTable ? '输入指令操作表格数据' : '选择快捷指令或输入自定义指令'}</span>
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
