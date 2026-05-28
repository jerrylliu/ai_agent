/**
 * 向量数据库服务
 * 使用 ChromaDB 进行向量存储和检索
 * 支持文档的增删改查和相似性搜索
 */

import { Chroma } from '@langchain/community/vectorstores/chroma';
import { ChromaClient } from 'chromadb';
import { OllamaEmbeddings } from '@langchain/ollama';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Embeddings } from '@langchain/core/embeddings';
import MiniSearch from 'minisearch';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';

const BATCH_SIZE = 1;

// 配置
const COLLECTION_NAME = 'knowledge_base'; // 知识库集合名称
const EMBEDDING_MODEL = 'bge-large'; // 嵌入模型（中文支持好）
const PERSIST_DIR = path.join(__dirname, '..', '..', 'chromadb_data'); // ChromaDB 数据持久化目录

// 创建嵌入模型实例
const embeddings = new OllamaEmbeddings({
  model: EMBEDDING_MODEL,
  baseUrl: 'http://localhost:11434',
});

// ==================== P0: 优化切分参数 ====================
// 原参数: chunkSize=400, chunkOverlap=80 (重叠率 20%)
// 新参数: chunkSize=350, chunkOverlap=30 (重叠率 ~8.6%)
// 理由:
//   1. bge-large 嵌入模型上下文为 512 tokens，中文约 1.5-2 tokens/字符
//      350 字符 ≈ 350-700 tokens，留有余量不会溢出
//   2. 重叠从 80 降到 30，降低冗余存储（原 20% → 新 8.6%）
//   3. 单个 chunk 较小不影响 LLM 回答质量，因为 P3 上下文扩展会合并相邻 chunk
//      检索时命中 1 个 chunk → 返回前后各 1 个 → 共 3 个 chunk ≈ 1050 字符给 LLM
export const DEFAULT_CHUNK_SIZE = 350;
export const DEFAULT_CHUNK_OVERLAP = 30;

// 创建默认文本分割器（用于通用文本：TXT、PDF、Word 等）
export const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: DEFAULT_CHUNK_SIZE,
  chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  separators: ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''],
});

// ==================== P1: 按文档类型差异化切分 ====================
// 不同文档类型使用不同的切分策略，避免"一刀切"导致语义断裂

/**
 * 代码文件切分器
 * 优先按函数/类/方法边界切分，保持代码结构完整
 * separators 优先级: 类定义 > 函数定义 > 代码块 > 语句 > 字符
 */
export const codeSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: DEFAULT_CHUNK_SIZE,
  chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  separators: [
    '\n\nclass ',      // Python/Java/TS 类定义
    '\n\ndef ',        // Python 函数定义
    '\n\nfunction ',   // JS/TS 函数定义
    '\n\nconst ',      // JS/TS 常量定义
    '\n\nlet ',        // JS/TS 变量定义
    '\n\n// ',        // 注释块
    '\n\n/*',         // 多行注释开始
    '\n\n',           // 空行（代码块分隔）
    '\n',             // 换行
    ';',              // 语句结束（JS/TS/C/Java）
    ' ',              // 空格
    '',               // 字符级兜底
  ],
});

/**
 * Markdown 文件切分器
 * 优先按标题层级切分，保留标题上下文
 * 每个 chunk 会包含其所属的标题路径（如 "# 第一章 > ## 第二节"）
 */
export const markdownSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: DEFAULT_CHUNK_SIZE,
  chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  separators: [
    '\n# ',           // H1 标题
    '\n## ',          // H2 标题
    '\n### ',         // H3 标题
    '\n#### ',        // H4 标题
    '\n\n',           // 段落分隔
    '\n',             // 换行
    '。', '！', '？', '.', '!', '?', // 句子结束
    ' ',              // 空格
    '',               // 字符级兜底
  ],
});

/**
 * 根据文件扩展名获取对应的文本分割器
 * @param fileName 文件名（含扩展名）
 * @returns 适合该文件类型的 RecursiveCharacterTextSplitter 实例
 */
export function getSplitterByFileType(fileName: string): RecursiveCharacterTextSplitter {
  const ext = fileName.toLowerCase();

  // 代码文件: 优先按函数/类边界切分
  if (ext.endsWith('.py') || ext.endsWith('.js') || ext.endsWith('.ts') ||
      ext.endsWith('.jsx') || ext.endsWith('.tsx') || ext.endsWith('.java') ||
      ext.endsWith('.cpp') || ext.endsWith('.c') || ext.endsWith('.h') ||
      ext.endsWith('.cs') || ext.endsWith('.go') || ext.endsWith('.rs') ||
      ext.endsWith('.php') || ext.endsWith('.rb') || ext.endsWith('.swift')) {
    return codeSplitter;
  }

  // Markdown 文件: 优先按标题层级切分
  if (ext.endsWith('.md') || ext.endsWith('.markdown') || ext.endsWith('.mdx')) {
    return markdownSplitter;
  }

  // 默认: 使用通用文本切分器
  return textSplitter;
}

/**
 * 检测文本内容是否为 Markdown 格式
 * 通过检查是否包含 Markdown 特有的语法标记来判断
 * @param text 文本内容
 * @returns 是否为 Markdown
 */
export function isMarkdownContent(text: string): boolean {
  // 检查常见的 Markdown 语法标记
  const markdownPatterns = [
    /^#{1,6}\s+/m,           // 标题: # 标题
    /^\*\*|^__/m,            // 粗体: **text** 或 __text__
    /^\*|^_/m,               // 斜体: *text* 或 _text_
    /^```/m,                 // 代码块: ```
    /^\[.*?\]\(.*?\)/m,      // 链接: [text](url)
    /^!\[.*?\]\(.*?\)/m,     // 图片: ![alt](url)
    /^\s*[-*+]\s+/m,         // 列表: - item 或 * item
    /^\s*\d+\.\s+/m,         // 有序列表: 1. item
    /^\|.*\|/m,              // 表格: | col1 | col2 |
    /^>/m,                   // 引用: > quote
    /^---/m,                 // 分隔线: ---
  ];

  // 如果命中 2 个及以上模式，判定为 Markdown
  let matchCount = 0;
  for (const pattern of markdownPatterns) {
    if (pattern.test(text)) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }
  return false;
}

// 向量存储实例（单例）
let vectorStore: Chroma | null = null;

// BM25 全文索引实例（单例）
let bm25Index: MiniSearch | null = null;
let bm25DocumentStore: Map<string, { content: string; metadata: any }> = new Map();

// BM25 索引持久化路径
const BM25_INDEX_PATH = path.join(PERSIST_DIR, 'bm25_index.json');

// BM25 参数
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// 混合搜索参数
const RRF_K = 10; // RRF 融合参数，越小越重视各来源的排名差异

/**
 * 创建 BM25 索引实例
 */
function createBM25Index(): MiniSearch<any> {
  return new MiniSearch({
    fields: ['content'],
    storeFields: ['content', 'metadata'],
    searchOptions: {
      boost: { content: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
}

/**
 * 初始化 BM25 索引
 */
async function initializeBM25Index(): Promise<MiniSearch> {
  if (bm25Index) {
    return bm25Index;
  }

  logger.info('初始化 BM25 索引', { module: 'VectorStore' });
  bm25Index = createBM25Index();

  await loadBM25Index();
  return bm25Index;
}

/**
 * 加载 BM25 索引（从磁盘）
 */
async function loadBM25Index(): Promise<void> {
  try {
    if (!fs.existsSync(BM25_INDEX_PATH)) {
      logger.info('BM25 索引文件不存在，将创建新索引', { module: 'VectorStore' });
      return;
    }
    
    const fileContent = fs.readFileSync(BM25_INDEX_PATH, 'utf-8');
    if (!fileContent || fileContent.trim().length === 0) {
      logger.info('BM25 索引文件为空，将创建新索引', { module: 'VectorStore' });
      return;
    }
    
    const data = JSON.parse(fileContent);
    if (bm25Index && data?.index?.documents) {
      bm25Index.addAll(data.index.documents);
      bm25DocumentStore = new Map(Object.entries(data.documentStore || {}));
      logger.info('已加载 BM25 索引', { module: 'VectorStore', documentCount: bm25Index.documentCount });
    } else {
      logger.warn('BM25 索引数据格式不正确，将创建新索引', { module: 'VectorStore' });
    }
  } catch (error: any) {
    logger.error('加载 BM25 索引失败', { module: 'VectorStore', error: error.message });
    logger.info('将删除损坏的索引文件并创建新索引', { module: 'VectorStore' });
    try {
      if (fs.existsSync(BM25_INDEX_PATH)) {
        fs.unlinkSync(BM25_INDEX_PATH);
        logger.info('已删除损坏的索引文件', { module: 'VectorStore' });
      }
    } catch (deleteError) {
      logger.error('删除损坏索引文件失败', { module: 'VectorStore', error: deleteError.message });
    }
  }
}

/**
 * 保存 BM25 索引到磁盘
 */
async function saveBM25Index(): Promise<void> {
  try {
    if (!fs.existsSync(PERSIST_DIR)) {
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
    }
    const data = {
      index: bm25Index ? bm25Index.toJSON() : null,
      documentStore: Object.fromEntries(bm25DocumentStore),
    };
    fs.writeFileSync(BM25_INDEX_PATH, JSON.stringify(data));
  } catch (error) {
    logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(error) });
  }
}

/**
 * 添加文档到 BM25 索引
 */
async function addToBM25Index(
  id: string,
  content: string,
  metadata: any
): Promise<void> {
  if (!bm25Index) {
    await initializeBM25Index();
  }

  bm25Index!.add({
    id,
    content,
    metadata,
  });

  bm25DocumentStore.set(id, { content, metadata });
  await saveBM25Index();
}

/**
 * 从 BM25 索引删除文档
 */
function deleteFromBM25Index(id: string): void {
  if (!bm25Index) return;

  try {
    bm25Index!.remove(id);
    bm25DocumentStore.delete(id);
    saveBM25Index().catch(err => logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(err) }));
  } catch (error) {
    logger.warn('删除 BM25 文档失败（可能不存在）', { module: 'VectorStore', id });
  }
}

/**
 * 清空 BM25 索引
 */
async function clearBM25Index(): Promise<void> {
  bm25Index = null;
  bm25DocumentStore.clear();
  try {
    if (fs.existsSync(BM25_INDEX_PATH)) {
      fs.unlinkSync(BM25_INDEX_PATH);
    }
  } catch (error) {
    logger.error('删除 BM25 索引文件失败', { module: 'VectorStore', error: String(error) });
  }
  await initializeBM25Index();
}

/**
 * 重建 BM25 索引（从 ChromaDB 中所有文档）
 */
async function rebuildBM25Index(): Promise<void> {
  logger.info('正在重建 BM25 索引', { module: 'VectorStore' });
  await clearBM25Index();

  const docs = await getAllDocuments();
  for (const [i, doc] of docs.entries()) {
    const id = `doc_${i}`;
    await addToBM25Index(id, doc.content, doc.metadata);
  }

  logger.info('BM25 索引重建完成', { module: 'VectorStore', documentCount: docs.length });
}

/**
 * 初始化向量数据库
 * 如果已存在则加载，否则创建新的
 */
export async function initializeVectorStore(): Promise<Chroma> {
  if (vectorStore) {
    return vectorStore;
  }

  logger.info('初始化向量数据库', { module: 'VectorStore' });

  // 确保持久化目录存在
  if (!fs.existsSync(PERSIST_DIR)) {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    logger.info('创建 ChromaDB 数据目录', { module: 'VectorStore', path: PERSIST_DIR });
  }

  try {
    // 首先尝试连接并检查集合是否存在
    const client = new ChromaClient({ host: 'localhost', port: 8000 });

    let collectionExists = false;
    try {
      await client.getCollection({ name: COLLECTION_NAME });
      collectionExists = true;
      logger.info('发现已有知识库集合', { module: 'VectorStore' });
    } catch {
      collectionExists = false;
      logger.info('知识库集合不存在，将创建新集合', { module: 'VectorStore' });
    }

    // 创建 Chroma 向量存储
    if (collectionExists) {
      vectorStore = await Chroma.fromExistingCollection(embeddings, {
        collectionName: COLLECTION_NAME,
        url: 'http://localhost:8000',
      });
      const coll = await client.getCollection({ name: COLLECTION_NAME });
      logger.info('当前集合空间', { module: 'VectorStore', space: coll.metadata?.['hnsw:space'] || 'l2(默认)' });
    } else {
      // 集合不存在，先创建集合
      await client.createCollection({
        name: COLLECTION_NAME,
        metadata: { "hnsw:space": "cosine" },
        embeddingFunction: embeddings as any,
      });
      logger.info('新知识库集合已创建', { module: 'VectorStore' });
      vectorStore = await Chroma.fromExistingCollection(embeddings, {
        collectionName: COLLECTION_NAME,
        url: 'http://localhost:8000',
      });
    }

    logger.info('向量数据库初始化完成', { module: 'VectorStore' });
    return vectorStore;
  } catch (error) {
    logger.error('初始化向量数据库失败', { module: 'VectorStore', error: String(error) });

    // 如果 ChromaDB 连接失败，使用内存存储作为备选
    logger.warn('ChromaDB 不可用，尝试使用内存存储', { module: 'VectorStore' });
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

  logger.info('内存向量存储初始化完成（注意：重启后数据会丢失）', { module: 'VectorStore' });
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
  metadata: Array<{ source: string; docType?: string; [key: string]: any }>,
): Promise<number> {
  const store = await initializeVectorStore();

  logger.info('开始向量化文档', { module: 'VectorStore', textCount: texts.length, docType: metadata[0]?.docType || 'general' });

  // ==================== P1: 按文档类型选择切分器 ====================
  // 根据文件名或内容类型选择最合适的切分策略
  const allChunks: Array<{ text: string; metaIndex: number; splitterType: string }> = [];
  for (let t = 0; t < texts.length; t++) {
    const text = texts[t];
    const fileName = metadata[t]?.source || '';

    // 步骤1: 根据文件名扩展名选择切分器
    let splitter = getSplitterByFileType(fileName);
    let splitterType = 'general';

    // 步骤2: 如果文件名无法判断（如 .txt），通过内容检测是否为 Markdown
    if (splitter === textSplitter && isMarkdownContent(text)) {
      splitter = markdownSplitter;
      splitterType = 'markdown';
    } else if (splitter === codeSplitter) {
      splitterType = 'code';
    } else if (splitter === markdownSplitter) {
      splitterType = 'markdown';
    }

    logger.debug('文件切分策略', { module: 'VectorStore', fileName: fileName || 'unknown', splitterType });

    const chunks = await splitter.splitText(text);
    for (const chunk of chunks) {
      allChunks.push({ text: chunk, metaIndex: t, splitterType });
    }
  }
  logger.info('文本分割完成', { module: 'VectorStore', chunkCount: allChunks.length });

  const documents = allChunks.map((chunk, i) => new Document({
    pageContent: chunk.text,
    metadata: {
      ...metadata[chunk.metaIndex],
      chunk_index: i,
      source: metadata[chunk.metaIndex]?.source || 'unknown',
      doc_type: metadata[chunk.metaIndex]?.docType || 'general',
      splitter_type: chunk.splitterType, // P1: 记录使用的切分策略，便于调试和优化
    },
  }));

  // 分批添加到向量存储，避免超过上下文长度限制
  let addedCount = 0;
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    try {
      await store.addDocuments(batch);
      addedCount += batch.length;
      logger.debug('文本块处理进度', { module: 'VectorStore', addedCount, total: documents.length });
    } catch (error: any) {
      logger.error('批量添加失败', { module: 'VectorStore', start: i, end: i + batch.length, error: error.message });
      const isContextError = error.message?.includes('context length') ||
        error.message?.includes('context') ||
        error.message?.includes('exceeds');
      if (isContextError) {
        logger.warn('检测到上下文长度错误，尝试逐个添加文档', { module: 'VectorStore' });
        for (let j = 0; j < batch.length; j++) {
          try {
            await store.addDocuments([batch[j]]);
            addedCount++;
          } catch (singleError: any) {
            logger.error('文档添加失败', { module: 'VectorStore', index: i + j + 1, error: singleError.message });
          }
        }
      }
    }
  }

  logger.info('成功添加文本块到知识库', { module: 'VectorStore', addedCount });

  if (addedCount === 0) {
    throw new Error('所有文本块添加失败，ChromaDB 可能未启动或不可用');
  }

  // 添加到 BM25 索引（失败不影响主流程）
  try {
    await initializeBM25Index();
    let bm25AddedCount = 0;
    for (const [i, chunk] of allChunks.entries()) {
      const id = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${i}`;
      const chunkMetadata = {
        ...metadata[chunk.metaIndex],
        chunk_index: i,
        source: metadata[chunk.metaIndex]?.source || 'unknown',
        doc_type: metadata[chunk.metaIndex]?.docType || 'general',
      };
      await addToBM25Index(id, chunk.text, chunkMetadata);
      bm25AddedCount++;
    }
    logger.info('已添加文档到 BM25 索引', { module: 'VectorStore', documentCount: bm25AddedCount });
  } catch (bm25Error: any) {
    logger.warn('BM25 索引添加失败，不影响文档存储', { module: 'VectorStore', error: bm25Error.message });
  }

  return addedCount;
}

/**
 * 从知识库删除文档
 * @param filter 删除文档的过滤条件
 */
export async function deleteDocuments(filter: Record<string, any>): Promise<void> {
  const store = await initializeVectorStore();
  await store.delete({ filter });
  logger.info('已从知识库删除文档', { module: 'VectorStore' });

  // 重建 BM25 索引以保持同步
  await rebuildBM25Index();
}

/**
 * 搜索知识库（支持元数据过滤）
 * @param query 查询文本
 * @param topK 返回结果数量
 * @param minSimilarity 最小相似度阈值（score越低越相似，建议 cosine: <=1.0, l2: 越小越好）
 * @param filter 元数据过滤条件，例如 { doc_type: "技术文档" } 或 { source: "xxx" }
 */
export async function searchKnowledgeBase(
  query: string,
  topK: number = 5,
  minSimilarity: number = 0.4,
  filter?: Record<string, any>,
): Promise<Array<{ content: string; metadata: any; score: number }>> {
  const store = await initializeVectorStore();

  logger.info('搜索知识库', { module: 'VectorStore', query });
  if (filter) {
    logger.debug('搜索过滤条件', { module: 'VectorStore', filter });
  }

  try {
    // 向量检索：不在 where 中过滤 versionStatus，改为结果后过滤（兼容旧数据无 versionStatus 字段）
    const searchFilter = { ...filter };
    const results = await store.similaritySearchWithScore(query, topK * 3, Object.keys(searchFilter).length > 0 ? searchFilter : undefined);

    logger.info('检索到结果', { module: 'VectorStore', resultCount: results.length });

    results.forEach(([doc, score], i) => {
      logger.debug('搜索结果', { module: 'VectorStore', index: i, score: score.toFixed(4), docType: doc.metadata?.doc_type, versionStatus: doc.metadata?.versionStatus });
    });

    // 后过滤：只保留 active 版本（无 versionStatus 的旧数据视为 active）
    const filtered = results
      .filter(([doc, score]) => {
        // 相似度过滤
        if (score > minSimilarity) return false;
        // 版本状态过滤：无 versionStatus 或 versionStatus=active
        const vs = doc.metadata?.versionStatus;
        return !vs || vs === 'active';
      })
      .slice(0, topK);

    logger.info('搜索结果过滤完成', { module: 'VectorStore', minSimilarity, filteredCount: filtered.length });

    return filtered.map(([doc, score]) => ({
      content: doc.pageContent,
      metadata: doc.metadata,
      score,
    }));
  } catch (error: any) {
    logger.error('搜索失败', { module: 'VectorStore', error: error.message });
    return [];
  }
}

/**
 * 混合搜索（向量检索 + BM25 关键词检索）
 * 使用 RRF (Reciprocal Rank Fusion) 融合两种检索结果
 * @param query 查询文本
 * @param topK 返回结果数量
 * @param vectorWeight 向量检索权重 (0-1)，默认 0.7
 * @param bm25Weight BM25 检索权重 (0-1)，默认 0.3
 * @param filter 元数据过滤条件
 */
export async function hybridSearchKnowledgeBase(
  query: string,
  topK: number = 5,
  vectorWeight: number = 0.7,
  bm25Weight: number = 0.3,
  filter?: Record<string, any>,
): Promise<Array<{ content: string; metadata: any; score: number; vectorScore: number; sources: string[] }>> {
  
  logger.info('混合搜索', { module: 'VectorStore', query });
  logger.debug('混合搜索权重配置', { module: 'VectorStore', vectorWeight, bm25Weight });
  if (filter) {
    logger.debug('混合搜索过滤条件', { module: 'VectorStore', filter });
  }
  

  const store = await initializeVectorStore();
  await initializeBM25Index();

  // 1. 向量检索
  let vectorResults: Array<{ content: string; metadata: any; score: number; rank: number }> = [];
  try {
    // 向量检索：不在 where 中过滤 versionStatus，改为结果后过滤（兼容旧数据无 versionStatus 字段）
    const searchFilter = { ...filter };
    const rawVectorResults = await store.similaritySearchWithScore(query, topK * 4, Object.keys(searchFilter).length > 0 ? searchFilter : undefined);
    vectorResults = rawVectorResults
      .filter(([doc, score]) => {
        // 相似度过滤
        if (score > 0.55) return false;
        // 版本状态过滤：无 versionStatus 或 versionStatus=active
        const vs = doc.metadata?.versionStatus;
        return !vs || vs === 'active';
      })
      .slice(0, topK * 2)
      .map(([doc, score], rank) => ({
        content: doc.pageContent,
        metadata: doc.metadata,
        score,
        rank: rank + 1,
      }));

    logger.info('向量检索结果', { module: 'VectorStore', resultCount: vectorResults.length });
  } catch (error: any) {
    logger.error('向量检索失败', { module: 'VectorStore', error: error.message });
  }

  // 2. BM25 检索
  let bm25Results: Array<{ content: string; metadata: any; score: number; rank: number }> = [];
  try {
    const searchResults = bm25Index!.search(query, {
      boost: { content: 1 },
      fuzzy: 0.2,
      prefix: true,
    });

    bm25Results = searchResults.slice(0, topK * 3).map((result, rank) => {
      const stored = bm25DocumentStore.get(result.id);
      return {
        content: stored?.content || result.content || '',
        metadata: stored?.metadata || result,
        score: result.score,
        rank: rank + 1,
      };
    });

    // 应用元数据过滤到 BM25 结果（版本状态过滤：无 versionStatus 或 active 视为有效）
    const bm25Filter = { ...filter };
    const beforeFilter = bm25Results.length;
    bm25Results = bm25Results.filter((result) => {
      // 版本状态过滤：无 versionStatus 或 versionStatus=active
      const vs = result.metadata?.versionStatus;
      if (vs && vs !== 'active') return false;
      // 其他自定义过滤条件
      for (const [key, value] of Object.entries(bm25Filter)) {
        if (result.metadata?.[key] !== value) {
          return false;
        }
      }
      return true;
    });
    logger.debug('BM25 过滤结果', { module: 'VectorStore', beforeFilter, afterFilter: bm25Results.length, filter: bm25Filter });

    // 重新分配 rank（过滤后）
    bm25Results = bm25Results.slice(0, topK * 2).map((result, rank) => ({
      ...result,
      rank: rank + 1,
    }));

    logger.info('BM25 检索结果', { module: 'VectorStore', resultCount: bm25Results.length });
  } catch (error: any) {
    logger.error('BM25 检索失败', { module: 'VectorStore', error: error.message });
  }

  // 3. RRF 融合
  const scoreMap = new Map<string, {
    content: string;
    metadata: any;
    vectorScore: number;
    bm25Score: number;
    rrfScore: number;
    sources: string[];
  }>();

  // 添加向量结果
  vectorResults.forEach((result) => {
    const key = `${result.metadata?.source}_${result.metadata?.chunk_index}`;
    const rrfScore = vectorWeight / (RRF_K + result.rank);
    const existing = scoreMap.get(key);
    if (existing) {
      existing.vectorScore = result.score;
      existing.rrfScore += rrfScore;
      if (!existing.sources.includes('vector')) {
        existing.sources.push('vector');
      }
    } else {
      scoreMap.set(key, {
        content: result.content,
        metadata: result.metadata,
        vectorScore: result.score,
        bm25Score: 0,
        rrfScore,
        sources: ['vector'],
      });
    }
  });

  // 添加 BM25 结果
  bm25Results.forEach((result) => {
    const key = `${result.metadata?.source}_${result.metadata?.chunk_index}`;
    const rrfScore = bm25Weight / (RRF_K + result.rank);
    const existing = scoreMap.get(key);
    if (existing) {
      existing.bm25Score = result.score;
      existing.rrfScore += rrfScore;
      if (!existing.sources.includes('bm25')) {
        existing.sources.push('bm25');
      }
    } else {
      scoreMap.set(key, {
        content: result.content,
        metadata: result.metadata,
        vectorScore: 0,
        bm25Score: result.score,
        rrfScore,
        sources: ['bm25'],
      });
    }
  });

  // ==================== P3: 父文档引用 - 扩展上下文 ====================
  // 核心思路: 用小块(chunk)做检索保证精度，返回时合并相邻块成大块(parent)保证上下文完整性
  // 实现方式: 对融合后的 top 结果，获取同一文件(source)内相邻的 chunk，合并成更大的上下文

  // 步骤1: 排序并初步过滤
  const sortedResults = Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .filter((item) => {
      if (item.vectorScore > 0 && item.vectorScore > 0.55) {
        return false;
      }
      return true;
    })
    .slice(0, topK);

  // 步骤2: 扩展上下文 - 为每个结果获取相邻 chunk 合并
  // 从 ChromaDB 获取同一文件的所有 chunk，按 chunk_index 排序后合并相邻内容
  const expandedResults = await Promise.all(
    sortedResults.map(async (item) => {
      const source = item.metadata?.source;
      const currentIndex = item.metadata?.chunk_index;

      // 如果没有 source 或 chunk_index，无法扩展，直接返回原内容
      if (!source || currentIndex === undefined) {
        return {
          content: item.content,
          metadata: item.metadata,
          score: item.rrfScore,
          vectorScore: item.vectorScore,
          sources: item.sources,
        };
      }

      try {
        const client = new ChromaClient({ host: 'localhost', port: 8000 });
        const collection = await client.getCollection({ name: COLLECTION_NAME });
        const neighborResults = await collection.get({
          where: { source },
          limit: 100,
        });

        const sameFileChunks = neighborResults.documents
          .map((doc, i) => ({
            content: doc || '',
            index: (neighborResults.metadatas?.[i] as any)?.chunk_index ?? -1,
          }))
          .filter((c) => c.index !== -1 && c.content.length > 0)
          .sort((a, b) => a.index - b.index);

        // 找到当前 chunk 在排序后的位置
        const currentPos = sameFileChunks.findIndex((c) => c.index === currentIndex);
        if (currentPos === -1) {
          // 未找到当前 chunk，返回原内容
          return {
            content: item.content,
            metadata: item.metadata,
            score: item.rrfScore,
            vectorScore: item.vectorScore,
            sources: item.sources,
          };
        }

        // 取前后各1个邻居，合并成父文档
        const startIdx = Math.max(0, currentPos - 1);
        const endIdx = Math.min(sameFileChunks.length - 1, currentPos + 1);
        const parentChunks = sameFileChunks.slice(startIdx, endIdx + 1);

        // 合并邻居 chunk 的内容
        const expandedContent = parentChunks.map((c) => c.content).join('\n\n');

        // 记录扩展信息到 metadata
        const expandedMetadata = {
          ...item.metadata,
          parent_chunk_count: parentChunks.length,
          parent_chunk_range: `${parentChunks[0]?.index}-${parentChunks[parentChunks.length - 1]?.index}`,
          original_chunk_index: currentIndex,
        };

        return {
          content: expandedContent,
          metadata: expandedMetadata,
          score: item.rrfScore,
          vectorScore: item.vectorScore,
          sources: item.sources,
        };
      } catch (error: any) {
        // 扩展失败时不影响主流程，返回原内容
        logger.warn('扩展上下文失败', { module: 'VectorStore', source, chunkIndex: currentIndex, error: error.message });
        return {
          content: item.content,
          metadata: item.metadata,
          score: item.rrfScore,
          vectorScore: item.vectorScore,
          sources: item.sources,
        };
      }
    })
  );

  logger.info('混合搜索最终返回', { module: 'VectorStore', resultCount: expandedResults.length });
  expandedResults.forEach((result, i) => { logger.debug('搜索结果详情', { module: 'VectorStore', index: i + 1, rrfScore: result.score.toFixed(4), vectorScore: result.vectorScore.toFixed(4), sources: result.sources.join('+'), parentChunks: result.metadata?.parent_chunk_count }); });

  return expandedResults;
}

/**
 * 获取知识库中所有文档类型
 */
export async function getDocumentTypes(): Promise<string[]> {
  try {
    const docs = await getAllDocuments();
    const types = new Set<string>();
    docs.forEach(doc => {
      if (doc.metadata?.doc_type) {
        types.add(doc.metadata.doc_type);
      }
    });
    return Array.from(types);
  } catch (error) {
    logger.error('获取文档类型失败', { module: 'VectorStore', error: String(error) });
    return [];
  }
}

/**
 * 获取知识库中的所有文档
 * @returns 所有文档的列表
 */
export async function getAllDocuments(): Promise<Array<{ content: string; metadata: any }>> {
  logger.info('获取知识库所有文档', { module: 'VectorStore' });

  try {
    const client = new ChromaClient({ host: 'localhost', port: 8000 });
    const collection = await client.getCollection({
      name: COLLECTION_NAME,
    });

    const results = await collection.get();

    const documents = results.documents.map((doc, i) => ({
      content: doc || '',
      metadata: results.metadatas?.[i] || {},
    }));

    logger.info('知识库文档统计', { module: 'VectorStore', documentCount: documents.length });
    return documents;
  } catch (error) {
    logger.error('获取文档列表失败', { module: 'VectorStore', error: String(error) });
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
    const client = new ChromaClient({ host: 'localhost', port: 8000 });
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
  logger.warn('即将清空整个知识库', { module: 'VectorStore' });

  try {
    // 使用 ChromaDB 原生 API 删除整个集合
    const client = new ChromaClient({ host: 'localhost', port: 8000 });

    // 检查集合是否存在并删除
    try {
      await client.deleteCollection({ name: COLLECTION_NAME });
      logger.info('知识库集合已删除', { module: 'VectorStore' });
    } catch (error: any) {
      if (error.message && error.message.includes('not found')) {
        logger.info('知识库集合不存在，无需删除', { module: 'VectorStore' });
      } else {
        throw error;
      }
    }

    // 重新创建空集合（指定嵌入函数）
    await client.createCollection({
      name: COLLECTION_NAME,
      metadata: { "hnsw:space": "cosine" },
      embeddingFunction: embeddings as any,
    });
    logger.info('已创建新的空知识库集合', { module: 'VectorStore' });

    // 清空 BM25 索引
    await clearBM25Index();
    logger.info('BM25 索引已清空', { module: 'VectorStore' });
  } catch (error) {
    logger.error('清空知识库失败', { module: 'VectorStore', error: String(error) });
  }
}

/**
 * 预览文本切片效果（不实际存储）
 * @param text 要切分的文本
 * @returns 切分后的块列表
 */
export async function previewChunking(text: string): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 400,
    chunkOverlap: 80,
  });
  return splitter.splitText(text);
}

/**
 * 预览 Embedding 向量（不实际存储）
 * @param text 要生成嵌入的文本
 * @returns 嵌入向量的前 10 维（完整向量太长）
 */
export async function previewEmbedding(text: string): Promise<{
  text: string;
  dimensions: number;
  sample: number[];
  fullLength: number;
}> {
  const fullEmbedding = await embeddings.embedQuery(text);
  return {
    text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
    dimensions: fullEmbedding.length,
    sample: fullEmbedding.slice(0, 10),
    fullLength: fullEmbedding.length,
  };
}

/**
 * 调试搜索（详细显示每一步）
 * @param query 查询文本
 * @param topK 返回数量
 */
export async function debugSearch(
  query: string,
  topK: number = 3,
  minSimilarity: number = 0.4
): Promise<{
  originalQuery: string;
  rawResults: Array<{
    content: string;
    score: number;
    metadata: any;
  }>;
  filteredResults: Array<{
    content: string;
    score: number;
    metadata: any;
  }>;
}> {
  const store = await initializeVectorStore();
  
  logger.debug('调试搜索流程', { module: 'VectorStore' });
  
  logger.debug('原始查询', { module: 'VectorStore', query });

  const results = await store.similaritySearchWithScore(query, topK * 3);

  logger.debug('原始搜索结果', { module: 'VectorStore', resultCount: results.length });
  results.forEach(([doc, score], i) => {
    logger.debug('调试搜索结果', { module: 'VectorStore', index: i + 1, score: score.toFixed(4), content: doc.pageContent.substring(0, 100), metadata: doc.metadata });
  });
  const filtered = results
    .filter(([_, score]) => score <= minSimilarity)
    .slice(0, topK);

  logger.debug('过滤后搜索结果', { module: 'VectorStore', minSimilarity, filteredCount: filtered.length });

  const rawResults = results.map(([doc, score]) => ({
    content: doc.pageContent,
    score,
    metadata: doc.metadata,
  }));

  const filteredResults = filtered.map(([doc, score]) => ({
    content: doc.pageContent,
    score,
    metadata: doc.metadata,
  }));

  return {
    originalQuery: query,
    rawResults,
    filteredResults,
  };
}

/**
 * 获取知识库中存储的所有文档（带分数调试信息）
 */
export async function getAllDocumentsWithDebug(): Promise<{
  totalCount: number;
  documents: Array<{
    content: string;
    metadata: any;
    contentPreview: string;
    contentLength: number;
  }>;
}> {
  const documents = await getAllDocuments();
  return {
    totalCount: documents.length,
    documents: documents.map(d => ({
      content: d.content,
      metadata: d.metadata,
      contentPreview: d.content.substring(0, 100) + (d.content.length > 100 ? '...' : ''),
      contentLength: d.content.length,
    })),
  };
}

// ==================== 版本化向量管理 ====================

/**
 * 按 versionId 从 ChromaDB + BM25 索引中批量删除
 */
export async function removeDocumentVersion(versionId: number): Promise<void> {
  logger.info('开始删除版本向量数据', { module: 'VectorStore', versionId });

  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    throw new Error('向量存储集合未初始化');
  }

  try {
    // 从 ChromaDB 删除该版本的所有向量
    const versionFilter = { versionId: String(versionId) };

    // 先获取该版本的所有向量 ID
    const existing = await collection.get({ where: versionFilter });
    logger.info('查询到版本向量数据', { module: 'VectorStore', versionId, vectorCount: existing.ids.length });

    if (existing.ids.length > 0) {
      await collection.delete({ where: versionFilter });
      logger.info('已从 ChromaDB 删除版本向量', { module: 'VectorStore', versionId, vectorCount: existing.ids.length });
    } else {
      logger.info('ChromaDB 中无该版本向量数据', { module: 'VectorStore', versionId });
    }

    // 从 BM25 索引中删除该版本的文档（使用 bm25DocumentStore 替代内部属性）
    if (bm25Index) {
      const idsToRemove: string[] = [];
      for (const [id, doc] of bm25DocumentStore.entries()) {
        if (doc.metadata?.versionId === String(versionId)) {
          idsToRemove.push(id);
        }
      }
      logger.info('BM25 索引中该版本文档数量', { module: 'VectorStore', versionId, docCount: idsToRemove.length });

      if (idsToRemove.length > 0) {
        for (const id of idsToRemove) {
          try {
            bm25Index.remove(id);
          } catch {
            logger.warn('BM25 删除文档失败（可能已不存在）', { module: 'VectorStore', id });
          }
          bm25DocumentStore.delete(id);
        }
        saveBM25Index().catch(err => logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(err) }));
        logger.info('已从 BM25 索引删除版本文档', { module: 'VectorStore', versionId, docCount: idsToRemove.length });
      }
    } else {
      logger.info('BM25 索引未初始化，跳过', { module: 'VectorStore', versionId });
    }

    logger.info('版本向量数据删除完成', { module: 'VectorStore', versionId });
  } catch (error: any) {
    logger.error('删除版本向量数据失败', { module: 'VectorStore', versionId, error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * 按 versionId 批量更新向量的 versionStatus（回滚时用，不删除向量）
 */
export async function updateVersionVectorStatus(versionId: number, newStatus: string): Promise<void> {
  logger.info('开始更新版本向量状态', { module: 'VectorStore', versionId, newStatus });

  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    throw new Error('向量存储集合未初始化');
  }

  try {
    const versionFilter = { versionId: String(versionId) };
    const existing = await collection.get({ where: versionFilter });
    logger.info('查询到版本向量数据', { module: 'VectorStore', versionId, vectorCount: existing.ids.length });

    if (existing.ids.length > 0) {
      // 更新 metadata 中的 versionStatus
      const updatedMetadata = existing.metadatas.map((meta: any) => ({
        ...meta,
        versionStatus: newStatus,
      }));

      await collection.update({
        ids: existing.ids,
        metadatas: updatedMetadata,
      });

      logger.info('已更新 ChromaDB 版本向量状态', { module: 'VectorStore', versionId, newStatus, vectorCount: existing.ids.length });
    } else {
      logger.info('ChromaDB 中无该版本向量数据，跳过状态更新', { module: 'VectorStore', versionId });
    }

    // 同步更新 BM25 索引（使用 bm25DocumentStore 替代内部属性）
    if (bm25Index) {
      let updatedCount = 0;
      for (const [id, doc] of bm25DocumentStore.entries()) {
        if (doc.metadata?.versionId === String(versionId)) {
          doc.metadata.versionStatus = newStatus;
          updatedCount++;
        }
      }
      if (updatedCount > 0) {
        logger.info('已更新 BM25 索引中版本文档状态', { module: 'VectorStore', versionId, newStatus, updatedCount });
        saveBM25Index().catch(err => logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(err) }));
      }
    }

    logger.info('版本向量状态更新完成', { module: 'VectorStore', versionId, newStatus });
  } catch (error: any) {
    logger.error('更新版本向量状态失败', { module: 'VectorStore', versionId, newStatus, error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * 重新向量化版本（先清理旧向量，再重新入库，保证幂等）
 */
export async function reindexVersion(
  versionId: number,
  documentId: number,
  textContent: string,
  versionStatus: string,
  fileInfo: { source: string; fileType: string },
): Promise<number> {
  logger.info('开始重新向量化版本', { module: 'VectorStore', versionId, documentId, versionStatus, textLength: textContent.length });

  // 1. 先清理旧向量
  await removeDocumentVersion(versionId);

  // 2. 重新向量化入库
  const metadata = {
    documentId: String(documentId),
    versionId: String(versionId),
    versionStatus,
    source: fileInfo.source,
    fileType: fileInfo.fileType,
  };

  logger.info('开始重新添加向量', { module: 'VectorStore', versionId, documentId });
  const chunkCount = await addDocuments([textContent], [metadata]);
  logger.info('版本重新向量化完成', { module: 'VectorStore', versionId, documentId, chunkCount });
  return chunkCount;
}

/**
 * 清理孤岛向量（ChromaDB 中存在但数据库无对应记录的向量）
 * @param validVersionIds 数据库中存在的 versionId 列表
 * @returns 清理的向量数量
 */
export async function cleanOrphanVectors(validVersionIds: string[]): Promise<number> {
  logger.info('开始清理孤岛向量', { module: 'VectorStore', validVersionCount: validVersionIds.length });

  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    throw new Error('向量存储集合未初始化');
  }

  try {
    const allDocs = await collection.get();
    const validSet = new Set(validVersionIds);
    const orphanIds: string[] = [];
    const orphanVersionIds = new Set<string>();

    logger.info('ChromaDB 中总向量数', { module: 'VectorStore', totalVectors: allDocs.ids.length });

    for (let i = 0; i < allDocs.ids.length; i++) {
      const meta = allDocs.metadatas[i] as any;
      const versionId = meta?.versionId;
      // 如果有 versionId 但不在有效列表中，则为孤岛向量
      if (versionId && !validSet.has(versionId)) {
        orphanIds.push(allDocs.ids[i]);
        orphanVersionIds.add(versionId);
      }
    }

    if (orphanIds.length > 0) {
      logger.info('发现孤岛向量', { module: 'VectorStore', orphanCount: orphanIds.length, orphanVersionIds: [...orphanVersionIds] });
      await collection.delete({ ids: orphanIds });
      logger.info('已清理孤岛向量', { module: 'VectorStore', count: orphanIds.length });
    } else {
      logger.info('未发现孤岛向量', { module: 'VectorStore' });
    }

    return orphanIds.length;
  } catch (error: any) {
    logger.error('清理孤岛向量失败', { module: 'VectorStore', error: error.message, stack: error.stack });
    return 0;
  }
}
