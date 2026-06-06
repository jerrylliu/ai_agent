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
