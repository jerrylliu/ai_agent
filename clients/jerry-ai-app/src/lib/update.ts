// ==================== 版本比较与平台判断工具 ====================

/**
 * 语义化版本号比较（仅支持数字段，如 0.1.2 > 0.1.10）。
 * @returns left > right 返回 1；left < right 返回 -1；相等返回 0
 */
export function compareVersions(left: string, right: string): number {
  // 逐段转数字比较，缺失段按 0 处理（0.1 与 0.1.0 等价）
  const segL = left.split(".").map((s) => parseInt(s, 10) || 0);
  const segR = right.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(segL.length, segR.length);
  for (let i = 0; i < len; i++) {
    const l = segL[i] ?? 0;
    const r = segR[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

/**
 * 判断当前是否运行在安卓端（Tauri WebView 的 UA 含 Android 标识）。
 * 桌面 WebView2/WebKit 的 UA 均不含 "Android"，浏览器直接访问官网时
 * 无需更新检测（调用方保证仅在 Tauri 环境调用）。
 */
export function isAndroidPlatform(): boolean {
  return navigator.userAgent.includes("Android");
}
