/**
 * 向量存储 — 文本切分器
 *
 * 提供不同文件类型的文本切分策略：
 * - 通用文本切分器（默认）
 * - 代码文件切分器（按语言识别）
 * - Markdown 切分器（按标题层级）
 * - Parent-Child 切分器（小粒度检索 + 大粒度上下文）
 *
 * 切分器本身无状态，不依赖向量存储的共享状态。
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

// ==================== 切分参数 ====================

/** 默认切分块大小 */
export const DEFAULT_CHUNK_SIZE = 500;

/** 默认切分块重叠大小 */
export const DEFAULT_CHUNK_OVERLAP = 50;

/** Parent-Child 切分：父块默认大小 */
export const DEFAULT_PARENT_CHUNK_SIZE = 1500;

/** Parent-Child 切分：父块默认重叠 */
export const DEFAULT_PARENT_CHUNK_OVERLAP = 200;

/** Parent-Child 切分：子块默认大小 */
export const DEFAULT_CHILD_CHUNK_SIZE = 300;

/** Parent-Child 切分：子块默认重叠 */
export const DEFAULT_CHILD_CHUNK_OVERLAP = 50;

export type AdaptiveDocumentType = 'markdown' | 'code' | 'pdf' | 'word' | 'text' | 'default';

export interface AdaptiveChunkingProfile {
  documentType: AdaptiveDocumentType;
  chunkSize: number;
  chunkOverlap: number;
  parentChunkSize: number;
  parentChunkOverlap: number;
  childChunkSize: number;
  childChunkOverlap: number;
}

// ==================== Parent-Child 切分 ====================

/**
 * Parent-Child 切分结果
 */
export interface ParentChildChunk {
  /** 父块（大粒度，提供完整上下文） */
  parent: {
    text: string;
    index: number;
  };
  /** 子块列表（小粒度，用于精准检索） */
  children: Array<{
    text: string;
    index: number;
    /** 子块在父块文本中的起始偏移 */
    offsetInParent: number;
  }>;
}

/**
 * Parent-Child 切分：将文档先切成大块（Parent），再将每个大块切成小块（Child）
 *
 * 检索时用 Child 匹配（精准），命中后返回 Parent 内容（完整上下文）。
 *
 * @param text 文档文本
 * @param options 切分参数
 * @returns Parent-Child 切分结果数组
 */
export async function parentChildSplit(
  text: string,
  options?: {
    /** 父块大小，默认 1500 */
    parentChunkSize?: number;
    /** 父块重叠，默认 200 */
    parentChunkOverlap?: number;
    /** 子块大小，默认 300 */
    childChunkSize?: number;
    /** 子块重叠，默认 50 */
    childChunkOverlap?: number;
  },
): Promise<ParentChildChunk[]> {
  const parentSize = options?.parentChunkSize ?? DEFAULT_PARENT_CHUNK_SIZE;
  const parentOverlap = options?.parentChunkOverlap ?? DEFAULT_PARENT_CHUNK_OVERLAP;
  const childSize = options?.childChunkSize ?? DEFAULT_CHILD_CHUNK_SIZE;
  const childOverlap = options?.childChunkOverlap ?? DEFAULT_CHILD_CHUNK_OVERLAP;

  // 第一步：切成父块
  const parentSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: parentSize,
    chunkOverlap: parentOverlap,
  });
  const parentTexts = await parentSplitter.splitText(text);

  // 第二步：每个父块切成子块
  const childSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: childSize,
    chunkOverlap: childOverlap,
  });

  const results: ParentChildChunk[] = [];

  for (let pIdx = 0; pIdx < parentTexts.length; pIdx++) {
    const parentText = parentTexts[pIdx];
    const childTexts = await childSplitter.splitText(parentText);

    const children: ParentChildChunk['children'] = [];
    let currentOffset = 0;

    for (let cIdx = 0; cIdx < childTexts.length; cIdx++) {
      const childText = childTexts[cIdx];
      // 计算子块在父块中的偏移量
      const offsetInParent = parentText.indexOf(childText, currentOffset);
      children.push({
        text: childText,
        index: cIdx,
        offsetInParent: offsetInParent >= 0 ? offsetInParent : currentOffset,
      });
      currentOffset = (offsetInParent >= 0 ? offsetInParent : currentOffset) + childText.length;
    }

    results.push({
      parent: { text: parentText, index: pIdx },
      children,
    });
  }

  return results;
}

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
  profile?: Pick<AdaptiveChunkingProfile, 'chunkSize' | 'chunkOverlap'>,
): RecursiveCharacterTextSplitter {
  const chunkSize = profile?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = profile?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

  if (isMarkdown || fileType === '.md') {
    return markdownSplitter(chunkSize, chunkOverlap);
  }

  // 代码文件
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java',
    '.cpp', '.c', '.cs', '.go', '.rs', '.rb', '.php', '.swift',
  ];
  if (codeExtensions.includes(fileType)) {
    return codeSplitter(fileType, chunkSize, chunkOverlap);
  }

  // 默认：通用文本切分
  return textSplitter(chunkSize, chunkOverlap);
}

export function getAdaptiveChunkingProfile(options: {
  fileType?: string;
  mimeType?: string;
  content?: string;
}): AdaptiveChunkingProfile {
  const fileType = (options.fileType || '').toLowerCase();
  const mimeType = (options.mimeType || '').toLowerCase();
  const content = options.content || '';
  const isMarkdown = fileType === '.md' || mimeType.includes('markdown') || isMarkdownContent(content);

  if (isMarkdown) {
    return {
      documentType: 'markdown',
      chunkSize: 800,
      chunkOverlap: 120,
      parentChunkSize: 1800,
      parentChunkOverlap: 240,
      childChunkSize: 420,
      childChunkOverlap: 70,
    };
  }

  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.go', '.rs', '.rb', '.php', '.swift',
  ];
  if (codeExtensions.includes(fileType) || mimeType.startsWith('text/x-')) {
    return {
      documentType: 'code',
      chunkSize: 420,
      chunkOverlap: 80,
      parentChunkSize: 1200,
      parentChunkOverlap: 180,
      childChunkSize: 260,
      childChunkOverlap: 60,
    };
  }

  if (fileType === '.pdf' || mimeType.includes('pdf')) {
    return {
      documentType: 'pdf',
      chunkSize: 900,
      chunkOverlap: 150,
      parentChunkSize: 2200,
      parentChunkOverlap: 300,
      childChunkSize: 450,
      childChunkOverlap: 80,
    };
  }

  if (['.doc', '.docx'].includes(fileType) || mimeType.includes('wordprocessingml') || mimeType.includes('msword')) {
    return {
      documentType: 'word',
      chunkSize: 850,
      chunkOverlap: 140,
      parentChunkSize: 2000,
      parentChunkOverlap: 260,
      childChunkSize: 420,
      childChunkOverlap: 70,
    };
  }

  if (fileType === '.txt' || mimeType.startsWith('text/')) {
    return {
      documentType: 'text',
      chunkSize: 650,
      chunkOverlap: 100,
      parentChunkSize: 1600,
      parentChunkOverlap: 220,
      childChunkSize: 340,
      childChunkOverlap: 60,
    };
  }

  return {
    documentType: 'default',
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    parentChunkSize: DEFAULT_PARENT_CHUNK_SIZE,
    parentChunkOverlap: DEFAULT_PARENT_CHUNK_OVERLAP,
    childChunkSize: DEFAULT_CHILD_CHUNK_SIZE,
    childChunkOverlap: DEFAULT_CHILD_CHUNK_OVERLAP,
  };
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
