/**
 * 轻量级 URL hash 路由
 *
 * 设计目标：
 *   - 零依赖（不引入 react-router）
 *   - 与 Tauri / Web 同源，hash 改变不会触发页面刷新
 *   - 满足 M1 阶段路由需求：聊天主页 / 编辑器页
 *
 * URL 约定：
 *   - #/                          → 聊天主页（默认）
 *   - #/editor/:documentId        → 编辑器（指定文档）
 *   - #/editor/:documentId?windowMode=standalone  → 独立窗口模式（M1.5 用）
 *   - #/editor/new                → 草稿模式（无 documentId）
 *
 * 二期（M3 路由复杂化时）：可平滑替换为 react-router
 */

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'chat' }
  | { name: 'editor'; documentId?: number; standalone: boolean };

/** 解析当前 hash 为 Route 对象 */
export function parseHash(hash: string): Route {
  // 形如 "#/editor/123?windowMode=standalone"
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');

  if (segments[0] === 'editor') {
    const idSeg = segments[1];
    const documentId = idSeg && idSeg !== 'new' && /^\d+$/.test(idSeg)
      ? Number(idSeg)
      : undefined;
    return {
      name: 'editor',
      documentId,
      standalone: query.get('windowMode') === 'standalone',
    };
  }

  return { name: 'chat' };
}

/** 跳转到指定 Route */
export function navigate(route: Route, replace = false): void {
  let hash = '#/';
  if (route.name === 'editor') {
    const id = route.documentId ?? 'new';
    const params = route.standalone ? '?windowMode=standalone' : '';
    hash = `#/editor/${id}${params}`;
  }
  if (replace) {
    window.location.replace(hash);
  } else {
    window.location.hash = hash;
  }
}

/** 便捷方法：打开编辑器 */
export function navigateToEditor(documentId?: number, standalone = false): void {
  navigate({ name: 'editor', documentId, standalone });
}

/** 返回聊天主页 */
export function navigateToChat(): void {
  navigate({ name: 'chat' });
}

/** React Hook：订阅 hash 变化并返回当前 Route */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}
