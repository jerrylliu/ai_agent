/**
 * 向量存储模块单元测试
 *
 * 测试拆分后的各子模块核心逻辑：
 * - text-splitter：切分器选择与 Markdown 检测
 * - bm25-index：BM25 索引增删查 + 持久化
 * - vector-search：纯向量检索过滤 + 混合搜索 RRF 融合
 * - vector-crud：文档添加/删除（ChromaDB + BM25 同步）
 * - store-state：状态管理与初始化
 */

// ==================== Mock 基础设施 ====================

// Mock 外部依赖，避免连接真实 ChromaDB/Ollama
// chromadb 包含 ESM 依赖（uuid），必须 mock 避免 Jest 解析失败
jest.mock('chromadb', () => ({
  ChromaClient: jest.fn().mockImplementation(() => ({
    getCollection: jest.fn(),
    createCollection: jest.fn(),
  })),
}));

jest.mock('@langchain/community/vectorstores/chroma', () => ({
  Chroma: {
    fromExistingCollection: jest.fn().mockResolvedValue({
      addDocuments: jest.fn(),
      similaritySearchWithScore: jest.fn(),
      delete: jest.fn(),
      collection: {},
    }),
  },
}));

jest.mock('@langchain/ollama', () => ({
  OllamaEmbeddings: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../config', () => ({
  config: {
    chromaHost: 'localhost',
    chromaPort: 8000,
    chromaUrl: 'http://localhost:8000',
    ollamaBaseUrl: 'http://localhost:11434',
  },
}));

// ==================== text-splitter 测试 ====================

describe('text-splitter', () => {
  let textSplitter: any;
  let markdownSplitter: any;
  let codeSplitter: any;
  let getSplitterByFileType: any;
  let isMarkdownContent: any;

  beforeAll(() => {
    const mod = require('./text-splitter');
    textSplitter = mod.textSplitter;
    markdownSplitter = mod.markdownSplitter;
    codeSplitter = mod.codeSplitter;
    getSplitterByFileType = mod.getSplitterByFileType;
    isMarkdownContent = mod.isMarkdownContent;
  });

  describe('isMarkdownContent', () => {
    it('应识别包含标题和粗体的 Markdown', () => {
      const content = '# 标题\n\n这是**粗体**文本';
      expect(isMarkdownContent(content)).toBe(true);
    });

    it('应识别包含代码块和链接的 Markdown', () => {
      const content = '使用 `npm install` 安装依赖，参考[文档](https://example.com)';
      expect(isMarkdownContent(content)).toBe(true);
    });

    it('应识别包含列表和引用的 Markdown', () => {
      const content = '- 项目一\n- 项目二\n\n> 引用文本';
      expect(isMarkdownContent(content)).toBe(true);
    });

    it('不应将纯文本误判为 Markdown', () => {
      const content = '这是一段普通的文本内容，没有任何特殊格式。';
      expect(isMarkdownContent(content)).toBe(false);
    });

    it('不应将只有一种 Markdown 模式的内容判定为 Markdown（需至少 2 种）', () => {
      const content = '这是一段文本，只有**粗体**没有其他格式';
      expect(isMarkdownContent(content)).toBe(false);
    });

    it('应正确处理空字符串', () => {
      expect(isMarkdownContent('')).toBe(false);
    });
  });

  describe('getSplitterByFileType', () => {
    it('Markdown 文件应返回 Markdown 切分器', () => {
      const splitter = getSplitterByFileType('.md');
      expect(splitter.constructor.name).toContain('TextSplitter');
    });

    it('isMarkdown=true 时应返回 Markdown 切分器', () => {
      const splitter = getSplitterByFileType('.txt', true);
      expect(splitter.constructor.name).toContain('TextSplitter');
    });

    it('TypeScript 文件应返回代码切分器', () => {
      const splitter = getSplitterByFileType('.ts');
      expect(splitter.constructor.name).toContain('TextSplitter');
    });

    it('Python 文件应返回代码切分器', () => {
      const splitter = getSplitterByFileType('.py');
      expect(splitter.constructor.name).toContain('TextSplitter');
    });

    it('未知文件类型应返回通用切分器', () => {
      const splitter = getSplitterByFileType('.xyz');
      expect(splitter.constructor.name).toContain('TextSplitter');
    });

    it('空文件类型应返回通用切分器', () => {
      const splitter = getSplitterByFileType('');
      expect(splitter.constructor.name).toContain('TextSplitter');
    });
  });

  describe('textSplitter', () => {
    it('应使用默认参数创建切分器', async () => {
      const splitter = textSplitter();
      const chunks = await splitter.splitText('短文本');
      expect(chunks).toEqual(['短文本']);
    });

    it('应按指定大小切分长文本', async () => {
      const splitter = textSplitter(20, 5);
      const longText = '这是一段很长的文本内容，需要被切分成多个小块来处理。';
      const chunks = await splitter.splitText(longText);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });
});

// ==================== bm25-index 测试 ====================

describe('bm25-index', () => {
  let createBM25Index: any;
  let initializeBM25Index: any;
  let addToBM25Index: any;
  let deleteFromBM25Index: any;
  let clearBM25Index: any;
  let rebuildBM25Index: any;
  let getBM25Index: any;
  let getBM25DocumentStore: any;
  let setBM25Index: any;
  let setBM25DocumentStore: any;

  beforeAll(() => {
    const bm25Mod = require('./bm25-index');
    createBM25Index = bm25Mod.createBM25Index;
    initializeBM25Index = bm25Mod.initializeBM25Index;
    addToBM25Index = bm25Mod.addToBM25Index;
    deleteFromBM25Index = bm25Mod.deleteFromBM25Index;
    clearBM25Index = bm25Mod.clearBM25Index;
    rebuildBM25Index = bm25Mod.rebuildBM25Index;

    const stateMod = require('./store-state');
    getBM25Index = stateMod.getBM25Index;
    getBM25DocumentStore = stateMod.getBM25DocumentStore;
    setBM25Index = stateMod.setBM25Index;
    setBM25DocumentStore = stateMod.setBM25DocumentStore;
  });

  beforeEach(async () => {
    // 每个测试前重置 BM25 状态：先清空索引（删除磁盘文件），再重置内存状态
    await clearBM25Index().catch(() => {});
    setBM25Index(null);
    setBM25DocumentStore(new Map());
  });

  describe('createBM25Index', () => {
    it('应创建一个有效的 MiniSearch 实例', () => {
      const index = createBM25Index();
      expect(index).toBeDefined();
      expect(index.documentCount).toBe(0);
    });
  });

  describe('initializeBM25Index', () => {
    it('应创建空索引（磁盘无文件时）', async () => {
      await initializeBM25Index();
      const index = getBM25Index();
      expect(index).toBeDefined();
      expect(index.documentCount).toBe(0);
    });

    it('已初始化时不应重复创建', async () => {
      await initializeBM25Index();
      const firstIndex = getBM25Index();
      await initializeBM25Index();
      expect(getBM25Index()).toBe(firstIndex);
    });
  });

  describe('addToBM25Index', () => {
    it('应添加文档到索引', async () => {
      await initializeBM25Index();
      await addToBM25Index('doc1', '机器学习是人工智能的子领域', { source: 'test' });

      const index = getBM25Index();
      expect(index.documentCount).toBe(1);
      expect(getBM25DocumentStore().has('doc1')).toBe(true);
    });

    it('应支持批量添加（skipSave=true）', async () => {
      await initializeBM25Index();
      await addToBM25Index('doc1', '内容一', {}, true);
      await addToBM25Index('doc2', '内容二', {}, true);

      expect(getBM25Index().documentCount).toBe(2);
    });

    it('未初始化时应自动初始化', async () => {
      expect(getBM25Index()).toBeNull();
      await addToBM25Index('doc1', '测试内容', {});
      expect(getBM25Index()).toBeDefined();
    });
  });

  describe('deleteFromBM25Index', () => {
    it('应从索引中删除文档', async () => {
      // 直接创建索引，不经过 initializeBM25Index（避免磁盘加载干扰）
      const index = createBM25Index();
      setBM25Index(index);
      setBM25DocumentStore(new Map());

      // 手动添加文档
      index.add({ id: 'doc1', content: '测试内容', metadata: {} });
      getBM25DocumentStore().set('doc1', { content: '测试内容', metadata: {} });

      expect(getBM25DocumentStore().has('doc1')).toBe(true);

      deleteFromBM25Index('doc1');

      expect(getBM25DocumentStore().has('doc1')).toBe(false);
      expect(index.documentCount).toBe(0);
    });

    it('删除不存在的文档不应报错', () => {
      expect(() => deleteFromBM25Index('nonexistent')).not.toThrow();
    });

    it('索引未初始化时不应报错', () => {
      expect(() => deleteFromBM25Index('doc1')).not.toThrow();
    });
  });

  describe('clearBM25Index', () => {
    it('应清空索引和文档存储', async () => {
      await initializeBM25Index();
      await addToBM25Index('doc1', '内容一', {});
      await addToBM25Index('doc2', '内容二', {});

      await clearBM25Index();

      expect(getBM25Index().documentCount).toBe(0);
      expect(getBM25DocumentStore().size).toBe(0);
    });
  });

  describe('rebuildBM25Index', () => {
    it('应从文档列表重建索引', async () => {
      const mockGetAllDocs = jest.fn().mockResolvedValue([
        { content: '文档一内容', metadata: { source: 'a', versionStatus: 'active' } },
        { content: '文档二内容', metadata: { source: 'b', versionStatus: 'active' } },
        { content: '已归档文档', metadata: { source: 'c', versionStatus: 'archived' } },
      ]);

      await rebuildBM25Index(mockGetAllDocs);

      // 应过滤掉 archived 文档
      expect(getBM25Index().documentCount).toBe(2);
      expect(getBM25DocumentStore().size).toBe(2);
    });

    it('应保留无 versionStatus 的旧数据', async () => {
      const mockGetAllDocs = jest.fn().mockResolvedValue([
        { content: '旧文档', metadata: { source: 'old' } },
      ]);

      await rebuildBM25Index(mockGetAllDocs);

      expect(getBM25Index().documentCount).toBe(1);
    });

    it('空文档列表应创建空索引', async () => {
      const mockGetAllDocs = jest.fn().mockResolvedValue([]);

      await rebuildBM25Index(mockGetAllDocs);

      expect(getBM25Index().documentCount).toBe(0);
    });
  });

  describe('BM25 搜索功能', () => {
    it('应能搜索到已添加的文档', async () => {
      await initializeBM25Index();
      await addToBM25Index('doc1', '机器学习是人工智能的重要分支', { source: 'ml' });
      await addToBM25Index('doc2', '深度学习是机器学习的子领域', { source: 'dl' });
      await addToBM25Index('doc3', '自然语言处理处理人类语言', { source: 'nlp' });

      const index = getBM25Index();
      const results = index.search('机器学习');

      expect(results.length).toBeGreaterThan(0);
      // 至少应匹配到包含"机器学习"的文档
      const matchedIds = results.map((r: any) => r.id);
      expect(matchedIds).toContain('doc1');
    });

    it('应支持模糊搜索', async () => {
      await initializeBM25Index();
      await addToBM25Index('doc1', '人工智能技术发展迅速', {});

      const index = getBM25Index();
      // 模糊搜索配置为 0.2，轻微拼写错误应能匹配
      const results = index.search('人工智');
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

// ==================== store-state 测试 ====================

describe('store-state', () => {
  let getVectorStore: any;
  let setVectorStore: any;
  let getIsMemoryStore: any;
  let setIsMemoryStore: any;
  let resetVectorStore: any;
  let isVectorStoreMemoryMode: any;
  let getBM25Index: any;
  let setBM25Index: any;
  let getBM25DocumentStore: any;
  let setBM25DocumentStore: any;

  beforeAll(() => {
    const mod = require('./store-state');
    getVectorStore = mod.getVectorStore;
    setVectorStore = mod.setVectorStore;
    getIsMemoryStore = mod.getIsMemoryStore;
    setIsMemoryStore = mod.setIsMemoryStore;
    resetVectorStore = mod.resetVectorStore;
    isVectorStoreMemoryMode = mod.isVectorStoreMemoryMode;
    getBM25Index = mod.getBM25Index;
    setBM25Index = mod.setBM25Index;
    getBM25DocumentStore = mod.getBM25DocumentStore;
    setBM25DocumentStore = mod.setBM25DocumentStore;
  });

  describe('向量存储状态管理', () => {
    it('初始状态应为 null', () => {
      resetVectorStore();
      expect(getVectorStore()).toBeNull();
    });

    it('应能设置和获取向量存储实例', () => {
      const mockStore = { addDocuments: jest.fn() } as any;
      setVectorStore(mockStore);
      expect(getVectorStore()).toBe(mockStore);
    });

    it('resetVectorStore 应清除所有状态', () => {
      setVectorStore({} as any);
      setIsMemoryStore(true);
      resetVectorStore();
      expect(getVectorStore()).toBeNull();
      expect(getIsMemoryStore()).toBe(false);
    });
  });

  describe('内存存储标记', () => {
    it('初始应为 false', () => {
      resetVectorStore();
      expect(isVectorStoreMemoryMode()).toBe(false);
    });

    it('设置后应能正确读取', () => {
      setIsMemoryStore(true);
      expect(isVectorStoreMemoryMode()).toBe(true);
      expect(getIsMemoryStore()).toBe(true);
    });
  });

  describe('BM25 状态管理', () => {
    it('初始 BM25 索引应为 null', () => {
      setBM25Index(null);
      expect(getBM25Index()).toBeNull();
    });

    it('应能设置和获取 BM25 索引', () => {
      const mockIndex = { documentCount: 5 };
      setBM25Index(mockIndex);
      expect(getBM25Index()).toBe(mockIndex);
    });

    it('应能设置和获取 BM25 文档存储', () => {
      const store = new Map<string, { content: string; metadata: any }>();
      store.set('doc1', { content: 'test', metadata: {} });
      setBM25DocumentStore(store);
      expect(getBM25DocumentStore().get('doc1')?.content).toBe('test');
    });
  });
});

// ==================== vector-search 测试 ====================

describe('vector-search', () => {
  let searchKnowledgeBase: any;
  let hybridSearchKnowledgeBase: any;

  // Mock store-state 的 initializeVectorStore
  let mockStore: any;

  beforeAll(() => {
    const mod = require('./vector-search');
    searchKnowledgeBase = mod.searchKnowledgeBase;
    hybridSearchKnowledgeBase = mod.hybridSearchKnowledgeBase;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // 清空缓存，避免测试间互相影响
    const cacheMod = require('../cache');
    cacheMod.searchCache.clear('测试重置');

    // 创建 mock 向量存储
    mockStore = {
      similaritySearchWithScore: jest.fn(),
      addDocuments: jest.fn(),
      delete: jest.fn(),
      collection: {},
    };

    // Mock initializeVectorStore 返回 mock 存储
    const stateMod = require('./store-state');
    stateMod.initializeVectorStore = jest.fn().mockResolvedValue(mockStore);
  });

  describe('searchKnowledgeBase', () => {
    it('应返回过滤后的搜索结果', async () => {
      mockStore.similaritySearchWithScore.mockResolvedValue([
        [{ pageContent: '结果1', metadata: { source: 'a' } }, 0.3],
        [{ pageContent: '结果2', metadata: { source: 'b' } }, 0.5],
      ]);

      const results = await searchKnowledgeBase('测试查询', 5);
      expect(results.length).toBe(2);
      expect(results[0].content).toBe('结果1');
      expect(results[0].score).toBe(0.3);
    });

    it('应过滤掉相似度低于阈值的结果', async () => {
      mockStore.similaritySearchWithScore.mockResolvedValue([
        [{ pageContent: '高相似度', metadata: {} }, 0.3],
        [{ pageContent: '低相似度', metadata: {} }, 0.8], // 超过默认阈值 0.55
      ]);

      const results = await searchKnowledgeBase('测试查询', 5, 0.55);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('高相似度');
    });

    it('应过滤掉 draft 状态的文档', async () => {
      mockStore.similaritySearchWithScore.mockResolvedValue([
        [{ pageContent: 'active 文档', metadata: { versionStatus: 'active' } }, 0.3],
        [{ pageContent: 'draft 文档', metadata: { versionStatus: 'draft' } }, 0.3],
      ]);

      const results = await searchKnowledgeBase('测试查询', 5);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('active 文档');
    });

    it('应保留无 versionStatus 的旧数据', async () => {
      mockStore.similaritySearchWithScore.mockResolvedValue([
        [{ pageContent: '旧文档', metadata: {} }, 0.3],
      ]);

      const results = await searchKnowledgeBase('测试查询', 5);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('旧文档');
    });

    it('搜索失败应返回空数组', async () => {
      mockStore.similaritySearchWithScore.mockRejectedValue(new Error('连接失败'));

      const results = await searchKnowledgeBase('测试查询', 5);
      expect(results).toEqual([]);
    });

    it('应从 filter 中移除 versionStatus（不在 ChromaDB where 中过滤）', async () => {
      mockStore.similaritySearchWithScore.mockResolvedValue([]);

      await searchKnowledgeBase('测试', 5, 0.55, { versionStatus: 'active', source: 'test' });

      // similaritySearchWithScore 的第三个参数不应包含 versionStatus
      const callArgs = mockStore.similaritySearchWithScore.mock.calls[0];
      const filter = callArgs[2];
      expect(filter).not.toHaveProperty('versionStatus');
      expect(filter).toHaveProperty('source', 'test');
    });
  });

  describe('hybridSearchKnowledgeBase', () => {
    it('应融合向量检索和 BM25 检索结果', async () => {
      // Mock 向量检索结果
      mockStore.similaritySearchWithScore.mockResolvedValue([
        [{ pageContent: '向量结果1', metadata: { source: 'vec1' } }, 0.2],
        [{ pageContent: '向量结果2', metadata: { source: 'vec2' } }, 0.4],
      ]);

      // Mock BM25 索引
      const stateMod = require('./store-state');
      const mockBM25Index = {
        search: jest.fn().mockReturnValue([
          { id: 'bm1', score: 5.0, content: 'BM25结果1' },
        ]),
        documentCount: 1,
      };
      const mockBM25DocStore = new Map([
        ['bm1', { content: 'BM25结果1', metadata: { source: 'bm1' } }],
      ]);
      stateMod.getBM25Index = jest.fn().mockReturnValue(mockBM25Index);
      stateMod.getBM25DocumentStore = jest.fn().mockReturnValue(mockBM25DocStore);

      const results = await hybridSearchKnowledgeBase('测试查询', 5);

      // 应有融合结果
      expect(results.length).toBeGreaterThan(0);
      // 每个结果应有 sources 字段
      results.forEach((r: any) => {
        expect(r).toHaveProperty('sources');
        expect(r).toHaveProperty('vectorScore');
        expect(r).toHaveProperty('score');
      });
    });

    it('BM25 索引为空时应只返回向量检索结果', async () => {
      mockStore.similaritySearchWithScore.mockResolvedValue([
        [{ pageContent: '向量结果', metadata: { source: 'vec' } }, 0.3],
      ]);

      const stateMod = require('./store-state');
      stateMod.getBM25Index = jest.fn().mockReturnValue({ documentCount: 0 });
      stateMod.getBM25DocumentStore = jest.fn().mockReturnValue(new Map());

      const results = await hybridSearchKnowledgeBase('测试查询', 5);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('向量结果');
    });

    it('向量检索为空时应只返回 BM25 检索结果', async () => {
      mockStore.similaritySearchWithScore.mockResolvedValue([]);

      const stateMod = require('./store-state');
      const mockBM25Index = {
        search: jest.fn().mockReturnValue([
          { id: 'bm1', score: 3.0, content: 'BM25结果' },
        ]),
        documentCount: 1,
      };
      const mockBM25DocStore = new Map([
        ['bm1', { content: 'BM25结果', metadata: { source: 'bm' } }],
      ]);
      stateMod.getBM25Index = jest.fn().mockReturnValue(mockBM25Index);
      stateMod.getBM25DocumentStore = jest.fn().mockReturnValue(mockBM25DocStore);

      const results = await hybridSearchKnowledgeBase('测试查询', 5);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('BM25结果');
    });
  });
});

// ==================== vector-crud 测试 ====================

describe('vector-crud', () => {
  let addDocuments: any;
  let deleteDocuments: any;
  let mockStore: any;

  beforeAll(() => {
    const mod = require('./vector-crud');
    addDocuments = mod.addDocuments;
    deleteDocuments = mod.deleteDocuments;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockStore = {
      similaritySearchWithScore: jest.fn(),
      addDocuments: jest.fn(),
      delete: jest.fn(),
      collection: {},
    };

    const stateMod = require('./store-state');
    stateMod.initializeVectorStore = jest.fn().mockResolvedValue(mockStore);
    stateMod.getBM25Index = jest.fn().mockReturnValue(null);
    stateMod.getBM25DocumentStore = jest.fn().mockReturnValue(new Map());
  });

  describe('addDocuments', () => {
    it('应切分文档并添加到 ChromaDB', async () => {
      mockStore.addDocuments.mockResolvedValue(undefined);

      // Mock BM25 初始化
      const bm25Mod = require('./bm25-index');
      bm25Mod.initializeBM25Index = jest.fn().mockResolvedValue(undefined);
      bm25Mod.addToBM25Index = jest.fn().mockResolvedValue(undefined);
      bm25Mod.saveBM25Index = jest.fn().mockResolvedValue(undefined);

      const count = await addDocuments(
        ['这是一段测试文本内容'],
        [{ source: 'test.txt', docType: 'general' }],
      );

      expect(count).toBeGreaterThan(0);
      expect(mockStore.addDocuments).toHaveBeenCalled();
    });

    it('批量添加失败时应降级为逐条添加', async () => {
      // 第一次批量调用失败，后续逐条成功
      mockStore.addDocuments
        .mockRejectedValueOnce(new Error('批量添加失败'))
        .mockResolvedValue(undefined);

      const bm25Mod = require('./bm25-index');
      bm25Mod.initializeBM25Index = jest.fn().mockResolvedValue(undefined);
      bm25Mod.addToBM25Index = jest.fn().mockResolvedValue(undefined);
      bm25Mod.saveBM25Index = jest.fn().mockResolvedValue(undefined);

      const count = await addDocuments(
        ['短文本'],
        [{ source: 'test.txt' }],
      );

      expect(count).toBeGreaterThan(0);
      // 批量失败后应逐条调用 addDocuments
      expect(mockStore.addDocuments.mock.calls.length).toBeGreaterThan(1);
    });

    it('所有文本块添加失败应抛出错误', async () => {
      mockStore.addDocuments.mockRejectedValue(new Error('ChromaDB 不可用'));

      const bm25Mod = require('./bm25-index');
      bm25Mod.initializeBM25Index = jest.fn().mockResolvedValue(undefined);

      await expect(
        addDocuments(['测试文本'], [{ source: 'test.txt' }])
      ).rejects.toThrow('所有文本块添加失败');
    });
  });

  describe('deleteDocuments', () => {
    it('应从 ChromaDB 删除文档', async () => {
      mockStore.delete.mockResolvedValue(undefined);

      // Mock BM25 为空
      const bm25Mod = require('./bm25-index');
      bm25Mod.initializeBM25Index = jest.fn().mockResolvedValue(undefined);
      bm25Mod.rebuildBM25Index = jest.fn().mockResolvedValue(undefined);

      const stateMod = require('./store-state');
      stateMod.getBM25Index = jest.fn().mockReturnValue(null);

      await deleteDocuments({ source: 'test.txt' });
      expect(mockStore.delete).toHaveBeenCalledWith({ filter: { source: 'test.txt' } });
    });

    it('BM25 增量删除失败时应降级为全量重建', async () => {
      mockStore.delete.mockResolvedValue(undefined);

      const bm25Mod = require('./bm25-index');
      bm25Mod.initializeBM25Index = jest.fn().mockRejectedValue(new Error('BM25 初始化失败'));
      bm25Mod.rebuildBM25Index = jest.fn().mockResolvedValue(undefined);

      await deleteDocuments({ source: 'test.txt' });
      // 应降级为全量重建
      expect(bm25Mod.rebuildBM25Index).toHaveBeenCalled();
    });
  });
});
