import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { FeatureDefaults } from '@/lib/api';

export interface AppSettings {
  memoryEnabled: boolean;
  summaryEnabled: boolean;
  injectMemoryOnNewSession: boolean;
  imageModel: 'wan2.7-image' | 'wan2.7-image-pro';
  /** 编辑器 AI 自动补全开关（关闭后不再触发幽灵补全请求） */
  autoCompleteEnabled: boolean;
}

/**
 * 服务端可广播全局默认的功能键。
 * 这三个开关已升级为「服务端全局默认」（runtime-config.json 的 features 区块）：
 * AI 工具（toggle_feature）或任意端改全局默认后，未自定义过的设备自动跟随。
 */
export type ServerFeatureKey =
  | 'memoryEnabled'
  | 'summaryEnabled'
  | 'injectMemoryOnNewSession';

const SERVER_FEATURE_KEYS: ServerFeatureKey[] = [
  'memoryEnabled',
  'summaryEnabled',
  'injectMemoryOnNewSession',
];

function isServerFeatureKey(key: string): key is ServerFeatureKey {
  return (SERVER_FEATURE_KEYS as string[]).includes(key);
}

interface SettingsState extends AppSettings {
  /**
   * 本设备手动改过的功能键：这些键不再跟随服务端全局默认，
   * 保持本地值（每设备独立）。从未改过的设备跟随全局默认。
   */
  customizedFeatures: string[];
  updateSettings: (settings: AppSettings) => void;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  /** 用服务端全局默认覆盖本设备未自定义的功能键（启动 / SSE settings_changed 时调用） */
  applyServerDefaults: (defaults: FeatureDefaults) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      memoryEnabled: true,
      summaryEnabled: true,
      injectMemoryOnNewSession: true,
      imageModel: 'wan2.7-image-pro',
      autoCompleteEnabled: true,
      customizedFeatures: [],

      updateSettings: (settings) =>
        set((state) => {
          // 全量替换路径（设置面板整体提交）：功能键有实际变化 = 本设备自定义
          const customized = new Set(state.customizedFeatures);
          for (const key of SERVER_FEATURE_KEYS) {
            if (settings[key] !== undefined && settings[key] !== state[key]) {
              customized.add(key);
            }
          }
          return { ...settings, customizedFeatures: [...customized] };
        }),

      updateSetting: (key, value) =>
        set((state) => {
          // 单键路径：仅当功能键真的被改动时才标记自定义，
          // 无变化的重复写入不应把设备升级为"已自定义"
          if (isServerFeatureKey(key) && value !== state[key]) {
            if (!state.customizedFeatures.includes(key)) {
              return {
                [key]: value,
                customizedFeatures: [...state.customizedFeatures, key],
              };
            }
          }
          return { [key]: value };
        }),

      applyServerDefaults: (defaults) => {
        const state = get();
        const patch: Partial<AppSettings> = {};
        for (const key of SERVER_FEATURE_KEYS) {
          // 自定义过的设备保持本地值（升级决策：用户手动改过即优先）
          if (state.customizedFeatures.includes(key)) continue;
          if (state[key] !== defaults[key]) patch[key] = defaults[key];
        }
        if (Object.keys(patch).length > 0) set(patch);
      },
    }),
    {
      name: 'app-settings',
      storage: createJSONStorage(() => localStorage),
    }
  )
);

/**
 * 跨窗口同步：当其他窗口（如主窗口的设置面板）修改了 localStorage 中的 app-settings，
 * 当前窗口（如独立编辑器窗口）通过 storage 事件感知并同步 store 状态。
 *
 * storage 事件只在其他窗口修改 localStorage 时触发（同窗口不触发），天然适合跨窗口同步。
 *
 * 补充：Tauri 的 WebviewWindow 之间不一定触发 storage 事件，因此额外用轮询兜底。
 */
if (typeof window !== 'undefined') {
  /** 从 localStorage 解析最新设置，返回 state 部分 */
  function readPersistedState(): Partial<SettingsState> | null {
    try {
      const raw = localStorage.getItem('app-settings');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const newState = parsed?.state;
      if (newState && typeof newState === 'object') return newState as Partial<SettingsState>;
    } catch {
      // 解析失败静默忽略
    }
    return null;
  }

  /** 比较并同步：当 localStorage 中的值与当前 store 不同时更新 */
  function syncFromStorage(): void {
    const persisted = readPersistedState();
    if (!persisted) return;
    const current = useSettingsStore.getState();
    // 逐字段比较，有差异才 setState（避免无谓的渲染）
    let changed = false;
    const patch: Partial<SettingsState> = {};
    (Object.keys(persisted) as (keyof SettingsState)[]).forEach((key) => {
      if (current[key] !== persisted[key]) {
        (patch as Record<string, unknown>)[key] = persisted[key];
        changed = true;
      }
    });
    if (changed) {
      useSettingsStore.setState(patch);
    }
  }

  // 方案 1：storage 事件（浏览器多标签页有效）
  window.addEventListener('storage', (e) => {
    if (e.key !== 'app-settings' || !e.newValue) return;
    syncFromStorage();
  });

  // 方案 2：轮询兜底（Tauri WebviewWindow 之间 storage 事件可能不触发）
  // 每 500ms 检查一次，开销极低
  setInterval(syncFromStorage, 500);
}
