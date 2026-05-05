import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownRendererProps {
  children: string;
  className?: string;
}

// 在 MarkdownRenderer.tsx 中添加代码块样式
const CodeBlock: React.FC<any> = ({ inline, className, children }) => {
  const match = /language-(\w+)/.exec(className || '');
  return !inline && match ? (
    <div className="mt-2 mb-4 rounded-lg overflow-hidden overflow-x-auto max-w-full break-all">
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={match[1]}
        PreTag="div"
        wrapLines={true}
        showLineNumbers={false}
        codeTagProps={{
          style: {
            fontSize: '14px',
            lineHeight: '1.5',
            wordBreak: 'break-all',
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
          },
        }}
        customStyle={{
          margin: 0,
          padding: '12px',
          borderRadius: '6px',
          maxWidth: '100%',
        }}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    </div>
  ) : (
    <code className={`${className} break-all`}>{children}</code>
  );
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ children, className }) => {
  return (
    <div className={className} style={{ maxWidth: '100%', wordBreak: 'break-word', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlock,
          // 添加图片组件支持，优化图片显示样式
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt || '图片'}
              style={{
                maxWidth: '100%',        // 最大宽度为容器宽度
                maxHeight: '300px',      // 最大高度300px
                objectFit: 'contain',    // 保持宽高比
                borderRadius: '8px',     // 圆角
                margin: '8px 0',         // 上下间距
                display: 'block'         // 块级显示
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
            <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic text-gray-600 dark:text-gray-400 my-4">
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
            <div className="overflow-x-auto my-4">
              <table className="min-w-full border-collapse">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-gray-300 dark:border-gray-600 px-4 py-2 bg-gray-100 dark:bg-gray-700 font-bold text-left">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-gray-300 dark:border-gray-600 px-4 py-2">
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownRenderer;