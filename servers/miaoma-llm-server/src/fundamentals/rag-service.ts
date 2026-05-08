/**
 * RAG（检索增强生成）服务
 * 完整流程：上传文档 → 解析 → 向量化 → 存储 → 检索 → 生成
 */

import { addDocuments, searchKnowledgeBase, hybridSearchKnowledgeBase, getKnowledgeBaseStats } from './vector-store';
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
 * @param filter 元数据过滤条件
 * @returns 检索到的相关文档内容
 */
export async function retrieveFromKnowledgeBase(
  query: string,
  topK: number = 3,
  filter?: Record<string, any>,
): Promise<{
  query: string;
  results: Array<{ content: string; metadata: any; score: number }>;
  context: string;
  hasResults: boolean;
}> {
  const results = await searchKnowledgeBase(query, topK, 1.0, filter);

  const context = results
    .map((r, i) => `[文档 ${i + 1}] ${r.content}`)
    .join('\n\n');

  return {
    query,
    results,
    context,
    hasResults: results.length > 0,
  };
}

/**
 * 混合检索（RAG 增强）
 * @param query 用户查询
 * @param topK 检索的文档数量
 * @param vectorWeight 向量检索权重
 * @param bm25Weight BM25 检索权重
 * @param filter 元数据过滤条件
 * @returns 检索到的相关文档内容
 */
export async function hybridRetrieveFromKnowledgeBase(
  query: string,
  topK: number = 3,
  vectorWeight: number = 0.7,
  bm25Weight: number = 0.3,
  filter?: Record<string, any>,
): Promise<{
  query: string;
  results: Array<{ content: string; metadata: any; score: number; sources: string[] }>;
  context: string;
  hasResults: boolean;
}> {
  const results = await hybridSearchKnowledgeBase(query, topK, vectorWeight, bm25Weight, filter);

  const context = results
    .map((r, i) => `[文档 ${i + 1}] ${r.content}`)
    .join('\n\n');

  return {
    query,
    results,
    context,
    hasResults: results.length > 0,
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
你是一个智能知识库助手。你会优先依据【参考资料】回答，但在资料完全无关联时，会动用自身知识帮助用户。请严格遵守以下决策规则：

### 第一步：判断资料相关性
在回答前，先快速评估【参考资料】是否与用户问题有任何实质关联（哪怕只涉及部分关键词或侧面信息）。
- 如果存在**任何一点**关联，进入“基于资料模式”。
- 如果**完全无关**（连一个相关词、相关概念都没有），进入“自主回答模式”。

### 第二步：按模式回答
**基于资料模式**（资料有任一部分相关）：
- 必须100%扎根于资料，不添加任何外部知识。
- 穷尽资料中所有相关条目，逐条完整列出，不得省略、概括或缩减。
- 若资料只覆盖问题的一部分，请先列出已有信息，再明确说明：“资料中未涉及以下方面：[具体缺失点]”。
- 若资料存在矛盾，请将矛盾点并列陈述，不加主观评判。
- 格式纯净：不要有任何寒暄、自我评价或补充建议。

**自主回答模式**（资料完全无关）：
- 首先明确告知：“知识库中未找到相关信息，以下回答基于我的通用知识，请谨慎参考。”
- 然后使用你自己的知识尽量回答问题，力求准确、完整。
- 如果连通用知识也无法给出确定答案，请如实说明不确定性。

【参考文档】：
${retrieval.context}

【用户问题】：${query}
你的回答：
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
