import React, { useMemo, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import mermaid from 'mermaid';
import * as echarts from 'echarts';

// Mermaid 初始化（只执行一次）
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  fontFamily: 'inherit',
});

let mermaidIdCounter = 0;

interface MarkdownRendererProps {
  children: string;
  className?: string;
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

const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(({ children, className }) => {
  // 缓存过滤后的内容，避免每次渲染都执行正则替换
  const content = useMemo(() => {
    return children.replace(/<think[\s\S]*?<\/think>/gs, '');
  }, [children]);

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
          a: ({ node, ...props }) => (
            <a
              {...props}
              className="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 underline"
              target="_blank"
              rel="noopener noreferrer"
            />
          ),
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
