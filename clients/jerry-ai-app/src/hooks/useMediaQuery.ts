import { useEffect, useState } from "react";

/**
 * useIsMobile - 检测当前是否为移动端布局（视口宽度 < 768px）
 *
 * 用途：布局形态切换（侧边栏抽屉化、面板形态切换等），业务逻辑不应依赖此值。
 * 实现基于 matchMedia 事件监听，横竖屏旋转 / 窗口拉伸时自动更新。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 767px)").matches
      : false,
  );

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // 同步一次，避免窗口在挂载后才变化导致状态陈旧
    setIsMobile(mql.matches);
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}
