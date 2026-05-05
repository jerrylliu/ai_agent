/**
 * RAG（检索增强生成）服务
 * 完整流程：上传文档 → 解析 → 向量化 → 存储 → 检索 → 生成
 */

import { addDocuments, searchKnowledgeBase, getKnowledgeBaseStats } from './vector-store';
import { parseDocument, getMimeType, splitIntoChunks } from './document-parser';
import * as path from 'path';
import * as fs from 'fs';
import type { Response } from 'express';

// 配置
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * 处理文档上传
 * @param file 上传的文件对象（来自 multer）
 * @returns 上传结果
 */
export async function handleDocumentUpload(file: any): Promise<{
  success: boolean;
  message: string;
  documentCount?: number;
}> {
  try {
    // 检查文件大小
    if (file.size > MAX_FILE_SIZE) {
      return {
        success: false,
        message: `文件过大，最大支持 ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      };
    }

    const filePath = file.path;
    const mimeType = file.mimetype;
    const originalName = file.originalname;

    console.log(`📄 收到文档上传: ${originalName} (${(file.size / 1024).toFixed(2)} KB)`);

    let tempFilePath = filePath;

    if (!tempFilePath && file.buffer) {
      const timestamp = Date.now();
      const ext = path.extname(originalName) || '.tmp';
      tempFilePath = path.join(UPLOAD_DIR, `temp_${timestamp}${ext}`);
      fs.writeFileSync(tempFilePath, file.buffer);
      console.log(`📁 临时保存文件到: ${tempFilePath}`);
    }

    // 解析文档内容
    console.log('📖 开始解析文档...');
    const textContent = await parseDocument(tempFilePath, mimeType);

    if (!textContent || textContent.trim().length === 0) {
      if (tempFilePath !== filePath) {
        fs.unlinkSync(tempFilePath);
      }
      return {
        success: false,
        message: '文档内容为空或无法提取文本',
      };
    }

    console.log(`✂️ 文档解析完成，字符数: ${textContent.length}`);

    // 分割文本
    const chunks = splitIntoChunks(textContent, 500, 50);
    console.log(`📑 文本分割完成，共 ${chunks.length} 个块`);

    // 添加到知识库
    const metadata = {
      source: originalName,
      uploadTime: new Date().toISOString(),
      mimeType: mimeType,
      chunkCount: chunks.length,
    };

    const docCount = await addDocuments(chunks, [metadata]);

    if (tempFilePath !== filePath) {
      fs.unlinkSync(tempFilePath);
    }

    // 清理上传的文件（可选，保留原始文件以便审计）
    // fs.unlinkSync(filePath);

    return {
      success: true,
      message: `成功上传文档 "${originalName}"，已提取 ${docCount} 个文本块到知识库`,
      documentCount: docCount,
    };
  } catch (error: any) {
    console.error('❌ 文档上传失败:', error);
    return {
      success: false,
      message: `文档上传失败: ${error.message}`,
    };
  }
}

/**
 * RAG 检索与生成
 * @param query 用户查询
 * @param topK 检索的文档数量
 * @returns 检索到的相关文档内容
 */
export async function retrieveFromKnowledgeBase(
  query: string,
  topK: number = 3
): Promise<{
  query: string;
  results: Array<{ content: string; metadata: any; score: number }>;
  context: string;
}> {
  // 搜索知识库
  const results = await searchKnowledgeBase(query, topK);

  // 构建上下文
  const context = results
    .map((r, i) => `[文档 ${i + 1}] ${r.content}`)
    .join('\n\n');

  return {
    query,
    results,
    context,
  };
}

/**
 * 使用 RAG 进行问答
 * 结合检索到的文档和 LLM 生成回答
 */
export async function ragWithLLM(
  query: string,
  history: Array<{ role: string; content: string }> = [],
  res?: Response
): Promise<any> {
  // 1. 检索相关文档
  console.log('🔍 执行 RAG 检索...');
  const retrieval = await retrieveFromKnowledgeBase(query, 3);

  if (retrieval.results.length === 0) {
    console.log('⚠️ 知识库中没有找到相关内容');
    return {
      success: false,
      message: '知识库中没有找到与您问题相关的内容，请先上传相关文档',
    };
  }

  console.log(`✅ 找到 ${retrieval.results.length} 个相关文档`);

  // 2. 构建增强后的提示词
  const augmentedPrompt = `
请根据以下参考文档回答用户的问题。

【参考文档】：
${retrieval.context}

【用户问题】：${query}

【回答要求】：
1. 基于参考文档的内容进行回答
2. 如果参考文档中没有相关信息，请明确说明"根据当前知识库没有找到相关内容"
3. 回答要准确、简洁、有条理
4. 如果涉及代码，请提供完整的代码示例

请开始回答：
`;

  // 3. 这里可以调用 LLM 生成回答
  // 由于当前实现中，RAG 和 LLM 调用是分开的，
  // 这个函数返回增强后的提示词，实际的 LLM 调用在 prompt.ts 中进行

  return {
    success: true,
    augmentedPrompt,
    retrieval,
  };
}

/**
 * 获取知识库状态
 */
export async function getKnowledgeBaseStatus(): Promise<{
  status: 'ready' | 'empty' | 'error';
  message: string;
  stats?: {
    documentCount: number;
    collectionName: string;
  };
}> {
  try {
    const stats = await getKnowledgeBaseStats();
    return {
      status: 'ready',
      message: '知识库就绪',
      stats,
    };
  } catch (error: any) {
    return {
      status: 'error',
      message: `知识库错误: ${error.message}`,
    };
  }
}
