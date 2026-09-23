import React, { useMemo, useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import mermaid from 'mermaid';
import * as echarts from 'echarts';
import { createPortal } from 'react-dom';
import { sanitizeMessageContent } from '@/lib/utils';
import type { CitationItem } from '@/types/session';

// Mermaid 初始化（只执行一次）
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  fontFamily: 'inherit',
});

let mermaidIdCounter = 0;

// ==================== 引用角标（RAG 可验证生成） ====================

/**
 * 正文引用标注替换：
 * 把（【文档 X】）/【文档 X】替换为 markdown 链接占位符 [X](#cite-X)，
 * 再由 components.a 拦截渲染为角标 chip。
 * 用链接占位符而非直接插 React 组件，是为了保持段落内联结构不被打断（链接是 inline 元素）。
 */
const CITATION_TEXT_RE = /（?【文档\s*(\d+)】）?/g;

/**
 * 对非代码围栏部分做引用占位符替换
 * 按 ``` 围栏分节：奇数索引为围栏块（含流式未闭合的围栏），跳过替换
 */
function transformCitationMarkers(content: string): string {
  const parts = content.split(/(```[\s\S]*?(?:```|$))/g);
  return parts
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(CITATION_TEXT_RE, '[$1](#cite-$1)'),
    )
    .join('');
}

/**
 * 引用角标 chip：显示 [X]，悬停/点击弹出来源卡片（title + snippet）
 * - 有 citation 数据：可交互，Portal 弹层复刻 PopupMenu 的边界翻转模式
 * - 无 citation 数据（旧历史消息）：退化为静态灰色上标，不可交互、不报错
 */
const CitationChip: React.FC<{ refNum: number; citations?: CitationItem[] }> = React.memo(
  ({ refNum, citations }) => {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const [cardStyle, setCardStyle] = useState<React.CSSProperties>({});
    const hoverTimerRef = useRef<number | null>(null);

    // 弹层定位：锚定 chip，边界翻转（与 popup-menu.tsx 同一套策略）
    const computePosition = useCallback(() => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const GAP = 6;
      const CARD_W = 280;
      const CARD_H = 150;

      let top = rect.bottom + GAP;
      let left = rect.left;
      // 垂直翻转：底部放不下时弹到 chip 上方
      if (top + CARD_H > window.innerHeight) {
        top = rect.top - CARD_H - GAP;
      }
      // 水平边界
      if (left < 4) left = 4;
      if (left + CARD_W > window.innerWidth - 4) {
        left = window.innerWidth - CARD_W - 4;
      }
      if (top < 4) top = 4;

      setCardStyle({
        position: 'fixed',
        top,
        left,
        zIndex: 9999,
        width: CARD_W,
      });
    }, []);

    // 悬停打开（200ms 延迟防误触）/ 离开关闭（150ms 延迟允许移入弹层）
    const openWithDelay = useCallback(() => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = window.setTimeout(() => {
        computePosition();
        setOpen(true);
      }, 200);
    }, [computePosition]);

    const closeWithDelay = useCallback(() => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = window.setTimeout(() => {
        setOpen(false);
      }, 150);
    }, []);

    useEffect(() => {
      if (!open) return;
      // 弹层打开期间：点击外部 / Escape 关闭
      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as Node;
        if (
          triggerRef.current?.contains(target) ||
          cardRef.current?.contains(target)
        ) {
          return;
        }
        setOpen(false);
      };
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }, [open]);

    useEffect(() => {
      return () => {
        // 卸载时清理悬停定时器，避免内存泄漏
        if (hoverTimerRef.current !== null) {
          window.clearTimeout(hoverTimerRef.current);
        }
      };
    }, []);

    const citation = citations?.find((c) => c.ref === refNum);

    // 无数据退化：静态上标（历史消息中没有 citations 富化数据）
    // 注意：此分支必须位于所有 hooks 之后，否则 hooks 调用顺序会因条件渲染而错乱
    if (!citation) {
      return (
        <sup
          className="mx-0.5 text-[10px] leading-none text-gray-400 dark:text-slate-500 select-none"
          title={`引用文档 ${refNum}`}
        >
          [{refNum}]
        </sup>
      );
    }

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          // 气泡内嵌在 markdown 流里，阻止点击冒泡触发消息层行为
          onClick={(e) => {
            e.stopPropagation();
            // 触屏/未 hover 直接点击时也要定位弹层（hover 路径已在 openWithDelay 中定位过）
            if (!open) {
              computePosition();
            }
            setOpen((prev) => !prev);
          }}
          onMouseEnter={openWithDelay}
          onMouseLeave={closeWithDelay}
          className={`citation-chip inline-flex items-center align-super mx-0.5 px-1 rounded text-[10px] leading-none font-medium select-none transition-colors ${
            open
              ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300'
              : 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/60'
          }`}
          title={citation.title}
          aria-label={`引用来源 ${refNum}：${citation.title}`}
        >
          [{refNum}]
        </button>
        {open &&
          createPortal(
            <div
              ref={cardRef}
              className="rounded-lg border border-border bg-popover text-popover-foreground shadow-lg p-3"
              style={cardStyle}
              role="tooltip"
              onMouseEnter={() => {
                if (hoverTimerRef.current !== null) {
                  window.clearTimeout(hoverTimerRef.current);
                }
              }}
              onMouseLeave={closeWithDelay}
            >
              <div className="flex items-start gap-1.5">
                <span className="citation-chip shrink-0 mt-0.5 inline-flex items-center px-1 rounded bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 text-[10px] font-medium">
                  [{refNum}]
                </span>
                {/* min-w-0 + break-all：长文档名/URL 不得撑破弹框（flex 子项默认 min-width:auto 会被长单词撑开）；两行截断，完整名悬停可见 */}
                <span
                  className="citation-glow min-w-0 text-xs font-medium leading-4 break-all line-clamp-2"
                  title={citation.title}
                >
                  {citation.title}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed break-words max-h-24 overflow-y-auto">
                {citation.snippet}
              </p>
            </div>,
            document.body,
          )}
      </>
    );
  },
);
CitationChip.displayName = 'CitationChip';

interface MarkdownRendererProps {
  children: string;
  className?: string;
  /**
   * RAG 引用来源列表（citations SSE 事件 / 历史消息富化）。
   * 非空时正文中的【文档 X】标注渲染为可点击角标；为空时角标退化为静态样式。
   */
  citations?: CitationItem[];
}

/**
 * Mermaid 图表渲染组件
 * 将 Mermaid 代码渲染为 SVG
 */
const MermaidBlock: React.FC<{ chart: string }> = React.memo(({ chart }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = React.useState<string>('');
  const [error, setError] = React.useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const renderChart = async () => {
      try {
        const id = `mermaid-${++mermaidIdCounter}`;
        const { svg: renderedSvg } = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError('');
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Mermaid 渲染失败');
          setSvg('');
        }
      }
    };
    renderChart();
    return () => { cancelled = true; };
  }, [chart]);

  if (error) {
    return (
      <div className="mt-2 mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
        <p className="text-sm text-red-600 dark:text-red-400">思维导图渲染失败</p>
        <pre className="mt-1 text-xs text-red-500 dark:text-red-300 overflow-x-auto">{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mt-2 mb-4 p-4 bg-gray-50 dark:bg-slate-800 rounded-lg animate-pulse">
        <p className="text-sm text-gray-400">正在渲染思维导图...</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mt-2 mb-4 p-4 bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-600 overflow-x-auto"
      style={{ maxWidth: '100%' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

/**
 * ECharts 交互式图表渲染组件
 * 将 ECharts JSON 配置渲染为交互式图表
 */
const EChartsBlock: React.FC<{ optionJson: string }> = React.memo(({ optionJson }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [error, setError] = React.useState<string>('');

  useEffect(() => {
    if (!containerRef.current) return;

    try {
      const option = JSON.parse(optionJson);
      if (!chartRef.current) {
        chartRef.current = echarts.init(containerRef.current);
      }
      chartRef.current.setOption(option, true);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'ECharts 渲染失败');
    }

    const handleResize = () => {
      chartRef.current?.resize();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [optionJson]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  if (error) {
    return (
      <div className="mt-2 mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
        <p className="text-sm text-red-600 dark:text-red-400">图表渲染失败</p>
        <pre className="mt-1 text-xs text-red-500 dark:text-red-300 overflow-x-auto">{optionJson}</pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mt-2 mb-4 p-4 bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-600"
      style={{ width: '100%', height: '400px' }}
    />
  );
});

const CodeBlock: React.FC<any> = React.memo(({ inline, className, children }) => {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const codeContent = String(children).replace(/\n$/, '');

  // Mermaid 代码块：渲染为思维导图/流程图
  if (!inline && language === 'mermaid') {
    return <MermaidBlock chart={codeContent} />;
  }

  // ECharts 代码块：渲染为交互式图表
  if (!inline && language === 'echarts') {
    return <EChartsBlock optionJson={codeContent} />;
  }

  return !inline && match ? (
    <div className="mt-2 mb-4 rounded-lg overflow-x-auto max-w-full">
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={language}
        PreTag="div"
        wrapLines={true}
        showLineNumbers={false}
        codeTagProps={{
          style: {
            fontSize: '14px',
            lineHeight: '1.5',
            whiteSpace: 'pre',
          },
        }}
        customStyle={{
          margin: 0,
          padding: '12px',
          borderRadius: '6px',
        }}
      >
        {codeContent}
      </SyntaxHighlighter>
    </div>
  ) : (
    <code className={`${className} break-all bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-sm`}>{children}</code>
  );
});

const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(({ children, className, citations }) => {
  // 缓存过滤后的内容，避免每次渲染都执行正则替换
  // sanitizeMessageContent：移除 think 块 + 残留工具调用控制标签（DSML 等方言）的渲染兜底
  // transformCitationMarkers：把（【文档 X】）标注替换为 [X](#cite-X) 占位链接（跳过代码围栏）
  const content = useMemo(
    () => transformCitationMarkers(sanitizeMessageContent(children)),
    [children],
  );

  return (
    <div className={`min-w-0 ${className || ''}`} style={{ maxWidth: '100%', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlock,
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt || '图片'}
              style={{
                maxWidth: '100%',
                maxHeight: '300px',
                objectFit: 'contain',
                borderRadius: '8px',
                margin: '8px 0',
                display: 'block'
              }}
            />
          ),
          a: ({ node, href, ...props }) => {
            // 引用角标占位链接（transformCitationMarkers 产出）：渲染为 CitationChip
            const citeMatch =
              typeof href === 'string' ? /^#cite-(\d+)$/.exec(href) : null;
            if (citeMatch) {
              return (
                <CitationChip refNum={Number(citeMatch[1])} citations={citations} />
              );
            }
            return (
              <a
                {...props}
                href={href}
                className="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 underline"
                target="_blank"
                rel="noopener noreferrer"
              />
            );
          },
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-300 dark:border-slate-500 pl-4 italic text-gray-600 dark:text-gray-300 my-4">
              {children}
            </blockquote>
          ),
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold mt-6 mb-3">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-bold mt-5 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-bold mt-4 mb-2">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 space-y-1 my-2">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 space-y-1 my-2">{children}</ol>
          ),
          p: ({ children }) => (
            <p className="my-2">{children}</p>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-4 max-w-full">
              <table className="border-collapse w-full">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-gray-300 dark:border-slate-500 px-4 py-2 bg-gray-100 dark:bg-slate-700 font-bold text-left whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-gray-300 dark:border-slate-500 px-4 py-2 whitespace-nowrap">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
