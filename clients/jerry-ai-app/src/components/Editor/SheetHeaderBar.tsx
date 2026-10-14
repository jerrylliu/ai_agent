/**
 * SheetHeaderBar - sheet 表格表头行确认条
 *
 * 上传 Excel 时服务端用启发式自动识别表头行（产出 HeaderRow 指令），识别
 * 结果在编辑器中以本条呈现：每个 sheet 显示当前表头行号，用户可在下拉中
 * 一键纠正。纠错直接改 doc 的 tableHeader 标记（table-convert.retypeSheetHeaderRow），
 * 保存时序列化侧自动写出 HeaderRow: N 指令——全链路闭环，无 LLM 参与。
 *
 * 显示策略：文档含 sheet 表格即显示（含"默认第 1 行"的常规表，让用户有处
 * 纠错）；关闭后本次会话不再打扰。样式与锚点/性能提示条同一族（非阻塞）。
 */
import { useMemo, useState } from 'react';
import { Table2, X } from 'lucide-react';
import type { JSONContent } from '@tiptap/react';
import { collectSheetTables, retypeSheetHeaderRow } from '@/lib/table-convert';

/** 下拉可选行数上限：表头总在表格顶部，列出前 N 行足够纠错 */
const MAX_ROW_OPTIONS = 10;

interface SheetHeaderBarProps {
  /** 当前编辑器内容（表头确认条从中读取各 sheet 的表头行号） */
  content: JSONContent;
  /** 纠错回调：父组件 setContent + 标脏（重走编辑器 value 同步） */
  onChange: (doc: JSONContent) => void;
}

export function SheetHeaderBar({ content, onChange }: SheetHeaderBarProps) {
  const [dismissed, setDismissed] = useState(false);
  const tables = useMemo(() => collectSheetTables(content), [content]);

  if (dismissed || tables.length === 0) return null;

  return (
    <div className="flex items-center flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-xs text-muted-foreground bg-muted/50 border-b border-border">
      <span className="flex items-center gap-1.5 font-medium text-foreground/80">
        <Table2 className="h-3.5 w-3.5" />
        表头行
      </span>
      {tables.map((t) => {
        // 选项上界：至少覆盖当前值（识别错位远的场景），同时不超过总行数
        const optionCount = Math.min(Math.max(MAX_ROW_OPTIONS, t.headerRowNumber), t.rowCount);
        return (
          <label key={t.tableIndex} className="flex items-center gap-1.5 cursor-pointer">
            <span className="max-w-32 truncate" title={t.sheetName}>「{t.sheetName}」</span>
            <span>第</span>
            <select
              value={t.headerRowNumber}
              onChange={(e) =>
                onChange(retypeSheetHeaderRow(content, t.tableIndex, Number(e.target.value)))
              }
              className="h-6 rounded border border-border bg-background px-1 text-xs text-foreground"
              aria-label={`${t.sheetName} 的表头行号`}
            >
              {Array.from({ length: optionCount }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span>行</span>
          </label>
        );
      })}
      <span className="text-muted-foreground/70">识别有误？选正确的行，保存后对 AI 与 Excel 导出同步生效</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-auto text-muted-foreground hover:text-foreground font-medium"
        aria-label="关闭表头确认条"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
