/**
 * DocumentManager - 文档版本管理主组件
 * 功能：文档列表、版本时间线、上传、删除、回滚、版本对比
 */

import { useState, useEffect, useCallback } from 'react';
import {
  FileText, Upload, Trash2,
  Clock, RefreshCw, X,
} from 'lucide-react';
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
  activateVersion,
  archiveVersion,
  getDocumentAuditLogs,
  type DocumentItem,
  type DocumentVersionItem,
  type DocumentAuditLogItem,
} from '../../lib/api';
import { DocumentUploadDialog } from './DocumentUploadDialog';
import { VersionTimeline } from './VersionTimeline';
import { VersionDiff } from './VersionDiff';

interface DocumentManagerProps {
  onClose?: () => void;
}

export function DocumentManager({ onClose }: DocumentManagerProps) {
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

  const showFeedback = useCallback((success: boolean, message: string) => {
    setFeedback({ show: true, success, message });
    setTimeout(() => setFeedback(prev => ({ ...prev, show: false })), 3000);
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
    } catch (err: any) {
      showFeedback(false, err.message || '刷新失败');
    } finally {
      setLoading(false);
    }
  }, [selectedDocId, showFeedback]);

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

  useEffect(() => {
    handleRefresh();
  }, []);

  useEffect(() => {
    if (selectedDocId) {
      loadVersions(selectedDocId);
    } else {
      setVersions([]);
      setAuditLogs([]);
    }
  }, [selectedDocId, loadVersions]);

  const handleDeleteDocument = async (id: number) => {
    if (!confirm('确定要删除此文档及其所有版本吗？此操作不可撤销。')) return;
    try {
      await deleteDocument(id);
      showFeedback(true, '文档已删除');
      if (selectedDocId === id) setSelectedDocId(null);
      loadDocuments();
    } catch (err: any) {
      showFeedback(false, err.message || '删除失败');
    }
  };

  const handleRollback = async (versionId: number) => {
    if (!selectedDocId) return;
    if (!confirm('确定要回滚到此版本吗？当前 active 版本将被归档。')) return;
    try {
      await rollbackVersion(selectedDocId, versionId);
      showFeedback(true, '已回滚到指定版本');
      loadVersions(selectedDocId);
    } catch (err: any) {
      showFeedback(false, err.message || '回滚失败');
    }
  };

  const handleDeleteVersion = async (versionId: number) => {
    if (!selectedDocId) return;
    if (!confirm('确定要删除此版本吗？')) return;
    try {
      await deleteVersion(selectedDocId, versionId);
      showFeedback(true, '版本已删除');
      loadVersions(selectedDocId);
    } catch (err: any) {
      showFeedback(false, err.message || '删除版本失败');
    }
  };

  const handleActivateVersion = async (versionId: number) => {
    if (!selectedDocId) return;
    try {
      await activateVersion(selectedDocId, versionId);
      showFeedback(true, '版本已激活');
      loadVersions(selectedDocId);
    } catch (err: any) {
      showFeedback(false, err.message || '激活失败');
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

  const handleUploadSuccess = () => {
    setShowUpload(false);
    showFeedback(true, '上传成功');
    loadDocuments();
    if (selectedDocId) loadVersions(selectedDocId);
  };

  const handleDiff = (v1: number, v2: number) => {
    setDiffVersionIds([v1, v2]);
  };

  const actionLabel: Record<string, string> = {
    upload: '上传', activate: '激活', archive: '归档', rollback: '回滚', delete: '删除',
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
                </TabsList>

                <TabsContent value="versions">
                  <VersionTimeline
                    versions={versions}
                    onRollback={handleRollback}
                    onDelete={handleDeleteVersion}
                    onActivate={handleActivateVersion}
                    onArchive={handleArchiveVersion}
                    onDiff={handleDiff}
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
              </Tabs>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
