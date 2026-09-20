/**
 * 向量存储 — BM25 引擎抽象层（永久双引擎架构）
 *
 * 背景：MiniSearch 落盘走 JSON.stringify，受 V8 单字符串 ~512MB 上限约束，
 * ~50 万 chunk 规模（ERB 数据集）会触顶导致持久化失效。因此引入 Tantivy
 * 作为第二引擎（S1.7b spike 验证后于 S1.8 落地适配器）。
 *
 * 架构约束（见《EnterpriseRAG-Bench接入方案.md》§3.7）：
 * - 窄接口：引擎能力以 init / add / commit / search / delete 五个必要方法
 *   （外加可选 clear）为交集，任一引擎的独有优化不得外泄到接口，
 *   避免抽象层把整体能力拉回最低公分母；
 * - 双引擎永久共存：BM25_ENGINE=minisearch|tantivy 切换，默认 minisearch；
 * - 进程级全局单例：getBM25Engine() 惰性创建且全链路统一，
 *   禁止同一进程内混用两种引擎（红线 #10）；
 * - 分数不可跨引擎对比：BM25 分数只在同引擎内有意义（红线 #11），
 *   评测报告必须标注所用引擎。
 */

import { config } from '../config.js';
import { MiniSearchBM25Engine } from './minisearch-engine.js';

// ==================== 类型定义 ====================

/** BM25 引擎类型标识（与 config.bm25Engine 同源） */
export type BM25EngineType = 'minisearch' | 'tantivy';

/** BM25 引擎检索结果（跨引擎统一形状） */
export interface BM25SearchResult {
  /** 文档唯一标识 */
  id: string;
  /** 文档文本内容（RRF 混合检索以 content 作为融合键） */
  content: string;
  /** 文档元数据 */
  metadata: any;
  /** 引擎相关性分数（仅同引擎内可比，禁止跨引擎对比） */
  score: number;
}

/**
 * BM25 引擎窄接口
 *
 * 所有引擎适配器（MiniSearch / Tantivy）必须实现本接口，
 * 调用方（S1.9 起）只依赖本接口，不感知具体引擎。
 */
export interface BM25Engine {
  /** 引擎类型标识，用于日志与评测报告标注 */
  readonly type: BM25EngineType;
  /** 初始化引擎（从磁盘加载已有索引，或创建空索引；幂等） */
  init(): Promise<void>;
  /**
   * 添加文档到索引
   * @param skipCommit 批量操作时设为 true，由调用方统一 commit，避免逐条落盘
   */
  add(id: string, content: string, metadata: any, skipCommit?: boolean): Promise<void>;
  /** 将索引变更持久化（MiniSearch=写 JSON 文件；Tantivy=目录 commit） */
  commit(): Promise<void>;
  /** 关键词检索，按相关性降序返回至多 limit 条 */
  search(query: string, limit: number): Promise<BM25SearchResult[]>;
  /**
   * 从索引删除文档（同步语义）
   * 实现内部自行调度持久化（fire-and-forget + 错误日志），
   * 与历史 deleteFromBM25Index 的 void 签名保持兼容。
   */
  delete(id: string): void;
  /** 清空索引（含磁盘持久化数据），并重新初始化为空索引 */
  clear(): Promise<void>;
}

// ==================== 引擎单例工厂 ====================

let engineInstance: BM25Engine | null = null;

/**
 * 获取进程级 BM25 引擎单例（惰性创建）
 *
 * 引擎选型由 config.bm25Engine（env BM25_ENGINE）决定，默认 minisearch。
 * tantivy 适配器在 S1.8 落地前不可用，选中会 fail-fast。
 */
export function getBM25Engine(): BM25Engine {
  if (engineInstance) return engineInstance;

  const engineType = config.bm25Engine as BM25EngineType;
  switch (engineType) {
    case 'minisearch':
      engineInstance = new MiniSearchBM25Engine();
      break;
    case 'tantivy': {
      // 惰性加载（不能改成顶层静态 import）：
      // @pngwasi/node-tantivy-binding@0.3.4 只发布 darwin/win32/linux-gnu 四个
      // 平台二进制，没有 linux-x64-musl（npm 404），而生产镜像基于 node:22-alpine
      // （musl）。顶层 import 会在启动期 require 原生绑定失败，直接炸掉整个进程，
      // 连默认 minisearch 引擎都起不来。改为选中 tantivy 时才加载：生产（minisearch）
      // 永不触碰该模块；真选 tantivy 且缺二进制时在首次调用处 fail-fast，报错更聚焦。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { TantivyBM25Engine } = require('./tantivy-engine.js') as {
        TantivyBM25Engine: new () => BM25Engine;
      };
      engineInstance = new TantivyBM25Engine();
      break;
    }
    default:
      throw new Error(`未知的 BM25 引擎类型: ${engineType}`);
  }
  return engineInstance;
}

/**
 * 重置引擎单例（仅供单元测试使用）
 * 生产代码禁止调用——运行中切换引擎会造成索引状态分裂（红线 #10）
 */
export function resetBM25Engine(): void {
  engineInstance = null;
}
