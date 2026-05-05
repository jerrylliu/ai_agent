/**
 * 文档解析模块
 * 支持解析 TXT、PDF、Word (.docx) 格式的文档
 * 提取纯文本内容用于向量化存储
 */

import * as fs from 'fs';
import * as path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * 解析不同格式的文档，返回纯文本内容
 * @param filePath 文件的绝对路径
 * @param mimeType 文件的 MIME 类型
 * @returns 提取的文本内容
 */
export async function parseDocument(filePath: string, mimeType: string): Promise<string> {
  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  // 根据文件类型选择解析方法
  switch (mimeType) {
    case 'text/plain':
      return await parseTextFile(filePath);

    case 'application/pdf':
      return await parsePdfFile(filePath);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      return await parseWordFile(filePath);

    default:
      // 尝试作为文本文件解析
      if (mimeType.startsWith('text/')) {
        return await parseTextFile(filePath);
      }
      throw new Error(`不支持的文件类型: ${mimeType}`);
  }
}

/**
 * 解析纯文本文件
 */
async function parseTextFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        reject(new Error(`读取文本文件失败: ${err.message}`));
        return;
      }
      resolve(data);
    });
  });
}

/**
 * 解析 PDF 文件
 */
async function parsePdfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const dataBuffer = fs.readFileSync(filePath);

    pdfParse(dataBuffer)
      .then(data => {
        // data.text 包含提取的文本内容
        resolve(data.text);
      })
      .catch(err => {
        reject(new Error(`解析 PDF 文件失败: ${err.message}`));
      });
  });
}

/**
 * 解析 Word 文件 (.docx)
 */
async function parseWordFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    mammoth.extractRawText({ path: filePath })
      .then(result => {
        // result.value 包含提取的纯文本内容
        resolve(result.value);
      })
      .catch(err => {
        reject(new Error(`解析 Word 文件失败: ${err.message}`));
      });
  });
}

/**
 * 根据文件扩展名获取 MIME 类型
 */
export function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();

  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * 将长文档分割成多个chunk（文本块）
 * 用于更好地进行向量检索
 * @param text 原始文本
 * @param chunkSize 每个 chunk 的字符数（默认 500）
 * @param overlap 相邻 chunk 之间的重叠字符数（默认 50）
 * @returns 分割后的文本块数组
 */
export function splitIntoChunks(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  // 清理文本
  const cleanText = text.replace(/\s+/g, ' ').trim();

  if (cleanText.length <= chunkSize) {
    return [cleanText];
  }

  const chunks: string[] = [];
  let startIndex = 0;

  while (startIndex < cleanText.length) {
    // 计算结束位置
    let endIndex = startIndex + chunkSize;

    // 如果不是最后一块，尽量在句子边界分割
    if (endIndex < cleanText.length) {
      // 向前查找最后一个句号、问号、感叹号或换行符
      const boundaryChars = ['。', '！', '？', '.', '!', '?', '\n', '\r\n'];
      let lastBoundary = -1;

      for (let i = endIndex; i > endIndex - 100 && i > startIndex; i--) {
        if (boundaryChars.includes(cleanText[i])) {
          lastBoundary = i;
          break;
        }
      }

      if (lastBoundary > startIndex) {
        endIndex = lastBoundary + 1;
      }
    }

    // 提取 chunk
    const chunk = cleanText.substring(startIndex, endIndex).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    // 移动起始位置（考虑重叠）
    startIndex = endIndex - overlap;

    // 确保不会陷入死循环
    if (startIndex <= chunks.length && chunks.length > 0 && chunks[chunks.length - 1] === chunk) {
      startIndex = endIndex;
    }
  }

  return chunks;
}
