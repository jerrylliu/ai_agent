/**
 * 向量存储 — BM25 关键词索引管理
 *
 * 管理 BM25 倒排索引的完整生命周期：
 * - 初始化（从磁盘加载或创建空索引）
 * - 增删改（单条/批量操作）
 * - 持久化（保存到磁盘）
 * - 重建（从 ChromaDB 全量重建）
 *
 * BM25 索引用于混合搜索中的关键词检索，
 * 与向量检索互补，提升关键词精确匹配的召回率。
 */

import MiniSearch from 'minisearch';
import * as fs from 'fs';
import { logger } from '../logger.js';
import {
  PERSIST_DIR,
  getBM25Index,
  setBM25Index,
  getBM25DocumentStore,
  setBM25DocumentStore,
} from './store-state.js';

// ==================== 常量 ====================

/** BM25 索引文件路径 */
const BM25_INDEX_PATH = `${PERSIST_DIR}/bm25_index.json`;

// ==================== 索引初始化 ====================

/**
 * 创建空的 BM25 索引
 * 使用 MiniSearch 实现，配置中文友好的搜索选项
 */
export function createBM25Index(): MiniSearch {
  return new MiniSearch({
    fields: ['content'],             // 只对 content 字段建立倒排索引
    storeFields: ['content', 'metadata'], // 存储原始内容，用于结果返回
    searchOptions: {
      boost: { content: 1 },         // content 字段权重
      fuzzy: 0.2,                    // 模糊匹配容忍度（处理拼写错误）
      prefix: true,                  // 支持前缀匹配（输入部分关键词即可匹配）
    },
  });
}

/**
 * 初始化 BM25 索引
 * 如果磁盘上有索引文件则加载，否则创建空索引
 */
export async function initializeBM25Index(): Promise<void> {
  if (getBM25Index()) return;

  // 创建空索引
  setBM25Index(createBM25Index());
  setBM25DocumentStore(new Map());

  // 尝试从磁盘加载已有索引
  if (fs.existsSync(BM25_INDEX_PATH)) {
    await loadBM25Index();
  } else {
    logger.info('BM25 索引文件不存在，已创建空索引', { module: 'VectorStore' });
  }
}

// ==================== 索引持久化 ====================

/**
 * 从磁盘加载 BM25 索引
 * 使用 MiniSearch 官方 loadJSON 反序列化
 */
async function loadBM25Index(): Promise<void> {
  try {
    const fileContent = fs.readFileSync(BM25_INDEX_PATH, 'utf-8');
    if (!fileContent || fileContent.trim().length === 0) {
      logger.info('BM25 索引文件为空，将创建新索引', { module: 'VectorStore' });
      return;
    }

    const data = JSON.parse(fileContent);
    if (data?.index && data.index.serializationVersion) {
      // 使用 MiniSearch 官方 loadJSON 反序列化
      setBM25Index(MiniSearch.loadJSON(JSON.stringify(data.index), {
        fields: ['content'],
        storeFields: ['content', 'metadata'],
        searchOptions: {
          boost: { content: 1 },
          fuzzy: 0.2,
          prefix: true,
        },
      }));
      setBM25DocumentStore(new Map(Object.entries(data.documentStore || {})));
      logger.info('已加载 BM25 索引', { module: 'VectorStore', documentCount: getBM25Index().documentCount });
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
 * 将索引和文档存储序列化为 JSON 写入文件
 */
export async function saveBM25Index(): Promise<void> {
  try {
    if (!fs.existsSync(PERSIST_DIR)) {
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
    }
    const bm25Index = getBM25Index();
    const bm25DocumentStore = getBM25DocumentStore();
    const data = {
      index: bm25Index ? bm25Index.toJSON() : null,
      documentStore: Object.fromEntries(bm25DocumentStore),
    };
    fs.writeFileSync(BM25_INDEX_PATH, JSON.stringify(data));
  } catch (error) {
    logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(error) });
  }
}

// ==================== 增删操作 ====================

/**
 * 添加文档到 BM25 索引
 *
 * @param id 文档唯一标识
 * @param content 文档文本内容
 * @param metadata 文档元数据
 * @param skipSave 跳过立即保存到磁盘（批量操作时设为 true，由调用方统一保存）
 */
export async function addToBM25Index(
  id: string,
  content: string,
  metadata: any,
  skipSave: boolean = false,
): Promise<void> {
  if (!getBM25Index()) {
    await initializeBM25Index();
  }

  getBM25Index()!.add({ id, content, metadata });
  getBM25DocumentStore().set(id, { content, metadata });

  if (!skipSave) {
    await saveBM25Index();
  }
}

/**
 * 从 BM25 索引删除文档
 * 删除后异步保存索引到磁盘
 */
export function deleteFromBM25Index(id: string): void {
  const bm25Index = getBM25Index();
  if (!bm25Index) return;

  try {
    bm25Index.remove(id);
    getBM25DocumentStore().delete(id);
    saveBM25Index().catch(err => logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(err) }));
  } catch (error) {
    logger.warn('删除 BM25 文档失败（可能不存在）', { module: 'VectorStore', id });
  }
}

/**
 * 清空 BM25 索引
 * 删除磁盘索引文件，重新创建空索引
 */
export async function clearBM25Index(): Promise<void> {
  setBM25Index(null);
  getBM25DocumentStore().clear();
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
 *
 * 场景：BM25 索引损坏或需要全量刷新时调用。
 * 仅将 active 状态的文档加入索引，archived 状态的文档不参与关键词检索。
 *
 * @param getAllDocuments 获取所有文档的回调（由 vector-version 模块提供，避免循环依赖）
 */
export async function rebuildBM25Index(
  getAllDocuments: () => Promise<Array<{ content: string; metadata: any }>>,
): Promise<void> {
  logger.info('正在重建 BM25 索引', { module: 'VectorStore' });
  await clearBM25Index();

  const docs = await getAllDocuments();

  // 过滤掉 archived 状态的文档，仅将 active 或无 versionStatus（兼容旧数据）的文档加入 BM25 索引
  // archived 状态的向量属于已被新版本替代的旧版本，不应参与关键词检索
  const activeDocs = docs.filter((doc) => {
    const vs = doc.metadata?.versionStatus;
    return !vs || vs === 'active';
  });

  for (const [i, doc] of activeDocs.entries()) {
    const id = `doc_${i}`;
    await addToBM25Index(id, doc.content, doc.metadata, true); // 批量操作，跳过单次保存
  }
  await saveBM25Index(); // 批量操作完成后统一保存

  logger.info('BM25 索引重建完成', { module: 'VectorStore', totalCount: docs.length, activeCount: activeDocs.length });
}
