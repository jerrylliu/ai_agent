/**
 * VersionDiff - 版本对比组件
 * 以行级差异展示两个版本的文本内容对比
 * 红色背景 = 删除内容，绿色背景 = 新增内容
 */

import { useState, useEffect } from 'react';
import { X, GitCompare, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { diffVersions, type DiffLine } from '../../lib/api';

interface VersionDiffProps {
  documentId: number;
  v1: number;
  v2: number;
  /** 两个版本的版本号（用于头部展示；不传则退化为显示版本记录 ID） */
  v1Number?: number;
  v2Number?: number;
  onClose: () => void;
}

export function VersionDiff({ documentId, v1, v2, v1Number, v2Number, onClose }: VersionDiffProps) {
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 重试触发器：递增后作为 effect 依赖强制重新加载（loadDiff 已内联进 effect）
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    // 竞态守卫：v1/v2 快速切换时，慢请求的后返回会覆盖新请求的正确结果；
    // 关闭弹窗后请求返回也会在已卸载组件上 setState。用 cancelled 标志丢弃过期响应
    let cancelled = false;
    setLoading(true);
    setError(null);
    diffVersions(documentId, v1, v2)
      .then((result) => {
        if (!cancelled) setDiff(result.diff || []);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || '加载对比数据失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, v1, v2, retryKey]);

  // 统计（按行而非按 diff 块：一个块可能包含多行，按块统计会严重低估）
  const countLines = (d: DiffLine) =>
    d.value.split('\n').filter((l) => l.trim() !== '').length;
  const addedCount = diff.filter((d) => d.added).reduce((n, d) => n + countLines(d), 0);
  const removedCount = diff.filter((d) => d.removed).reduce((n, d) => n + countLines(d), 0);
  const unchangedCount = diff
    .filter((d) => !d.added && !d.removed)
    .reduce((n, d) => n + countLines(d), 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col border border-border">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <GitCompare className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">版本对比</h3>
            <span className="text-sm text-muted-foreground">
              v{v1Number ?? v1} vs v{v2Number ?? v2}
              {(v1Number === undefined || v2Number === undefined) && (
                <span className="ml-1 text-xs text-muted-foreground/60">
                  （版本 ID）
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {/* 统计信息 */}
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded bg-red-200 dark:bg-red-900" />
                删除 {removedCount}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded bg-green-200 dark:bg-green-900" />
                新增 {addedCount}
              </span>
              <span className="text-muted-foreground">
                未变更 {unchangedCount}
              </span>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="ml-3 text-muted-foreground">加载对比数据...</span>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-destructive mb-3">{error}</p>
              <Button variant="outline" size="sm" onClick={() => {
                // 重试：重新触发加载（改 key 强制 effect 重跑）
                setRetryKey((k) => k + 1);
              }}>重试</Button>
            </div>
          ) : diff.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              两个版本内容完全相同
            </div>
          ) : (
            <div className="font-mono text-sm leading-relaxed">
              {diff.map((line, index) => {
                const lines = line.value.split('\n').filter((l, i, arr) =>
                  i < arr.length - 1 || l !== ''
                );

                return lines.map((text, lineIndex) => (
                  <div
                    key={`${index}-${lineIndex}`}
                    className={`px-3 py-0.5 ${
                      line.added
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                        : line.removed
                          ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
                          : ''
                    }`}
                  >
                    <span className="inline-block w-6 text-right mr-3 text-muted-foreground/50 select-none">
                      {line.added ? '+' : line.removed ? '-' : ' '}
                    </span>
                    {text}
                  </div>
                ));
              })}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex justify-end p-4 border-t border-border">
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}
