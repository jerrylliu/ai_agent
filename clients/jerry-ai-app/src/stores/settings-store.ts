import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AppSettings {
  memoryEnabled: boolean;
  summaryEnabled: boolean;
  injectMemoryOnNewSession: boolean;
  imageModel: 'wan2.7-image' | 'wan2.7-image-pro';
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

      updateSettings: (settings) => set(settings),

      updateSetting: (key, value) => set({ [key]: value }),
    }),
    {
      name: 'app-settings',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
