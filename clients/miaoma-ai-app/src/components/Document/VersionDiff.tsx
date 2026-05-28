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
  onClose: () => void;
}

export function VersionDiff({ documentId, v1, v2, onClose }: VersionDiffProps) {
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDiff();
  }, [documentId, v1, v2]);

  const loadDiff = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await diffVersions(documentId, v1, v2);
      setDiff(result.diff || []);
    } catch (err: any) {
      setError(err.message || '加载对比数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 统计
  const addedCount = diff.filter(d => d.added).length;
  const removedCount = diff.filter(d => d.removed).length;
  const unchangedCount = diff.filter(d => !d.added && !d.removed).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col border border-border">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <GitCompare className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">版本对比</h3>
            <span className="text-sm text-muted-foreground">
              v{v1} vs v{v2}
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
              <Button variant="outline" size="sm" onClick={loadDiff}>重试</Button>
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
