/**
 * FavoriteDocContext
 *
 * 轻量跨组件状态共享中枢：
 *   - FileCard 收藏/取消收藏后通知 Context → "我的收藏"面板感知变化并重取数据
 *   - "我的收藏"面板取消收藏后通知 Context → FileCard 感知变化并把星标变灰
 *
 * 设计原则：仅存版本号 + 最近事件信息，避免全量数据重渲染。
 *
 * 跨组件传递的精细事件：
 *   - favoriteOverridesRef：面板取消收藏 / 别处切换收藏 → 对话中的 FileCard
 *     同步星标状态（取消收藏时 UI 必须立即变灰，否则用户再点会基于旧状态发请求）
 */
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

type ContextValue = {
  /** 版本号，每次收藏/取消收藏/删除后递增，组件可用作 useEffect 依赖 */
  version: number;
  /** 通知所有订阅者状态已变更（粗粒度，触发面板重取列表） */
  notifyChange: () => void;
  /** 通知所有订阅者某个文档的收藏状态已变化（跨组件同步星标 UI） */
  notifyFavoriteChanged: (key: string, favorited: boolean) => void;
  /** 最近收藏状态变更的覆盖值（key → favorited，1 秒后自动清空） */
  favoriteOverridesRef: React.MutableRefObject<Map<string, boolean>>;
};

const FavoriteDocContext = createContext<ContextValue>({
  version: 0,
  notifyChange: () => {},
  notifyFavoriteChanged: () => {},
  favoriteOverridesRef: { current: new Map() },
});

export function FavoriteDocProvider({ children }: { children: React.ReactNode }) {
  const [version, setVersion] = useState(0);
  const favoriteOverridesRef = useRef<Map<string, boolean>>(new Map());
  const timeoutIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const notifyChange = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  const notifyFavoriteChanged = useCallback((key: string, favorited: boolean) => {
    favoriteOverridesRef.current.set(key, favorited);
    setVersion((v) => v + 1);
    const id = setTimeout(() => {
      // 仅在值仍未被更新覆盖时清理（避免误删后续更新）
      if (favoriteOverridesRef.current.get(key) === favorited) {
        favoriteOverridesRef.current.delete(key);
      }
      timeoutIdsRef.current.delete(id);
    }, 1000);
    timeoutIdsRef.current.add(id);
  }, []);

  // provider 卸载时清理所有 pending timeout
  useEffect(() => {
    return () => {
      for (const id of timeoutIdsRef.current) {
        clearTimeout(id);
      }
    };
  }, []);

  return (
    <FavoriteDocContext.Provider
      value={{
        version,
        notifyChange,
        notifyFavoriteChanged,
        favoriteOverridesRef,
      }}
    >
      {children}
    </FavoriteDocContext.Provider>
  );
}

export function useFavoriteDocContext() {
  return useContext(FavoriteDocContext);
}
