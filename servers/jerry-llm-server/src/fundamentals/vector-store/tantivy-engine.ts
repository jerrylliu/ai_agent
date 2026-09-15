/**
 * 向量存储 — BM25 引擎适配器：Tantivy（S1.8）
 *
 * 与 MiniSearch 适配器的本质差异（见方案 §3.7.3 #4/#9）：
 * - 落盘为**目录**（`${PERSIST_DIR}/bm25_index_tantivy/`），非单个 JSON 文件，
 *   绕开 V8 单字符串 ~512MB 上限，可承载 ~50 万 chunk 规模（ERB 数据集）；
 * - content + metadata 由 Tantivy **stored fields** 承载，检索命中后直接从
 *   doc store 取回，**无需**在内存维护文档 Map（这是相对 MiniSearch 的核心优势）；
 * - 删除走 **delete-by-term**（id 字段用 raw tokenizer 精确匹配），O(1) 语义。
 *
 * 引擎约束（红线）：
 * - #10 禁止同进程混用两种引擎；本适配器状态全部私有，不写 store-state 全局态；
 * - #11 BM25 分数只在同引擎内可比，评测报告必须标注 BM25_ENGINE。
 *
 * 已知限制：content 字段使用 Tantivy 默认分词器（SimpleTokenizer），
 * 对无空格中文按整段切分，检索质量与 MiniSearch 默认分词器同源；
 * 保持默认分词是为满足 §3.7.5 双引擎一致性对照（topK 重合度 ≥70%）。
 */

import {
  Index,
  SchemaBuilder,
  Document,
  TokenizerStatic,
  TextAnalyzerBuilder,
} from '@pngwasi/node-tantivy-binding';
import type { IndexWriter, Schema } from '@pngwasi/node-tantivy-binding';
import * as fs from 'fs';
import { logger } from '../logger.js';
import { PERSIST_DIR } from './store-state.js';
import type { BM25Engine, BM25SearchResult } from './bm25-engine.js';

// ==================== 常量 ====================

/** Tantivy 索引目录（与 MiniSearch 的 bm25_index.json 路径隔离，切换引擎不删另一份数据） */
const TANTIVY_INDEX_DIR = `${PERSIST_DIR}/bm25_index_tantivy`;

/** id 字段使用的 raw tokenizer 名称（delete-by-term 精确匹配要求） */
const RAW_TOKENIZER = 'raw';

/** IndexWriter 堆大小（字节）：Tantivy 要求每线程 ≥ 3_000_000 */
const WRITER_HEAP_SIZE = 50_000_000;

/** IndexWriter 线程数：单线程写入，避免并发 commit 竞争 */
const WRITER_NUM_THREADS = 1;

// ==================== 适配器实现 ====================

/**
 * Tantivy 引擎适配器
 *
 * 实现 BM25Engine 窄接口；索引/写入器实例为适配器私有状态，
 * 不落入 store-state 全局态（红线 #10：禁止同进程混用引擎）。
 */
export class TantivyBM25Engine implements BM25Engine {
  readonly type = 'tantivy' as const;

  private index: Index | null = null;
  private writer: IndexWriter | null = null;
  private initialized = false;

  /**
   * 初始化 Tantivy 索引（幂等）
   * 目录已存在则重开复用，否则新建；随后创建 IndexWriter。
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    if (!fs.existsSync(PERSIST_DIR)) {
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
    }

    // 注意：绑定 Index.exists() 对不存在的路径会抛 "Directory does not exist"，
    // 不能用于判断目录缺失（spike 实测纠正），故改用 fs.existsSync 判断是否重开
    const exists = fs.existsSync(TANTIVY_INDEX_DIR);
    if (exists) {
      // 重开已有索引（schema 从磁盘读取）
      this.index = Index.open(TANTIVY_INDEX_DIR);
    } else {
      // 目录必须先存在，Index 构造器不会自动创建
      fs.mkdirSync(TANTIVY_INDEX_DIR, { recursive: true });
      this.index = new Index(this.buildSchema(), TANTIVY_INDEX_DIR, false);
    }
    // raw tokenizer 供 id 字段使用（delete-by-term 精确匹配），重开时也需注册
    this.registerRawTokenizer(this.index);
    this.writer = this.index.writer(WRITER_HEAP_SIZE, WRITER_NUM_THREADS);
    this.initialized = true;

    logger.info('Tantivy BM25 索引已初始化', {
      module: 'VectorStore',
      reused: exists,
      dir: TANTIVY_INDEX_DIR,
    });
  }

  /**
   * 添加文档到 Tantivy 索引
   * content/metadata 写入 stored fields，检索命中后直接取回，无需内存 Map。
   *
   * @param skipCommit 批量操作时设为 true，由调用方统一 commit，避免逐条落盘
   */
  async add(id: string, content: string, metadata: any, skipCommit: boolean = false): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    const doc = new Document();
    doc.addText('id', id);
    doc.addText('content', content);
    doc.addJson('metadata', metadata ?? {});
    this.writer!.addDocument(doc);

    if (!skipCommit) {
      await this.commit();
    }
  }

  /**
   * 提交索引变更到磁盘目录，并 reload reader 使后续 searcher 可见最新数据。
   * Tantivy commit 为同步调用；reload 后 index.searcher() 才反映已提交文档。
   */
  async commit(): Promise<void> {
    if (!this.writer || !this.index) return;
    try {
      this.writer.commit();
      this.index.reload();
    } catch (error) {
      logger.error('Tantivy BM25 索引提交失败', { module: 'VectorStore', error: String(error) });
    }
  }

  /**
   * 关键词检索
   * 使用 parseQueryLenient 容错解析（用户查询可能含 Tantivy 查询语法特殊字符），
   * 命中后从 stored fields 取回 content/metadata。
   */
  async search(query: string, limit: number): Promise<BM25SearchResult[]> {
    if (!this.initialized) {
      await this.init();
    }
    const searcher = this.index!.searcher();
    if (searcher.numDocs === 0) {
      return [];
    }

    // parseQueryLenient 返回 [Query, errors[]]，best-effort 解析，避免非法查询抛错击穿检索
    const [parsedQuery, parseErrors] = this.index!.parseQueryLenient(query, ['content']);
    if (parseErrors && parseErrors.length > 0) {
      logger.debug('Tantivy 查询宽松解析产生告警', {
        module: 'VectorStore',
        query: query.substring(0, 100),
        errors: parseErrors,
      });
    }

    const result = searcher.search(parsedQuery, limit);
    return result.hits.map((hit) => {
      const doc = searcher.doc(hit.docAddress);
      return {
        id: String(doc.getFirst('id') ?? ''),
        content: String(doc.getFirst('content') ?? ''),
        metadata: (doc.getFirst('metadata') as any) ?? {},
        score: hit.score ?? 0,
      };
    });
  }

  /**
   * 从索引删除文档（同步语义）
   * delete-by-term 按 id 字段（raw tokenizer）精确匹配，随后 commit + reload。
   */
  delete(id: string): void {
    if (!this.writer || !this.index) return;
    try {
      this.writer.deleteDocumentsByTerm('id', id);
      this.writer.commit();
      this.index.reload();
    } catch (error) {
      logger.warn('Tantivy BM25 删除文档失败（可能不存在）', {
        module: 'VectorStore',
        id,
        error: String(error),
      });
    }
  }

  /**
   * 清空索引（保留目录与 writer 实例）
   * deleteAllDocuments + commit + reload，语义等价于 MiniSearch 的清空重建。
   */
  async clear(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    try {
      this.writer!.deleteAllDocuments();
      this.writer!.commit();
      this.index!.reload();
    } catch (error) {
      logger.error('Tantivy BM25 清空索引失败', { module: 'VectorStore', error: String(error) });
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 构建 schema：
   * - id：text + raw tokenizer + stored（delete-by-term 精确匹配、检索回取）
   * - content：text + 默认分词器 + stored（BM25 检索字段 + 结果回取）
   * - metadata：json + stored（结构化元数据回取，替代内存 Map）
   */
  private buildSchema(): Schema {
    const builder = new SchemaBuilder();
    builder.addTextField('id', { stored: true, tokenizerName: RAW_TOKENIZER });
    builder.addTextField('content', { stored: true });
    builder.addJsonField('metadata', { stored: true });
    return builder.build();
  }

  /** 注册 raw tokenizer（新建与重开索引后均需注册） */
  private registerRawTokenizer(index: Index): void {
    index.registerTokenizer(
      RAW_TOKENIZER,
      new TextAnalyzerBuilder(TokenizerStatic.raw()).build(),
    );
  }
}
