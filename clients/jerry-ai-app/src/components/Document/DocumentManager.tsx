/**
 * DocumentManager - 文档版本管理主组件
 * 功能：文档列表、版本时间线、上传、删除、回滚、版本对比
 */

import { useState, useEffect, useCallback } from 'react';
import {
  FileText, Upload, Trash2,
  Clock, RefreshCw, X, AlertTriangle, Play, XCircle,
  Pencil, ShieldCheck,
} from 'lucide-react';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  getDocuments,
  getDocumentVersions,
  deleteDocument,
  rollbackVersion,
  deleteVersion,
  archiveVersion,
  publishToVectorStore,
  exportVersion,
  getDocumentAuditLogs,
  getPendingVectorOps,
  retrySingleVectorOp,
  deletePendingVectorOp,
  retryAllFailedOps,
  getScanPendingReviews,
  type DocumentItem,
  type DocumentVersionItem,
  type DocumentAuditLogItem,
  type PendingVectorOpItem,
} from '../../lib/api';
import { DocumentUploadDialog } from './DocumentUploadDialog';
import { VersionTimeline } from './VersionTimeline';
import { VersionDiff } from './VersionDiff';
import { ScanReviewQueue } from './ScanReviewQueue';
import { openEditorWindow } from '../../lib/window';

interface DocumentManagerProps {
  onClose?: () => void;
  onRefreshKnowledgeBase?: () => void;
}

export function DocumentManager({ onClose, onRefreshKnowledgeBase }: DocumentManagerProps) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [versions, setVersions] = useState<DocumentVersionItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<DocumentAuditLogItem[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [diffVersionIds, setDiffVersionIds] = useState<[number, number] | null>(null);
  const [feedback, setFeedback] = useState<{ show: boolean; success: boolean; message: string }>({
    show: false, success: false, message: '',
  });
  const [activeTab, setActiveTab] = useState('versions');
  const [pendingOps, setPendingOps] = useState<PendingVectorOpItem[]>([]);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [publishingVersionId, setPublishingVersionId] = useState<number | null>(null);
  // 注入扫描人工复核队列：角标计数 + 队列弹窗开关
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [reviewQueueOpen, setReviewQueueOpen] = useState(false);

  // 确认弹窗状态
  const [deleteDocConfirmOpen, setDeleteDocConfirmOpen] = useState(false);
  const [deleteDocId, setDeleteDocId] = useState<number | null>(null);
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);
  const [rollbackTargetId, setRollbackTargetId] = useState<number | null>(null);
  const [deleteVersionConfirmOpen, setDeleteVersionConfirmOpen] = useState(false);
  const [deleteVersionTargetId, setDeleteVersionTargetId] = useState<number | null>(null);
  const [deleteOpConfirmOpen, setDeleteOpConfirmOpen] = useState(false);
  const [deleteOpTargetId, setDeleteOpTargetId] = useState<number | null>(null);

  const showFeedback = useCallback((success: boolean, message: string) => {
    setFeedback({ show: true, success, message });
    setTimeout(() => setFeedback(prev => ({ ...prev, show: false })), 3000);
  }, []);

  const loadPendingOps = useCallback(async () => {
    try {
      const ops = await getPendingVectorOps();
      setPendingOps(ops);
    } catch {
      // silent
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      const docs = await getDocuments();
      setDocuments(docs);
      if (selectedDocId) {
        const [vers, logs] = await Promise.all([
          getDocumentVersions(selectedDocId),
          getDocumentAuditLogs(selectedDocId),
        ]);
        setVersions(vers);
        setAuditLogs(logs);
      }
      loadPendingOps();
    } catch (err: any) {
      showFeedback(false, err.message || '刷新失败');
    } finally {
      setLoading(false);
    }
  }, [selectedDocId, showFeedback, loadPendingOps]);

  const loadDocuments = useCallback(async () => {
    try {
      const docs = await getDocuments();
      setDocuments(docs);
    } catch (err: any) {
      showFeedback(false, err.message || '加载文档列表失败');
    }
  }, [showFeedback]);

  // 加载版本列表和审计日志
  const loadVersions = useCallback(async (docId: number) => {
    try {
      const [vers, logs] = await Promise.all([
        getDocumentVersions(docId),
        getDocumentAuditLogs(docId),
      ]);
      setVersions(vers);
      setAuditLogs(logs);
    } catch (err: any) {
      showFeedback(false, err.message || '加载版本信息失败');
    }
  }, [showFeedback]);

  // 拉取待人工复核数量，用于"安全复核"按钮角标（失败静默，不影响主流程）
  const loadPendingReviewCount = useCallback(async () => {
    try {
      const items = await getScanPendingReviews();
      setPendingReviewCount(items.length);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    handleRefresh();
    loadPendingReviewCount();
  }, [handleRefresh, loadPendingReviewCount]);

  useEffect(() => {
    if (selectedDocId) {
      loadVersions(selectedDocId);
    } else {
      setVersions([]);
      setAuditLogs([]);
    }
  }, [selectedDocId, loadVersions]);

  const handleDeleteDocument = async (id: number) => {
    setDeleteDocId(id);
    setDeleteDocConfirmOpen(true);
  };

  const executeDeleteDocument = async () => {
    if (!deleteDocId) return;
    setDeleteDocConfirmOpen(false);
    try {
      await deleteDocument(deleteDocId);
      showFeedback(true, '文档已删除');
      if (selectedDocId === deleteDocId) setSelectedDocId(null);
      loadDocuments();
      onRefreshKnowledgeBase?.();
    } catch (err: any) {
      showFeedback(false, err.message || '删除失败');
    }
  };

  const handleRollback = async (versionId: number) => {
    if (!selectedDocId) return;
    setRollbackTargetId(versionId);
    setRollbackConfirmOpen(true);
  };

  const executeRollback = async () => {
    if (!selectedDocId || !rollbackTargetId) return;
    setRollbackConfirmOpen(false);
    try {
      await rollbackVersion(selectedDocId, rollbackTargetId);
      showFeedback(true, '已回滚到指定版本');
      loadVersions(selectedDocId);
    } catch (err: any) {
      showFeedback(false, err.message || '回滚失败');
    }
  };

  const handleDeleteVersion = async (versionId: number) => {
    if (!selectedDocId) return;
    setDeleteVersionTargetId(versionId);
    setDeleteVersionConfirmOpen(true);
  };

  const executeDeleteVersion = async () => {
    if (!selectedDocId || !deleteVersionTargetId) return;
    setDeleteVersionConfirmOpen(false);
    try {
      await deleteVersion(selectedDocId, deleteVersionTargetId);
      showFeedback(true, '版本已删除');
      loadVersions(selectedDocId);
    } catch (err: any) {
      showFeedback(false, err.message || '删除版本失败');
    }
  };

  const handleArchiveVersion = async (versionId: number) => {
    if (!selectedDocId) return;
    try {
      await archiveVersion(selectedDocId, versionId);
      showFeedback(true, '版本已归档');
      loadVersions(selectedDocId);
    } catch (err: any) {
      showFeedback(false, err.message || '归档失败');
    }
  };

  /** 发布版本到知识库（先过注入扫描门禁，再向量化 + 激活） */
  const handlePublishVersion = async (versionId: number) => {
    if (!selectedDocId) return;
    setPublishingVersionId(versionId);
    try {
      const result = await publishToVectorStore(selectedDocId, versionId);
      // 扫描门禁关闭时 scanGate 为 null，保持旧行为提示
      const verdict = result.scanGate?.verdict;
      if (verdict === 'needs_review') {
        showFeedback(false, '安全扫描发现可疑内容，已暂扣等待人工复核');
        // 有新版本进入复核队列，刷新角标
        loadPendingReviewCount();
      } else if (verdict === 'blocked') {
        showFeedback(false, '安全扫描命中高危内容，该版本已被拒绝入库');
      } else {
        showFeedback(true, '已发布到知识库');
        onRefreshKnowledgeBase?.();
      }
      loadVersions(selectedDocId);
    } catch (err: any) {
      showFeedback(false, err.message || '发布失败');
    } finally {
      setPublishingVersionId(null);
    }
  };

  /** 导出版本到 md/txt/docx 格式并下载（跨环境兼容） */
  const handleExportVersion = async (versionId: number, format: 'md' | 'txt' | 'docx') => {
    if (!selectedDocId) return;
    try {
      const blob = await exportVersion(selectedDocId, versionId, format);
      const fileName = `v${versionId}.${format}`;

      // Tauri 环境：用系统保存对话框
      if (!!(window as any).__TAURI_INTERNALS__) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        const filePath = await save({
          defaultPath: fileName,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!filePath) return;
        const buf = new Uint8Array(await blob.arrayBuffer());
        await writeFile(filePath, buf);
        return;
      }

      // 浏览器环境：URL.createObjectURL + a.click()
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    } catch (err: any) {
      showFeedback(false, err.message || '导出失败');
    }
  };

  const handleUploadSuccess = () => {
    setShowUpload(false);
    showFeedback(true, '上传成功');
    loadDocuments();
    if (selectedDocId) loadVersions(selectedDocId);
    onRefreshKnowledgeBase?.();
  };

  const handleDiff = (v1: number, v2: number) => {
    setDiffVersionIds([v1, v2]);
  };

  const handleRetryOp = async (opId: number) => {
    setRetrying(opId);
    try {
      const result = await retrySingleVectorOp(opId);
      if (result.success) {
        showFeedback(true, '向量操作重试成功');
        onRefreshKnowledgeBase?.();
      } else {
        showFeedback(false, `重试失败: ${result.error || '未知错误'}`);
      }
      loadPendingOps();
    } catch (err: any) {
      showFeedback(false, err.message || '重试失败');
    } finally {
      setRetrying(null);
    }
  };

  const handleDeleteOp = async (opId: number) => {
    setDeleteOpTargetId(opId);
    setDeleteOpConfirmOpen(true);
  };

  const executeDeleteOp = async () => {
    if (!deleteOpTargetId) return;
    setDeleteOpConfirmOpen(false);
    try {
      await deletePendingVectorOp(deleteOpTargetId);
      showFeedback(true, '记录已清除');
      loadPendingOps();
    } catch (err: any) {
      showFeedback(false, err.message || '清除失败');
    }
  };

  const handleRetryAll = async () => {
    try {
      const result = await retryAllFailedOps();
      showFeedback(result.retried > 0, `已重试 ${result.retried}/${result.total} 个操作`);
      loadPendingOps();
      if (result.retried > 0) onRefreshKnowledgeBase?.();
    } catch (err: any) {
      showFeedback(false, err.message || '批量重试失败');
    }
  };

  const actionLabel: Record<string, string> = {
    upload: '上传', activate: '激活', archive: '归档', rollback: '回滚', delete: '删除',
    scan_hold: '扫描暂扣', scan_reject: '扫描拒绝', review_approve: '复核通过', review_reject: '复核拒绝',
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-600">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FileText className="h-5 w-5" />
          文档版本管理
        </h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {/* 安全复核入口：注入扫描判定为可疑的版本在此人工处置，角标显示待复核数量 */}
          <Button
            variant="outline"
            size="sm"
            className="relative"
            onClick={() => setReviewQueueOpen(true)}
          >
            <ShieldCheck className="h-4 w-4 mr-1" />
            安全复核
            {pendingReviewCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-orange-500 text-white text-[10px] leading-4 text-center">
                {pendingReviewCount}
              </span>
            )}
          </Button>
          <Button size="sm" onClick={() => setShowUpload(true)}>
            <Upload className="h-4 w-4 mr-1" />
            上传文档
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* 反馈提示 */}
      {feedback.show && (
        <div className={`mx-4 mt-2 px-3 py-2 rounded text-sm ${
          feedback.success
            ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
            : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
        }`}>
          {feedback.message}
        </div>
      )}

      {/* 版本对比弹窗 */}
      {diffVersionIds && selectedDocId && (
        <VersionDiff
          documentId={selectedDocId}
          v1={diffVersionIds[0]}
          v2={diffVersionIds[1]}
          onClose={() => setDiffVersionIds(null)}
        />
      )}

      {/* 上传对话框 */}
      {showUpload && (
        <DocumentUploadDialog
          documents={documents}
          onSuccess={handleUploadSuccess}
          onClose={() => setShowUpload(false)}
        />
      )}

      {/* 注入扫描人工复核队列 */}
      {reviewQueueOpen && (
        <ScanReviewQueue
          onClose={() => setReviewQueueOpen(false)}
          onQueueChanged={(remaining: number) => setPendingReviewCount(remaining)}
          onPublished={() => {
            // 复核通过会发布入库：刷新知识库与当前文档的版本状态
            onRefreshKnowledgeBase?.();
            if (selectedDocId) loadVersions(selectedDocId);
          }}
        />
      )}

      {/* 主体：左侧文档列表 + 右侧版本详情 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧文档列表 */}
        <div className="w-72 border-r border-gray-200 dark:border-slate-600 overflow-y-auto">
          <div className="p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
              文档列表 ({documents.length})
            </div>
            {documents.length === 0 && !loading && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                暂无文档，点击上传按钮添加
              </div>
            )}
            {documents.map(doc => (
              <div
                key={doc.id}
                className={`p-3 rounded-lg cursor-pointer mb-1 transition-colors ${
                  selectedDocId === doc.id
                    ? 'bg-primary/10 border border-primary/30'
                    : 'hover:bg-muted border border-transparent'
                }`}
                onClick={() => setSelectedDocId(doc.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{doc.title}</div>
                    {doc.description && (
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">{doc.description}</div>
                    )}
                    <div className="text-xs text-muted-foreground mt-1">
                      {new Date(doc.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-1 shrink-0"
                    title="在编辑器中打开"
                    onClick={(e) => {
                      e.stopPropagation();
                      void openEditorWindow(doc.id, doc.title);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-1 shrink-0"
                    onClick={(e) => { e.stopPropagation(); handleDeleteDocument(doc.id); }}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
                {doc.tags && doc.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {doc.tags.slice(0, 3).map((tag, i) => (
                      <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0">{tag}</Badge>
                    ))}
                    {doc.tags.length > 3 && (
                      <span className="text-[10px] text-muted-foreground">+{doc.tags.length - 3}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 右侧版本详情 */}
        <div className="flex-1 overflow-y-auto">
          {!selectedDocId ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>选择左侧文档查看版本详情</p>
              </div>
            </div>
          ) : (
            <div className="p-4">
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="versions">版本时间线</TabsTrigger>
                  <TabsTrigger value="audit">审计日志</TabsTrigger>
                  <TabsTrigger value="retry" className="relative">
                    重试队列
                    {pendingOps.length > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full bg-red-500 text-white">
                        {pendingOps.length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="versions">
                  <VersionTimeline
                    versions={versions}
                    documentId={selectedDocId}
                    onRollback={handleRollback}
                    onDelete={handleDeleteVersion}
                    onArchive={handleArchiveVersion}
                    onDiff={handleDiff}
                    onPublish={handlePublishVersion}
                    publishingVersionId={publishingVersionId}
                    onExport={handleExportVersion}
                  />
                </TabsContent>

                <TabsContent value="audit">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        操作历史
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {auditLogs.length === 0 ? (
                        <div className="text-center py-6 text-muted-foreground text-sm">暂无操作记录</div>
                      ) : (
                        <div className="space-y-2">
                          {auditLogs.map(log => (
                            <div key={log.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                              <Badge variant="outline" className="text-xs shrink-0">
                                {actionLabel[log.action] || log.action}
                              </Badge>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm truncate">{log.detail || '-'}</div>
                                <div className="text-xs text-muted-foreground">
                                  {log.operator} · {new Date(log.createdAt).toLocaleString()}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="retry">
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                          向量操作重试队列
                        </CardTitle>
                        {pendingOps.length > 0 && (
                          <Button variant="outline" size="sm" onClick={handleRetryAll}>
                            <Play className="h-3 w-3 mr-1" />
                            全部重试
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      {pendingOps.length === 0 ? (
                        <div className="text-center py-6 text-muted-foreground text-sm">
                          队列为空，所有向量操作已完成
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {pendingOps.map(op => (
                            <div
                              key={op.id}
                              className="flex items-center gap-3 py-3 px-3 rounded-lg border border-border/50 bg-muted/30"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <Badge
                                    variant={
                                      op.status === 'failed' ? 'destructive' :
                                      op.status === 'pending' ? 'secondary' :
                                      op.status === 'processing' ? 'default' : 'outline'
                                    }
                                    className="text-xs"
                                  >
                                    {op.status === 'pending' ? '待处理' :
                                     op.status === 'failed' ? '失败' :
                                     op.status === 'processing' ? '处理中' : '已完成'}
                                  </Badge>
                                  <Badge variant="outline" className="text-xs">
                                    {op.operation === 'remove' ? '删除向量' :
                                     op.operation === 'update_status' ? '更新状态' :
                                     op.operation === 'reindex' ? '重建索引' : op.operation}
                                  </Badge>
                                  <span className="text-xs text-muted-foreground">
                                    版本 #{op.versionId}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    重试 {op.retryCount} 次
                                  </span>
                                </div>
                                {op.errorMessage && (
                                  <div className="text-xs text-red-500 mt-1 truncate" title={op.errorMessage}>
                                    {op.errorMessage}
                                  </div>
                                )}
                                <div className="text-xs text-muted-foreground mt-1">
                                  {new Date(op.createdAt).toLocaleString()}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  variant="outline"
                                  size="icon-xs"
                                  disabled={retrying === op.id || op.status === 'processing'}
                                  onClick={() => handleRetryOp(op.id)}
                                  title="重试"
                                >
                                  <Play className={`h-3 w-3 ${retrying === op.id ? 'animate-spin' : ''}`} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => handleDeleteOp(op.id)}
                                  title="清除记录"
                                >
                                  <XCircle className="h-3 w-3 text-muted-foreground" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </div>

      {/* 确认弹窗 */}
      <ConfirmDialog
        open={deleteDocConfirmOpen}
        onOpenChange={setDeleteDocConfirmOpen}
        title="删除文档"
        description="确定要删除此文档及其所有版本吗？此操作不可撤销。"
        confirmLabel="确认删除"
        variant="destructive"
        onConfirm={executeDeleteDocument}
      />
      <ConfirmDialog
        open={rollbackConfirmOpen}
        onOpenChange={setRollbackConfirmOpen}
        title="回滚版本"
        description="确定要回滚到此版本吗？当前 active 版本将被归档。"
        confirmLabel="确认回滚"
        onConfirm={executeRollback}
      />
      <ConfirmDialog
        open={deleteVersionConfirmOpen}
        onOpenChange={setDeleteVersionConfirmOpen}
        title="删除版本"
        description="确定要删除此版本吗？"
        confirmLabel="确认删除"
        variant="destructive"
        onConfirm={executeDeleteVersion}
      />
      <ConfirmDialog
        open={deleteOpConfirmOpen}
        onOpenChange={setDeleteOpConfirmOpen}
        title="清除记录"
        description="确定要清除这条重试记录吗？"
        confirmLabel="确认清除"
        onConfirm={executeDeleteOp}
      />
    </div>
  );
}
