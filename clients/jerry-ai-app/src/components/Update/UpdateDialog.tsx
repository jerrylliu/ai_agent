import { RefreshCw, X } from "lucide-react";

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
  // 按钮文案统一为「立即更新」：各端行为差异改由下方说明文字交代。
  // 原来的「立即更新（下载安装包）」有 10 个全角字宽，逼得主按钮必须比次要按钮宽一倍，
  // 且按钮内还要塞一个 Download 图标（占位 20px 把文字整体右顶 10px）—— 这正是
  // 「两个按钮宽窄不一致、按钮内文字不居中偏右」的来源
  const buttonLabel = installing ? "正在下载更新…" : "立即更新";

  return (
    <div
      // 安全区留白：手机上避免弹窗贴到状态栏/手势条（左右兼容横屏刘海；
      // --safe-left/right 尚未定义时回退 0，行为等同普通 padding）
      className="fixed inset-0 z-50 flex items-center justify-center p-4 pt-[max(1rem,var(--safe-top,0px))] pb-[max(1rem,var(--safe-bottom,0px))] pl-[max(1rem,var(--safe-left,0px))] pr-[max(1rem,var(--safe-right,0px))]"
      // 强制更新时点击遮罩不关闭
      onClick={update.force ? undefined : onClose}
    >
      {/* 半透明遮罩 */}
      <div className="absolute inset-0 bg-black/50" />
      <div
        // max-h-full + 内部滚动：矮屏（如手机横屏）内容放不下时滚动而不是溢出屏幕
        className="relative w-[min(92vw,420px)] max-h-full overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 可选关闭按钮 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
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
              // h-6 与标题 24px 行高同高，视觉中心对齐（原 16px 无内边距图标显得偏上）
              className="shrink-0 -mr-1 -mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
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

        {/* 更新方式说明：两端行为不同，统一用一行说明文字交代（按钮文案因此可以保持简短） */}
        <p className="text-xs text-muted-foreground mt-2.5 leading-relaxed">
          {isAndroid
            ? "将跳转浏览器下载安装包，下载完成后请手动打开安装。"
            : "将在后台静默下载，完成后自动重启完成安装。"}
        </p>

        {/* 操作区：窄屏（<640px）竖排、按钮全宽（原实现横排且按钮默认可收缩 flex-shrink:1，
            在 ≤367px 屏宽下被压到文字折行两行、按钮高度 32→52px —— 手机端畸形的根因）；
            宽屏（≥640px）两按钮 sm:flex-1 等宽平分整行，视觉重量平衡。
            按钮内不再放 Download 图标：图标占位 20px 会把文字整体右顶 10px，
            造成「文字不居中、看着歪」；转圈图标只在下载中短暂出现 */}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row">
          {!update.force && (
            <button
              type="button"
              onClick={onClose}
              disabled={installing}
              className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed sm:flex-1"
            >
              稍后再说
            </button>
          )}
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed sm:flex-1"
          >
            {installing && <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />}
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
