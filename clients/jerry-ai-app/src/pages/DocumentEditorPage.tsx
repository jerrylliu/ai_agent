/**
 * DocumentEditorPage - 文档编辑器页面
 *
 * 职责：
 *   - 加载文档元信息（标题等）
 *   - 管理编辑器内容的本地状态 + 持久化（M1 阶段先用 localStorage 兜底）
 *   - 提供顶部操作栏：返回、标题展示、保存按钮、未保存指示
 *
 * M1 阶段策略：
 *   - 后端 contentJson 字段尚未落地，本期先用 localStorage 持久化（key: editor-draft-${id}）
 *   - 提供 TODO 标记，待后端接口完成后切换为 PUT /documents/:id/content
 *   - 不强制要求 documentId 必须存在的远端文档，未传 id 时进入"草稿模式"
 *
 * 路由约定（M1.5 多窗口阶段会用到）：
 *   - URL: /editor/:id?windowMode=standalone
 *   - standalone 模式下隐藏全局侧边栏（M1.5 接入）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Save, Loader2, CheckCircle2, UploadCloud, BookOpen, Sparkles, PanelRightClose } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocumentEditor, type Editor, type JSONContent } from '@/components/Editor/DocumentEditor';
import { EditorToolbar } from '@/components/Editor/EditorToolbar';
import { SelectionToolbar } from '@/components/Editor/SelectionToolbar';
import { KnowledgePanel } from '@/components/Editor/panels/KnowledgePanel';
import { AIWritingPanel } from '@/components/Editor/panels/AIWritingPanel';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/utils/index';
import {
  getDocument,
  getDocumentContent,
  saveDocumentContent,
  saveDocumentDraft,
  getDocumentByTitle,
  getDocumentVersions,
  publishToVectorStore,
  type DocumentItem,
} from '@/lib/api';
import { consumeTransientContent, isTauri, readHashQueryValue } from '@/lib/window';
import { ANCHOR_NOT_FOUND, findAnchorBlockIndex, normalizeAnchorText } from '@/lib/anchor-match';
import { highlightAnchor } from '@/components/Editor/extensions/AnchorHighlight';

export interface DocumentEditorPageProps {
  /** 要编辑的文档 ID；不传则进入草稿模式 */
  documentId?: number;
  /** 关闭/返回回调，由父级路由处理（M1 没有 react-router，由调用方控制显示/隐藏） */
  onClose?: () => void;
  /** 是否为独立窗口模式（M1.5 多窗口启用时为 true） */
  standalone?: boolean;
}

/** localStorage 草稿 key */
const draftKey = (id?: number) => `editor-draft-${id ?? 'new'}`;

/** 空文档 */
const EMPTY_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/** 锚点未命中提示文案 */
const ANCHOR_MISS_NOTICE = '未能定位到该引用片段，已打开全文（文档可能已被修改，或引用来自图片说明）';

/** 高亮动画总时长（ms），= new.css 中 1s × 5 次，需与 .citation-anchor-highlight 动画时长一致 */
const ANCHOR_HIGHLIGHT_MS = 5000;

/** 锚点定位遇到"编辑器内容尚未同步"时的重试上限，防极端情况下无限循环 */
const ANCHOR_MAX_ATTEMPTS = 5;

/** 锚点定位结果：hit 成功 / miss 未命中（降级普通打开） / stale 内容未同步（需重试） */
type AnchorScrollResult = 'hit' | 'miss' | 'stale';

export default function DocumentEditorPage({
  documentId,
  onClose,
  standalone = false,
}: DocumentEditorPageProps) {
  const [doc, setDoc] = useState<DocumentItem | null>(null);
  const [content, setContent] = useState<JSONContent>(EMPTY_DOC);
  const [loading, setLoading] = useState<boolean>(!!documentId);
  const [saving, setSaving] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [dirty, setDirty] = useState<boolean>(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);

  /** 右侧面板：是否展开 + 当前 Tab */
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<'knowledge' | 'aiwriting'>('knowledge');

  /** 当前文档 ID（草稿保存后更新，后续保存走已有文档逻辑） */
  const [currentDocId, setCurrentDocId] = useState<number | undefined>(documentId);

  // 同步 documentId prop → currentDocId state
  // useState 只在首次挂载取初始值，切换文档时 prop 变化不会自动更新 state
  // 不同步会导致 KnowledgePanel 的 filter 用旧 documentId，搜出旧文档的内容
  useEffect(() => {
    setCurrentDocId(documentId);
    console.log('[DocumentEditorPage] documentId 变化，同步 currentDocId', { old: currentDocId, new: documentId });
  }, [documentId]);

  /**
   * 待定位的引用锚点（RAG 可验证生成闭环）
   * 两个来源统一进入 pending 队列，编辑器内容就绪后消费一次：
   *   1. 独立窗口 URL query 的 anchor（新建窗口场景，URLSearchParams 已自动解码）
   *   2. Tauri `editor-anchor` 事件（窗口已存在场景，payload 为 encodeURIComponent 串需手动解码）
   */
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);

  /**
   * 锚点未命中提示：非阻塞浮层文案，null 表示不显示。
   * 用浮层而非 alert——定位失败是"降级为普通打开"，不是错误，
   * 阻塞式弹窗会打断用户阅读文档本身。
   */
  const [anchorNotice, setAnchorNotice] = useState<string | null>(null);

  // 锚点来源 1：独立窗口 URL query（新建窗口场景；URLSearchParams.get 已自动解码）
  useEffect(() => {
    const anchor = readHashQueryValue('anchor');
    if (anchor) setPendingAnchor(anchor);
  }, []);

  // 锚点来源 2：Tauri 事件（编辑器窗口已存在时，Rust 端 emit 推送新锚点）
  // 仅 Tauri 桌面端注册；payload 是前端 encodeURIComponent 后的编码串，需手动解码
  useEffect(() => {
    if (!isTauri()) return;
    // listen 注册是异步的：组件先卸载、监听器后注册成功时，
    // 靠 disposed 标志在 resolve 后立即反注册，避免泄漏一个事件监听器
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<string>('editor-anchor', (e) => {
          try {
            setPendingAnchor(decodeURIComponent(e.payload));
          } catch {
            setPendingAnchor(e.payload);
          }
        }),
      )
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => console.warn('[DocumentEditorPage] 注册 editor-anchor 监听失败', err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * 引用锚点定位：在编辑器文本块中查找 anchor 片段，命中后滚动居中并闪烁高亮。
   * 匹配与容错策略（长度阶梯、空白归一化）见 @/lib/anchor-match；
   * 高亮走 AnchorHighlight 扩展（ProseMirror Decoration）：class 由编辑器引擎
   * 亲手绘制，重绘不会被抹掉——之前用 classList.add 从外部加 class 会被
   * ProseMirror 的 DOM 观察机制回滚，表现为"定位成功但高亮看不见"。
   * @returns 'hit' 成功 / 'miss' 未命中（降级普通打开，由调用方提示） / 'stale' 内容尚未同步（需重试）
   */
  const scrollToAnchorInEditor = useCallback((editor: Editor, anchor: string): AnchorScrollResult => {
    try {
      // 编辑器还是空文档：value→setContent 同步可能尚未完成，此时匹配会误报未命中
      if (!editor.state.doc.textContent.trim()) return 'stale';

      // 单次遍历收集全部文本块（节点位置 + 节点长度 + 归一化文本），阶梯匹配在内存中完成，
      // 避免每一档都重新遍历全文档
      const blocks: Array<{ pos: number; size: number; text: string }> = [];
      editor.state.doc.descendants((node, pos) => {
        // 只收含文本的块级节点（段落/标题/列表项等），空块无匹配价值
        if (node.isTextblock && node.textContent) {
          blocks.push({ pos, size: node.nodeSize, text: normalizeAnchorText(node.textContent) });
        }
        return true;
      });

      const hitIndex = findAnchorBlockIndex(
        blocks.map((block) => block.text),
        anchor,
      );
      if (hitIndex === ANCHOR_NOT_FOUND) {
        console.warn('[DocumentEditorPage] 引用锚点未命中（文档可能已被编辑，或为图片描述类引用）');
        return 'miss';
      }

      const hit = blocks[hitIndex];
      const dom = editor.view.nodeDOM(hit.pos);
      if (dom instanceof HTMLElement) {
        dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        console.warn('[DocumentEditorPage] 引用锚点命中但无法取得 DOM 节点，跳过滚动');
      }

      // 高亮动画总长 5s，远覆盖平滑滚动的 ~0.45s，随滚动同步启动即可
      highlightAnchor(editor.view, hit.pos, hit.pos + hit.size, ANCHOR_HIGHLIGHT_MS);
      return 'hit';
    } catch (err) {
      // 定位异常同样降级为普通打开，由调用方给出可观察提示
      console.warn('[DocumentEditorPage] 引用锚点定位失败', err);
      return 'miss';
    }
  }, []);

  // 消费锚点：编辑器实例就绪后定位一次；内容尚未同步（stale）时限次重试
  const anchorAttemptsRef = useRef(0);
  const [anchorRetryTick, setAnchorRetryTick] = useState(0);
  useEffect(() => {
    if (!pendingAnchor || !editorInstance || loading) return;
    // DocumentEditor 的 value→Tiptap 同步走 queueMicrotask，本 effect 同步执行时
    // editor.state.doc 可能仍是旧内容（如 EMPTY_DOC），直接匹配会误报"未命中"。
    // 推迟到宏任务：微任务队列（含 setContent）必然已执行完毕，文档内容已就位。
    const anchor = pendingAnchor;
    const timer = window.setTimeout(() => {
      const result = scrollToAnchorInEditor(editorInstance, anchor);
      if (result === 'stale' && anchorAttemptsRef.current < ANCHOR_MAX_ATTEMPTS) {
        // 内容还没到位：保留 pendingAnchor，通过 tick 变化触发本 effect 下一次重试
        anchorAttemptsRef.current += 1;
        setAnchorRetryTick((t) => t + 1);
        return;
      }
      anchorAttemptsRef.current = 0;
      setPendingAnchor(null);
      // 未命中时给出非阻塞提示：静默降级会让用户误以为"跳转功能没生效"
      if (result === 'miss') setAnchorNotice(ANCHOR_MISS_NOTICE);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingAnchor, editorInstance, loading, anchorRetryTick, scrollToAnchorInEditor]);

  // 锚点未命中提示 5 秒后自动消失，避免长期占据顶部空间
  useEffect(() => {
    if (!anchorNotice) return;
    const timer = window.setTimeout(() => setAnchorNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [anchorNotice]);

  // 标题展示
  const title = useMemo(() => {
    if (doc) return doc.title;
    if (documentId) return `文档 #${documentId}`;
    return '未命名草稿';
  }, [doc, documentId]);

  // 初始化：优先从后端获取内容，失败时回退到 localStorage 草稿
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        if (documentId) {
          // 1. 拉取后端文档元信息
          const remote = await getDocument(documentId);
          if (cancelled) return;
          setDoc(remote);

          // 2. 拉取后端编辑器内容（失败时回退草稿）
          try {
            const content = await getDocumentContent(documentId);
            if (cancelled) return;
            if (content.contentJson) {
              setContent(content.contentJson as JSONContent);
            } else {
              // 后端无内容 → 尝试本地草稿
              const cached = localStorage.getItem(draftKey(documentId));
              if (cached) {
                try {
                  setContent(JSON.parse(cached) as JSONContent);
                } catch {
                  // 损坏的缓存忽略
                }
              }
            }
          } catch (err) {
            // 接口失败时回退本地草稿
            const cached = localStorage.getItem(draftKey(documentId));
            if (cached) {
              try {
                if (!cancelled) setContent(JSON.parse(cached) as JSONContent);
              } catch {
                // 损坏的缓存忽略
              }
            }
            // 仅记录，不阻塞渲染
            console.warn('加载远端内容失败，已回退本地草稿', err);
          }
        } else {
          // 草稿模式：优先读取跨窗口传递的临时内容（聊天里"在编辑器中打开"）
          const transient = consumeTransientContent();
          console.log('[Editor] 草稿模式启动，临时内容:', transient ? `命中(${transient.fileName})` : '未命中');
          if (transient) {
            // 先按文件名查后端，找到则走已有文档模式加载最新内容
            // （聊天卡片的 documentId 可能缺失，但后端可能已通过编辑器保存创建了同名文档）
            const title = transient.fileName.replace(/\.[^/.]+$/, '');
            let foundRemote = false;
            try {
              const existingDoc = await getDocumentByTitle(title);
              if (existingDoc && !cancelled) {
                // 找到已有文档 → 切换为已有文档模式，从后端加载最新内容
                setCurrentDocId(existingDoc.id);
                setDoc(existingDoc);
                try {
                  const contentResp = await getDocumentContent(existingDoc.id);
                  if (!cancelled && contentResp.contentJson) {
                    setContent(contentResp.contentJson as JSONContent);
                  }
                } catch {
                  // 加载远端内容失败，用 transient 快照兜底
                  if (!cancelled) setContent(transient.contentJson as JSONContent);
                }
                foundRemote = true;
              }
            } catch {
              // 查找失败，走 transient 兜底
            }

            // 后端未找到 → 用 transient 的旧快照
            if (!foundRemote && !cancelled) {
              setContent(transient.contentJson as JSONContent);
              setDoc({
                id: 0,
                title: transient.fileName,
                description: null,
                tags: [],
                currentVersionId: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            }
          } else {
            // 没有临时内容 → 尝试本地草稿
            const cached = localStorage.getItem(draftKey(documentId));
            if (cached) {
              try {
                if (!cancelled) setContent(JSON.parse(cached) as JSONContent);
              } catch {
                // 损坏的缓存忽略
              }
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载文档失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // 编辑器内容变化
  const handleChange = useCallback((json: JSONContent) => {
    setContent(json);
    setDirty(true);
  }, []);

  /**
   * 从 Tiptap JSONContent 提取纯文本
   * 用于后端 RAG 分块；递归遍历所有 text 节点，块级节点之间补换行
   */
  const extractText = useCallback((node: JSONContent): string => {
    if (!node) return '';
    if (node.type === 'text') return node.text ?? '';
    const blockTypes = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'taskItem']);
    const childTexts = (node.content ?? []).map(extractText);
    const joined = childTexts.join('');
    return blockTypes.has(node.type ?? '') ? joined + '\n' : joined;
  }, []);

  // 保存
  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const contentText = extractText(content).trim();

      if (currentDocId) {
        // 已有文档 → 直接保存（内容变了会自动创建新版本）
        await saveDocumentContent(currentDocId, {
          contentJson: content,
          contentText,
        });
        // 同步清理本地草稿（保存成功后不再需要）
        localStorage.removeItem(draftKey(currentDocId));
      } else if (doc?.title) {
        // 草稿模式且有文件名 → 按文件名保存（创建文档或新增版本）
        const result = await saveDocumentDraft(doc.title, content, contentText);
        setCurrentDocId(result.document.id);
        // 更新 doc 元信息
        setDoc(result.document);
        // 清理草稿模式的本地缓存
        localStorage.removeItem(draftKey(undefined));
      } else {
        // 纯草稿（无文件名）→ 仅本地
        localStorage.setItem(draftKey(documentId), JSON.stringify(content));
      }
      setDirty(false);
      setSavedAt(new Date());
    } catch (err) {
      // 保存失败时把内容存到 localStorage 作为离线兜底，避免数据丢失
      try {
        localStorage.setItem(draftKey(currentDocId), JSON.stringify(content));
      } catch {
        // 存储满 / 隐私模式忽略
      }
      setError(err instanceof Error ? err.message : '保存失败，已暂存到本地草稿');
    } finally {
      setSaving(false);
    }
  }, [content, currentDocId, doc, extractText]);

  /**
   * 发布到知识库
   * 先保存未保存的修改，再调 publishToVectorStore 向量化 + 激活
   * 需要获取最新版本 ID（DRAFT 版本 currentVersionId 可能为 null）
   */
  const handlePublish = useCallback(async () => {
    if (!currentDocId) return;
    setPublishing(true);
    setError(null);
    try {
      // 先保存未保存的修改
      if (dirty) {
        const contentText = extractText(content).trim();
        await saveDocumentContent(currentDocId, { contentJson: content, contentText });
        setDirty(false);
        setSavedAt(new Date());
      }

      // 获取最新版本
      const versions = await getDocumentVersions(currentDocId);
      if (!versions || versions.length === 0) {
        throw new Error('未找到可发布的版本');
      }
      // 取最新版本（按 versionNumber 降序）
      const latestVersion = versions.reduce((a, b) =>
        a.versionNumber > b.versionNumber ? a : b
      );

      await publishToVectorStore(currentDocId, latestVersion.id);
      setSavedAt(new Date());
      setError(null);
      // 用 alert 提示成功（编辑器窗口可能没有 toast 系统）
      alert('已发布到知识库');
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  }, [currentDocId, dirty, content, extractText]);

  // 快捷键：Ctrl/Cmd + S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
      if (isSave) {
        e.preventDefault();
        if (!saving && dirty) void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, dirty, handleSave]);

  // 离开/关闭未保存提示
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // 顶部状态文本
  const statusText = useMemo(() => {
    if (saving) return '保存中...';
    if (dirty) return '有未保存的修改';
    if (savedAt) return `已保存 · ${savedAt.toLocaleTimeString()}`;
    return '尚未编辑';
  }, [saving, dirty, savedAt]);

  return (
    <div className="flex flex-col h-full w-full bg-background text-foreground cyberpunk-editor-page">
      {/* 顶部栏 */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-background/80 backdrop-blur cyberpunk-editor-header">
        <div className="flex items-center gap-2 min-w-0">
          {!standalone && onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title="返回"
              className="shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <div className="flex flex-col min-w-0">
            <h1 className="text-sm font-medium truncate cyberpunk-editor-title">{title}</h1>
            <span className="text-xs text-muted-foreground flex items-center gap-1 cyberpunk-editor-status">
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              {!saving && !dirty && savedAt && (
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              )}
              {statusText}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* 右侧面板切换按钮
              点击逻辑：
              - 面板已关闭 → 打开并切换到对应 Tab
              - 面板已打开且当前 Tab 相同 → 关闭面板
              - 面板已打开但当前 Tab 不同 → 切换到对应 Tab（保持打开） */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              const isSameTab = rightPanelOpen && rightPanelTab === 'knowledge';
              console.log('[DocumentEditorPage] 切换知识库面板', { willOpen: !isSameTab });
              setRightPanelTab('knowledge');
              setRightPanelOpen(!isSameTab);
            }}
            title="知识库面板"
            className={cn('shrink-0', rightPanelOpen && rightPanelTab === 'knowledge' && 'bg-accent text-accent-foreground')}
          >
            <BookOpen className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              const isSameTab = rightPanelOpen && rightPanelTab === 'aiwriting';
              console.log('[DocumentEditorPage] 切换 AI 写作面板', { willOpen: !isSameTab });
              setRightPanelTab('aiwriting');
              setRightPanelOpen(!isSameTab);
            }}
            title="AI 写作面板"
            className={cn('shrink-0', rightPanelOpen && rightPanelTab === 'aiwriting' && 'bg-accent text-accent-foreground')}
          >
            <Sparkles className="h-4 w-4" />
          </Button>

          <Button
            variant="default"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </Button>
          {/* 发布到知识库：已有文档时显示（含草稿保存后创建的文档） */}
          {currentDocId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handlePublish()}
              disabled={publishing || saving}
              className="gap-1.5"
            >
              {publishing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              {publishing ? '发布中...' : '发布到知识库'}
            </Button>
          )}
        </div>
      </header>

      {/* 错误提示 */}
      {error && (
        <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/30">
          {error}
        </div>
      )}

      {/* 引用锚点未命中提示：非阻塞，5 秒自动消失，可手动关闭 */}
      {anchorNotice && (
        <div className="flex items-start gap-2 px-4 py-2 text-xs text-foreground/80 bg-muted border-b border-border">
          <span className="flex-1">{anchorNotice}</span>
          <button
            type="button"
            onClick={() => setAnchorNotice(null)}
            className="text-muted-foreground hover:text-foreground font-medium"
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      {/* 选中文字浮动工具栏（润色/翻译/改写）— 浮动定位，不受面板布局影响 */}
      {!loading && <SelectionToolbar editor={editorInstance} />}

      {/* 主内容区：编辑器 + 右侧面板（知识库 / AI 写作） */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载文档...
          </div>
        ) : rightPanelOpen ? (
           <div className="flex h-full">
             {/* 左侧：工具栏 + 编辑器 */}
             <div className="flex-1 min-w-0 flex flex-col">
               <EditorToolbar editor={editorInstance} />
               <div className="flex-1 min-h-0">
                 <DocumentEditor
                   value={content}
                   onChange={handleChange}
                   onReady={editor => {
                     editorRef.current = editor;
                     setEditorInstance(editor);
                   }}
                   placeholder="在这里开始你的创作..."
                 />
               </div>
             </div>

             {/* 右侧：知识库 / AI 写作面板 */}
             <div className="w-80 shrink-0 border-l border-border">
               <Tabs
                 value={rightPanelTab}
                 onValueChange={(v) => setRightPanelTab(v as 'knowledge' | 'aiwriting')}
                 className="h-full flex flex-col"
               >
                 <TabsList className="w-full rounded-none border-b border-border">
                   <TabsTrigger value="knowledge" className="flex-1 gap-1">
                     <BookOpen className="h-3.5 w-3.5" />
                     知识库
                   </TabsTrigger>
                   <TabsTrigger value="aiwriting" className="flex-1 gap-1">
                     <Sparkles className="h-3.5 w-3.5" />
                     AI 写作
                   </TabsTrigger>
                   <Button
                     variant="ghost"
                     size="icon-sm"
                     className="shrink-0 mr-1"
                     onClick={() => setRightPanelOpen(false)}
                     title="关闭面板"
                   >
                     <PanelRightClose className="h-4 w-4" />
                   </Button>
                 </TabsList>
                 <TabsContent value="knowledge" className="flex-1 min-h-0 overflow-hidden">
                   <KnowledgePanel editor={editorInstance} documentId={currentDocId} />
                 </TabsContent>
                 <TabsContent value="aiwriting" className="flex-1 min-h-0 overflow-hidden">
                   <AIWritingPanel editor={editorInstance} />
                 </TabsContent>
               </Tabs>
             </div>
           </div>
        ) : (
          <div className="flex flex-col h-full">
            <EditorToolbar editor={editorInstance} />
            <div className="flex-1 min-h-0">
              <DocumentEditor
                value={content}
                onChange={handleChange}
                onReady={editor => {
                  editorRef.current = editor;
                  setEditorInstance(editor);
                }}
                placeholder="在这里开始你的创作..."
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
