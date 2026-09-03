/**
 * fundamentals/vector-store/vector-crud-dedup.spec.ts
 *
 * 文本块内容级幂等去重（deduplicateTextChunks）单元测试
 *
 * 核心保护点：
 *   1. 作用域必须含 versionId：不同版本（如 v1 归档 / v2 活跃）的同内容块
 *      不能互相删除 -- 否则版本回滚时 updateVersionVectorStatus 匹配不到向量
 *   2. legacy 路径（versionId='legacy'）同 source 同内容旧块应被删除（幂等）
 *   3. ChromaDB / BM25 双端同步清理
 *   4. 知识源路径（无 versionId）退化为 source + hash 去重
 *   5. 去重失败不阻塞入库（异常吞掉 + warn 日志）
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { chromaUrl: 'http://localhost:8000' },
}));

jest.mock('../event-bus', () => ({
  eventBus: { emit: jest.fn() },
}));

jest.mock('chromadb', () => ({
  ChromaClient: jest.fn(),
}));

// store-state / bm25-index / text-splitter 全部 mock，
// 只测试 deduplicateTextChunks 自身的分组与删除逻辑
jest.mock('./store-state', () => ({
  BATCH_SIZE: 20,
  COLLECTION_NAME: 'knowledge_base',
  embeddings: { embedQuery: jest.fn() },
  initializeVectorStore: jest.fn(),
  getBM25Index: jest.fn(),
  getBM25DocumentStore: jest.fn(),
  getEmbeddingSemaphore: jest.fn(() => ({
    acquire: jest.fn().mockResolvedValue('id'),
    release: jest.fn(),
  })),
}));

jest.mock('./bm25-index', () => ({
  initializeBM25Index: jest.fn().mockResolvedValue(undefined),
  addToBM25Index: jest.fn(),
  saveBM25Index: jest.fn().mockResolvedValue(undefined),
  rebuildBM25Index: jest.fn(),
}));

jest.mock('./text-splitter', () => ({
  getSplitterByFileType: jest.fn(),
  isMarkdownContent: jest.fn(() => false),
  getAdaptiveChunkingProfile: jest.fn(() => ({
    chunkSize: 1000,
    chunkOverlap: 200,
    parentChunkSize: 1500,
    parentChunkOverlap: 200,
    childChunkSize: 400,
    childChunkOverlap: 100,
    documentType: 'general',
  })),
  parentChildSplit: jest.fn(),
  DEFAULT_CHUNK_SIZE: 1000,
  DEFAULT_CHUNK_OVERLAP: 200,
  DEFAULT_PARENT_CHUNK_SIZE: 1500,
  DEFAULT_PARENT_CHUNK_OVERLAP: 200,
  DEFAULT_CHILD_CHUNK_SIZE: 400,
  DEFAULT_CHILD_CHUNK_OVERLAP: 100,
}));

import {
  computeChunkHash,
  deduplicateTextChunks,
} from './vector-crud';
import { initializeVectorStore } from './store-state';
import { getBM25Index, getBM25DocumentStore } from './store-state';
import { saveBM25Index } from './bm25-index';

const mockInitializeVectorStore = initializeVectorStore as jest.Mock;
const mockGetBM25Index = getBM25Index as jest.Mock;
const mockGetBM25DocumentStore = getBM25DocumentStore as jest.Mock;
const mockSaveBM25Index = saveBM25Index as jest.Mock;

/** 构造带 get/delete 的假 collection，get 按 where 条件返回预置数据 */
function createFakeCollection(
  existing: Array<{ id: string; document: string; metadata: Record<string, any> }>,
) {
  const deletedIds: string[] = [];
  return {
    deletedIds,
    get: jest.fn(async (opts: { where?: Record<string, any> }) => {
      // 简化的 where 求值：支持 $and 下的 source / versionId / chunk_hash $in
      const clauses = (opts.where?.$and ?? []) as Array<Record<string, any>>;
      const ids: string[] = [];
      const documents: string[] = [];
      const metadatas: Record<string, any>[] = [];
      for (const entry of existing) {
        const matched = clauses.every((clause) => {
          if (clause.source !== undefined) {
            return entry.metadata.source === clause.source;
          }
          if (clause.versionId !== undefined) {
            return entry.metadata.versionId === clause.versionId;
          }
          if (clause.chunk_hash?.$in !== undefined) {
            return clause.chunk_hash.$in.includes(entry.metadata.chunk_hash);
          }
          return true;
        });
        if (matched) {
          ids.push(entry.id);
          documents.push(entry.document);
          metadatas.push(entry.metadata);
        }
      }
      return { ids, documents, metadatas };
    }),
    delete: jest.fn(async (opts: { ids: string[] }) => {
      deletedIds.push(...opts.ids);
    }),
  };
}

/** 构造假 BM25 documentStore（Map<id, {content, metadata}>） */
function createFakeBM25Store(
  entries: Array<{ id: string; content: string; metadata: Record<string, any> }>,
) {
  const store = new Map();
  for (const e of entries) {
    store.set(e.id, { content: e.content, metadata: e.metadata });
  }
  return store;
}

describe('computeChunkHash', () => {
  it('相同文本 hash 相同，不同文本 hash 不同', () => {
    expect(computeChunkHash('块内容')).toBe(computeChunkHash('块内容'));
    expect(computeChunkHash('块内容A')).not.toBe(computeChunkHash('块内容B'));
  });

  it('hash 为 64 位十六进制', () => {
    expect(computeChunkHash('任意')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deduplicateTextChunks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveBM25Index.mockResolvedValue(undefined);
  });

  it('legacy 场景：同 versionId+source 的同内容旧块应被删除（Chroma + BM25 双端）', async () => {
    const chunkText = '液氮杜瓦冷罐的工程参数说明';
    const chunkHash = computeChunkHash(chunkText);
    const collection = createFakeCollection([
      {
        id: 'doc_1000_aaa_0',
        document: chunkText,
        metadata: { source: 'report.pdf', versionId: 'legacy', chunk_hash: chunkHash },
      },
    ]);
    mockInitializeVectorStore.mockResolvedValue({ collection });

    const bm25Store = createFakeBM25Store([
      {
        id: 'doc_1000_aaa_0',
        content: chunkText,
        metadata: { source: 'report.pdf', versionId: 'legacy', chunk_hash: chunkHash },
      },
      // 不同内容的条目不应被删
      {
        id: 'doc_1000_bbb_1',
        content: '完全不同的内容',
        metadata: { source: 'report.pdf', versionId: 'legacy', chunk_hash: computeChunkHash('完全不同的内容') },
      },
    ]);
    mockGetBM25Index.mockReturnValue({ remove: jest.fn() });
    mockGetBM25DocumentStore.mockReturnValue(bm25Store);

    await deduplicateTextChunks(
      { collection } as any,
      [{ text: chunkText, metaIndex: 0 }],
      [{ source: 'report.pdf', versionId: 'legacy' }],
    );

    // Chroma 旧块被删
    expect(collection.deletedIds).toEqual(['doc_1000_aaa_0']);
    // BM25 匹配条目被删，不同内容保留
    expect(Array.from(bm25Store.keys())).toEqual(['doc_1000_bbb_1']);
    expect(mockSaveBM25Index).toHaveBeenCalled();
  });

  it('回滚保护：不同 versionId 的同内容块不能互相删除', async () => {
    const chunkText = '两个版本共有的内容段落';
    const chunkHash = computeChunkHash(chunkText);
    // v1（归档）已有该内容块；现在发布 v2
    const collection = createFakeCollection([
      {
        id: 'doc_1000_v1_0',
        document: chunkText,
        metadata: { source: 'a.pdf', versionId: '1', chunk_hash: chunkHash, versionStatus: 'archived' },
      },
    ]);
    mockInitializeVectorStore.mockResolvedValue({ collection });
    const bm25Store = createFakeBM25Store([]);
    mockGetBM25Index.mockReturnValue({ remove: jest.fn() });
    mockGetBM25DocumentStore.mockReturnValue(bm25Store);

    await deduplicateTextChunks(
      { collection } as any,
      [{ text: chunkText, metaIndex: 0 }],
      [{ source: 'a.pdf', versionId: '2' }], // v2 入库
    );

    // v1 的归档块不受影响（versionId 不匹配）
    expect(collection.deletedIds).toEqual([]);
  });

  it('知识源场景：无 versionId 时按 source + hash 去重', async () => {
    const chunkText = '某个知识源页面的内容';
    const chunkHash = computeChunkHash(chunkText);
    const collection = createFakeCollection([
      {
        id: 'doc_2000_ccc_0',
        document: chunkText,
        metadata: { source: 'https://example.com/page', chunk_hash: chunkHash },
      },
    ]);
    mockInitializeVectorStore.mockResolvedValue({ collection });
    mockGetBM25Index.mockReturnValue({ remove: jest.fn() });
    mockGetBM25DocumentStore.mockReturnValue(createFakeBM25Store([]));

    await deduplicateTextChunks(
      { collection } as any,
      [{ text: chunkText, metaIndex: 0 }],
      [{ source: 'https://example.com/page' }], // 知识源 metadata 无 versionId
    );

    expect(collection.deletedIds).toEqual(['doc_2000_ccc_0']);
  });

  it('同 source 不同内容 hash 的旧块不应被删除', async () => {
    const collection = createFakeCollection([
      {
        id: 'doc_3000_ddd_0',
        document: '旧内容',
        metadata: {
          source: 'report.pdf',
          versionId: 'legacy',
          chunk_hash: computeChunkHash('旧内容'),
        },
      },
    ]);
    mockInitializeVectorStore.mockResolvedValue({ collection });
    mockGetBM25Index.mockReturnValue({ remove: jest.fn() });
    mockGetBM25DocumentStore.mockReturnValue(createFakeBM25Store([]));

    await deduplicateTextChunks(
      { collection } as any,
      [{ text: '新内容', metaIndex: 0 }],
      [{ source: 'report.pdf', versionId: 'legacy' }],
    );

    expect(collection.deletedIds).toEqual([]);
  });

  it('Chroma 查询异常时不抛错（去重失败不阻塞入库）', async () => {
    const collection = {
      get: jest.fn().mockRejectedValue(new Error('chroma down')),
      delete: jest.fn(),
    };
    mockInitializeVectorStore.mockResolvedValue({ collection });
    mockGetBM25Index.mockReturnValue({ remove: jest.fn() });
    mockGetBM25DocumentStore.mockReturnValue(createFakeBM25Store([]));

    await expect(
      deduplicateTextChunks(
        { collection } as any,
        [{ text: '内容', metaIndex: 0 }],
        [{ source: 'a.pdf', versionId: 'legacy' }],
      ),
    ).resolves.toBeUndefined();
    expect(collection.delete).not.toHaveBeenCalled();
  });

  it('collection 不存在时直接返回（内存模式等场景）', async () => {
    mockInitializeVectorStore.mockResolvedValue({ collection: null });

    await expect(
      deduplicateTextChunks(
        { collection: null } as any,
        [{ text: '内容', metaIndex: 0 }],
        [{ source: 'a.pdf' }],
      ),
    ).resolves.toBeUndefined();
  });
});
