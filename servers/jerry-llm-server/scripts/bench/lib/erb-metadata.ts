/**
 * EnterpriseRAG-Bench (ERB) metadata 映射（benchmark-only）
 *
 * 职责：把 ErbDoc + 切分后的 child chunk 信息，映射为写入 ChromaDB / BM25 的
 *       最小 metadata（方案文档 4.4）。
 *
 * 🔴 必须写 `parent_content`（S4.0 修复）：
 *    生产 parent-child 模式把父块全文塞进每个 child chunk 的 metadata
 *    （vector-crud.ts#L381-L383），检索命中子块后由 vector-search.ts 展开为父块上下文。
 *    早期版本为省 ChromaDB 磁盘与 BM25 内存，刻意不写该字段，理由写的是
 *    「ERB 评测只按 documentId 比对、不做父块展开」——但该前提是错的：
 *    评测跑的是真实 RAG 链路（promptTemplate → search_knowledge_base → hybridSearch），
 *    展开逻辑缺少 `parent_content` 时**静默降级**，注入模型的只有 340 字符子块碎片
 *    （实测 gold 文档被切成 15 个碎片、答案横跨 3 块且句子被拦腰截断），
 *    而生产环境同一路径会注入 1600 字符父块 —— 评测因此系统性低估产品表现。
 *    代价是 ChromaDB 磁盘与 BM25 内存放大约 3~4 倍，属可接受成本。
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
 * child chunk 写入 ChromaDB / BM25 的 metadata（方案 4.4 最小集 + parent_content）。
 *
 * 字段与生产 baseMeta 对齐。`chunk_role` 恒为 'child'：ERB 入库只嵌子块、父块不入库
 * （生产亦然，见 vector-crud.ts#L271-L289「父块不写入向量库」），父块全文通过
 * `parent_content` 携带，供检索命中后展开。
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
  /** 父块 id，仅供追溯 */
  parent_id: string;
  /**
   * 父块全文（生产同名字段）：vector-search 命中 child 后据此展开为父块上下文。
   * 缺失会导致展开静默失效、只返回 340 字符子块碎片。
   */
  parent_content: string;
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
 * 构造单个 child chunk 的完整 metadata。
 *
 * @param doc ErbDoc
 * @param chunkText 子块原文（用于算 chunk_hash）
 * @param chunkIndex 子块在文档内的序号
 * @param parentId 父块 id（仅供追溯）
 * @param parentText 父块全文（检索命中子块后据此展开上下文，与生产同口径）
 */
export function buildChildChunkMeta(
  doc: ErbDoc,
  chunkText: string,
  chunkIndex: number,
  parentId: string,
  parentText: string,
): ErbChunkMetadata {
  return {
    ...buildDocMeta(doc),
    chunk_index: chunkIndex,
    chunk_hash: chunkHash(chunkText),
    chunk_role: 'child',
    parent_id: parentId,
    parent_content: parentText,
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
