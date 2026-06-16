/**
 * FileCard 组件
 *
 * 渲染 generate_document 工具产出的文件卡片：
 * - 点击卡片主体（图标 + 元数据区）→ 预览（DOCX 则自动下载）
 * - 下载按钮：Tauri 走系统保存对话框，浏览器走 Blob
 * - 收藏按钮（★）：常驻卡片，收藏后永不过期，不参与自动清理
 * - ⋮ 菜单：删除（红色，需确认）
 *
 * hover 效果 + cursor:pointer 暗示卡片可交互。
 */
import { useEffect, useState, useCallback } from 'react';
import { FileText, Download, Clock, AlertCircle, Star, Trash2 } from 'lucide-react';
import type { MessageAttachment } from '../types/session';
import { API_BASE_URL } from '../lib/constants';
import { deleteGeneratedDocument, setDocumentFavorite } from '../lib/api';
import { PopupMenu, type PopupMenuItem } from './PopupMenu';
import { useFavoriteDocContext } from '../contexts/FavoriteDocContext';

interface FileCardProps {
  attachment: MessageAttachment;
  /** 删除成功后的回调，由父组件更新消息列表 */
  onDelete?: (key: string) => void;
  /** 收藏状态变更后的回调，由父组件更新消息列表 */
  onFavoriteChange?: (key: string, favorited: boolean) => void;
}

/* ============== 纯工具函数（组件外定义，避免每次 render 重建） ============== */

function getFormatStyle(format: string): { color: string; bg: string; label: string } {
  switch (format.toLowerCase()) {
    case 'pdf':
      return { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950/40', label: 'PDF' };
    case 'docx':
    case 'doc':
      return { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/40', label: 'Word' };
    case 'html':
    case 'htm':
      return { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950/40', label: 'HTML' };
    default:
      return { color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900', label: format.toUpperCase() };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatRemaining(expiresAt: number, favorited?: boolean): { text: string; expired: boolean; warning: boolean } {
  if (favorited) return { text: '已收藏·永不过期', expired: false, warning: false };
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return { text: '已过期', expired: true, warning: false };
  const hours = remainingMs / (1000 * 60 * 60);
  if (hours < 1) {
    const minutes = Math.ceil(remainingMs / (1000 * 60));
    return { text: `还剩 ${minutes} 分钟`, expired: false, warning: true };
  }
  if (hours < 24) {
    return { text: `还剩 ${Math.ceil(hours)} 小时`, expired: false, warning: hours < 6 };
  }
  return { text: `还剩 ${Math.ceil(hours / 24)} 天`, expired: false, warning: false };
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

async function readErrorMessage(resp: Response): Promise<string> {
  try {
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await resp.json();
      if (data?.message) return String(data.message);
    }
  } catch { /* ignore */ }
  if (resp.status === 404) return '文档不存在或已过期';
  return `请求失败：${resp.status}`;
}

async function browserDownload(url: string, filename: string): Promise<void> {
  const resp = await fetch(url, { headers: { Accept: 'application/json, application/octet-stream' } });
  if (!resp.ok) throw new Error(await readErrorMessage(resp));
  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
}

async function tauriDownload(url: string, filename: string, format: string): Promise<void> {
  const probe = await probeDocumentExists(url);
  if (!probe.ok) throw new Error(probe.message || '文档不可用');
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const ext = format.toLowerCase();
  const filterName = ext === 'pdf' ? 'PDF' : ext === 'docx' ? 'Word' : ext === 'html' ? 'HTML' : '文件';
  const filePath = await save({
    defaultPath: filename,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!filePath) return;
  const resp = await fetch(url, { headers: { Accept: 'application/json, application/octet-stream' } });
  if (!resp.ok) throw new Error(await readErrorMessage(resp));
  const buf = new Uint8Array(await resp.arrayBuffer());
  await writeFile(filePath, buf);
}

async function tauriOpenUrl(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

async function probeDocumentExists(url: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const resp = await fetch(url, { method: 'HEAD', headers: { Accept: 'application/json, application/octet-stream' } });
    if (resp.ok) return { ok: true };
    if (resp.status === 404) return { ok: false, message: '文档不存在或已过期' };
    return { ok: false, message: `请求失败：${resp.status}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || '网络错误' };
  }
}

/* ============== 组件主体 ============== */

export function FileCard({ attachment, onDelete, onFavoriteChange }: FileCardProps) {
  const style = getFormatStyle(attachment.format);
  const ctx = useFavoriteDocContext();

  const [favorited, setFavorited] = useState(!!attachment.favorited);
  const [remaining, setRemaining] = useState(() => formatRemaining(attachment.expiresAt, favorited));
  const [downloading, setDownloading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 跨组件同步：监听收藏状态覆盖值（来自"我的收藏"面板的取消收藏操作）
  // 必须先变 UI，否则用户回到聊天看到星标仍亮，再点会基于旧状态发起一次"取消收藏 → 收藏"请求，
  // 在登录态/属主校验失败时还会触发后端 userId 不匹配告警。
  useEffect(() => {
    const override = ctx.favoriteOverridesRef.current.get(attachment.key);
    if (override !== undefined && override !== favorited) {
      setFavorited(override);
      onFavoriteChange?.(attachment.key, override);
    }
  }, [ctx.version, attachment.key, ctx.favoriteOverridesRef, favorited, onFavoriteChange]);

  // attachment.favorited prop 变化时，同步本地 state（例如父组件重置 attachments）
  useEffect(() => {
    setFavorited(!!attachment.favorited);
  }, [attachment.favorited]);

  // 每分钟刷新一次倒计时
  useEffect(() => {
    setRemaining(formatRemaining(attachment.expiresAt, favorited));
    const timer = setInterval(() => {
      setRemaining(formatRemaining(attachment.expiresAt, favorited));
    }, 60 * 1000);
    return () => clearInterval(timer);
  }, [attachment.expiresAt, favorited]);

  const downloadHref = `${API_BASE_URL}${attachment.downloadUrl}`;
  const previewHref = `${API_BASE_URL}${attachment.previewUrl}`;
  const canPreview = ['pdf', 'html', 'htm'].includes(attachment.format.toLowerCase());
  const isAvailable = favorited || !remaining.expired;

  const handleDownload = useCallback(async () => {
    if (!isAvailable || downloading) return;
    setErrorMsg(null);
    setDownloading(true);
    try {
      if (isTauri()) {
        await tauriDownload(downloadHref, attachment.filename, attachment.format);
      } else {
        await browserDownload(downloadHref, attachment.filename);
      }
    } catch (err: any) {
      console.error('文件下载失败：', err);
      setErrorMsg(`下载失败：${err?.message || err}`);
    } finally {
      setDownloading(false);
    }
  }, [isAvailable, downloading, downloadHref, attachment.filename, attachment.format]);

  // 预览逻辑：PDF/HTML → 打开预览；DOCX → 自动触发下载
  const handlePreview = useCallback(async () => {
    if (!isAvailable || previewing) return;
    setErrorMsg(null);

    // DOCX：不支持浏览器预览，点击卡身自动触发下载
    if (!canPreview) {
      setPreviewing(true);
      try {
        await handleDownload();
      } finally {
        setPreviewing(false);
      }
      return;
    }

    setPreviewing(true);
    try {
      const probe = await probeDocumentExists(previewHref);
      if (!probe.ok) throw new Error(probe.message || '文档不可用');
      if (isTauri()) {
        await tauriOpenUrl(previewHref);
      } else {
        const win = window.open(previewHref, '_blank', 'noopener,noreferrer');
        if (!win) throw new Error('浏览器拦截了弹出窗口，请允许后重试');
      }
    } catch (err: any) {
      console.error('文件预览失败：', err);
      setErrorMsg(`预览失败：${err?.message || err}`);
    } finally {
      setPreviewing(false);
    }
  }, [canPreview, isAvailable, previewing, previewHref, handleDownload]);

  const handleFavorite = useCallback(async () => {
    setErrorMsg(null);
    const newFav = !favorited;
    try {
      const result = await setDocumentFavorite(attachment.key, newFav);
      if (result.success) {
        setFavorited(result.favorited);
        onFavoriteChange?.(attachment.key, result.favorited);
        // 通知"我的收藏"面板刷新，并把新值写入 overrides 让同 key 的其它 FileCard 同步
        ctx.notifyFavoriteChanged(attachment.key, result.favorited);
      } else {
        setErrorMsg(result.message || '操作失败');
      }
    } catch (err: any) {
      console.error('收藏操作失败：', err);
      setErrorMsg(`收藏失败：${err?.message || err}`);
    }
  }, [favorited, attachment.key, onFavoriteChange, ctx]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    const msg = favorited
      ? `确定删除收藏文档"${attachment.filename}"吗？此操作不可恢复。`
      : `确定删除"${attachment.filename}"吗？此操作不可恢复。`;
    if (!window.confirm(msg)) return;

    setDeleting(true);
    setErrorMsg(null);
    try {
      const result = await deleteGeneratedDocument(attachment.key);
      if (result.success) {
        ctx.notifyChange(); // 通知"我的收藏"面板刷新
        onDelete?.(attachment.key);
      } else {
        setErrorMsg(result.message || '删除失败');
      }
    } catch (err: any) {
      console.error('文件删除失败：', err);
      setErrorMsg(`删除失败：${err?.message || err}`);
    } finally {
      setDeleting(false);
    }
  }, [favorited, attachment.key, attachment.filename, onDelete, ctx, deleting]);

  // ⋮ 菜单项（仅"删除"一项）
  const menuItems: PopupMenuItem[] = [
    {
      id: 'delete',
      label: '删除文件',
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      onClick: handleDelete,
    },
  ];

  // 判断是否可以预览 (PDF/HTML 可预览，DOCX 点击则下载)
  const clickableHint = canPreview
    ? '点击预览'
    : '点击下载';

  return (
    <div
      className={`my-3 rounded-xl border shadow-sm overflow-hidden transition-colors ${
        favorited
          ? 'border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20'
          : 'border-border bg-card text-card-foreground'
      }`}
    >
      <div className="flex items-stretch">
        {/* 左侧图标块 + 中间元信息 → 点击预览（DOCX → 下载） */}
        <div
          className={`flex flex-1 min-w-0 items-stretch cursor-pointer group ${
            isAvailable
              ? 'hover:bg-muted/30 dark:hover:bg-muted/10'
              : 'cursor-default'
          }`}
          onClick={isAvailable ? handlePreview : undefined}
          title={isAvailable ? clickableHint : '已过期'}
          role={isAvailable ? 'button' : undefined}
          tabIndex={isAvailable ? 0 : undefined}
          onKeyDown={isAvailable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePreview(); } } : undefined}
        >
          {/* 图标 */}
          <div className={`flex items-center justify-center px-4 ${style.bg}`}>
            <FileText className={`h-8 w-8 ${style.color}`} aria-hidden="true" />
          </div>

          {/* 元信息 */}
          <div className="flex-1 min-w-0 px-4 py-3">
            <div className="font-medium text-sm truncate filecard-title" title={attachment.filename}>
              {attachment.filename}
              {favorited && <Star className="inline h-3.5 w-3.5 ml-1 text-amber-500 fill-amber-500" />}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`px-1.5 py-0.5 rounded ${style.bg} ${style.color} font-medium`}>
                {style.label}
              </span>
              <span>·</span>
              <span>{formatSize(attachment.sizeBytes)}</span>
              <span>·</span>
              <span
                className={`inline-flex items-center gap-1 ${
                  remaining.expired && !favorited
                    ? 'text-red-500'
                    : remaining.warning
                    ? 'text-amber-500'
                    : favorited
                    ? 'text-amber-600 dark:text-amber-400'
                    : ''
                }`}
              >
                {remaining.expired && !favorited ? (
                  <AlertCircle className="h-3 w-3" />
                ) : (
                  <Clock className="h-3 w-3" />
                )}
                {remaining.text}
              </span>
            </div>
          </div>
        </div>

        {/* 右侧操作按钮 */}
        <div className="flex items-center gap-1 pr-2" onClick={(e) => e.stopPropagation()}>
          {/* 收藏 */}
          <button
            type="button"
            onClick={handleFavorite}
            className={`inline-flex items-center justify-center p-1.5 text-xs rounded-md transition-colors ${
              favorited
                ? 'text-amber-500 hover:text-amber-600'
                : 'text-muted-foreground hover:text-amber-500'
            }`}
            title={favorited ? '取消收藏（取消后将恢复自动过期）' : '收藏（收藏后永不过期，不被自动清理）'}
          >
            <Star className={`h-4 w-4 ${favorited ? 'fill-amber-500' : ''}`} />
          </button>

          {/* 下载 */}
          <button
            type="button"
            onClick={handleDownload}
            disabled={!isAvailable || downloading}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors filecard-download-btn ${
              !isAvailable
                ? 'opacity-40 border border-border cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-wait'
            }`}
            title={!isAvailable ? '已过期，请重新生成' : downloading ? '正在下载...' : '下载文件'}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{downloading ? '下载中' : '下载'}</span>
          </button>

          {/* 省略号菜单 */}
          <PopupMenu items={menuItems} label="更多操作" />
        </div>
      </div>

      {/* 错误提示条 */}
      {errorMsg && (
        <div className="flex items-start gap-2 px-4 py-2 text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-t border-red-200 dark:border-red-900">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-300 font-medium"
            aria-label="关闭错误提示"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
