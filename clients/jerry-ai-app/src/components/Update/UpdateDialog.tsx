import { Download, RefreshCw, X } from "lucide-react";

import type { UpdateAvailable } from "@/types/update";

// ==================== UpdateDialog：版本更新提示弹窗 ====================
//
// 桌面端：展示新版说明，「立即更新」后台静默下载后自动重启安装
// 安卓端：「立即更新」跳系统浏览器下载 APK（系统限制无法应用内静默安装）
// 强制更新（force=true）：不渲染关闭按钮、遮罩点击不关闭

interface UpdateDialogProps {
  update: UpdateAvailable;
  /** 桌面端下载/安装进行中（按钮转 loading 并禁用） */
  installing: boolean;
  onInstall: () => void;
  onClose: () => void;
}

export function UpdateDialog({ update, installing, onInstall, onClose }: UpdateDialogProps) {
  const isAndroid = update.channel === "android";
  const buttonLabel = installing
    ? "正在下载更新…"
    : isAndroid
      ? "立即更新（下载安装包）"
      : "立即更新（自动安装）";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      // 强制更新时点击遮罩不关闭
      onClick={update.force ? undefined : onClose}
    >
      {/* 半透明遮罩 */}
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-[min(92vw,420px)] rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 可选关闭按钮 */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground cyberpunk-ms-text">
              发现新版本 v{update.version}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              当前版本 v{update.currentVersion}
              {update.force ? " · 需强制更新" : ""}
            </p>
          </div>
          {!update.force && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* 更新说明 */}
        {update.notes && (
          <div className="mt-3 max-h-40 overflow-y-auto rounded-md bg-muted/50 px-3 py-2.5">
            <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
              {update.notes}
            </p>
          </div>
        )}

        {/* 安卓端提示：跳浏览器后由用户手动安装 */}
        {isAndroid && (
          <p className="text-xs text-muted-foreground mt-2.5 leading-relaxed">
            将跳转浏览器下载安装包，下载完成后请手动打开安装。
          </p>
        )}

        {/* 操作区 */}
        <div className="mt-4 flex items-center justify-end gap-2">
          {!update.force && (
            <button
              type="button"
              onClick={onClose}
              disabled={installing}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              稍后再说
            </button>
          )}
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {installing ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
