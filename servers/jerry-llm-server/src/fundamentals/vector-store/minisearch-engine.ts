/**
 * 向量存储 — BM25 引擎适配器：MiniSearch
 *
 * 对既有 bm25-index.ts 逻辑的原样包装（S1.7a，零行为变更）：
 * - 索引实例与文档 Map 仍存放在 store-state（getBM25Index / getBM25DocumentStore），
 *   保证现有调用方（vector-search / vector-crud / vector-version）零改动；
 *   S1.9 调用方全部改走 BM25Engine 接口后，Map 才下沉为适配器私有状态；
 * - 落盘格式与路径不变：`${PERSIST_DIR}/bm25_index.json`；
 * - 已知限制：saveBM25Index 走 JSON.stringify，受 V8 单字符串 ~512MB 上限，
 *   ~50 万 chunk 规模会触顶（这是引入 Tantivy 第二引擎的动因，见方案 §3.5）。
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
import type { BM25Engine, BM25SearchResult } from './bm25-engine.js';

// ==================== 常量 ====================

/** BM25 索引文件路径 */
const BM25_INDEX_PATH = `${PERSIST_DIR}/bm25_index.json`;

/** MiniSearch 实例化配置（create 与 loadJSON 必须保持一致） */
const MINISEARCH_OPTIONS = {
  fields: ['content'],                    // 只对 content 字段建立倒排索引
  storeFields: ['content', 'metadata'],   // 存储原始内容，用于结果返回
  searchOptions: {
    boost: { content: 1 },                // content 字段权重
    fuzzy: 0.2,                           // 模糊匹配容忍度（处理拼写错误）
    prefix: true,                         // 支持前缀匹配（输入部分关键词即可匹配）
  },
};

/**
 * 创建空的 MiniSearch 索引
 * 配置中文友好的搜索选项
 */
export function createBM25Index(): MiniSearch {
  return new MiniSearch(MINISEARCH_OPTIONS);
}

// ==================== 适配器实现 ====================

/**
 * MiniSearch 引擎适配器
 *
 * 实现 BM25Engine 窄接口，内部逻辑与原 bm25-index.ts 完全一致，
 * 仅做接口形状适配，不引入任何行为变更。
 */
export class MiniSearchBM25Engine implements BM25Engine {
  readonly type = 'minisearch' as const;

  /**
   * 初始化 BM25 索引（幂等）
   * 如果磁盘上有索引文件则加载，否则创建空索引
   */
  async init(): Promise<void> {
    if (getBM25Index()) return;

    // 创建空索引
    setBM25Index(createBM25Index());
    setBM25DocumentStore(new Map());

    // 尝试从磁盘加载已有索引
    if (fs.existsSync(BM25_INDEX_PATH)) {
      await this.load();
    } else {
      logger.info('BM25 索引文件不存在，已创建空索引', { module: 'VectorStore' });
    }
  }

  /**
   * 添加文档到 BM25 索引
   *
   * @param id 文档唯一标识
   * @param content 文档文本内容
   * @param metadata 文档元数据
   * @param skipCommit 跳过立即保存到磁盘（批量操作时设为 true，由调用方统一 commit）
   */
  async add(id: string, content: string, metadata: any, skipCommit: boolean = false): Promise<void> {
    if (!getBM25Index()) {
      await this.init();
    }

    getBM25Index()!.add({ id, content, metadata });
    getBM25DocumentStore().set(id, { content, metadata });

    if (!skipCommit) {
      await this.commit();
    }
  }

  /**
   * 保存 BM25 索引到磁盘
   * 将索引和文档存储序列化为 JSON 写入文件
   *
   * ⚠️ V8 单字符串 ~512MB 上限：~50 万 chunk 规模 JSON.stringify 会触顶失效，
   * 该规模场景须切换 BM25_ENGINE=tantivy（见方案 §3.5 / §3.7）
   */
  async commit(): Promise<void> {
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

  /**
   * 关键词检索
   * 优先从文档 Map 取回 content/metadata（与既有 bm25Search 的取值逻辑一致），
   * Map 缺失时回退到 MiniSearch storeFields 中存储的副本
   */
  async search(query: string, limit: number): Promise<BM25SearchResult[]> {
    const bm25Index = getBM25Index();
    if (!bm25Index || bm25Index.documentCount === 0) {
      return [];
    }

    const bm25DocumentStore = getBM25DocumentStore();
    const searchResults = bm25Index.search(query, { limit });

    return searchResults.map((result: any) => {
      const doc = bm25DocumentStore.get(result.id);
      return {
        id: String(result.id),
        content: doc?.content || result.content,
        metadata: doc?.metadata || {},
        score: result.score,
      };
    });
  }

  /**
   * 从 BM25 索引删除文档（同步语义）
   * 删除后异步保存索引到磁盘（fire-and-forget + 错误日志，与历史行为一致）
   */
  delete(id: string): void {
    const bm25Index = getBM25Index();
    if (!bm25Index) return;

    try {
      // MiniSearch.remove 需要传入完整文档对象（与添加时一致）
      const doc = getBM25DocumentStore().get(id);
      if (doc) {
        bm25Index.remove({ id, content: doc.content, metadata: doc.metadata });
      }
      getBM25DocumentStore().delete(id);
      this.commit().catch(err => logger.error('保存 BM25 索引失败', { module: 'VectorStore', error: String(err) }));
    } catch (error) {
      logger.warn('删除 BM25 文档失败（可能不存在）', { module: 'VectorStore', id });
    }
  }

  /**
   * 清空 BM25 索引
   * 删除磁盘索引文件，重新创建空索引
   */
  async clear(): Promise<void> {
    setBM25Index(null);
    getBM25DocumentStore().clear();
    try {
      if (fs.existsSync(BM25_INDEX_PATH)) {
        fs.unlinkSync(BM25_INDEX_PATH);
      }
    } catch (error) {
      logger.error('删除 BM25 索引文件失败', { module: 'VectorStore', error: String(error) });
    }
    await this.init();
  }

  // ==================== 私有方法 ====================

  /**
   * 从磁盘加载 BM25 索引
   * 使用 MiniSearch 官方 loadJSON 反序列化；文件损坏时删除并重建
   */
  private async load(): Promise<void> {
    try {
      const fileContent = fs.readFileSync(BM25_INDEX_PATH, 'utf-8');
      if (!fileContent || fileContent.trim().length === 0) {
        logger.info('BM25 索引文件为空，将创建新索引', { module: 'VectorStore' });
        return;
      }

      const data = JSON.parse(fileContent);
      if (data?.index && data.index.serializationVersion) {
        // 使用 MiniSearch 官方 loadJSON 反序列化
        setBM25Index(MiniSearch.loadJSON(JSON.stringify(data.index), MINISEARCH_OPTIONS));
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
      } catch (deleteError: any) {
        logger.error('删除损坏索引文件失败', { module: 'VectorStore', error: deleteError.message });
      }
    }
  }
}
