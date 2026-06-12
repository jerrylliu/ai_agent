/**
 * fundamentals/vector-store/bm25-index.spec.ts
 *
 * BM25 索引管理单元测试
 * 覆盖：createBM25Index / addToBM25Index / deleteFromBM25Index / clearBM25Index
 *
 * 注意：需要先 mock store-state 和 fs/logger 防止初始化失败
 */

/* =====================================================================
 * Mock 基础模块
 * ==================================================================*/
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockBM25Index: any = null;
let mockDocumentStore: Map<string, any> = new Map();

jest.mock('./store-state', () => ({
  PERSIST_DIR: '/tmp/bm25-test',
  getBM25Index: () => mockBM25Index,
  setBM25Index: (val: any) => { mockBM25Index = val; },
  getBM25DocumentStore: () => mockDocumentStore,
  setBM25DocumentStore: (val: any) => { mockDocumentStore = val; },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import {
  createBM25Index,
  addToBM25Index,
  deleteFromBM25Index,
  clearBM25Index,
  saveBM25Index,
  initializeBM25Index,
} from './bm25-index';

describe('BM25 索引管理', () => {
  beforeEach(() => {
    mockBM25Index = null;
    mockDocumentStore = new Map();
    jest.clearAllMocks();
  });

  describe('createBM25Index', () => {
    it('应创建 MiniSearch 实例', () => {
      const idx = createBM25Index();
      expect(idx).toBeDefined();
      expect(typeof idx.add).toBe('function');
      expect(typeof idx.search).toBe('function');
    });

    it('应配置 content 为索引字段', () => {
      const idx = createBM25Index();
      // 验证索引可正常添加文档
      idx.add({ id: '1', content: '测试文档', metadata: {} });
      expect(idx.documentCount).toBe(1);
    });
  });

  describe('addToBM25Index', () => {
    it('应添加文档到索引', async () => {
      await addToBM25Index('doc1', '人工智能发展趋势', { type: 'article' }, true);
      expect(mockBM25Index).toBeDefined();
      expect(mockBM25Index.documentCount).toBe(1);
      expect(mockDocumentStore.has('doc1')).toBe(true);
    });

    it('skipSave=false 时应保存索引', async () => {
      await addToBM25Index('doc2', '机器学习算法', {}, false);
      expect(mockBM25Index.documentCount).toBe(1);
    });

    it('多次添加不应报错', async () => {
      await addToBM25Index('d1', '文本1', {}, true);
      await addToBM25Index('d2', '文本2', {}, true);
      expect(mockBM25Index.documentCount).toBe(2);
    });
  });

  describe('deleteFromBM25Index', () => {
    it('应删除已存在的文档', async () => {
      await addToBM25Index('d3', '可删除文档', {}, true);
      expect(mockBM25Index.documentCount).toBe(1);

      deleteFromBM25Index('d3');
      expect(mockBM25Index.documentCount).toBe(0);
    });

    it('删除不存在的文档不应报错', () => {
      expect(() => deleteFromBM25Index('nonexistent')).not.toThrow();
    });

    it('索引为空时删除不应报错', () => {
      mockBM25Index = null;
      expect(() => deleteFromBM25Index('any')).not.toThrow();
    });
  });

  describe('clearBM25Index', () => {
    it('应清空索引和文档存储', async () => {
      await addToBM25Index('d4', '待清空', {}, true);
      expect(mockBM25Index.documentCount).toBe(1);

      await clearBM25Index();
      expect(mockBM25Index).toBeDefined(); // 重建后非空
      expect(mockBM25Index.documentCount).toBe(0);
      expect(mockDocumentStore.size).toBe(0);
    });
  });

  describe('saveBM25Index', () => {
    it('应在索引为 null 时不报错', async () => {
      mockBM25Index = null;
      await expect(saveBM25Index()).resolves.not.toThrow();
    });
  });
});
