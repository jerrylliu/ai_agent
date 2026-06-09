/**
 * 向量存储 — 统一导出
 *
 * 将各子模块的公开 API 统一 re-export，
 * 对外保持与原 vector-store.ts 完全相同的接口，
 * 调用方无需修改 import 路径。
 *
 * 模块结构：
 *   store-state.ts    — 共享状态 + 初始化
 *   text-splitter.ts  — 文本切分器
 *   bm25-index.ts     — BM25 索引管理
 *   vector-crud.ts    — 文档增删
 *   vector-search.ts  — 检索（向量 + 混合）
 *   vector-version.ts — 版本管理 + 维护
 */

// ==================== 初始化与状态 ====================
export {
  initializeVectorStore,
  resetVectorStore,
  isVectorStoreMemoryMode,
  COLLECTION_NAME,
  EMBEDDING_MODEL,
  PERSIST_DIR,
  embeddings,
} from './store-state.js';

// ==================== 文本切分 ====================
export {
  textSplitter,
  codeSplitter,
  markdownSplitter,
  getSplitterByFileType,
  isMarkdownContent,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
} from './text-splitter.js';

// ==================== BM25 索引 ====================
export {
  initializeBM25Index,
  saveBM25Index,
  addToBM25Index,
  deleteFromBM25Index,
  clearBM25Index,
  rebuildBM25Index,
} from './bm25-index.js';

// ==================== 文档 CRUD ====================
export {
  addDocuments,
  deleteDocuments,
  getAllDocuments,
} from './vector-crud.js';

// ==================== 检索 ====================
export {
  searchKnowledgeBase,
  hybridSearchKnowledgeBase,
} from './vector-search.js';

// ==================== 版本管理与维护 ====================
export {
  getDocumentTypes,
  getKnowledgeBaseStats,
  clearKnowledgeBase,
  previewChunking,
  previewEmbedding,
  debugSearch,
  getAllDocumentsWithDebug,
  removeDocumentVersion,
  updateVersionVectorStatus,
  reindexVersion,
  cleanOrphanVectors,
  fixDraftVectors,
} from './vector-version.js';
