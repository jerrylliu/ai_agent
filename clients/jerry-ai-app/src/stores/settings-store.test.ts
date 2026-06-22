import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 在导入 store 之前 mock localStorage
const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { localStorageStore[key] = String(value); },
  removeItem: (key: string) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
  get length() { return Object.keys(localStorageStore).length; },
  key: (i: number) => Object.keys(localStorageStore)[i] ?? null,
});

// 动态导入，确保 localStorage 已就绪
const { useSettingsStore } = await import('./settings-store');

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      memoryEnabled: true,
      summaryEnabled: true,
      injectMemoryOnNewSession: true,
      imageModel: 'wan2.7-image-pro',
      autoCompleteEnabled: true,
    });
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('默认值', () => {
    it('所有设置默认为 true', () => {
      const state = useSettingsStore.getState();
      expect(state.memoryEnabled).toBe(true);
      expect(state.summaryEnabled).toBe(true);
      expect(state.injectMemoryOnNewSession).toBe(true);
    });
  });

  describe('updateSettings', () => {
    it('应批量更新设置', () => {
      useSettingsStore.getState().updateSettings({
        memoryEnabled: false,
        summaryEnabled: false,
        injectMemoryOnNewSession: false,
        imageModel: 'wan2.7-image',
        autoCompleteEnabled: true,
      });
      const state = useSettingsStore.getState();
      expect(state.memoryEnabled).toBe(false);
      expect(state.summaryEnabled).toBe(false);
      expect(state.injectMemoryOnNewSession).toBe(false);
    });

    it('应部分更新设置（保留未指定的字段）', () => {
      useSettingsStore.getState().updateSettings({
        memoryEnabled: false,
        summaryEnabled: true,
        injectMemoryOnNewSession: true,
        imageModel: 'wan2.7-image-pro',
        autoCompleteEnabled: true,
      });
      expect(useSettingsStore.getState().memoryEnabled).toBe(false);
      expect(useSettingsStore.getState().summaryEnabled).toBe(true);
    });
  });

  describe('updateSetting', () => {
    it('应更新单个设置项', () => {
      useSettingsStore.getState().updateSetting('memoryEnabled', false);
      expect(useSettingsStore.getState().memoryEnabled).toBe(false);
      expect(useSettingsStore.getState().summaryEnabled).toBe(true);
    });

    it('应更新 summaryEnabled', () => {
      useSettingsStore.getState().updateSetting('summaryEnabled', false);
      expect(useSettingsStore.getState().summaryEnabled).toBe(false);
    });

    it('应更新 injectMemoryOnNewSession', () => {
      useSettingsStore.getState().updateSetting('injectMemoryOnNewSession', false);
      expect(useSettingsStore.getState().injectMemoryOnNewSession).toBe(false);
    });
  });

  describe('persist 中间件', () => {
    it('更新设置后应同步到 localStorage', () => {
      useSettingsStore.getState().updateSetting('memoryEnabled', false);
      const stored = localStorage.getItem('app-settings');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.state.memoryEnabled).toBe(false);
    });

    it('updateSettings 后应同步到 localStorage', () => {
      useSettingsStore.getState().updateSettings({
        memoryEnabled: false,
        summaryEnabled: false,
        injectMemoryOnNewSession: true,
        imageModel: 'wan2.7-image',
        autoCompleteEnabled: true,
      });
      const stored = localStorage.getItem('app-settings');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.state.memoryEnabled).toBe(false);
      expect(parsed.state.summaryEnabled).toBe(false);
      expect(parsed.state.injectMemoryOnNewSession).toBe(true);
    });
  });
});
