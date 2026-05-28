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
    case 'text/markdown':
    case 'text/csv':
    case 'application/json':
    case 'text/html':
    case 'text/xml':
      return await parseTextFile(filePath);

    case 'application/pdf':
      return await parsePdfFile(filePath);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      return await parseWordFile(filePath);

    default:
      // 对于 application/octet-stream 等未知 MIME 类型，按扩展名回退解析
      const ext = path.extname(filePath).toLowerCase();
      const textExts = ['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf'];
      if (textExts.includes(ext)) {
        return await parseTextFile(filePath);
      }
      throw new Error(`不支持的文件类型: ${mimeType}（扩展名: ${ext}）`);
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
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.json': 'application/json',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'text/xml',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}


