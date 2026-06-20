import { useState, useEffect } from 'react';

export type ThemeMode = 'light' | 'dark' | 'cyberpunk';

const THEME_KEY = 'app-theme-mode';

const THEME_CLASSES: Record<ThemeMode, string[]> = {
  light: [],
  dark: ['dark'],
  cyberpunk: ['dark', 'cyberpunk'],
};

const ALL_THEME_CLASSES = ['dark', 'cyberpunk'];

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'cyberpunk' || saved === 'light') {
      return saved;
    }
    return 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    ALL_THEME_CLASSES.forEach(cls => root.classList.remove(cls));
    THEME_CLASSES[theme].forEach(cls => root.classList.add(cls));
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // 跨窗口同步：当其他窗口（如主窗口）修改了主题，当前窗口（如独立编辑器窗口）
  // 通过 storage 事件收到通知并更新自身状态，实现实时切换
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      const next = e.newValue;
      if (next === 'light' || next === 'dark' || next === 'cyberpunk') {
        setThemeState(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = (mode: ThemeMode) => {
    setThemeState(mode);
  };

  const cycleTheme = () => {
    const order: ThemeMode[] = ['light', 'dark', 'cyberpunk'];
    const idx = order.indexOf(theme);
    setThemeState(order[(idx + 1) % order.length]);
  };

  const darkMode = theme === 'dark';
  const cyberpunkMode = theme === 'cyberpunk';
  const isDark = theme === 'dark' || theme === 'cyberpunk';

  return { theme, setTheme, cycleTheme, darkMode, cyberpunkMode, isDark };
}
