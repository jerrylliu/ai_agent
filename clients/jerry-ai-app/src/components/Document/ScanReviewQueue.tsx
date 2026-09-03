/**
 * ScanReviewQueue - 注入扫描人工复核队列
 *
 * 展示被安全扫描判定为"可疑（待人工复核）"的文档版本，
 * 复核人可查看命中明细（静态规则 / 模型判定 + 证据片段），
 * 并通过"通过并发布"或"拒绝"完成处置。
 * 通过时后端会校验内容哈希（TOCTOU 防护），若复核期间内容被修改会拒绝放行。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldAlert, ShieldCheck, ShieldX, RefreshCw, X, Loader2, FileSearch,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  getScanPendingReviews,
  approveScanReview,
  rejectScanReview,
  type PendingScanReviewItem,
  type ScanFindingItem,
} from '../../lib/api';

interface ScanReviewQueueProps {
  onClose: () => void;
  /** 队列数量变化时回调（父组件用于更新入口角标） */
  onQueueChanged: (remaining: number) => void;
  /** 复核通过并成功发布入库后回调（父组件用于刷新知识库/版本状态） */
  onPublished: () => void;
}

// 发现项严重级别徽标样式
const severityBadge = (severity: ScanFindingItem['severity']): { label: string; className: string } => {
  switch (severity) {
    case 'blocked':
      return { label: '拦截', className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' };
    case 'suspicious':
      return { label: '可疑', className: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200' };
    default:
      return { label: '记录', className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' };
  }
};

// 发现项产生阶段标签
const stageLabel = (stage: ScanFindingItem['stage']): string =>
  stage === 'static' ? '静态规则' : '模型判定';

export function ScanReviewQueue({ onClose, onQueueChanged, onPublished }: ScanReviewQueueProps) {
  const [items, setItems] = useState<PendingScanReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [processingVersionId, setProcessingVersionId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ show: boolean; success: boolean; message: string }>({
    show: false, success: false, message: '',
  });

  // 确认弹窗状态：通过 / 拒绝分开管理，避免互相干扰
  const [approveTarget, setApproveTarget] = useState<PendingScanReviewItem | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingScanReviewItem | null>(null);

  // 父组件以内联箭头函数传入回调，每次父组件重渲染都会产生新引用；
  // 用 ref 持有最新回调，避免将其放进 useCallback 依赖 →
  // loadQueue 重建 → effect 重跑 → 重复发起队列拉取请求
  const onQueueChangedRef = useRef(onQueueChanged);
  onQueueChangedRef.current = onQueueChanged;
  const onPublishedRef = useRef(onPublished);
  onPublishedRef.current = onPublished;

  const showFeedback = useCallback((success: boolean, message: string) => {
    setFeedback({ show: true, success, message });
    setTimeout(() => setFeedback(prev => ({ ...prev, show: false })), 3000);
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getScanPendingReviews();
      setItems(list);
      onQueueChangedRef.current(list.length);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '加载复核队列失败';
      showFeedback(false, message);
    } finally {
      setLoading(false);
    }
  }, [showFeedback]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const handleApprove = async () => {
    if (!approveTarget) return;
    const target = approveTarget;
    setApproveTarget(null);
    setProcessingVersionId(target.version.id);
    try {
      await approveScanReview(target.version.id);
      // 副作用（回调父组件）不得放在 setState 更新器内部（更新器必须是纯函数，
      // StrictMode 下会被双调用），先计算新列表再分别提交状态与回调
      const next = items.filter(i => i.version.id !== target.version.id);
      setItems(next);
      onQueueChangedRef.current(next.length);
      showFeedback(true, `v${target.version.versionNumber} 复核通过，已发布到知识库`);
      onPublishedRef.current();
    } catch (err: unknown) {
      // 常见失败：复核期间内容被修改，后端哈希校验拒绝放行，需要重新扫描
      const message = err instanceof Error ? err.message : '复核通过失败';
      showFeedback(false, message);
      loadQueue();
    } finally {
      setProcessingVersionId(null);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    const target = rejectTarget;
    setRejectTarget(null);
    setProcessingVersionId(target.version.id);
    try {
      await rejectScanReview(target.version.id, '人工复核拒绝');
      // 同上：先计算新列表，再提交状态与回调父组件
      const next = items.filter(i => i.version.id !== target.version.id);
      setItems(next);
      onQueueChangedRef.current(next.length);
      showFeedback(true, `v${target.version.versionNumber} 已拒绝入库`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '复核拒绝失败';
      showFeedback(false, message);
    } finally {
      setProcessingVersionId(null);
    }
  };

  return (
    // 自定义全屏遮罩弹窗（项目未引入 shadcn Dialog，沿用 VersionDiff 的 fixed 遮罩模式）
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border border-border rounded-lg shadow-xl w-[720px] max-w-[92vw] max-h-[85vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-orange-500" />
            安全复核队列
            <Badge variant="secondary" className="text-xs">{items.length}</Badge>
          </h3>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadQueue} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 反馈提示 */}
        {feedback.show && (
          <div className={`mx-4 mt-3 px-3 py-2 rounded text-sm ${
            feedback.success
              ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
          }`}>
            {feedback.message}
          </div>
        )}

        {/* 队列主体 */}
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 && !loading && (
            <div className="text-center py-10 text-muted-foreground text-sm">
              <FileSearch className="h-8 w-8 mx-auto mb-2 opacity-50" />
              暂无待复核的版本
            </div>
          )}
          <div className="space-y-4">
            {items.map(item => {
              const findings = item.version.scanFindings ?? [];
              const processing = processingVersionId === item.version.id;
              return (
                <div key={item.version.id} className="p-3 rounded-lg border border-border">
                  {/* 条目头部：文档标题 + 版本号 + 扫描时间 */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-sm truncate">{item.documentTitle}</span>
                      <Badge variant="outline" className="text-xs shrink-0">
                        v{item.version.versionNumber}
                      </Badge>
                    </div>
                    {item.version.scannedAt && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        扫描于 {new Date(item.version.scannedAt).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* 命中明细 */}
                  <div className="space-y-1.5 mb-3">
                    {findings.length === 0 && (
                      <div className="text-xs text-muted-foreground">无命中明细记录</div>
                    )}
                    {findings.map((finding, idx) => {
                      const severity = severityBadge(finding.severity);
                      return (
                        <div key={idx} className="text-xs rounded bg-muted/60 p-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge className={`text-[10px] ${severity.className}`}>{severity.label}</Badge>
                            <span className="text-muted-foreground">{stageLabel(finding.stage)}</span>
                            {typeof finding.chunkIndex === 'number' && (
                              <span className="text-muted-foreground">chunk #{finding.chunkIndex}</span>
                            )}
                          </div>
                          <div className="mt-1 text-foreground/90">{finding.detail}</div>
                          {finding.evidence && (
                            <div className="mt-1 text-muted-foreground font-mono break-all">
                              证据：{finding.evidence}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* 处置按钮 */}
                  <div className="flex items-center gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setRejectTarget(item)}
                      disabled={processing}
                    >
                      <ShieldX className="h-3 w-3 mr-1 text-red-500" />
                      拒绝入库
                    </Button>
                    <Button
                      size="xs"
                      onClick={() => setApproveTarget(item)}
                      disabled={processing}
                    >
                      {processing ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3 w-3 mr-1" />
                      )}
                      通过并发布
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 通过确认 */}
      <ConfirmDialog
        open={approveTarget !== null}
        onOpenChange={(open) => { if (!open) setApproveTarget(null); }}
        title="复核通过并发布"
        description={
          approveTarget
            ? `确认 "${approveTarget.documentTitle}" v${approveTarget.version.versionNumber} 内容安全？\n通过后该版本将立即向量化并入库到知识库。\n若复核期间内容被修改，后端会拒绝放行并要求重新扫描。`
            : ''
        }
        confirmLabel="通过并发布"
        onConfirm={handleApprove}
      />

      {/* 拒绝确认 */}
      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(open) => { if (!open) setRejectTarget(null); }}
        title="拒绝入库"
        description={
          rejectTarget
            ? `确认拒绝 "${rejectTarget.documentTitle}" v${rejectTarget.version.versionNumber}？\n拒绝后该版本不会被发布到知识库，可在版本列表中查看状态。`
            : ''
        }
        confirmLabel="拒绝"
        variant="destructive"
        onConfirm={handleReject}
      />
    </div>
  );
}
