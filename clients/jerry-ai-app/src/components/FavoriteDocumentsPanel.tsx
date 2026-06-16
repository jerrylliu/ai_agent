/**
 * FavoriteDocumentsPanel — "我的收藏"面板
 *
 * 在侧边栏中以 Tab 形式展示用户收藏的所有文档（跨会话）。
 * 支持预览、下载、删除操作。
 *   - 点击文档条目 → 预览（DOCX → 下载）
 *   - 删除后同步刷新面板 + 通知对话中的 FileCard
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, Download, StarOff, AlertCircle, Loader2 } from 'lucide-react';
import { fetchFavoriteDocuments, setDocumentFavorite, type FavoriteDocument } from '../lib/api';
import { API_BASE_URL } from '../lib/constants';
import { useFavoriteDocContext } from '../contexts/FavoriteDocContext';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatRemaining(expiresAt: number): { text: string; expired: boolean; warning: boolean } {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return { text: '已过期', expired: true, warning: false };
  const hours = remainingMs / (1000 * 60 * 60);
  if (hours < 1) return { text: `还剩 ${Math.ceil(remainingMs / (1000 * 60))} 分钟`, expired: false, warning: true };
  if (hours < 24) return { text: `还剩 ${Math.ceil(hours)} 小时`, expired: false, warning: hours < 6 };
  return { text: `还剩 ${Math.ceil(hours / 24)} 天`, expired: false, warning: false };
}

function getFormatColor(format: string): string {
  switch (format.toLowerCase()) {
    case 'pdf': return 'text-red-600 dark:text-red-400';
    case 'docx': case 'doc': return 'text-blue-600 dark:text-blue-400';
    case 'html': case 'htm': return 'text-orange-600 dark:text-orange-400';
    default: return 'text-gray-600 dark:text-gray-400';
  }
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

export function FavoriteDocumentsPanel() {
  const ctx = useFavoriteDocContext();
  const [docs, setDocs] = useState<FavoriteDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null); // 预览/下载并发守卫
  const [opError, setOpError] = useState<string | null>(null); // 预览/下载/删除错误提示
  // 标记：本地面板删除后不需要重新请求后端（避免网络延迟覆盖本地即时更新）
  const skipNextRefreshRef = useRef(false);

  const loadFavorites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFavoriteDocuments();
      setDocs(data);
    } catch (err: any) {
      console.error('获取收藏文档失败：', err);
      setError('加载失败，请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  // 初始加载 + Context 版本变更时刷新（但跳过本地面板触发的删除刷新）
  useEffect(() => {
    if (skipNextRefreshRef.current) {
      skipNextRefreshRef.current = false;
      return;
    }
    loadFavorites();
  }, [loadFavorites, ctx.version]);

  /**
   * 从收藏列表移除 = 取消收藏（不删文件）
   * 取消收藏后的文档仍保留在对话的 FileCard 中，只是星标变灰
   */
  const handleRemoveFavorite = useCallback(async (doc: FavoriteDocument) => {
    const msg = `确定将"${doc.filename}"从收藏中移除吗？`;
    if (!window.confirm(msg)) return;

    setOpError(null);
    setDeletingKey(doc.key);
    try {
      const result = await setDocumentFavorite(doc.key, false);
      if (result.success) {
        // 通知对话中的 FileCard 同步把星标变灰
        ctx.notifyFavoriteChanged(doc.key, false);
        // 本地即时移除（不等重取）
        setDocs((prev) => prev.filter((d) => d.key !== doc.key));
        skipNextRefreshRef.current = true;
      } else {
        setOpError(result.message || '操作失败');
      }
    } catch (err: any) {
      console.error('取消收藏失败：', err);
      setOpError(`操作失败：${err?.message || err}`);
    } finally {
      setDeletingKey(null);
    }
  }, [ctx]);

  const handlePreviewOrDownload = useCallback(async (doc: FavoriteDocument) => {
    if (busyKey) return; // 并发守卫
    const url = `${API_BASE_URL}${doc.previewUrl}`;
    const dlUrl = `${API_BASE_URL}${doc.downloadUrl}`;
    const canPreview = ['pdf', 'html', 'htm'].includes(doc.format.toLowerCase());

    setOpError(null);
    setBusyKey(doc.key);
    try {
      if (!canPreview) {
        // DOCX：自动下载（Tauri 走系统对话框，浏览器走 Blob）
        if (isTauri()) {
          const { save } = await import('@tauri-apps/plugin-dialog');
          const { writeFile } = await import('@tauri-apps/plugin-fs');
          const ext = doc.format.toLowerCase();
          const filterName = ext === 'docx' ? 'Word' : '文件';
          const filePath = await save({ defaultPath: doc.filename, filters: [{ name: filterName, extensions: [ext] }] });
          if (!filePath) return;
          const resp = await fetch(dlUrl);
          if (!resp.ok) throw new Error(`请求失败：${resp.status}`);
          const buf = new Uint8Array(await resp.arrayBuffer());
          await writeFile(filePath, buf);
        } else {
          const a = document.createElement('a');
          a.href = dlUrl;
          a.download = doc.filename;
          a.click();
        }
        return;
      }

      // HEAD 探测文档是否存在
      const probe = await fetch(url, { method: 'HEAD' });
      if (!probe.ok) {
        throw new Error(probe.status === 404 ? '文档不存在或已过期' : `请求失败：${probe.status}`);
      }

      if (isTauri()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
      } else {
        const win = window.open(url, '_blank', 'noopener,noreferrer');
        if (!win) throw new Error('浏览器拦截了弹出窗口，请允许后重试');
      }
    } catch (err: any) {
      console.error('预览/下载失败：', err);
      setOpError(`操作失败：${err?.message || err}`);
    } finally {
      setBusyKey(null);
    }
  }, [busyKey]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {/* 标题 */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground">我的收藏</h3>
        <button
          type="button"
          onClick={loadFavorites}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="刷新"
          disabled={loading}
        >
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {/* 操作错误提示（预览/下载/删除） */}
      {opError && (
        <div className="flex items-start gap-2 px-2 py-1.5 mb-2 text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 rounded border border-red-200 dark:border-red-900">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{opError}</span>
          <button
            type="button"
            onClick={() => setOpError(null)}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-300 font-medium"
            aria-label="关闭错误提示"
          >
            ×
          </button>
        </div>
      )}

      {/* 加载中 */}
      {loading && docs.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* 错误 */}
      {error && docs.length === 0 && (
        <div className="flex flex-col items-center py-8 gap-2">
          <AlertCircle className="h-5 w-5 text-red-500" />
          <p className="text-xs text-muted-foreground">{error}</p>
          <button type="button" onClick={loadFavorites} className="text-xs text-primary hover:underline">重试</button>
        </div>
      )}

      {/* 空状态 */}
      {!loading && !error && docs.length === 0 && (
        <div className="flex flex-col items-center py-8 gap-2 text-muted-foreground">
          <FileText className="h-6 w-6 opacity-40" />
          <p className="text-xs">暂无收藏文档</p>
          <p className="text-xs opacity-60">在对话中点击星标即可收藏</p>
        </div>
      )}

      {/* 文档列表 */}
      {docs.length > 0 && (
        <div className="space-y-2">
          {docs.map((doc) => {
            const remaining = formatRemaining(doc.expiresAt);
            const formatColor = getFormatColor(doc.format);
            const canPreview = ['pdf', 'html', 'htm'].includes(doc.format.toLowerCase());
            const isDeleting = deletingKey === doc.key;

            return (
              <div
                key={doc.key}
                className="rounded-lg border border-border bg-card p-2 hover:bg-muted/30 dark:hover:bg-muted/10 cursor-pointer transition-colors group"
                onClick={() => handlePreviewOrDownload(doc)}
                title={canPreview ? '点击预览' : '点击下载'}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePreviewOrDownload(doc); } }}
              >
                <div className="flex items-start gap-2">
                  <FileText className={`h-5 w-5 mt-0.5 shrink-0 ${formatColor}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{doc.filename}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <span className={formatColor}>{doc.format.toUpperCase()}</span>
                      <span>·</span>
                      <span>{formatSize(doc.sizeBytes)}</span>
                      <span>·</span>
                      <span className={remaining.expired ? 'text-red-500' : remaining.warning ? 'text-amber-500' : ''}>
                        {remaining.text}
                      </span>
                    </div>
                  </div>

                  {/* 操作区：不冒泡到预览 */}
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                    {/* 下载 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const dlUrl = `${API_BASE_URL}${doc.downloadUrl}`;
                        if (isTauri()) {
                          (async () => {
                            const { save } = await import('@tauri-apps/plugin-dialog');
                            const { writeFile } = await import('@tauri-apps/plugin-fs');
                            const ext = doc.format.toLowerCase();
                            const filterName = ext === 'pdf' ? 'PDF' : ext === 'docx' ? 'Word' : ext === 'html' ? 'HTML' : '文件';
                            const filePath = await save({ defaultPath: doc.filename, filters: [{ name: filterName, extensions: [ext] }] });
                            if (!filePath) return;
                            const resp = await fetch(dlUrl);
                            if (!resp.ok) return;
                            const buf = new Uint8Array(await resp.arrayBuffer());
                            await writeFile(filePath, buf);
                          })();
                        } else {
                          const a = document.createElement('a');
                          a.href = dlUrl;
                          a.download = doc.filename;
                          a.click();
                        }
                      }}
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title="下载"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>

                    {/* 取消收藏 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveFavorite(doc);
                      }}
                      disabled={isDeleting}
                      className="p-1 rounded text-muted-foreground hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors disabled:opacity-50"
                      title="取消收藏"
                    >
                      {isDeleting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <StarOff className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
