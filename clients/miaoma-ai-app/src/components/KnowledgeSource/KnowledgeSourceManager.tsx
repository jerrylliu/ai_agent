import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Globe, MessageSquare, Plus, RefreshCw, Trash2, Play,
  X, AlertCircle, Clock, Loader2,
  RotateCcw, Layers, Bell, BellOff, FileEdit, FilePlus, FileMinus,
  ClipboardPaste, Check, Pencil,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import {
  getKnowledgeSources,
  createKnowledgeSource,
  updateKnowledgeSource,
  deleteKnowledgeSource,
  syncKnowledgeSource,
  resetKnowledgeSourceStatus,
  acknowledgeKnowledgeSourceUpdate,
  getKnowledgeSourceStats,
  getKnowledgeSourceSyncLogs,
  type KnowledgeSourceItem,
  type KnowledgeSourceStats,
  type KnowledgeSourceSyncLog,
} from '../../lib/api';

interface KnowledgeSourceManagerProps {
  onClose?: () => void;
  onContentChange?: () => void;
}

const TYPE_CONFIG: Record<string, { icon: typeof Globe; label: string; color: string }> = {
  web: { icon: Globe, label: 'Web 网页', color: 'text-blue-500' },
  feishu: { icon: MessageSquare, label: '飞书', color: 'text-purple-500' },
};

const STATUS_MAP: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  idle: { label: '待同步', variant: 'secondary' },
  syncing: { label: '同步中', variant: 'default' },
  success: { label: '已同步', variant: 'outline' },
  failed: { label: '失败', variant: 'destructive' },
};

export function KnowledgeSourceManager({ onClose, onContentChange }: KnowledgeSourceManagerProps) {
  const [sources, setSources] = useState<KnowledgeSourceItem[]>([]);
  const [stats, setStats] = useState<KnowledgeSourceStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [syncLogs, setSyncLogs] = useState<KnowledgeSourceSyncLog[]>([]);
  const [feedback, setFeedback] = useState<{ show: boolean; success: boolean; message: string }>({
    show: false, success: false, message: '',
  });

  const showFeedback = useCallback((success: boolean, message: string) => {
    setFeedback({ show: true, success, message });
    setTimeout(() => setFeedback(prev => ({ ...prev, show: false })), 3000);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sourceList, statsData] = await Promise.all([
        getKnowledgeSources(),
        getKnowledgeSourceStats(),
      ]);
      setSources(sourceList);
      setStats(statsData);
    } catch (err: any) {
      showFeedback(false, err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [showFeedback]);

  const loadSyncLogs = useCallback(async (id: number) => {
    try {
      const logs = await getKnowledgeSourceSyncLogs(id, 10);
      setSyncLogs(logs);
    } catch {
      setSyncLogs([]);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (selectedId) {
      loadSyncLogs(selectedId);
    } else {
      setSyncLogs([]);
    }
  }, [selectedId, loadSyncLogs]);

  const prevSyncingRef = useRef(false);

  useEffect(() => {
    const hasSyncing = sources.some(s => s.lastSyncStatus === 'syncing');
    if (hasSyncing) {
      prevSyncingRef.current = true;
    } else if (prevSyncingRef.current) {
      prevSyncingRef.current = false;
      onContentChange?.();
    }

    if (!hasSyncing) return;

    const timer = setInterval(() => {
      loadData();
    }, 5000);

    return () => clearInterval(timer);
  }, [sources, loadData]);

  const handleSync = async (id: number) => {
    setSyncingIds(prev => new Set(prev).add(id));
    try {
      await syncKnowledgeSource(id);
      showFeedback(true, '同步已触发');
      await loadData();
      if (selectedId === id) await loadSyncLogs(id);
      onContentChange?.();
    } catch (err: any) {
      showFeedback(false, err.message || '同步失败');
    } finally {
      setSyncingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除此知识源吗？相关同步记录也将被删除。')) return;
    try {
      await deleteKnowledgeSource(id);
      showFeedback(true, '知识源已删除');
      if (selectedId === id) setSelectedId(null);
      await loadData();
      onContentChange?.();
    } catch (err: any) {
      showFeedback(false, err.message || '删除失败');
    }
  };

  const handleToggleEnabled = async (source: KnowledgeSourceItem) => {
    try {
      await updateKnowledgeSource(source.id, { enabled: !source.enabled });
      showFeedback(true, source.enabled ? '已禁用' : '已启用');
      await loadData();
    } catch (err: any) {
      showFeedback(false, err.message || '操作失败');
    }
  };

  const handleResetStatus = async (id: number) => {
    try {
      await resetKnowledgeSourceStatus(id);
      showFeedback(true, '状态已重置');
      await loadData();
    } catch (err: any) {
      showFeedback(false, err.message || '重置失败');
    }
  };

  const handleAcknowledgeUpdate = async (id: number) => {
    try {
      await acknowledgeKnowledgeSourceUpdate(id);
      await loadData();
      onContentChange?.();
    } catch (err: any) {
      showFeedback(false, err.message || '确认失败');
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-600">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Layers className="h-5 w-5" />
          知识源管理
        </h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            添加知识源
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {feedback.show && (
        <div className={`mx-4 mt-2 px-3 py-2 rounded text-sm ${
          feedback.success
            ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
            : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
        }`}>
          {feedback.message}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-5 gap-2 p-4 border-b border-gray-200 dark:border-slate-600">
          <StatCard label="总计" value={stats.total} />
          <StatCard label="已启用" value={stats.enabled} color="text-blue-500" />
          <StatCard label="同步中" value={stats.syncing} color="text-amber-500" />
          <StatCard label="已同步" value={stats.success} color="text-green-500" />
          <StatCard label="失败" value={stats.failed} color="text-red-500" />
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 border-r border-gray-200 dark:border-slate-600 overflow-y-auto">
          <div className="p-3">
            {sources.length === 0 && !loading && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                暂无知识源，点击"添加知识源"创建
              </div>
            )}
            {sources.map(source => {
              const typeConf = TYPE_CONFIG[source.type] || TYPE_CONFIG.web;
              const TypeIcon = typeConf.icon;
              const statusConf = STATUS_MAP[source.lastSyncStatus] || STATUS_MAP.idle;
              const isSyncing = source.lastSyncStatus === 'syncing';

              return (
                <div
                  key={source.id}
                  className={`p-3 rounded-lg cursor-pointer mb-1 transition-colors ${
                    selectedId === source.id
                      ? 'bg-primary/10 border border-primary/30'
                      : 'hover:bg-muted border border-transparent'
                  }`}
                  onClick={() => setSelectedId(source.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      <TypeIcon className={`h-4 w-4 mt-0.5 shrink-0 ${typeConf.color}`} />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{source.name}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <Badge variant={statusConf.variant} className="text-[10px] px-1.5 py-0">
                            {isSyncing && <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />}
                            {statusConf.label}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">{typeConf.label}</span>
                          {!source.enabled && (
                            <span className="text-[10px] text-amber-500">已禁用</span>
                          )}
                          {source.hasContentUpdate && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30 px-1.5 py-0 rounded-full animate-pulse">
                              <Bell className="h-2.5 w-2.5" />
                              内容有更新
                            </span>
                          )}
                        </div>
                        {source.lastSyncAt && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {new Date(source.lastSyncAt).toLocaleString()}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={isSyncing || syncingIds.has(source.id)}
                        onClick={(e) => { e.stopPropagation(); handleSync(source.id); }}
                        title="同步"
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => { e.stopPropagation(); handleDelete(source.id); }}
                        title="删除"
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!selectedId ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <Layers className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>选择左侧知识源查看详情</p>
              </div>
            </div>
          ) : (
            <SourceDetail
              sourceId={selectedId}
              sources={sources}
              syncLogs={syncLogs}
              onSync={handleSync}
              onToggleEnabled={handleToggleEnabled}
              onResetStatus={handleResetStatus}
              onDelete={handleDelete}
              syncingIds={syncingIds}
              onRefresh={loadData}
              onAcknowledgeUpdate={handleAcknowledgeUpdate}
            />
          )}
        </div>
      </div>

      {showCreate && (
        <CreateSourceDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            loadData();
            onContentChange?.();
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="text-center p-2 rounded-lg bg-muted/50">
      <div className={`text-lg font-bold ${color || ''}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function SourceDetail({
  sourceId,
  sources,
  syncLogs,
  onSync,
  onToggleEnabled,
  onResetStatus,
  onDelete,
  syncingIds,
  onRefresh,
  onAcknowledgeUpdate,
}: {
  sourceId: number;
  sources: KnowledgeSourceItem[];
  syncLogs: KnowledgeSourceSyncLog[];
  onSync: (id: number) => void;
  onToggleEnabled: (source: KnowledgeSourceItem) => void;
  onResetStatus: (id: number) => void;
  onDelete: (id: number) => void;
  syncingIds: Set<number>;
  onRefresh?: () => void;
  onAcknowledgeUpdate: (id: number) => void;
}) {
  const source = sources.find(s => s.id === sourceId);
  if (!source) return null;

  const typeConf = TYPE_CONFIG[source.type] || TYPE_CONFIG.web;
  const TypeIcon = typeConf.icon;
  const isSyncing = source.lastSyncStatus === 'syncing';

  const [editing, setEditing] = useState(false);
  const [editSyncInterval, setEditSyncInterval] = useState(source.syncInterval);
  const [editMaxPages, setEditMaxPages] = useState(source.maxPages);
  const [editMaxDepth, setEditMaxDepth] = useState(source.maxDepth);
  const [editPreferMarkdown, setEditPreferMarkdown] = useState(source.preferMarkdown ?? true);
  const [editEnableJsRendering, setEditEnableJsRendering] = useState(source.enableJsRendering ?? false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  useEffect(() => {
    if (!editing) {
      setEditSyncInterval(source.syncInterval);
      setEditMaxPages(source.maxPages);
      setEditMaxDepth(source.maxDepth);
      setEditPreferMarkdown(source.preferMarkdown ?? true);
      setEditEnableJsRendering(source.enableJsRendering ?? false);
    }
  }, [source.syncInterval, source.maxPages, source.maxDepth, source.preferMarkdown, source.enableJsRendering, editing]);

  const handleSaveEdit = async () => {
    setEditError('');
    if (isNaN(editSyncInterval) || editSyncInterval < 1) { setEditError('同步间隔必须为正整数'); return; }
    if (isNaN(editMaxPages) || editMaxPages < 1) { setEditError('最大页面数必须为正整数'); return; }
    if (isNaN(editMaxDepth) || editMaxDepth < 1 || editMaxDepth > 5) { setEditError('爬取深度必须在 1-5 之间'); return; }
    setSaving(true);
    try {
      await updateKnowledgeSource(source.id, {
        syncInterval: editSyncInterval,
        maxPages: editMaxPages,
        maxDepth: editMaxDepth,
        preferMarkdown: editPreferMarkdown,
        enableJsRendering: editEnableJsRendering,
      });
      setEditing(false);
      onRefresh?.();
    } catch (err: any) {
      setEditError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditSyncInterval(source.syncInterval);
    setEditMaxPages(source.maxPages);
    setEditMaxDepth(source.maxDepth);
    setEditPreferMarkdown(source.preferMarkdown ?? true);
    setEditEnableJsRendering(source.enableJsRendering ?? false);
    setEditError('');
    setEditing(false);
  };

  return (
    <div className="p-4 space-y-4">
      {source.hasContentUpdate && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-900/30 dark:to-amber-900/30 border border-orange-200 dark:border-orange-800 shadow-sm">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-800/50 flex items-center justify-center">
            <Bell className="h-4 w-4 text-orange-600 dark:text-orange-400 animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-orange-800 dark:text-orange-300">
              检测到内容更新
            </div>
            <div className="text-xs text-orange-600 dark:text-orange-400 mt-0.5">
              飞书文档内容已变更，知识库已自动更新向量索引
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-800/50"
            onClick={() => onAcknowledgeUpdate(source.id)}
          >
            <BellOff className="h-3 w-3 mr-1" />
            我知道了
          </Button>
        </div>
      )}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <TypeIcon className={`h-4 w-4 ${typeConf.color}`} />
              {source.name}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isSyncing || syncingIds.has(source.id) || editing}
                onClick={() => onSync(source.id)}
              >
                <Play className="h-3 w-3 mr-1" />
                同步
              </Button>
              {isSyncing && (
                <Button variant="outline" size="sm" onClick={() => onResetStatus(source.id)}>
                  <RotateCcw className="h-3 w-3 mr-1" />
                  重置状态
                </Button>
              )}
              {!editing && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="h-3 w-3 mr-1" />
                  编辑
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <DetailRow label="类型" value={typeConf.label} />
            <DetailRow label="状态" value={
              <Badge variant={(STATUS_MAP[source.lastSyncStatus] || STATUS_MAP.idle).variant} className="text-xs">
                {isSyncing && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                {(STATUS_MAP[source.lastSyncStatus] || STATUS_MAP.idle).label}
              </Badge>
            } />
            {editing ? (
              <>
                <EditRow label="同步间隔(分)" value={editSyncInterval} onChange={setEditSyncInterval} min={1} />
                <EditRow label="最大页面数" value={editMaxPages} onChange={setEditMaxPages} min={1} />
                <EditRow label="爬取深度" value={editMaxDepth} onChange={setEditMaxDepth} min={1} max={5} />
                <div className="flex items-center justify-between py-1">
                  <span className="text-muted-foreground text-xs">优先 Markdown</span>
                  <Switch checked={editPreferMarkdown} onCheckedChange={setEditPreferMarkdown} />
                </div>
                {source.type === 'web' && (
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted-foreground text-xs">JS 渲染</span>
                    <Switch checked={editEnableJsRendering} onCheckedChange={setEditEnableJsRendering} />
                  </div>
                )}
              </>
            ) : (
              <>
                <DetailRow label="同步间隔" value={`${source.syncInterval} 分钟`} />
                <DetailRow label="最大页面数" value={`${source.maxPages}`} />
                <DetailRow label="爬取深度" value={`${source.maxDepth}`} />
                <DetailRow label="优先 Markdown" value={source.type === 'web' ? (source.preferMarkdown ? '开启' : '关闭') : '—'} />
                <DetailRow label="JS 渲染" value={source.type === 'web' ? (source.enableJsRendering ? '开启' : '关闭') : '—'} />
              </>
            )}
            <DetailRow label="最后同步" value={source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : '从未同步'} />
            <DetailRow label="启用状态" value={
              <Switch checked={source.enabled} onCheckedChange={() => onToggleEnabled(source)} />
            } />
          </div>

          {editing && (
            <div className="space-y-2 pt-1">
              {editError && (
                <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-xs">
                  <AlertCircle className="h-3 w-3 inline mr-1" />
                  {editError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={handleCancelEdit}>取消</Button>
                <Button size="sm" onClick={handleSaveEdit} disabled={saving}>
                  {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  保存
                </Button>
              </div>
            </div>
          )}

          {source.lastSyncError && (
            <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-xs">
              <AlertCircle className="h-3 w-3 inline mr-1" />
              {source.lastSyncError}
            </div>
          )}

          <div className="pt-2 border-t border-border/50">
            <div className="text-xs font-medium text-muted-foreground mb-2">配置信息</div>
            <SourceConfigDisplay type={source.type} config={source.config} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            同步日志
          </CardTitle>
        </CardHeader>
        <CardContent>
          {syncLogs.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground text-sm">暂无同步记录</div>
          ) : (
            <div className="space-y-2">
              {syncLogs.map(log => {
                const hasUpdates = (log.pagesUpdated && log.pagesUpdated > 0) || (log.pagesDeleted && log.pagesDeleted > 0);
                return (
                <div key={log.id} className={`py-2 border-b border-border/50 last:border-0 ${hasUpdates ? 'px-2 -mx-2 rounded-md bg-orange-50/50 dark:bg-orange-900/10' : ''}`}>
                  <div className="flex items-center gap-3">
                    <Badge
                      variant={log.status === 'success' ? 'outline' : log.status === 'failed' ? 'destructive' : 'default'}
                      className="text-xs shrink-0"
                    >
                      {log.status === 'success' ? '成功' : log.status === 'failed' ? '失败' : '运行中'}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs flex items-center gap-2 flex-wrap">
                        <span>获取 {log.pagesFetched} 页</span>
                        {log.pagesNew > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-green-600 dark:text-green-400">
                            <FilePlus className="h-3 w-3" />新增 {log.pagesNew} 页
                          </span>
                        )}
                        {log.pagesUpdated > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-orange-600 dark:text-orange-400 font-semibold">
                            <FileEdit className="h-3 w-3" />更新 {log.pagesUpdated} 页
                          </span>
                        )}
                        {log.pagesDeleted > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400">
                            <FileMinus className="h-3 w-3" />删除 {log.pagesDeleted} 页
                          </span>
                        )}
                        <span className="text-muted-foreground">· {log.chunksAdded} 新块 · {log.chunksUpdated} 更新块</span>
                      </div>
                      {hasUpdates && log.updatedPageDetails && log.updatedPageDetails.length > 0 && (
                        <div className="mt-1 p-1.5 rounded bg-orange-100/50 dark:bg-orange-800/20 border border-orange-200/50 dark:border-orange-700/30">
                          <div className="text-[10px] font-semibold text-orange-700 dark:text-orange-300 mb-0.5">变更的文档：</div>
                          {log.updatedPageDetails.map((p, i) => (
                            <div key={i} className="text-[10px] text-orange-600 dark:text-orange-400 truncate">
                              {p.title}
                            </div>
                          ))}
                        </div>
                      )}
                      {log.errorMessage && (
                        <div className="text-xs text-red-500 truncate" title={log.errorMessage}>{log.errorMessage}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(log.createdAt).toLocaleString()}
                        {log.startedAt && log.finishedAt && (
                          <span> · 耗时 {Math.round((new Date(log.finishedAt).getTime() - new Date(log.startedAt).getTime()) / 1000)}s</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="destructive" size="sm" onClick={() => onDelete(source.id)}>
          <Trash2 className="h-3 w-3 mr-1" />
          删除知识源
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-xs font-medium">{value}</span>
    </div>
  );
}

function EditRow({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <Input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        min={min}
        max={max}
        className="w-20 h-7 text-xs text-right"
      />
    </div>
  );
}

function SourceConfigDisplay({ type, config }: { type: string; config: Record<string, any> }) {
  const fields: Array<{ key: string; label: string; secret?: boolean }> = [];

  if (type === 'web') {
    fields.push({ key: 'startUrl', label: '起始 URL' });
    fields.push({ key: 'url', label: 'URL' });
  } else if (type === 'feishu') {
    fields.push({ key: 'appId', label: 'App ID' });
    fields.push({ key: 'appSecret', label: 'App Secret', secret: true });
    fields.push({ key: 'wikiSpaceId', label: 'Wiki 空间 ID' });
    fields.push({ key: 'docToken', label: '文档 Token' });
  }

  return (
    <div className="space-y-1">
      {fields.map(f => {
        const val = config?.[f.key];
        if (!val) return null;
        return (
          <div key={f.key} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{f.label}</span>
            <span className="font-mono text-[11px] max-w-[200px] truncate">
              {f.secret ? '••••••••' : String(val)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function parseFeishuConfig(text: string): Partial<Record<'appId' | 'appSecret' | 'wikiSpaceId' | 'docToken' | 'feishuDomain', string>> {
  const result: Partial<Record<'appId' | 'appSecret' | 'wikiSpaceId' | 'docToken' | 'feishuDomain', string>> = {};

  try {
    const json = JSON.parse(text);
    if (typeof json === 'object' && json !== null) {
      const keyMap: Record<string, 'appId' | 'appSecret' | 'wikiSpaceId' | 'docToken' | 'feishuDomain'> = {
        appId: 'appId', app_id: 'appId', 'App ID': 'appId', 'AppID': 'appId', appid: 'appId',
        appSecret: 'appSecret', app_secret: 'appSecret', 'App Secret': 'appSecret', 'AppSecret': 'appSecret', appsecret: 'appSecret', secret: 'appSecret',
        wikiSpaceId: 'wikiSpaceId', wiki_space_id: 'wikiSpaceId', 'Wiki 空间 ID': 'wikiSpaceId', 'Wiki Space Id': 'wikiSpaceId', wikispaceid: 'wikiSpaceId', spaceId: 'wikiSpaceId', space_id: 'wikiSpaceId',
        docToken: 'docToken', doc_token: 'docToken', '文档 Token': 'docToken', 'Doc Token': 'docToken', doctoken: 'docToken',
        feishuDomain: 'feishuDomain', feishu_domain: 'feishuDomain', '飞书域名': 'feishuDomain', domain: 'feishuDomain',
      };
      for (const [k, v] of Object.entries(json)) {
        if (typeof v === 'string' && keyMap[k]) {
          result[keyMap[k]] = v.trim();
        }
      }
      return result;
    }
  } catch {}

  const patterns: Array<{ regex: RegExp; key: 'appId' | 'appSecret' | 'wikiSpaceId' | 'docToken' | 'feishuDomain' }> = [
    { regex: /(?:App\s*ID|AppID|app_id|appId|appid)[\s]*[：:=]\s*([^\s,;，；\n]+)/i, key: 'appId' },
    { regex: /(?:App\s*Secret|AppSecret|app_secret|appSecret|appsecret|secret)[\s]*[：:=]\s*([^\s,;，；\n]+)/i, key: 'appSecret' },
    { regex: /(?:Wiki\s*空间\s*ID|Wiki\s*Space\s*Id|wiki_space_id|wikiSpaceId|wikispaceid|space_id|spaceId)[\s]*[：:=]\s*([^\s,;，；\n]+)/i, key: 'wikiSpaceId' },
    { regex: /(?:文档\s*Token|Doc\s*Token|doc_token|docToken|doctoken)[\s]*[：:=]\s*([^\s,;，；\n]+)/i, key: 'docToken' },
    { regex: /(?:飞书域名|feishu_domain|feishuDomain|domain)[\s]*[：:=]\s*([^\s,;，；\n]+)/i, key: 'feishuDomain' },
  ];

  for (const { regex, key } of patterns) {
    const match = text.match(regex);
    if (match && match[1]) {
      result[key] = match[1].trim();
    }
  }

  if (!result.appId) {
    const cliMatch = text.match(/(cli_[a-zA-Z0-9]+)/);
    if (cliMatch) result.appId = cliMatch[1];
  }

  if (!result.feishuDomain) {
    const domainMatch = text.match(/([a-zA-Z0-9-]+\.feishu\.cn)/);
    if (domainMatch) result.feishuDomain = domainMatch[1];
  }

  return result;
}

function CreateSourceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'web' | 'feishu'>('web');
  const [config, setConfig] = useState<Record<string, any>>({});
  const [syncInterval, setSyncInterval] = useState(60);
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(2);
  const [preferMarkdown, setPreferMarkdown] = useState(true);
  const [enableJsRendering, setEnableJsRendering] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [pasteSuccess, setPasteSuccess] = useState(false);

  const handlePasteAndParse = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        setError('剪贴板为空，请先复制包含飞书配置的文本');
        return;
      }
      const parsed = parseFeishuConfig(text.trim());
      const filledKeys = Object.keys(parsed) as Array<keyof typeof parsed>;
      if (filledKeys.length === 0) {
        setError('未能从剪贴板内容中识别出飞书配置信息，请检查复制的内容');
        return;
      }
      setConfig(prev => ({ ...prev, ...parsed }));
      setPasteSuccess(true);
      setError('');
      setTimeout(() => setPasteSuccess(false), 2000);
    } catch {
      setError('无法读取剪贴板，请手动粘贴到输入框');
    }
  };

  const handleCreate = async () => {
    setError('');
    if (!name.trim()) { setError('请输入名称'); return; }

    let finalConfig = { ...config };

    if (type === 'web') {
      if (!finalConfig.startUrl && !finalConfig.url) { setError('请输入起始 URL'); return; }
      if (!finalConfig.startUrl && finalConfig.url) {
        finalConfig.startUrl = finalConfig.url;
      }
    } else if (type === 'feishu') {
      if (!finalConfig.appId || !finalConfig.appSecret) { setError('请输入 App ID 和 App Secret'); return; }
      if (!finalConfig.wikiSpaceId && !finalConfig.docToken) { setError('请输入 Wiki 空间 ID 或文档 Token'); return; }
    }

    setCreating(true);
    try {
      await createKnowledgeSource({
        name: name.trim(),
        type,
        config: finalConfig,
        syncInterval,
        maxPages,
        maxDepth,
        preferMarkdown,
        enableJsRendering,
      });
      onCreated();
    } catch (err: any) {
      setError(err.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">添加知识源</h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
              <AlertCircle className="h-4 w-4 inline mr-1" />
              {error}
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-1 block">名称</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="例如：技术文档" />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">类型</label>
            <div className="flex gap-2">
              {Object.entries(TYPE_CONFIG).map(([key, conf]) => {
                const Icon = conf.icon;
                return (
                  <Button
                    key={key}
                    variant={type === key ? 'default' : 'outline'}
                    size="sm"
                    className="flex-1"
                    onClick={() => { setType(key as any); setConfig({}); }}
                  >
                    <Icon className={`h-4 w-4 mr-1 ${type !== key ? conf.color : ''}`} />
                    {conf.label}
                  </Button>
                );
              })}
            </div>
          </div>

          {type === 'web' && (
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">起始 URL</label>
                <Input value={config.startUrl || ''} onChange={e => setConfig({ ...config, startUrl: e.target.value })} placeholder="https://example.com/docs" />
              </div>
            </div>
          )}

          {type === 'feishu' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">飞书配置</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePasteAndParse}
                  className={`text-xs h-7 ${pasteSuccess ? 'border-green-400 text-green-600 dark:text-green-400' : ''}`}
                >
                  {pasteSuccess ? (
                    <>
                      <Check className="h-3.5 w-3.5 mr-1" />
                      已填充
                    </>
                  ) : (
                    <>
                      <ClipboardPaste className="h-3.5 w-3.5 mr-1" />
                      粘贴自动填充
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">
                复制包含 App ID、App Secret、Wiki 空间 ID 等字段的文本，点击按钮自动解析并填充
              </p>
              <div>
                <label className="text-sm font-medium mb-1 block">App ID</label>
                <Input value={config.appId || ''} onChange={e => setConfig({ ...config, appId: e.target.value })} placeholder="cli_xxxxx" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">App Secret</label>
                <Input type="password" value={config.appSecret || ''} onChange={e => setConfig({ ...config, appSecret: e.target.value })} placeholder="飞书应用密钥" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Wiki 空间 ID</label>
                <Input value={config.wikiSpaceId || ''} onChange={e => setConfig({ ...config, wikiSpaceId: e.target.value })} placeholder="知识空间 ID" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">文档 Token（可选）</label>
                <Input value={config.docToken || ''} onChange={e => setConfig({ ...config, docToken: e.target.value })} placeholder="单个文档的 Token" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">飞书域名（可选）</label>
                <Input value={config.feishuDomain || ''} onChange={e => setConfig({ ...config, feishuDomain: e.target.value })} placeholder="hcnmu4qh7w91.feishu.cn" />
              </div>
            </div>
          )}

          <div className="border-t border-border pt-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">同步间隔(分)</label>
                <Input type="number" value={syncInterval} onChange={e => setSyncInterval(Number(e.target.value))} min={1} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">最大页面数</label>
                <Input type="number" value={maxPages} onChange={e => setMaxPages(Number(e.target.value))} min={1} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">爬取深度</label>
                <Input type="number" value={maxDepth} onChange={e => setMaxDepth(Number(e.target.value))} min={1} max={5} />
              </div>
            </div>
            {type === 'web' && (
              <div className="flex items-center justify-between mt-3 py-1">
                <div>
                  <span className="text-sm font-medium">优先 Markdown</span>
                  <span className="text-xs text-muted-foreground ml-2">自动尝试获取 .md 优化版本</span>
                </div>
                <Switch checked={preferMarkdown} onCheckedChange={setPreferMarkdown} />
              </div>
            )}
            {type === 'web' && (
              <div className="flex items-center justify-between mt-1 py-1">
                <div>
                  <span className="text-sm font-medium">JS 渲染</span>
                  <span className="text-xs text-muted-foreground ml-2">用浏览器渲染 SPA 页面（较慢）</span>
                </div>
                <Switch checked={enableJsRendering} onCheckedChange={setEnableJsRendering} />
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={handleCreate} disabled={creating}>
            {creating && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            创建
          </Button>
        </div>
      </div>
    </div>
  );
}
