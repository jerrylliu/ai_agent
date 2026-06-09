/**
 * 向量存储 — 文本切分器
 *
 * 提供不同文件类型的文本切分策略：
 * - 通用文本切分器（默认）
 * - 代码文件切分器（按语言识别）
 * - Markdown 切分器（按标题层级）
 *
 * 切分器本身无状态，不依赖向量存储的共享状态。
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

// ==================== 切分参数 ====================

/** 默认切分块大小 */
export const DEFAULT_CHUNK_SIZE = 500;

/** 默认切分块重叠大小 */
export const DEFAULT_CHUNK_OVERLAP = 50;

// ==================== 切分器工厂 ====================

/**
 * 通用文本切分器
 * 适用于纯文本、PDF 等无结构化标记的文档
 */
export function textSplitter(
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP,
): RecursiveCharacterTextSplitter {
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });
}

/**
 * 代码文件切分器
 * 根据文件类型自动选择对应语言的分隔符策略
 */
export function codeSplitter(
  fileType: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP,
): RecursiveCharacterTextSplitter {
  // 文件扩展名 → LangChain 支持的语言字符串映射
  const languageMap: Record<string, string> = {
    '.js': 'js',
    '.jsx': 'js',
    '.ts': 'js',      // TypeScript 使用 JS 切分器（语法结构相似）
    '.tsx': 'js',
    '.py': 'python',
    '.java': 'java',
    '.cpp': 'cpp',
    '.c': 'cpp',       // C 使用 C++ 切分器
    '.cs': 'cpp',      // C# 使用 C++ 切分器（语法结构相似）
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
  };

  const language = languageMap[fileType];

  if (language) {
    return RecursiveCharacterTextSplitter.fromLanguage(language as any, {
      chunkSize,
      chunkOverlap,
    });
  }

  // 未识别的代码文件，降级为通用切分
  return textSplitter(chunkSize, chunkOverlap);
}

/**
 * Markdown 切分器
 * 按标题层级（#, ##, ###）切分，保持章节完整性
 */
export function markdownSplitter(
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP,
): RecursiveCharacterTextSplitter {
  return RecursiveCharacterTextSplitter.fromLanguage('markdown' as any, {
    chunkSize,
    chunkOverlap,
  });
}

/**
 * 根据文件类型自动选择合适的切分器
 *
 * @param fileType 文件扩展名（如 '.md', '.py', '.txt'）
 * @param isMarkdown 是否为 Markdown 内容（优先于文件扩展名判断）
 */
export function getSplitterByFileType(
  fileType: string,
  isMarkdown: boolean = false,
): RecursiveCharacterTextSplitter {
  if (isMarkdown || fileType === '.md') {
    return markdownSplitter();
  }

  // 代码文件
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java',
    '.cpp', '.c', '.cs', '.go', '.rs', '.rb', '.php', '.swift',
  ];
  if (codeExtensions.includes(fileType)) {
    return codeSplitter(fileType);
  }

  // 默认：通用文本切分
  return textSplitter();
}

/**
 * 判断内容是否为 Markdown 格式
 * 通过检查常见 Markdown 标记来判断
 */
export function isMarkdownContent(content: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m,           // 标题 # ## ###
    /\*\*[^*]+\*\*/,        // 粗体 **text**
    /`[^`]+`/,              // 行内代码 `code`
    /^\s*[-*+]\s/m,         // 无序列表 - * +
    /^\s*\d+\.\s/m,         // 有序列表 1. 2.
    /^\s*>\s/m,             // 引用 >
    /\[.+\]\(.+\)/,         // 链接 [text](url)
  ];

  let matchCount = 0;
  for (const pattern of markdownPatterns) {
    if (pattern.test(content)) {
      matchCount++;
    }
  }

  // 至少匹配 2 种 Markdown 模式才认为是 Markdown
  return matchCount >= 2;
}
