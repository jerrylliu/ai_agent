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

const MAX_CHUNK_SIZE = 1000;
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

// 创建文本分割器
const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 256,
  chunkOverlap: 50,
  separators: ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''],
});

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
 * 初始化 BM25 索引
 */
async function initializeBM25Index(): Promise<MiniSearch> {
  if (bm25Index) {
    return bm25Index;
  }

  console.log('🔍 初始化 BM25 索引...');
  bm25Index = new MiniSearch({
    fields: ['content'],
    storeFields: ['content', 'metadata'],
    searchOptions: {
      boost: { content: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });

  await loadBM25Index();
  return bm25Index;
}

/**
 * 加载 BM25 索引（从磁盘）
 */
async function loadBM25Index(): Promise<void> {
  try {
    if (!fs.existsSync(BM25_INDEX_PATH)) {
      console.log('📂 BM25 索引文件不存在，将创建新索引');
      return;
    }
    const data = JSON.parse(fs.readFileSync(BM25_INDEX_PATH, 'utf-8'));
    if (bm25Index && data?.index?.documents) {
      bm25Index.addAll(data.index.documents);
      bm25DocumentStore = new Map(Object.entries(data.documentStore || {}));
      console.log(`✅ 已加载 BM25 索引，包含 ${bm25Index.documentCount} 个文档`);
    }
  } catch (error) {
    console.error('❌ 加载 BM25 索引失败:', error);
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
    console.error('❌ 保存 BM25 索引失败:', error);
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
    saveBM25Index();
  } catch (error) {
    console.log(`⚠️ 删除 BM25 文档失败 (可能不存在): ${id}`);
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
    console.error('❌ 删除 BM25 索引文件失败:', error);
  }
  await initializeBM25Index();
}

/**
 * 重建 BM25 索引（从 ChromaDB 中所有文档）
 */
async function rebuildBM25Index(): Promise<void> {
  console.log('🔄 正在重建 BM25 索引...');
  await clearBM25Index();

  const docs = await getAllDocuments();
  for (const [i, doc] of docs.entries()) {
    const id = `doc_${i}`;
    await addToBM25Index(id, doc.content, doc.metadata);
  }

  console.log(`✅ BM25 索引重建完成，共 ${docs.length} 个文档`);
}

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
    // 首先尝试连接并检查集合是否存在
    const client = new ChromaClient({ host: 'localhost', port: 8000 });

    let collectionExists = false;
    try {
      await client.getCollection({ name: COLLECTION_NAME });
      collectionExists = true;
      console.log('📂 发现已有知识库集合');
    } catch {
      collectionExists = false;
      console.log('📂 知识库集合不存在，将创建新集合');
    }

    // 创建 Chroma 向量存储
    if (collectionExists) {
      vectorStore = await Chroma.fromExistingCollection(embeddings, {
        collectionName: COLLECTION_NAME,
        url: 'http://localhost:8000',
      });
      const coll = await client.getCollection({ name: COLLECTION_NAME });
      console.log(`ℹ️ 当前集合空间: ${coll.metadata?.['hnsw:space'] || 'l2(默认)'}`);
    } else {
      // 集合不存在，先创建集合
      await client.createCollection({
        name: COLLECTION_NAME,
        metadata: { "hnsw:space": "cosine" },
        embeddingFunction: embeddings as any,
      });
      console.log('✅ 新知识库集合已创建');
      vectorStore = await Chroma.fromExistingCollection(embeddings, {
        collectionName: COLLECTION_NAME,
        url: 'http://localhost:8000',
      });
    }

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
  metadata: Array<{ source: string; docType?: string; [key: string]: any }>,
): Promise<number> {
  const store = await initializeVectorStore();

  console.log(`📤 开始向量化 ${texts.length} 个文档...(docType: ${metadata[0]?.docType || 'general'})...`);

  // 分割文本
  const allChunks: string[] = [];
  for (const text of texts) {
    const chunks = await textSplitter.splitText(text);
    allChunks.push(...chunks);
  }
  console.log('📋 分割后的文本块预览：');
  allChunks.forEach((chunk, i) => {
    console.log(`块${i}: ${chunk.substring(0, 100)}...`);
  });
  console.log(`✂️ 文本分割完成，共 ${allChunks.length} 个文本块`);

  // 为每个分割后的文本块创建文档
  const documents = allChunks.map((text, i) => new Document({
    pageContent: text,
    metadata: {
      ...metadata[0],
      chunk_index: i,
      source: metadata[0]?.source || 'unknown',
      doc_type: metadata[0]?.docType || 'general',
    },
  }));

  // 分批添加到向量存储，避免超过上下文长度限制
  let addedCount = 0;
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    try {
      await store.addDocuments(batch);
      addedCount += batch.length;
      console.log(`📦 已处理 ${addedCount}/${documents.length} 个文本块`);
    } catch (error: any) {
      console.error(`❌ 批量添加失败 (${i}-${i + batch.length}):`, error.message);
      const isContextError = error.message?.includes('context length') ||
        error.message?.includes('context') ||
        error.message?.includes('exceeds');
      if (isContextError) {
        console.log('⚠️ 检测到上下文长度错误，尝试逐个添加文档...');
        for (let j = 0; j < batch.length; j++) {
          try {
            await store.addDocuments([batch[j]]);
            addedCount++;
          } catch (singleError: any) {
            console.error(`❌ 文档 ${i + j + 1} 添加失败:`, singleError.message);
          }
        }
      }
    }
  }

  console.log(`✅ 成功添加 ${addedCount} 个文本块到知识库`);

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
        ...metadata[0],
        chunk_index: i,
        source: metadata[0]?.source || 'unknown',
        doc_type: metadata[0]?.docType || 'general',
      };
      await addToBM25Index(id, chunk, chunkMetadata);
      bm25AddedCount++;
    }
    console.log(`🔍 已添加 ${bm25AddedCount} 个文档到 BM25 索引`);
  } catch (bm25Error: any) {
    console.warn('⚠️ BM25 索引添加失败，不影响文档存储:', bm25Error.message);
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
  console.log('🗑️ 已从知识库删除文档');

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
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

export async function searchKnowledgeBase(
  query: string,
  topK: number = 5,
  minSimilarity: number = 0.4,
  filter?: Record<string, any>,
): Promise<Array<{ content: string; metadata: any; score: number }>> {
  const store = await initializeVectorStore();

  const prefixedQuery = QUERY_PREFIX + query;

  console.log(`🔍 搜索知识库: "${query}"`);
  console.log(`   📝 带前缀查询: "${prefixedQuery.substring(0, 80)}..."`);
  if (filter) {
    console.log(`   📋 过滤条件: ${JSON.stringify(filter)}`);
  }

  try {
    const results = await store.similaritySearchWithScore(prefixedQuery, topK * 2, filter);

    console.log(`📊 检索到 ${results.length} 个结果`);

    results.forEach(([doc, score], i) => {
      console.log(`   [${i}] score=${score.toFixed(4)} | doc_type=${doc.metadata?.doc_type} | "${doc.pageContent.substring(0, 50)}..."`);
    });

    const filtered = results
      .filter(([_, score]) => score <= minSimilarity)
      .slice(0, topK);

    console.log(`✅ 通过阈值(score<=${minSimilarity})过滤后: ${filtered.length} 个结果`);

    return filtered.map(([doc, score]) => ({
      content: doc.pageContent,
      metadata: doc.metadata,
      score,
    }));
  } catch (error: any) {
    console.error('❌ 搜索失败:', error.message);
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
): Promise<Array<{ content: string; metadata: any; score: number; sources: string[] }>> {
  console.log('='.repeat(50));
  console.log(`🔍 混合搜索: "${query}"`);
  console.log(`   权重配置: 向量=${vectorWeight}, BM25=${bm25Weight}`);
  if (filter) {
    console.log(`   过滤条件: ${JSON.stringify(filter)}`);
  }
  console.log('='.repeat(50));

  const store = await initializeVectorStore();
  await initializeBM25Index();

  // 1. 向量检索
  let vectorResults: Array<{ content: string; metadata: any; score: number; rank: number }> = [];
  try {
    const rawVectorResults = await store.similaritySearchWithScore(QUERY_PREFIX + query, topK * 3, filter);
    vectorResults = rawVectorResults
      .filter(([_, score]) => score <= 0.7)
      .slice(0, topK * 2)
      .map(([doc, score], rank) => ({
        content: doc.pageContent,
        metadata: doc.metadata,
        score,
        rank: rank + 1,
      }));

    console.log(`📊 向量检索: ${vectorResults.length} 个结果`);
  } catch (error: any) {
    console.error('❌ 向量检索失败:', error.message);
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

    // 应用元数据过滤到 BM25 结果
    if (filter) {
      const beforeFilter = bm25Results.length;
      bm25Results = bm25Results.filter((result) => {
        for (const [key, value] of Object.entries(filter)) {
          if (result.metadata?.[key] !== value) {
            return false;
          }
        }
        return true;
      });
      console.log(`📋 BM25 过滤: ${beforeFilter} -> ${bm25Results.length} 个结果 (filter: ${JSON.stringify(filter)})`);
    }

    // 重新分配 rank（过滤后）
    bm25Results = bm25Results.slice(0, topK * 2).map((result, rank) => ({
      ...result,
      rank: rank + 1,
    }));

    console.log(`📊 BM25 检索: ${bm25Results.length} 个结果`);
  } catch (error: any) {
    console.error('❌ BM25 检索失败:', error.message);
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

  // 排序并返回 topK
  const fusedResults = Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
    .map((item) => ({
      content: item.content,
      metadata: item.metadata,
      score: item.rrfScore,
      sources: item.sources,
    }));

  console.log(`✅ 混合搜索最终返回: ${fusedResults.length} 个结果`);
  fusedResults.forEach((result, i) => {
    console.log(`   [${i + 1}] rrf=${result.score.toFixed(4)} | sources=${result.sources.join('+')} | "${result.content.substring(0, 40)}..."`);
  });

  return fusedResults;
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
    console.error('❌ 获取文档类型失败:', error);
    return [];
  }
}

/**
 * 获取知识库中的所有文档
 * @returns 所有文档的列表
 */
export async function getAllDocuments(): Promise<Array<{ content: string; metadata: any }>> {
  console.log('📋 获取知识库所有文档...');

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
  console.log('⚠️ 即将清空整个知识库...');

  try {
    // 使用 ChromaDB 原生 API 删除整个集合
    const client = new ChromaClient({ host: 'localhost', port: 8000 });

    // 检查集合是否存在并删除
    try {
      await client.deleteCollection({ name: COLLECTION_NAME });
      console.log('✅ 知识库集合已删除');
    } catch (error: any) {
      if (error.message && error.message.includes('not found')) {
        console.log('ℹ️ 知识库集合不存在，无需删除');
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
    console.log('✅ 已创建新的空知识库集合');

    // 清空 BM25 索引
    await clearBM25Index();
    console.log('✅ BM25 索引已清空');
  } catch (error) {
    console.error('❌ 清空知识库失败:', error);
  }
}

/**
 * 预览文本切片效果（不实际存储）
 * @param text 要切分的文本
 * @returns 切分后的块列表
 */
export async function previewChunking(text: string): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 256,
    chunkOverlap: 50,
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
  console.log('='.repeat(50));
  console.log('🔍 调试搜索流程');
  console.log('='.repeat(50));
  console.log(`原始查询: "${query}"`);

  const results = await store.similaritySearchWithScore(query, topK * 3);

  console.log(`\n📊 原始搜索结果: ${results.length} 个`);
  results.forEach(([doc, score], i) => {
    console.log(`\n--- 结果 ${i + 1} ---`);
    console.log(`分数: ${score.toFixed(4)}`);
    console.log(`内容: ${doc.pageContent.substring(0, 100)}...`);
    console.log(`元数据: ${JSON.stringify(doc.metadata)}`);
  });
  const filtered = results
    .filter(([_, score]) => score <= minSimilarity)
    .slice(0, topK);

  console.log(`\n✅ 通过阈值(score<=${minSimilarity})过滤后: ${filtered.length} 个`);

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
  documents.forEach(doc => {
    if (doc.content.includes('迟到')) {
      console.log('找到包含迟到的块:', doc.content.substring(0, 200));
    }
  });
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
