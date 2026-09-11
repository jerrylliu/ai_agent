// ==================== 应用版本更新相关类型 ====================

/**
 * 服务端版本信息文件（docker/data/download/version.json）结构。
 * 由发布流程手工维护：每次发新版除了上传安装包，必须同步更新该文件，
 * 否则老客户端永远收不到更新提示。
 */
export interface AppVersionInfo {
  /** 最新版本号（semver，如 0.1.2） */
  version: string;
  /** 发布日期（YYYY-MM-DD） */
  pubDate: string;
  /** 更新说明（中文，弹窗中展示给用户） */
  notes?: string;
  /** 强制更新：为 true 时弹窗不可关闭，必须升级（接口不兼容旧版时使用） */
  force?: boolean;
  /** 各端安装包相对路径（客户端拼接 API_BASE_URL 使用，换域名不用改文件） */
  downloads: {
    /** 安卓 APK 相对路径，如 /download/以太忆核_0.1.2_arm64.apk */
    android: string;
    /** Windows 安装包相对路径，如 /download/以太忆核_0.1.2_x64-setup.exe */
    windows: string;
  };
}

/** 统一后的更新信息（桌面/安卓两端的检测结果归一化，供弹窗组件消费） */
export interface UpdateAvailable {
  /** 最新版本号 */
  version: string;
  /** 当前已安装版本号 */
  currentVersion: string;
  /** 更新说明 */
  notes?: string;
  /** 是否强制更新 */
  force: boolean;
  /** 更新方式：desktop = 静默下载后重启安装；android = 跳系统浏览器下载 APK */
  channel: "desktop" | "android";
  /**
   * 桌面端 updater 插件返回的更新对象（含 downloadAndInstall 方法）。
   * 安卓端为 undefined（走浏览器下载链接）。
   * 用 unknown 弱化第三方类型，避免插件类型泄漏到 UI 层。
   */
  desktopUpdate?: unknown;
  /** 安卓端 APK 完整下载地址（channel = android 时存在） */
  androidUrl?: string;
}
