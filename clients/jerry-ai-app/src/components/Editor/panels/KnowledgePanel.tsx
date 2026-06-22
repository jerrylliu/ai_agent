/**
 * KnowledgePanel - 知识库面板
 *
 * 职责：
 *   - 在编辑器右侧提供知识库搜索能力
 *   - 用户输入问题 → 调用已有 /knowledge/search → 展示来源片段
 *   - 支持一键插入引用（blockquote）或原文（paragraph）到编辑器
 *   - 支持"仅搜索当前文档"过滤
 *
 * 设计要点：
 *   - 完全复用后端 /knowledge/search 接口，不新建后端端点
 *   - 搜索防抖 800ms + 最小 2 字符门槛（避免触发后端 ThrottlerGuard: 60s/10 次）
 *   - 后端返回的 score 是 RRF 融合分数（约 0.01~0.05），不可直接当百分比
 *   - 插入引用时使用 editor.chain().focus().insertContent()，保持光标聚焦
 */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, Quote, FileText, BookOpen, AlertCircle } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { searchKnowledgeBase } from '@/lib/api';
import { cn } from '@/utils/index';

export interface KnowledgePanelProps {
  /** 编辑器实例，用于插入引用 */
  editor: Editor | null;
  /** 当前文档 ID，用于"仅搜索当前文档"过滤 */
  documentId?: number;
}

/** 搜索结果条目 */
interface KnowledgeResult {
  content: string;
  metadata: {
    /** 后端实际存的是字符串形式的 documentId（vector-version.ts L434） */
    documentId?: string | number;
    /** 后端入库时写入的文档标题（document.service.ts L509 / vector-version.ts L437） */
    documentTitle?: string;
    versionId?: string | number;
    versionStatus?: string;
    /** 文件来源（纯文件名或路径，由后端 vector-version.ts L438 写入） */
    source?: string;
    fileType?: string;
    mimeType?: string;
    /** 切块索引（vector-crud.ts L201 写入为 chunk_index） */
    chunk_index?: number;
    doc_type?: string;
    [key: string]: unknown;
  };
  /**
   * RRF 融合分数（约 0.01 ~ 0.05），不是相似度也不是百分比
   * 仅用于排序，不直接展示
   */
  score: number;
}

/** 搜索状态 */
type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

export function KnowledgePanel({ editor, documentId }: KnowledgePanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [onlyCurrentDoc, setOnlyCurrentDoc] = useState(false);

  // 防抖定时器
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 当前请求的 AbortController
  const abortRef = useRef<AbortController | null>(null);
  // 记录上一次 onlyCurrentDoc 值，用于检测开关变化
  const prevOnlyCurrentDoc = useRef<boolean | null>(null);

  /**
   * 执行搜索
   * - 仅搜索当前文档时，传 filter 给后端，让 ChromaDB 在当前文档范围内检索 top-K
   *   （避免前端过滤 top-5 后当前文档片段不在其中导致空结果）
   * - 最小 2 字符门槛 + 1200ms 防抖（避免触发后端 ThrottlerGuard: 60s/10 次，同时减少 LLM 改写调用）
   */
  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setStatus('idle');
      return;
    }

    // 中断上一个请求
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setStatus('loading');
    setErrorMsg('');

    const startTime = Date.now();

    // 构造后端 filter：仅搜索当前文档时按 documentId 过滤
    const filter =
      onlyCurrentDoc && documentId
        ? { documentId: String(documentId) }
        : undefined;

    console.log('[KnowledgePanel] 开始搜索知识库', {
      queryLength: trimmed.length,
      query: trimmed,
      onlyCurrentDoc,
      documentId,
      filter,
    });

    try {
      // 传 signal 给 fetch，真正中断旧请求（防止旧请求返回后覆盖新结果）
      const resp = await searchKnowledgeBase(trimmed, 5, filter, ac.signal);
      if (ac.signal.aborted) {
        console.log('[KnowledgePanel] 搜索结果丢弃：请求已被新搜索覆盖');
        return;
      }

      if (resp.success) {
        const filtered = resp.results as KnowledgeResult[];
        console.log('[KnowledgePanel] 搜索完成', {
          rawCount: filtered.length,
          filteredCount: filtered.length,
          onlyCurrentDoc,
          filter,
          durationMs: Date.now() - startTime,
          // 打印每条结果的完整 metadata，便于排查来源显示问题
          sources: filtered.map((r) => ({
            documentId: r.metadata?.documentId,
            documentTitle: r.metadata?.documentTitle,
            source: r.metadata?.source,
            chunk_index: r.metadata?.chunk_index,
            // 完整 metadata 供调试（含 legacyUpload 等字段）
            fullMetadata: r.metadata,
          })),
        });
        setResults(filtered);
        setStatus('done');
      } else {
        console.warn('[KnowledgePanel] 搜索失败：后端返回 success=false', {
          durationMs: Date.now() - startTime,
        });
        setStatus('error');
        setErrorMsg('搜索失败，请稍后重试');
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      const errMsg = err instanceof Error ? err.message : '搜索失败';
      // 识别 429 限流错误（NestJS Throttler 返回 ThrottlerException）
      const isThrottled =
        errMsg.includes('Too Many Requests') ||
        errMsg.includes('ThrottlerException') ||
        errMsg.includes('429');
      console.error('[KnowledgePanel] 搜索异常', {
        error: errMsg,
        isThrottled,
        onlyCurrentDoc,
        filter,
        durationMs: Date.now() - startTime,
      });
      setStatus('error');
      setErrorMsg(isThrottled
        ? '搜索过于频繁，请稍等约 1 分钟后再试'
        : errMsg);
    }
  }, [onlyCurrentDoc, documentId]);

  // 输入防抖 1200ms（避免连续输入触发后端 throttler + 减少 LLM 改写调用）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setStatus('idle');
      return;
    }
    debounceRef.current = setTimeout(() => {
      void doSearch(query);
    }, 1200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  // 切换"仅搜索当前文档"开关时：立即重新搜索（不走 1200ms 防抖）
  // 避免用户切换开关后看到旧结果，误以为没有生效
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) return;
    // 用 ref 记录上一次的 onlyCurrentDoc，跳过首次渲染
    if (prevOnlyCurrentDoc.current === null) {
      prevOnlyCurrentDoc.current = onlyCurrentDoc;
      return;
    }
    if (prevOnlyCurrentDoc.current !== onlyCurrentDoc) {
      prevOnlyCurrentDoc.current = onlyCurrentDoc;
      console.log('[KnowledgePanel] 仅搜索当前文档开关变化，立即重新搜索', {
        onlyCurrentDoc,
        query: query.trim(),
      });
      // 立即搜索，不走防抖
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void doSearch(query);
    }
  }, [onlyCurrentDoc, query, doSearch]);

  // 组件卸载时中断请求
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  /** 插入为引用块（blockquote） */
  const insertAsQuote = useCallback((text: string) => {
    if (!editor) {
      console.warn('[KnowledgePanel] 插入引用失败：editor 为空');
      return;
    }
    console.log('[KnowledgePanel] 插入引用', { length: text.length });
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })
      .insertContent({ type: 'paragraph' })
      .run();
  }, [editor]);

  /** 插入为普通段落 */
  const insertAsText = useCallback((text: string) => {
    if (!editor) {
      console.warn('[KnowledgePanel] 插入原文失败：editor 为空');
      return;
    }
    console.log('[KnowledgePanel] 插入原文', { length: text.length });
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })
      .run();
  }, [editor]);

  // ==================== 滑动窗口预览 + 关键词高亮 ====================

  /**
   * 中文停用词表（过滤无意义的高频词，避免关键词过多导致高亮噪声）
   */
  const STOP_WORDS = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '上',
    '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己',
    '这', '那', '与', '或', '但', '而', '及', '以', '为', '被', '让', '使', '从', '向',
    '怎么', '什么', '为什么', '如何', '哪个', '哪些', '可以', '应该', '需要', '关于',
  ]);

  /**
   * 从用户查询中提取关键词
   *
   * 策略：
   *   - 中文连续字（≥2字）作为一个词
   *   - 英文连续字母（≥2字）作为一个词，转小写
   *   - 过滤停用词
   *
   * @param query 用户搜索查询
   * @returns 去重后的关键词数组
   */
  const extractKeywords = useCallback((query: string): string[] => {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // 中文连续字（2字以上）+ 英文连续字母（2字以上）
    const matches = trimmed.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{2,}/g) || [];
    const keywords = matches
      .filter((kw) => !STOP_WORDS.has(kw.toLowerCase()))
      .filter((kw, i, arr) => arr.indexOf(kw) === i); // 去重

    return keywords;
  }, []);

  /**
   * 转义正则特殊字符（用于安全构建高亮 regex）
   */
  const escapeRegExp = (str: string): string => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  /**
   * 滑动窗口预览：以关键词首次出现位置为中心截取内容
   *
   * 策略：
   *   1. 从查询提取关键词
   *   2. 在 content 中找最早命中的关键词位置
   *   3. 以该位置为中心，前后各取 windowSize/2 字符
   *   4. 找不到关键词 → 从开头截取（退化为原 truncate 行为）
   *   5. 内容不足 windowSize → 返回全文
   *
   * @param content 文档片段完整内容
   * @param query 用户搜索查询
   * @param windowSize 预览窗口大小，默认 220 字符
   * @returns 截取后的预览文本（可能带 ... 前缀/后缀）
   */
  const extractPreview = useCallback(
    (content: string, query: string, windowSize = 220): string => {
      if (content.length <= windowSize) return content;

      const keywords = extractKeywords(query);

      // 无关键词 → 从开头截取
      if (keywords.length === 0) {
        return content.slice(0, windowSize) + '...';
      }

      // 在 content 中找最早命中的关键词位置（大小写不敏感）
      let earliestPos = -1;
      for (const kw of keywords) {
        const pos = content.toLowerCase().indexOf(kw.toLowerCase());
        if (pos >= 0 && (earliestPos < 0 || pos < earliestPos)) {
          earliestPos = pos;
        }
      }

      // 未命中任何关键词 → 从开头截取
      if (earliestPos < 0) {
        return content.slice(0, windowSize) + '...';
      }

      // 以命中位置为中心截取窗口
      const half = Math.floor(windowSize / 2);
      let start = Math.max(0, earliestPos - half);
      const end = Math.min(content.length, start + windowSize);
      // 如果 end 到了末尾，start 往前挪以凑够 windowSize
      if (end - start < windowSize) {
        start = Math.max(0, end - windowSize);
      }

      const prefix = start > 0 ? '...' : '';
      const suffix = end < content.length ? '...' : '';
      const preview = prefix + content.slice(start, end) + suffix;

      console.log('[KnowledgePanel] 滑动窗口预览', {
        contentLength: content.length,
        keywords,
        earliestMatchPos: earliestPos,
        windowStart: start,
        windowEnd: end,
        previewLength: preview.length,
        hasPrefix: start > 0,
        hasSuffix: end < content.length,
      });

      return preview;
    },
    [extractKeywords],
  );

  /**
   * 关键词高亮渲染组件（安全，无 XSS 风险）
   *
   * 用正则拆分文本为 [非匹配, 匹配, 非匹配, ...] 数组，
   * 匹配部分用 <mark> 包裹，非匹配部分用 <span> 包裹。
   * 不使用 dangerouslySetInnerHTML，天然防御 XSS。
   *
   * @param text 预览文本
   * @param keywords 需要高亮的关键词
   */
  const HighlightedText = ({
    text,
    keywords,
  }: {
    text: string;
    keywords: string[];
  }): React.ReactElement => {
    if (keywords.length === 0) return <>{text}</>;

    // 构建大小写不敏感的正则，捕获分组使 split 保留匹配项
    const escaped = keywords.map((kw) => escapeRegExp(kw));
    const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
    const parts = text.split(pattern);

    // split 配合捕获分组：偶数索引=非匹配，奇数索引=匹配
    return (
      <>
        {parts.map((part, i) =>
          i % 2 === 1 ? (
            <mark
              key={i}
              className="bg-yellow-200 dark:bg-yellow-500/30 rounded px-0.5 text-foreground"
            >
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </>
    );
  };

  /**
   * 对搜索结果排序：关键词命中的排前面，命中的之间按原 score 降序，未命中的保持原序
   *
   * 排序规则：
   *   1. 命中关键词的结果 > 未命中的
   *   2. 同为命中/未命中时，保持后端返回的 score 降序顺序
   *
   * 注意：不改 score，不改原始排名 #N，只改展示顺序
   * 返回值带 originalIndex 字段，用于渲染时显示原始排名
   */
  const sortResultsByKeywordMatch = useCallback(
    (
      resultList: KnowledgeResult[],
      queryStr: string,
    ): Array<KnowledgeResult & { originalIndex: number }> => {
      // 无关键词或只有 1 条结果 → 不排序，直接附带 originalIndex
      const keywords = extractKeywords(queryStr);
      if (keywords.length === 0 || resultList.length <= 1) {
        return resultList.map((r, i) => ({ ...r, originalIndex: i }));
      }

      const lowerKeywords = keywords.map((kw) => kw.toLowerCase());
      const matched: Array<KnowledgeResult & { originalIndex: number }> = [];
      const unmatched: Array<KnowledgeResult & { originalIndex: number }> = [];

      resultList.forEach((r, originalIndex) => {
        const lowerContent = r.content.toLowerCase();
        const isMatched = lowerKeywords.some((kw) => lowerContent.includes(kw));
        if (isMatched) {
          matched.push({ ...r, originalIndex });
        } else {
          unmatched.push({ ...r, originalIndex });
        }
      });

      console.log('[KnowledgePanel] 关键词命中重排序', {
        query: queryStr,
        keywords,
        matchedCount: matched.length,
        unmatchedCount: unmatched.length,
        // 原始排名 = originalIndex + 1，方便日志直观阅读
        matchedOriginalRanks: matched.map((r) => `#${r.originalIndex + 1}`),
        unmatchedOriginalRanks: unmatched.map((r) => `#${r.originalIndex + 1}`),
      });

      // 命中的在前，未命中的在后；各自内部保持原 score 降序（即原始顺序）
      return [...matched, ...unmatched];
    },
    [extractKeywords],
  );

  /**
   * 提取来源标签（兼容新旧数据）
   *
   * 新数据（改动后上传）：
   *   - documentTitle: 文档标题（优先使用）
   *   - source: 纯文件名（如 "考勤报告.docx"）
   *
   * 旧数据（改动前上传）：
   *   - documentTitle: 不存在
   *   - source: 可能是 URL/路径（如 "http://.../files/xxx.docx" 或 "documents/42/v1/xxx.docx"）
   *           或 "fc://document/xxx"（AI 生成文档）
   *           或 "unknown"（fileUrl 为空时的兜底）
   *
   * 兼容策略：documentTitle > source 提取文件名 > "未知来源"
   */
  const getSourceLabel = (metadata: KnowledgeResult['metadata']): string => {
    const parts: string[] = [];

    // 1) 优先使用 documentTitle（新数据）
    if (metadata.documentTitle && metadata.documentTitle !== 'unknown') {
      parts.push(metadata.documentTitle);
    } else if (metadata.source && typeof metadata.source === 'string' && metadata.source !== 'unknown') {
      // 2) 旧数据兜底：从 source 提取文件名
      const source = metadata.source;
      if (source.startsWith('fc://')) {
        // AI 生成文档的特殊前缀
        parts.push('AI 生成文档');
      } else {
        // 从 URL/路径中提取最后一段作为文件名（去掉查询参数）
        const lastSegment = source.split(/[\\/]/).pop()?.split('?')[0] || source;
        if (lastSegment) parts.push(lastSegment);
      }
    }

    // 3) 切块序号（若有）
    if (typeof metadata.chunk_index === 'number') {
      parts.push(`片段 #${metadata.chunk_index + 1}`);
    }

    return parts.length > 0 ? parts.join(' · ') : '未知来源';
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 标题 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">知识库</span>
      </div>

      {/* 搜索框 */}
      <div className="p-3 border-b border-border space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索知识库..."
            className="h-8 pl-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                void doSearch(query);
              }
            }}
          />
          {status === 'loading' && (
            <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* 仅搜索当前文档开关 */}
        {documentId && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <Switch
              size="sm"
              checked={onlyCurrentDoc}
              onCheckedChange={setOnlyCurrentDoc}
            />
            <span>仅搜索当前文档</span>
          </label>
        )}
      </div>

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {status === 'loading' && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 py-8">
            <Loader2 className="h-7 w-7 animate-spin opacity-60" />
            <span className="text-xs">AI 深度检索中...</span>
          </div>
        )}

        {status === 'idle' && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-8">
            <BookOpen className="h-8 w-8 opacity-40" />
            <span className="text-xs">输入问题搜索知识库</span>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center justify-center h-full text-destructive gap-2 py-8">
            <AlertCircle className="h-8 w-8 opacity-60" />
            <span className="text-xs">{errorMsg}</span>
          </div>
        )}

        {status === 'done' && results.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-8">
            <Search className="h-8 w-8 opacity-40" />
            <span className="text-xs">未找到相关内容</span>
          </div>
        )}

        {/* 关键词命中的优先展示（不改 score，只改展示顺序）
            #N 显示的是原始排名（后端返回的 score 降序位置），
            展示顺序经 sortResultsByKeywordMatch 调整：命中关键词的排前面 */}
        {(() => {
          // 缓存关键词提取结果，避免每次渲染重复调用 3 次
          const keywords = extractKeywords(query);
          const sortedResults = sortResultsByKeywordMatch(results, query);

          return sortedResults.map((result, displayIndex) => {
          // 检测当前结果是否命中关键词（用于显示"命中关键词"标记）
          const lowerContent = result.content.toLowerCase();
          const isKeywordMatched =
            keywords.length > 0 &&
            keywords.some((kw) => lowerContent.includes(kw.toLowerCase()));

          // 原始排名：后端返回的 score 降序位置（不改）
          const originalRank = result.originalIndex + 1;

          return (
          <div
            key={`${result.originalIndex}-${result.score}`}
            className="rounded-lg border border-border bg-card p-3 space-y-2 hover:border-primary/30 transition-colors"
          >
            {/* 排名 + 来源 + 命中关键词标记 */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground truncate">
                {getSourceLabel(result.metadata)}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                {/* 命中关键词标记 */}
                {isKeywordMatched && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded font-medium bg-orange-500/10 text-orange-600 dark:text-orange-400"
                    title="该片段包含搜索关键词"
                  >
                    命中关键词
                  </span>
                )}
                {/* 原始排名标记（#N 不随展示顺序变化，始终反映后端 score 排名） */}
                <span
                  className={cn(
                    'text-xs px-1.5 py-0.5 rounded shrink-0 font-medium',
                    originalRank === 1
                      ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                      : originalRank <= 3
                        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                        : 'bg-muted text-muted-foreground',
                  )}
                  title={`RRF 融合分数: ${result.score.toFixed(4)}`}
                >
                  #{originalRank}
                </span>
              </div>
            </div>

            {/* 内容预览（滑动窗口 + 关键词高亮） */}
            <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
              <HighlightedText
                text={extractPreview(result.content, query)}
                keywords={keywords}
              />
            </p>

            {/* 操作按钮 */}
            <div className="flex items-center gap-1.5 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => insertAsQuote(result.content)}
                disabled={!editor}
                title="插入为引用块"
              >
                <Quote className="h-3 w-3" />
                插入引用
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => insertAsText(result.content)}
                disabled={!editor}
                title="插入为普通文本"
              >
                <FileText className="h-3 w-3" />
                插入原文
              </Button>
            </div>
          </div>
          );
        });
        })()}
      </div>
    </div>
  );
}
