/**
 * 跨环境的窗口管理工具
 *
 * 设计目标：
 *   - Tauri 桌面端 → 调用 Rust 命令 `open_editor_window` 打开独立桌面窗口
 *   - 浏览器 / 非 Tauri 环境 → 用 window.open 打开新标签页（兜底）
 *   - 调用方无需关心当前环境
 *
 * 用法：
 *   import { openEditorWindow } from '@/lib/window';
 *   await openEditorWindow(123);          // 打开文档 #123
 *   await openEditorWindow();             // 草稿模式
 *   await openEditorWindow(123, '需求文档.md'); // 自定义窗口标题
 */

/**
 * 检测当前是否运行在 Tauri 环境中
 * 使用 Tauri 注入的全局对象判断，无需 import @tauri-apps/api
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 当前窗口是否是独立编辑器窗口（通过 URL query 判断）
 */
export function isStandaloneWindow(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  return hash.includes('windowMode=standalone');
}

/**
 * 从当前 URL 的 hash query 中读取参数
 */
function readHashQuery(name: string): string | null {
  const hash = window.location.hash;
  const queryStart = hash.indexOf('?');
  if (queryStart < 0) return null;
  const params = new URLSearchParams(hash.slice(queryStart + 1));
  return params.get(name);
}

/**
 * 打开编辑器窗口
 *
 * @param documentId 文档 ID；不传则进入草稿模式
 * @param title 窗口标题（仅 Tauri 桌面端生效）
 * @param transientToken 跨窗口传递内容的 token（可选）
 * @returns 窗口 label（Tauri）或空字符串（浏览器）
 */
export async function openEditorWindow(
  documentId?: number,
  title?: string,
  transientToken?: string,
): Promise<string> {
  if (isTauri()) {
    // 动态 import 避免 Web 环境构建报错
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      const label = await invoke<string>('open_editor_window', {
        documentId: documentId ?? null,
        title: title ?? null,
        transientToken: transientToken ?? null,
      });
      return label;
    } catch (err) {
      console.error('[window] 打开 Tauri 编辑器窗口失败，降级到浏览器新标签', err);
      // 降级到浏览器新标签
    }
  }

  // 浏览器环境兜底
  const id = documentId ?? 'new';
  const tokenParam = transientToken ? `&transientToken=${encodeURIComponent(transientToken)}` : '';
  const url = `${window.location.pathname}#/editor/${id}?windowMode=standalone${tokenParam}`;
  const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
  if (!newWindow) {
    console.warn('[window] 浏览器拦截了新标签页，请检查弹窗权限');
  }
  return '';
}

/**
 * 关闭当前窗口（仅在 Tauri 环境有效；浏览器环境会尝试 window.close()）
 */
export async function closeCurrentWindow(): Promise<void> {
  if (isTauri()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
    return;
  }
  window.close();
}

/**
 * localStorage key 前缀：用于跨窗口传递聊天上传的文档内容
 * 每次调用生成唯一 token，避免不同窗口冲突
 */
const TRANSIENT_CONTENT_KEY_PREFIX = 'editor-transient-content:';

interface TransientContent {
  contentJson: unknown;
  fileName: string;
  createdAt: number;
}

/** 生成唯一 token */
function generateToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 打开编辑器并加载指定内容（用于聊天里"在编辑器中打开"功能）
 *
 * 如果传了 documentId，直接以已有文档模式打开（编辑器从后端加载 contentJson）。
 * 如果没传 documentId，走草稿模式（通过 localStorage 传递 contentJson），兼容旧消息。
 *
 * @param contentJson Tiptap JSONContent（草稿模式时使用）
 * @param fileName 文档文件名（用作窗口标题）
 * @param documentId 后端文档记录 ID（有值时走已有文档模式，编辑保存走版本管理）
 */
export async function openEditorWithContent(
  contentJson: unknown,
  fileName: string,
  documentId?: number,
): Promise<string> {
  // 有 documentId → 已有文档模式，编辑器从后端加载内容
  if (documentId) {
    return openEditorWindow(documentId, `${fileName} - 编辑`);
  }

  // 无 documentId → 草稿模式，通过 localStorage 传递内容（兼容旧消息）
  const token = generateToken();
  const key = `${TRANSIENT_CONTENT_KEY_PREFIX}${token}`;
  const payload: TransientContent = {
    contentJson,
    fileName,
    createdAt: Date.now(),
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    console.log('[window] 写入 transient 内容', { token, fileName, bytes: JSON.stringify(payload).length });
  } catch (err) {
    console.error('[window] 写入临时内容失败（localStorage 可能已满）', err);
    throw err;
  }

  // 同时清理 30 分钟以上的旧 token，避免 localStorage 累积
  cleanupExpiredTransients();

  return openEditorWindow(undefined, `${fileName} - 编辑`, token);
}

/**
 * 读取当前窗口对应的临时内容（编辑器窗口启动时调用）
 *
 * 流程：
 *   1. 从当前 URL 的 hash query 读取 transientToken
 *   2. 用 token 拼出 key 并从 localStorage 读取
 *   3. 读取成功后**不立即删除**，因为 StrictMode 会双调用；
 *      由 cleanupExpiredTransients 在 30 分钟后清理（或下次写入时清理）
 */
export function consumeTransientContent(): { contentJson: unknown; fileName: string } | null {
  const token = readHashQuery('transientToken');
  console.log('[window] 读取 transient token from URL:', token, 'hash:', window.location.hash);
  if (!token) return null;

  const key = `${TRANSIENT_CONTENT_KEY_PREFIX}${token}`;
  const raw = localStorage.getItem(key);
  console.log('[window] 从 localStorage 读取 key:', key, '是否命中:', !!raw);
  if (!raw) return null;

  try {
    const payload = JSON.parse(raw) as TransientContent;
    return { contentJson: payload.contentJson, fileName: payload.fileName };
  } catch {
    return null;
  }
}

/**
 * 清理 30 分钟以上的旧 transient token
 * 在每次写入时调用，避免 localStorage 累积过多
 */
function cleanupExpiredTransients(): void {
  const now = Date.now();
  const EXPIRY_MS = 30 * 60 * 1000; // 30 分钟
  const keysToRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(TRANSIENT_CONTENT_KEY_PREFIX)) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const payload = JSON.parse(raw) as TransientContent;
      if (now - payload.createdAt > EXPIRY_MS) {
        keysToRemove.push(key);
      }
    } catch {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach(k => localStorage.removeItem(k));
}
