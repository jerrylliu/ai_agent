import { useCallback, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { fetchLatestVersion } from "../lib/api";
import { API_BASE_URL } from "../lib/constants";
import { compareVersions, isAndroidPlatform } from "../lib/update";
import type { UpdateAvailable } from "../types/update";

// ==================== useUpdateCheck：应用版本更新检测 Hook ====================
//
// 职责：
//   1. 启动时 / 手动触发时检测新版本（桌面走 Tauri updater 插件静默清单校验，
//      安卓走 version.json 静态文件比对）
//   2. 归一化两端的更新结果为 UpdateAvailable，供 UpdateDialog 展示
//   3. 执行更新：桌面 = 静默下载 + 重启安装；安卓 = 跳系统浏览器下载 APK
//
// 设计约束：
//   - 检测失败（网络断 / 版本文件缺失 / 插件异常）一律静默：更新检测是增强能力，
//     绝不能干扰正常使用；仅手动触发时把失败原因透出给设置页展示
//   - 浏览器环境（官网直开）getVersion 会抛异常，直接按「非 Tauri 环境」跳过

export interface UseUpdateCheckResult {
  /** 当前待展示的更新（null = 无更新或未检测） */
  update: UpdateAvailable | null;
  /** 当前已安装版本号（Tauri 环境检测后可得；浏览器环境为 null） */
  currentVersion: string | null;
  /** 检测进行中（按钮 loading 态） */
  checking: boolean;
  /** 桌面端正在下载更新包 */
  installing: boolean;
  /** 手动检测的反馈文案（「已是最新」/ 失败原因），供设置页展示 */
  manualFeedback: string | null;
  /** 触发一次检测；manual = true 时把结果/失败原因写入 manualFeedback */
  checkForUpdate: (manual?: boolean) => Promise<void>;
  /** 执行更新（桌面下载并重启；安卓跳浏览器） */
  installUpdate: () => Promise<void>;
  /** 关闭更新弹窗（force 更新时弹窗不提供关闭入口） */
  dismissUpdate: () => void;
  /** 启动时自动检测（生命周期内仅一次，延迟 3 秒避开首屏） */
  autoCheck: () => void;
}

export function useUpdateCheck(): UseUpdateCheckResult {
  const [update, setUpdate] = useState<UpdateAvailable | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [manualFeedback, setManualFeedback] = useState<string | null>(null);
  // 应用生命周期内只自动检测一次（StrictMode 下 effect 双跑防抖）
  const autoCheckedRef = useRef(false);

  const checkForUpdate = useCallback(async (manual = false): Promise<void> => {
    if (checking) return;
    setChecking(true);
    if (manual) setManualFeedback(null);
    try {
      // 当前安装版本：Tauri 环境读应用元数据；拿不到（浏览器环境）视为无法检测
      let current: string;
      try {
        current = await getVersion();
        setCurrentVersion(current);
      } catch {
        if (manual) setManualFeedback("仅应用内支持检查更新");
        return;
      }

      let found: UpdateAvailable | null = null;

      if (isAndroidPlatform()) {
        // 安卓：version.json 静态比对（系统限制无法静默安装，跳浏览器下载）
        const info = await fetchLatestVersion();
        if (info && compareVersions(info.version, current) > 0) {
          found = {
            version: info.version,
            currentVersion: current,
            notes: info.notes,
            force: info.force === true,
            channel: "android",
            androidUrl: `${API_BASE_URL}${info.downloads.android}`,
          };
        }
      } else {
        // 桌面：updater 插件拉取 latest.json 并校验签名，返回 null 表示已是最新
        const result: Update | null = await check();
        if (result) {
          found = {
            version: result.version,
            currentVersion: current,
            notes: result.body || undefined,
            force: false,
            channel: "desktop",
            desktopUpdate: result,
          };
        }
      }

      if (found) {
        setUpdate(found);
        if (manual) setManualFeedback(null);
      } else if (manual) {
        setManualFeedback("当前已是最新版本");
      }
    } catch (err) {
      // 检测失败静默化：自动触发时完全无感，手动触发时给出可读原因
      if (manual) {
        const reason = err instanceof Error ? err.message : String(err);
        setManualFeedback(`检查更新失败：${reason}`);
      }
    } finally {
      setChecking(false);
    }
  }, [checking]);

  const installUpdate = useCallback(async (): Promise<void> => {
    if (!update || installing) return;
    if (update.channel === "desktop") {
      // 桌面：静默下载（passive 模式下 NSIS 自带进度 UI），完成后重启进新版本
      setInstalling(true);
      try {
        const desktopUpdate = update.desktopUpdate as Update;
        await desktopUpdate.downloadAndInstall();
        await relaunch();
      } catch {
        // 下载/安装失败保留弹窗，用户可重试或稍后再说
        setInstalling(false);
      }
      return;
    }
    // 安卓：跳系统浏览器下载 APK，安装由用户在系统层完成
    if (update.androidUrl) {
      try {
        // 与项目其他跳转一致：动态导入 opener（保持既有 chunk 划分），失败退回 window.open
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(update.androidUrl);
      } catch {
        window.open(update.androidUrl, "_blank", "noopener,noreferrer");
      }
    }
  }, [update, installing]);

  const dismissUpdate = useCallback((): void => {
    // 强制更新不允许关闭，只能升级
    if (update?.force) return;
    setUpdate(null);
  }, [update]);

  const autoCheck = useCallback((): void => {
    if (autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    // 延迟 3 秒：避开启动瞬间的网络高峰与首屏渲染，降低存在感
    window.setTimeout(() => {
      void checkForUpdate(false);
    }, 3000);
  }, [checkForUpdate]);

  return {
    update,
    currentVersion,
    checking,
    installing,
    manualFeedback,
    checkForUpdate,
    installUpdate,
    dismissUpdate,
    autoCheck,
  };
}
