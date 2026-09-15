/**
 * EnterpriseRAG-Bench (ERB) metadata 映射（benchmark-only）
 *
 * 职责：把 ErbDoc + 切分后的 child chunk 信息，映射为写入 ChromaDB / BM25 的
 *       最小 metadata（方案文档 4.4）。
 *
 * 🔴 刻意不写 `parent_content`：
 *    生产 parent-child 模式会把父块全文（默认 1500+ 字符）塞进每个 child chunk 的
 *    metadata（vector-crud.ts#L381-L383 / #L467-L469），供命中子块后展开父块上下文。
 *    但 ERB 评测只按 `documentId` 比对、不做父块展开，写它纯属浪费——
 *    去掉后 BM25 常驻内存与 ChromaDB 磁盘同时砍掉约 2/3（方案 3.2 / 4.3）。
 *
 * 设计原则：
 *   1. 纯函数、零重型依赖：**不** import vector-crud / store-state / config
 *      （后者 zod fail-fast 需完整 env，会把 bench 脚本与生产配置强耦合）。
 *   2. chunk_hash 复刻 vector-crud.computeChunkHash 的 SHA-256 算法，保持幂等键一致；
 *      复刻而非 import，是为让 scripts/bench 天然独立于主链路（方案 4.5）。
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { ErbDoc, ErbSourceType } from './erb-loader.js';

// ==================== 类型定义 ====================

/**
 * child chunk 写入 ChromaDB / BM25 的 metadata（方案 4.4 最小集）。
 *
 * 字段与生产 baseMeta 对齐，但**不含** `parent_content`（见文件头说明）。
 * `chunk_role` 恒为 'child'：ERB 入库只嵌子块、父块不入库
 * （生产亦然，见 vector-crud.ts#L271-L289「父块不写入向量库」）。
 */
export interface ErbChunkMetadata {
  /** 文档唯一标识 = dsid（含 `dsid_` 前缀），评测按此比对 gold */
  documentId: string;
  /** 文件名（与生产 legacy 路径的 source 语义一致） */
  source: string;
  /** 顶层目录名（slack/gmail/linear/...） */
  source_type: ErbSourceType;
  /** 子块在文档内的序号 */
  chunk_index: number;
  /** 子块内容 SHA-256（内容级幂等去重键，与生产同算法） */
  chunk_hash: string;
  /** 块角色，ERB 恒为 'child' */
  chunk_role: 'child';
  /** 父块 id，仅供追溯（不写 parent_content） */
  parent_id: string;
}

/** 每篇文档的基础 metadata（documentId / source / source_type） */
export type ErbDocMeta = Pick<
  ErbChunkMetadata,
  'documentId' | 'source' | 'source_type'
>;

// ==================== 纯函数 ====================

/**
 * 计算文本块内容 SHA-256（十六进制）。
 *
 * 🔴 必须与 [vector-crud.computeChunkHash](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/fundamentals/vector-store/vector-crud.ts#L55)
 * 保持完全一致的算法，否则 bench 入库的 chunk_hash 与生产语义不符。
 * 此处复刻（而非 import）是为让 scripts/bench 独立于主链路重型依赖。
 *
 * @param text 子块原文
 */
export function chunkHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * 构造单篇文档的基础 metadata。
 *
 * @param doc ErbDoc（来自 erb-loader 递归遍历）
 */
export function buildDocMeta(doc: ErbDoc): ErbDocMeta {
  return {
    documentId: doc.documentId,
    source: basename(doc.filePath),
    source_type: doc.sourceType,
  };
}

/**
 * 构造单个 child chunk 的完整 metadata（方案 4.4 最小集，不含 parent_content）。
 *
 * @param doc ErbDoc
 * @param chunkText 子块原文（用于算 chunk_hash）
 * @param chunkIndex 子块在文档内的序号
 * @param parentId 父块 id（仅供追溯）
 */
export function buildChildChunkMeta(
  doc: ErbDoc,
  chunkText: string,
  chunkIndex: number,
  parentId: string,
): ErbChunkMetadata {
  return {
    ...buildDocMeta(doc),
    chunk_index: chunkIndex,
    chunk_hash: chunkHash(chunkText),
    chunk_role: 'child',
    parent_id: parentId,
  };
}

/**
 * 生成确定性父块 id。
 *
 * 生产用 `parent_${batchIndex}_${parentIndex}`（含批次内文档序号，跨批次不稳定）；
 * benchmark 入库按文档独立处理，改用 documentId 前缀保证全局唯一且可复现。
 *
 * @param documentId 文档 dsid
 * @param parentIndex 父块在文档内的序号
 */
export function makeParentId(documentId: string, parentIndex: number): string {
  return `${documentId}__parent_${parentIndex}`;
}
