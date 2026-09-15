/**
 * 向量存储 — BM25 关键词索引管理（门面层）
 *
 * 对外提供 BM25 索引的完整生命周期 API：
 * - 初始化（从磁盘加载或创建空索引）
 * - 增删改（单条/批量操作）
 * - 持久化（保存到磁盘）
 * - 重建（从 ChromaDB 全量重建）
 *
 * BM25 索引用于混合搜索中的关键词检索，
 * 与向量检索互补，提升关键词精确匹配的召回率。
 *
 * ⚠️ 架构说明（S1.7a，永久双引擎）：
 * 本文件已退化为**门面**，所有实际逻辑委派给 BM25Engine 适配器
 * （当前实现：MiniSearchBM25Engine；Tantivy 适配器待 S1.7b spike + S1.8 落地）。
 * 引擎由 env BM25_ENGINE 选型（默认 minisearch），进程内单例、全链路统一。
 * 本文件的导出签名与改造前完全一致，因此调用方
 * （vector-search / vector-crud / vector-version）在本阶段零改动；
 * 调用方改为直接依赖 BM25Engine 接口属于 S1.9 的工作。
 */

import { logger } from '../logger.js';
import { getBM25Engine } from './bm25-engine.js';

// 兼容既有引用点：createBM25Index 是 MiniSearch 适配器特有的实例化工厂，
// 不属于 BM25Engine 窄接口（Tantivy 无对应概念），故从适配器直接再导出。
export { createBM25Index } from './minisearch-engine.js';

// ==================== 索引初始化 ====================

/**
 * 初始化 BM25 索引（幂等）
 * 如果磁盘上有索引文件则加载，否则创建空索引
 */
export async function initializeBM25Index(): Promise<void> {
  await getBM25Engine().init();
}

// ==================== 索引持久化 ====================

/**
 * 保存 BM25 索引到磁盘
 * MiniSearch 引擎：序列化为 JSON 写入 `${PERSIST_DIR}/bm25_index.json`
 */
export async function saveBM25Index(): Promise<void> {
  await getBM25Engine().commit();
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
  await getBM25Engine().add(id, content, metadata, skipSave);
}

/**
 * 从 BM25 索引删除文档
 * 删除后异步保存索引到磁盘
 */
export function deleteFromBM25Index(id: string): void {
  getBM25Engine().delete(id);
}

/**
 * 清空 BM25 索引
 * 删除磁盘索引文件，重新创建空索引
 */
export async function clearBM25Index(): Promise<void> {
  await getBM25Engine().clear();
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
