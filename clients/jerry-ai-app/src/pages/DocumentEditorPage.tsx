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
import { ArrowLeft, Save, Loader2, CheckCircle2, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocumentEditor, type Editor, type JSONContent } from '@/components/Editor/DocumentEditor';
import { EditorToolbar } from '@/components/Editor/EditorToolbar';
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
import { consumeTransientContent, isStandaloneWindow } from '@/lib/window';

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

  /** 当前文档 ID（草稿保存后更新，后续保存走已有文档逻辑） */
  const [currentDocId, setCurrentDocId] = useState<number | undefined>(documentId);

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

      {/* 工具栏 */}
      {!loading && <EditorToolbar editor={editorInstance} />}

      {/* 编辑区 */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载文档...
          </div>
        ) : (
          <DocumentEditor
            value={content}
            onChange={handleChange}
            onReady={editor => {
              editorRef.current = editor;
              setEditorInstance(editor);
            }}
            placeholder="在这里开始你的创作..."
          />
        )}
      </main>
    </div>
  );
}
