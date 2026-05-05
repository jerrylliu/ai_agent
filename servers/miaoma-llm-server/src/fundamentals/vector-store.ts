/**
 * 向量数据库服务
 * 使用 ChromaDB 进行向量存储和检索
 * 支持文档的增删改查和相似性搜索
 */

import { Chroma } from '@langchain/community/vectorstores/chroma';
import { ChromaClient } from 'chromadb';
import { OllamaEmbeddings } from '@langchain/ollama';
import { Document } from '@langchain/core/documents';
import * as path from 'path';
import * as fs from 'fs';

interface TextSplitterOptions {
  chunkSize: number;
  chunkOverlap: number;
  separators?: string[];
}

class SimpleTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[];

  constructor(options: TextSplitterOptions) {
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
    this.separators = options.separators || ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''];
  }

  async splitTexts(texts: string[]): Promise<string[]> {
    const result: string[] = [];

    for (const text of texts) {
      const chunks = this.splitText(text);
      result.push(...chunks);
    }

    return result;
  }

  private splitText(text: string): string[] {
    if (text.length <= this.chunkSize) {
      return [text];
    }

    const chunks: string[] = [];
    let startIndex = 0;

    while (startIndex < text.length) {
      let endIndex = startIndex + this.chunkSize;

      if (endIndex >= text.length) {
        endIndex = text.length;
        chunks.push(text.slice(startIndex, endIndex));
        break;
      }

      for (const separator of this.separators) {
        const lastSeparatorIndex = text.lastIndexOf(separator, endIndex);
        if (lastSeparatorIndex > startIndex) {
          endIndex = lastSeparatorIndex + separator.length;
          break;
        }
      }

      chunks.push(text.slice(startIndex, endIndex));
      startIndex = endIndex - this.chunkOverlap;

      if (this.chunkOverlap > 0 && startIndex < endIndex) {
        startIndex = endIndex - this.chunkOverlap;
      }
    }

    return chunks;
  }
}

// 配置
const COLLECTION_NAME = 'knowledge_base'; // 知识库集合名称
const EMBEDDING_MODEL = 'bge-large'; // 嵌入模型（中文支持好）
const PERSIST_DIR = path.join(__dirname, '..', '..', 'chromadb_data'); // ChromaDB 数据持久化目录

// 创建嵌入模型实例
const embeddings = new OllamaEmbeddings({
  model: EMBEDDING_MODEL,
  baseUrl: 'http://localhost:11434',
});

// 创建文本分割器
const textSplitter = new SimpleTextSplitter({
  chunkSize: 500, // 每个文本块的字符数
  chunkOverlap: 50, // 相邻块的重叠字符数
  separators: ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''], // 分割符（按优先级）
});

// 向量存储实例（单例）
let vectorStore: Chroma | null = null;

/**
 * 初始化向量数据库
 * 如果已存在则加载，否则创建新的
 */
export async function initializeVectorStore(): Promise<Chroma> {
  if (vectorStore) {
    return vectorStore;
  }

  console.log('🗄️ 初始化向量数据库...');

  // 确保持久化目录存在
  if (!fs.existsSync(PERSIST_DIR)) {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    console.log(`📁 创建 ChromaDB 数据目录: ${PERSIST_DIR}`);
  }

  try {
    // 创建 Chroma 向量存储
    vectorStore = await Chroma.fromExistingCollection(embeddings, {
      collectionName: COLLECTION_NAME,
      url: 'http://localhost:8000',
    });

    console.log('✅ 向量数据库初始化完成');
    return vectorStore;
  } catch (error) {
    console.error('❌ 初始化向量数据库失败:', error);

    // 如果 ChromaDB 连接失败，使用内存存储作为备选
    console.log('⚠️ ChromaDB 不可用，尝试使用内存存储...');
    return await createMemoryVectorStore();
  }
}

/**
 * 创建内存向量存储（备选方案）
 */
async function createMemoryVectorStore(): Promise<Chroma> {
  const { MemoryVectorStore } = await import('@langchain/classic/vectorstores/memory');

  const store = new MemoryVectorStore(embeddings);
  vectorStore = store as unknown as Chroma;

  console.log('✅ 内存向量存储初始化完成（注意：重启后数据会丢失）');
  return vectorStore;
}

/**
 * 向知识库添加文档
 * @param texts 文本内容数组
 * @param metadata 元数据数组（每个文本对应的来源文件等信息）
 * @returns 添加的文档数量
 */
export async function addDocuments(
  texts: string[],
  metadata: Array<{ source: string; [key: string]: any }>
): Promise<number> {
  const store = await initializeVectorStore();

  console.log(`📤 开始向量化 ${texts.length} 个文档...`);

  // 分割文本
  const splitTexts = await textSplitter.splitTexts(texts);

  console.log(`✂️ 文本分割完成，共 ${splitTexts.length} 个文本块`);

  // 为每个分割后的文本块创建文档
  const documents = splitTexts.map((text, i) => new Document({
    pageContent: text,
    metadata: {
      ...metadata[0],
      chunk_index: i,
      source: metadata[0]?.source || 'unknown',
    },
  }));

  // 添加到向量存储
  await store.addDocuments(documents);

  console.log(`✅ 成功添加 ${splitTexts.length} 个文本块到知识库`);
  return splitTexts.length;
}

/**
 * 从知识库删除文档
 * @param filter 删除文档的过滤条件
 */
export async function deleteDocuments(filter: Record<string, any>): Promise<void> {
  const store = await initializeVectorStore();
  await store.delete({ filter });
  console.log('🗑️ 已从知识库删除文档');
}

/**
 * 搜索知识库
 * @param query 查询文本
 * @param topK 返回的最相似文档数量
 * @returns 搜索结果（文档内容和相似度分数）
 */
export async function searchKnowledgeBase(
  query: string,
  topK: number = 3
): Promise<Array<{ content: string; metadata: any; score: number }>> {
  const store = await initializeVectorStore();

  console.log(`🔍 搜索知识库: "${query}"`);

  // 执行相似性搜索
  const results = await store.similaritySearchWithScore(query, topK);

  console.log(`✅ 找到 ${results.length} 个相关文档`);

  return results.map(([doc, score]) => ({
    content: doc.pageContent,
    metadata: doc.metadata,
    score,
  }));
}

/**
 * 获取知识库中的所有文档
 * @returns 所有文档的列表
 */
export async function getAllDocuments(): Promise<Array<{ content: string; metadata: any }>> {
  console.log('📋 获取知识库所有文档...');

  try {
    const client = new ChromaClient({ path: 'http://localhost:8000' });
    const collection = await client.getCollection({
      name: COLLECTION_NAME,
    });

    const results = await collection.get();

    const documents = results.documents.map((doc, i) => ({
      content: doc || '',
      metadata: results.metadatas?.[i] || {},
    }));

    console.log(`✅ 知识库共有 ${documents.length} 个文档`);
    return documents;
  } catch (error) {
    console.error('❌ 获取文档列表失败:', error);
    return [];
  }
}

/**
 * 获取知识库统计信息
 */
export async function getKnowledgeBaseStats(): Promise<{
  documentCount: number;
  collectionName: string;
}> {
  try {
    const client = new ChromaClient({ path: 'http://localhost:8000' });
    const collection = await client.getCollection({
      name: COLLECTION_NAME,
    });

    const results = await collection.get();
    const documentCount = results.documents?.length || 0;

    return {
      documentCount,
      collectionName: COLLECTION_NAME,
    };
  } catch (error) {
    return {
      documentCount: 0,
      collectionName: COLLECTION_NAME,
    };
  }
}

/**
 * 清空知识库（谨慎使用）
 */
export async function clearKnowledgeBase(): Promise<void> {
  console.log('⚠️ 即将清空整个知识库...');
  const store = await initializeVectorStore();

  try {
    // 删除所有文档（过滤条件为空会删除所有）
    await store.delete({ filter: {} });
    console.log('✅ 知识库已清空');
  } catch (error) {
    console.error('❌ 清空知识库失败:', error);
  }
}
