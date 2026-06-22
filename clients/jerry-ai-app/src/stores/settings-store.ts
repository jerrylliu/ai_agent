import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AppSettings {
  memoryEnabled: boolean;
  summaryEnabled: boolean;
  injectMemoryOnNewSession: boolean;
  imageModel: 'wan2.7-image' | 'wan2.7-image-pro';
  /** 编辑器 AI 自动补全开关（关闭后不再触发幽灵补全请求） */
  autoCompleteEnabled: boolean;
}

interface SettingsState extends AppSettings {
  updateSettings: (settings: AppSettings) => void;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      memoryEnabled: true,
      summaryEnabled: true,
      injectMemoryOnNewSession: true,
      imageModel: 'wan2.7-image-pro',
      autoCompleteEnabled: true,

      updateSettings: (settings) => set(settings),

      updateSetting: (key, value) => set({ [key]: value }),
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
  function readPersistedState(): Partial<AppSettings> | null {
    try {
      const raw = localStorage.getItem('app-settings');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const newState = parsed?.state;
      if (newState && typeof newState === 'object') return newState as Partial<AppSettings>;
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
    const patch: Partial<AppSettings> = {};
    (Object.keys(persisted) as (keyof AppSettings)[]).forEach((key) => {
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
