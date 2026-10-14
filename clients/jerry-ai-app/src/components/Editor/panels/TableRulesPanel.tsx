/**
 * TableRulesPanel - 表格规则器面板（功能 5"表格的 ESLint"）
 *
 * 职责：
 *   - 规则 CRUD：手动新增（5 类规则 + 可选修复动作）、启停、删除（确认弹框）
 *   - 检查：干跑服务端规则引擎，展示违规行清单（按规则分组）与失效规则（标红）
 *   - 修复：确认弹框展示影响行数 → 服务端批量修复（过期行自动跳过）→
 *     结果应用回编辑器（与 AI 表格指令同一套结构守卫/并发编辑守卫）→ 自动重查
 *   - AI 提议：看列级统计提议候选规则（不落库），勾选确认后批量入库
 *
 * 设计要点：
 *   - 检查是纯只读干跑：规则增删改后若面板已有检查结果，自动重新检查刷新，无需确认；
 *     修复是写操作：必须过确认弹框
 *   - 规则绑列名，改表头/删列后规则"失效"标红，绝不静默失灵
 *   - 未保存的新文档（无 documentId）面板置灰提示"保存后可用"
 *   - 违规行号 = 数据行号（1 起，不含表头），与编辑器"第 N 行"口径一致
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, Loader2, AlertCircle, CheckCircle2, Plus, Trash2,
  Sparkles, ScanLine, Wrench, Table2, TriangleAlert,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  listTableRules, createTableRule, batchCreateTableRules, updateTableRule,
  deleteTableRule, checkTableRules, fixTableRules, suggestTableRules,
  type TableRuleDto, type TableRuleInput, type TableRuleFixAction,
  type TableRuleCheckResult, type TableRuleSuggestResponse,
} from '@/lib/api';
import {
  docContainsTable,
  isSheetStructuredText,
  sheetTextToTableDoc,
  tableDocToSheetText,
  tableDocToSheets,
} from '@/lib/table-convert';
import { cn } from '@/utils/index';

export interface TableRulesPanelProps {
  /** 编辑器实例 */
  editor: Editor | null;
  /** 文档 ID；未保存的新文档为 undefined → 面板置灰 */
  documentId?: number;
}

/** 规则类型的人可读名称 */
const RULE_TYPE_LABEL: Record<TableRuleInput['type'], string> = {
  notEmpty: '非空',
  allowedValues: '白名单',
  numericRange: '数值范围',
  unique: '唯一性',
  formula: '跨列公式',
};

const RULE_TYPE_ORDER: TableRuleInput['type'][] = [
  'notEmpty', 'allowedValues', 'numericRange', 'unique', 'formula',
];

/** 修复动作的人可读名称（脏数据兜底：未知 kind 回退 JSON，不返回 undefined） */
function describeFixAction(fa: TableRuleFixAction): string {
  try {
    switch (fa.kind) {
      case 'fixedValue': return `改为固定值"${fa.value}"`;
      case 'formula': return `按 ${fa.expression} 重算`;
      case 'deleteRow': return '删除该行';
    }
  } catch {
    /* 落入下方兜底 */
  }
  return JSON.stringify(fa).slice(0, 80);
}

/** 规则参数的人可读摘要（脏数据兜底：结构异常时回退 JSON，不抛错） */
function describeRule(rule: TableRuleDto): string {
  try {
    switch (rule.type) {
      case 'notEmpty':
        return `「${rule.params.column}」不能留空`;
      case 'allowedValues':
        return `「${rule.params.column}」只能是 ${rule.params.values.join('/')} 之一`;
      case 'numericRange': {
        const { min, max } = rule.params;
        if (min !== undefined && max !== undefined) return `「${rule.params.column}」应为 ${min} ~ ${max} 之间的数字`;
        if (min !== undefined) return `「${rule.params.column}」应为 ≥ ${min} 的数字`;
        if (max !== undefined) return `「${rule.params.column}」应为 ≤ ${max} 的数字`;
        return `「${rule.params.column}」应为数字`;
      }
      case 'unique':
        return `「${rule.params.column}」不能重复`;
      case 'formula':
        return `「${rule.params.targetColumn}」= ${rule.params.expression}`;
    }
  } catch {
    /* 落入下方兜底 */
  }
  // 未知规则类型/参数结构异常（脏数据兜底）：回退 JSON 摘要，绝不返回 undefined
  return `参数无法解析：${JSON.stringify(rule.params ?? {}).slice(0, 80)}`;
}

/**
 * 从 sheetText 提取第一个 sheet 的表头列名（供规则表单的列下拉选择）。
 * 简易 CSV 解析：支持引号包裹与 "" 转义，与后端 parseCsvLine 口径一致。
 * 识别 HeaderRow: N 指令（报表式表格）：说明行跳过，取第 N 个非空行为表头。
 */
function extractFirstSheetHeaders(sheetText: string): string[] {
  const lines = sheetText.split(/\r?\n/);
  // 跳过 "Sheet: xxx" 标题行与空行
  const contentLines = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^sheet\s*:/i.test(l));
  // 表头锚定指令：块首第一个非空行（与后端 parseSheetData / table-convert 口径一致）
  let headerRowIndex = 1;
  if (contentLines.length > 0) {
    const directive = contentLines[0].match(/^HeaderRow\s*[:：]\s*(\d+)$/i);
    if (directive) {
      const n = Number.parseInt(directive[1], 10);
      headerRowIndex = Math.min(Math.max(n, 1), contentLines.length - 1);
      contentLines.shift();
    }
  }
  const headerLine = contentLines[headerRowIndex - 1];
  if (!headerLine) return [];
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (inQuotes) {
      if (ch === '"') {
        if (headerLine[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells.filter((c) => c.length > 0);
}

export function TableRulesPanel({ editor, documentId }: TableRulesPanelProps) {
  // ==================== 状态 ====================
  const [rules, setRules] = useState<TableRuleDto[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [checkResult, setCheckResult] = useState<TableRuleCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [suggestResult, setSuggestResult] = useState<TableRuleSuggestResponse | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);

  // 新增规则表单
  const [formOpen, setFormOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<TableRuleInput['type']>('notEmpty');
  const [formColumn, setFormColumn] = useState('');
  const [formValues, setFormValues] = useState('');
  const [formMin, setFormMin] = useState('');
  const [formMax, setFormMax] = useState('');
  const [formTargetColumn, setFormTargetColumn] = useState('');
  const [formExpression, setFormExpression] = useState('');
  const [formFixKind, setFormFixKind] = useState<'none' | 'fixedValue' | 'formula' | 'deleteRow'>('none');
  const [formFixValue, setFormFixValue] = useState('');
  const [formFixExpression, setFormFixExpression] = useState('');
  const [formTargetSheet, setFormTargetSheet] = useState('');

  // 确认弹框
  const [fixConfirmOpen, setFixConfirmOpen] = useState(false);
  const [deleteConfirmRule, setDeleteConfirmRule] = useState<TableRuleDto | null>(null);

  // toast
  const [toast, setToast] = useState<{ show: boolean; success: boolean; message: string }>({
    show: false, success: false, message: '',
  });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((success: boolean, message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ show: true, success, message });
    toastTimerRef.current = setTimeout(() => {
      setToast({ show: false, success: false, message: '' });
      toastTimerRef.current = null;
    }, 3000);
  }, []);

  // ==================== 文档/表格判定 ====================

  /** 当前文档是否含表格（订阅编辑器 update 事件，手动插表/删表实时刷新） */
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

  /** 当前表格文本是否为 sheet 结构化（与 AI 表格指令同一守卫口径） */
  const [sheetStructured, setSheetStructured] = useState(false);
  useEffect(() => {
    if (!editor || !hasTable) {
      setSheetStructured(false);
      return;
    }
    const update = () => {
      const text = tableDocToSheetText(editor.getJSON());
      setSheetStructured(text !== null && isSheetStructuredText(text));
    };
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor, hasTable]);

  /** 面板可用条件：已保存 + 含表格 + sheet 结构化 */
  const panelReady = Boolean(documentId) && hasTable && sheetStructured;

  /** 编辑器内容版本号：任何 update 事件 +1，用于驱动表头下拉等派生数据重算 */
  const [contentVersion, setContentVersion] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => setContentVersion((v) => v + 1);
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);

  /** 当前表头列名（规则表单下拉选项；内容变化即时重算，改表头后不过期） */
  const headers = useMemo(() => {
    if (!panelReady || !editor) return [];
    const text = tableDocToSheetText(editor.getJSON());
    return text ? extractFirstSheetHeaders(text) : [];
  }, [panelReady, editor, contentVersion]);

  /** 当前文档全部工作表名（"生效工作表"下拉选项；多 sheet 文档规则需绑定所在表） */
  const sheetNames = useMemo(() => {
    if (!panelReady || !editor) return [];
    return (tableDocToSheets(editor.getJSON()) ?? []).map((s) => s.name);
  }, [panelReady, editor, contentVersion]);

  /** 失效规则 ID 集合（列表标红用） */
  const invalidRuleIds = useMemo(() => {
    const set = new Set<number>();
    for (const info of checkResult?.invalidRules ?? []) set.add(info.ruleId);
    return set;
  }, [checkResult]);

  /** 可修复的违规（配置了修复动作的规则产生的违规） */
  const fixableViolations = useMemo(
    () => (checkResult?.violations ?? []).filter((v) => v.fixable),
    [checkResult],
  );

  // ==================== 数据加载 ====================

  const loadRules = useCallback(async () => {
    if (!documentId) return;
    setRulesLoading(true);
    try {
      const list = await listTableRules(documentId);
      setRules(list);
    } catch (err) {
      console.error('[TableRulesPanel] 加载规则列表失败', err);
      showToast(false, (err as Error)?.message || '加载规则失败');
    } finally {
      setRulesLoading(false);
    }
  }, [documentId, showToast]);

  // 面板可用时拉取规则列表；documentId 变化时清空本地检查结果
  useEffect(() => {
    if (!panelReady) {
      setRules([]);
      setCheckResult(null);
      setSuggestResult(null);
      return;
    }
    void loadRules();
    // panelReady 首次变真时拉取
  }, [panelReady, loadRules]);

  // ==================== 检查 / 修复 ====================

  /** 序列化当前表格文本（守卫失败返回 null 并 toast） */
  const getSheetTextOrNotify = useCallback((): string | null => {
    if (!editor) return null;
    const text = tableDocToSheetText(editor.getJSON());
    if (!text) {
      showToast(false, '无法提取表格数据，请重试');
      return null;
    }
    if (!isSheetStructuredText(text)) {
      showToast(false, '规则器仅支持 Excel 上传生成的表格文档');
      return null;
    }
    return text;
  }, [editor, showToast]);

  /** 检查（干跑，无副作用） */
  const handleCheck = useCallback(async () => {
    if (!documentId) return;
    const sheetText = getSheetTextOrNotify();
    if (!sheetText) return;
    setChecking(true);
    try {
      const result = await checkTableRules(documentId, sheetText);
      setCheckResult(result);
      if (result.invalidRules.length > 0) {
        showToast(false, `有 ${result.invalidRules.length} 条规则已失效（列不存在），请处理`);
      } else if (result.violations.length === 0) {
        showToast(true, `检查完成：${result.checkedRules} 条规则全部通过`);
      } else {
        showToast(false, `检查完成：发现 ${result.violations.length} 处违规`);
      }
    } catch (err) {
      console.error('[TableRulesPanel] 规则检查失败', err);
      showToast(false, (err as Error)?.message || '规则检查失败');
    } finally {
      setChecking(false);
    }
  }, [documentId, getSheetTextOrNotify, showToast]);

  /** 点击"修复"：先弹确认框（展示影响行数），确认后才真正调用 */
  const handleFixClick = useCallback(() => {
    if (fixableViolations.length === 0) return;
    setFixConfirmOpen(true);
  }, [fixableViolations]);

  /** 确认修复：调服务端修复 → 应用回编辑器 → 自动重查 */
  const handleFixConfirm = useCallback(async () => {
    if (!documentId || !editor) return;
    const sheetText = getSheetTextOrNotify();
    if (!sheetText) return;
    setFixing(true);
    setFixConfirmOpen(false);
    try {
      const items = fixableViolations.map((v) => ({ ruleId: v.ruleId, rowIndex: v.rowIndex }));
      const result = await fixTableRules(documentId, sheetText, items);

      // 防篡改守卫：服务端跳过了过期行时明确提示（表格在检查后被改过）
      if (result.skippedStale > 0) {
        showToast(false, `${result.skippedStale} 行因表格已变动被跳过，建议重新检查`);
      }

      // 应用新文本回编辑器：与 AI 表格指令同一套结构守卫
      // （fix 基于刚提交的 sheetText，并发编辑窗口极小，但守卫不能省——宁可不应用不可应用坏）
      if (result.sheetText) {
        const currentText = tableDocToSheetText(editor.getJSON());
        if (currentText !== null && currentText !== sheetText) {
          showToast(false, '表格在修复期间又被修改，结果未应用，请重新检查后再试');
          return;
        }
        const { doc: newDoc, degraded } = sheetTextToTableDoc(result.sheetText);
        if (degraded) {
          showToast(false, '修复结果未能转换为表格，已放弃应用，请重试');
          return;
        }
        editor.commands.setContent(newDoc);
        showToast(true, `修复完成，Ctrl+Z 可撤销（${result.report.length} 条规则已处理）`);
      }

      // 应用后自动重新检查刷新违规清单（干跑只读）
      setCheckResult(null);
      const newText = tableDocToSheetText(editor.getJSON());
      if (newText && isSheetStructuredText(newText)) {
        try {
          setCheckResult(await checkTableRules(documentId, newText));
        } catch (err) {
          console.error('[TableRulesPanel] 修复后重查失败', err);
        }
      }
    } catch (err) {
      console.error('[TableRulesPanel] 规则修复失败', err);
      showToast(false, (err as Error)?.message || '规则修复失败');
    } finally {
      setFixing(false);
    }
  }, [documentId, editor, fixableViolations, getSheetTextOrNotify, showToast]);

  // ==================== 规则 CRUD ====================

  /** 规则变更成功后的统一动作：刷新列表；若已有检查结果则自动重查（纯只读） */
  const afterRuleMutation = useCallback(async () => {
    await loadRules();
    if (!documentId) return;
    if (!checkResult) return; // 用户没检查过就不主动检查
    const sheetText = getSheetTextOrNotify();
    if (!sheetText) return;
    try {
      setCheckResult(await checkTableRules(documentId, sheetText));
    } catch (err) {
      console.error('[TableRulesPanel] 规则变更后重查失败', err);
    }
  }, [documentId, loadRules, checkResult, getSheetTextOrNotify]);

  /** 启停规则 */
  const handleToggleEnabled = useCallback(async (rule: TableRuleDto, enabled: boolean) => {
    try {
      await updateTableRule(rule.id, { enabled });
      await afterRuleMutation();
    } catch (err) {
      console.error('[TableRulesPanel] 更新规则状态失败', err);
      showToast(false, (err as Error)?.message || '更新规则状态失败');
    }
  }, [afterRuleMutation, showToast]);

  /** 删除规则（确认后） */
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmRule) return;
    try {
      await deleteTableRule(deleteConfirmRule.id);
      setDeleteConfirmRule(null);
      showToast(true, '规则已删除');
      await afterRuleMutation();
    } catch (err) {
      console.error('[TableRulesPanel] 删除规则失败', err);
      showToast(false, (err as Error)?.message || '删除规则失败');
    }
  }, [deleteConfirmRule, afterRuleMutation, showToast]);

  // ==================== 新增规则表单 ====================

  const resetForm = useCallback(() => {
    setFormName('');
    setFormType('notEmpty');
    setFormColumn('');
    setFormValues('');
    setFormMin('');
    setFormMax('');
    setFormTargetColumn('');
    setFormExpression('');
    setFormFixKind('none');
    setFormFixValue('');
    setFormFixExpression('');
    setFormTargetSheet('');
  }, []);

  /** 从表单构造规则输入（校验必填项；失败返回 null 并 toast） */
  const buildRuleInput = useCallback((): TableRuleInput | null => {
    const name = formName.trim();
    if (!name) {
      showToast(false, '请填写规则名称');
      return null;
    }
    const column = formColumn.trim();
    const values = formValues.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const minRaw = formMin.trim();
    const maxRaw = formMax.trim();
    const min = minRaw === '' ? undefined : Number(minRaw);
    const max = maxRaw === '' ? undefined : Number(maxRaw);
    const targetColumn = formTargetColumn.trim();
    const expression = formExpression.trim();

    let params: TableRuleInput['params'];
    switch (formType) {
      case 'notEmpty':
      case 'unique':
        if (!column) { showToast(false, '请填写列名'); return null; }
        params = { column };
        break;
      case 'allowedValues':
        if (!column) { showToast(false, '请填写列名'); return null; }
        if (values.length === 0) { showToast(false, '请填写至少一个允许值（逗号分隔）'); return null; }
        params = { column, values };
        break;
      case 'numericRange':
        if (!column) { showToast(false, '请填写列名'); return null; }
        if (minRaw !== '' && !Number.isFinite(min)) { showToast(false, '最小值必须是数字'); return null; }
        if (maxRaw !== '' && !Number.isFinite(max)) { showToast(false, '最大值必须是数字'); return null; }
        if (min !== undefined && max !== undefined && min > max) { showToast(false, '最小值不能大于最大值'); return null; }
        params = { column, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
        break;
      case 'formula':
        if (!targetColumn) { showToast(false, '请填写结果列名'); return null; }
        if (!expression) { showToast(false, '请填写表达式，如 [数量]*[单价]'); return null; }
        params = { targetColumn, expression };
        break;
    }

    let fixAction: TableRuleFixAction | undefined;
    if (formFixKind === 'fixedValue') {
      if (!formFixValue.trim()) { showToast(false, '请填写固定值'); return null; }
      fixAction = { kind: 'fixedValue', value: formFixValue.trim() };
    } else if (formFixKind === 'formula') {
      if (!formFixExpression.trim()) { showToast(false, '请填写修复表达式'); return null; }
      fixAction = { kind: 'formula', expression: formFixExpression.trim() };
    } else if (formFixKind === 'deleteRow') {
      fixAction = { kind: 'deleteRow' };
    }

    return {
      name,
      type: formType,
      params,
      // 绑定工作表（未选 = 第一个工作表；多 sheet 文档里列在别的表时必须选）
      ...(formTargetSheet ? { targetSheet: formTargetSheet } : {}),
      ...(fixAction ? { fixAction } : {}),
    } as TableRuleInput;
  }, [formName, formType, formColumn, formValues, formMin, formMax, formTargetColumn, formExpression, formFixKind, formFixValue, formFixExpression, formTargetSheet, showToast]);

  /** 提交新增规则 */
  const handleCreate = useCallback(async () => {
    if (!documentId) return;
    const rule = buildRuleInput();
    if (!rule) return;
    setCreating(true);
    try {
      await createTableRule(documentId, rule);
      showToast(true, '规则已创建');
      setFormOpen(false);
      resetForm();
      await afterRuleMutation();
    } catch (err) {
      console.error('[TableRulesPanel] 创建规则失败', err);
      showToast(false, (err as Error)?.message || '创建规则失败');
    } finally {
      setCreating(false);
    }
  }, [documentId, buildRuleInput, showToast, resetForm, afterRuleMutation]);

  // ==================== AI 提议 ====================

  const handleSuggest = useCallback(async () => {
    if (!documentId) return;
    const sheetText = getSheetTextOrNotify();
    if (!sheetText) return;
    setSuggestLoading(true);
    setSuggestResult(null);
    setSelectedCandidates(new Set());
    try {
      const result = await suggestTableRules(documentId, sheetText);
      setSuggestResult(result);
      // 默认全选候选（用户可取消勾选；确认前绝不入库）
      setSelectedCandidates(new Set(result.candidates.map((_, i) => i)));
      if (result.candidates.length === 0) {
        showToast(true, 'AI 未提议新规则（可手动新增）');
      }
    } catch (err) {
      console.error('[TableRulesPanel] AI 规则提议失败', err);
      showToast(false, (err as Error)?.message || 'AI 规则提议失败');
    } finally {
      setSuggestLoading(false);
    }
  }, [documentId, getSheetTextOrNotify, showToast]);

  /** 勾选/取消候选 */
  const toggleCandidate = useCallback((index: number) => {
    setSelectedCandidates((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  /** 确认入库选中的候选规则 */
  const handleImportCandidates = useCallback(async () => {
    if (!documentId || !suggestResult) return;
    const picked = suggestResult.candidates.filter((_, i) => selectedCandidates.has(i));
    if (picked.length === 0) {
      showToast(false, '请先勾选要入库的规则');
      return;
    }
    setImporting(true);
    try {
      const { created, failed } = await batchCreateTableRules(documentId, picked);
      if (failed.length > 0) {
        showToast(false, `${created.length} 条入库成功，${failed.length} 条失败：${failed[0].reason}`);
      } else {
        showToast(true, `${created.length} 条规则已入库`);
      }
      setSuggestResult(null);
      setSelectedCandidates(new Set());
      await afterRuleMutation();
    } catch (err) {
      console.error('[TableRulesPanel] 候选规则入库失败', err);
      showToast(false, (err as Error)?.message || '候选规则入库失败');
    } finally {
      setImporting(false);
    }
  }, [documentId, suggestResult, selectedCandidates, showToast, afterRuleMutation]);

  // 组件卸载清理 toast 定时器
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // ==================== 渲染 ====================

  /** 按规则 ID 聚合违规（展示分组） */
  const violationsByRule = useMemo(() => {
    const map = new Map<number, TableRuleCheckResult['violations']>();
    for (const v of checkResult?.violations ?? []) {
      const list = map.get(v.ruleId) ?? [];
      list.push(v);
      map.set(v.ruleId, list);
    }
    return map;
  }, [checkResult]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 标题 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">表格规则</span>
      </div>

      {/* 置灰/不可用提示 */}
      {!documentId && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-muted-foreground py-8">
          <ShieldCheck className="h-8 w-8 opacity-40" />
          <span className="text-xs text-center leading-relaxed">
            文档保存后才能使用规则器
            <br />
            （规则与文档绑定存储）
          </span>
        </div>
      )}

      {documentId && !hasTable && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-muted-foreground py-8">
          <ShieldCheck className="h-8 w-8 opacity-40" />
          <span className="text-xs text-center leading-relaxed">
            当前文档不含表格，规则器仅对表格文档可用
          </span>
        </div>
      )}

      {documentId && hasTable && !sheetStructured && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-muted-foreground py-8">
          <Table2 className="h-8 w-8 opacity-40" />
          <span className="text-xs text-center leading-relaxed">
            规则器仅支持 Excel 上传生成的表格文档，当前文档结构不符合
          </span>
        </div>
      )}

      {panelReady && (
        <>
          {/* 操作按钮行 */}
          <div className="p-3 border-b border-border space-y-2">
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={checking || fixing || suggestLoading}
                onClick={() => void handleCheck()}
              >
                {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanLine className="h-3 w-3" />}
                检查
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={checking || fixing || suggestLoading || fixableViolations.length === 0}
                onClick={handleFixClick}
              >
                {fixing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                修复{fixableViolations.length > 0 ? `（${fixableViolations.length}）` : ''}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={checking || fixing || suggestLoading}
                onClick={() => void handleSuggest()}
              >
                {suggestLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                AI 提议
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={checking || fixing || suggestLoading}
                onClick={() => setFormOpen((v) => !v)}
              >
                <Plus className="h-3 w-3" />
                新增规则
              </Button>
            </div>
            {rules.length === 0 && !rulesLoading && (
              <div className="text-xs text-muted-foreground leading-relaxed">
                还没有规则。可手动新增，或点"AI 提议"让 AI 根据表格数据推荐。
                规则将在 AI 表格指令执行前自动把关。
              </div>
            )}
          </div>

          {/* 滚动区：检查结果 / AI 提议 / 表单 / 规则列表 */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {rulesLoading && (
              <div className="flex items-center justify-center gap-2 text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-xs">加载规则中…</span>
              </div>
            )}

            {/* 检查结果 */}
            {checkResult && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground">
                  检查结果（{checkResult.checkedRules} 条规则生效）
                </div>

                {/* 失效规则标红 */}
                {checkResult.invalidRules.length > 0 && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs text-destructive font-medium">
                      <TriangleAlert className="h-3.5 w-3.5" />
                      {checkResult.invalidRules.length} 条规则已失效
                    </div>
                    {checkResult.invalidRules.map((info) => (
                      <div key={info.ruleId} className="text-xs text-destructive/90 leading-relaxed pl-5">
                        {info.ruleName}：{info.reason}
                      </div>
                    ))}
                    <div className="text-xs text-muted-foreground pl-5">
                      通常是列被改名/删除导致，请修改或删除这些规则
                    </div>
                  </div>
                )}

                {/* 违规清单（按规则分组） */}
                {checkResult.violations.length === 0 && checkResult.invalidRules.length === 0 && (
                  <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-2.5 flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <span className="text-xs text-muted-foreground">全部规则通过，未发现违规</span>
                  </div>
                )}

                {checkResult.truncated && (
                  <div className="text-xs text-amber-600 dark:text-amber-400">
                    违规过多，仅显示前 1000 条，请先处理已列出的违规
                  </div>
                )}

                {[...violationsByRule.entries()].map(([ruleId, violations]) => {
                  const rule = rules.find((r) => r.id === ruleId);
                  return (
                    <div key={ruleId} className="rounded-lg border border-border bg-muted/30 p-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-foreground truncate">
                          {violations[0]?.ruleName ?? `规则 #${ruleId}`}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {violations.length} 行{violations[0]?.fixable ? '·可修复' : '·仅标记'}
                        </span>
                      </div>
                      {!rule && (
                        <div className="text-xs text-muted-foreground">（规则已删除或停用）</div>
                      )}
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {violations.slice(0, 50).map((v, idx) => (
                          <div key={`${v.rowIndex}-${idx}`} className="text-xs leading-relaxed text-muted-foreground">
                            {rule?.targetSheet ? `「${v.sheetName}」` : ''}第 {v.rowIndex} 行「{v.column}」：
                            {v.currentValue ? `"${v.currentValue.slice(0, 50)}"` : '（空）'}
                            <span className="text-foreground/70"> → {v.expectation}</span>
                          </div>
                        ))}
                        {violations.length > 50 && (
                          <div className="text-xs text-muted-foreground">
                            …还有 {violations.length - 50} 条
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* AI 提议结果 */}
            {suggestResult && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground">
                  AI 提议了 {suggestResult.candidates.length} 条规则（勾选确认后才会入库）
                </div>
                {suggestResult.candidates.length === 0 && (
                  <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                    AI 未发现值得建议的规则。也可以手动新增。
                  </div>
                )}
                {suggestResult.candidates.map((candidate, i) => (
                  <label
                    key={i}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border p-2 cursor-pointer transition-colors',
                      selectedCandidates.has(i)
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-border bg-muted/30 hover:bg-muted/60',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-primary shrink-0"
                      checked={selectedCandidates.has(i)}
                      onChange={() => toggleCandidate(i)}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">
                        {candidate.name}
                        {candidate.targetSheet ? (
                          <span className="text-muted-foreground font-normal">（{candidate.targetSheet}）</span>
                        ) : null}
                      </span>
                      <span className="block text-xs text-muted-foreground leading-relaxed">
                        {describeRule(candidate as TableRuleDto)}
                        {candidate.fixAction ? `；${describeFixAction(candidate.fixAction)}` : '；仅标记'}
                      </span>
                    </span>
                  </label>
                ))}
                {suggestResult.candidates.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={importing || selectedCandidates.size === 0}
                      onClick={() => void handleImportCandidates()}
                    >
                      {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                      入库选中项（{selectedCandidates.size}）
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setSuggestResult(null)}
                    >
                      放弃
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* 新增规则表单 */}
            {formOpen && (
              <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-2.5">
                <div className="text-xs font-medium text-foreground">新增规则</div>

                <div className="space-y-1">
                  <Label className="text-xs">规则名称</Label>
                  <Input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="如：区域不能留空"
                    className="h-7 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">规则类型</Label>
                  <select
                    value={formType}
                    onChange={(e) => setFormType(e.target.value as TableRuleInput['type'])}
                    className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {RULE_TYPE_ORDER.map((t) => (
                      <option key={t} value={t}>{RULE_TYPE_LABEL[t]}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">生效工作表</Label>
                  <select
                    value={formTargetSheet}
                    onChange={(e) => setFormTargetSheet(e.target.value)}
                    className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">第一个工作表（默认）</option>
                    {sheetNames.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>

                {/* 按类型渲染参数表单 */}
                {(formType === 'notEmpty' || formType === 'allowedValues' ||
                  formType === 'numericRange' || formType === 'unique') && (
                  <div className="space-y-1">
                    <Label className="text-xs">
                      {formType === 'notEmpty' ? '不能留空的列' : '受约束的列'}
                    </Label>
                    <select
                      value={formColumn}
                      onChange={(e) => setFormColumn(e.target.value)}
                      className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="">请选择列…</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                )}

                {formType === 'allowedValues' && (
                  <div className="space-y-1">
                    <Label className="text-xs">允许的取值（逗号分隔）</Label>
                    <Input
                      value={formValues}
                      onChange={(e) => setFormValues(e.target.value)}
                      placeholder="如：重点客户,普通客户"
                      className="h-7 text-xs"
                    />
                  </div>
                )}

                {formType === 'numericRange' && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className="space-y-1">
                      <Label className="text-xs">最小值（可空）</Label>
                      <Input
                        value={formMin}
                        onChange={(e) => setFormMin(e.target.value)}
                        placeholder="不设下限"
                        className="h-7 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">最大值（可空）</Label>
                      <Input
                        value={formMax}
                        onChange={(e) => setFormMax(e.target.value)}
                        placeholder="不设上限"
                        className="h-7 text-xs"
                      />
                    </div>
                  </div>
                )}

                {formType === 'formula' && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">结果列</Label>
                      <select
                        value={formTargetColumn}
                        onChange={(e) => setFormTargetColumn(e.target.value)}
                        className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs"
                      >
                        <option value="">请选择列…</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">表达式（[列名] 引用，如 [数量]*[单价]）</Label>
                      <Input
                        value={formExpression}
                        onChange={(e) => setFormExpression(e.target.value)}
                        placeholder="[数量]*[单价]"
                        className="h-7 text-xs"
                      />
                    </div>
                  </>
                )}

                {/* 修复动作 */}
                <div className="space-y-1">
                  <Label className="text-xs">修复动作（可选，不配则只标记）</Label>
                  <select
                    value={formFixKind}
                    onChange={(e) => setFormFixKind(e.target.value as typeof formFixKind)}
                    className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="none">不修复（只标记）</option>
                    <option value="fixedValue">改为固定值</option>
                    <option value="formula">按表达式重算</option>
                    <option value="deleteRow">删除违规行</option>
                  </select>
                </div>
                {formFixKind === 'fixedValue' && (
                  <Input
                    value={formFixValue}
                    onChange={(e) => setFormFixValue(e.target.value)}
                    placeholder="违规单元格统一改为该值"
                    className="h-7 text-xs"
                  />
                )}
                {formFixKind === 'formula' && (
                  <Input
                    value={formFixExpression}
                    onChange={(e) => setFormFixExpression(e.target.value)}
                    placeholder="如 [数量]*[单价]"
                    className="h-7 text-xs"
                  />
                )}

                <div className="flex items-center gap-1.5 pt-0.5">
                  <Button
                    variant="default"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={creating}
                    onClick={() => void handleCreate()}
                  >
                    {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : '创建'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setFormOpen(false);
                      resetForm();
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}

            {/* 规则列表 */}
            {!rulesLoading && rules.map((rule) => {
              const invalid = invalidRuleIds.has(rule.id);
              const violationCount = violationsByRule.get(rule.id)?.length ?? 0;
              return (
                <div
                  key={rule.id}
                  className={cn(
                    'rounded-lg border p-2.5 space-y-1.5',
                    invalid
                      ? 'border-destructive/50 bg-destructive/5'
                      : 'border-border bg-muted/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Switch
                      size="sm"
                      checked={rule.enabled}
                      onCheckedChange={(checked) => void handleToggleEnabled(rule, checked)}
                      aria-label={`启停规则：${rule.name}`}
                    />
                    <span className={cn('text-xs font-medium truncate flex-1', !rule.enabled && 'text-muted-foreground line-through')}>
                      {rule.name}
                    </span>
                    <Badge variant="outline" className="text-[10px] px-1.5 shrink-0">
                      {RULE_TYPE_LABEL[rule.type]}
                    </Badge>
                    {rule.targetSheet && (
                      <Badge variant="outline" className="text-[10px] px-1.5 shrink-0 max-w-28 truncate">
                        {rule.targetSheet}
                      </Badge>
                    )}
                    {rule.source === 'ai' && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 shrink-0">AI</Badge>
                    )}
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => setDeleteConfirmRule(rule)}
                      aria-label={`删除规则：${rule.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className={cn('text-xs leading-relaxed', invalid ? 'text-destructive' : 'text-muted-foreground')}>
                    {describeRule(rule)}
                    {rule.fixAction ? `；${describeFixAction(rule.fixAction)}` : '；仅标记'}
                  </div>
                  {invalid && (
                    <div className="text-xs text-destructive/80">
                      失效：{checkResult?.invalidRules.find((i) => i.ruleId === rule.id)?.reason ?? '绑定的列不存在'}
                    </div>
                  )}
                  {!invalid && rule.enabled && violationCount > 0 && (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      当前违规 {violationCount} 行
                    </div>
                  )}
                </div>
              );
            })}

            {!rulesLoading && rules.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
                <ShieldCheck className="h-8 w-8 opacity-40" />
                <span className="text-xs">还没有规则，点上方"新增规则"或"AI 提议"开始</span>
              </div>
            )}
          </div>
        </>
      )}

      {/* 修复确认弹框：按规则聚合展示影响行数 */}
      <ConfirmDialog
        open={fixConfirmOpen}
        onOpenChange={setFixConfirmOpen}
        title="确认修复"
        description={[
          `将按各规则配置的修复动作处理 ${fixableViolations.length} 个违规单元格/行：`,
          ...[...violationsByRule.entries()]
            .filter(([ruleId]) => fixableViolations.some((v) => v.ruleId === ruleId))
            .map(([ruleId, list]) => {
              const name = list[0]?.ruleName ?? `规则 #${ruleId}`;
              return `· ${name}：${list.length} 行`;
            }),
          '',
          '修复结果会应用回表格，Ctrl+Z 可撤销。',
        ].join('\n')}
        confirmLabel="开始修复"
        onConfirm={() => void handleFixConfirm()}
      />

      {/* 删除规则确认弹框 */}
      <ConfirmDialog
        open={deleteConfirmRule !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmRule(null);
        }}
        title="删除规则"
        description={`确定删除规则"${deleteConfirmRule?.name ?? ''}"吗？删除后不再参与检查与 AI 指令把关。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={() => void handleDeleteConfirm()}
      />

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
