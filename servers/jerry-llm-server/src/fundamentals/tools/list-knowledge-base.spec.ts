/**
 * fundamentals/tools/list-knowledge-base.spec.ts
 *
 * list_knowledge_base 工具单元测试
 * Mock getAllDocuments 以测试聚合逻辑
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../vector-store/index', () => ({
  getAllDocuments: jest.fn(),
}));

import { executeListKnowledgeBase, listKnowledgeBaseSchema } from './list-knowledge-base';

describe('list_knowledge_base 工具', () => {
  describe('listKnowledgeBaseSchema', () => {
    it('应定义正确的函数名', () => {
      expect(listKnowledgeBaseSchema.function.name).toBe('list_knowledge_base');
    });

    it('detail_level 应有 enum 约束', () => {
      const props = listKnowledgeBaseSchema.function.parameters.properties as any;
      expect(props.detail_level.enum).toEqual(['brief', 'detailed']);
    });
  });

  describe('executeListKnowledgeBase', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('按 source 分组聚合', async () => {
      const { getAllDocuments } = require('../vector-store/index');
      getAllDocuments.mockResolvedValue([
        { content: 'doc A content chunk 1', metadata: { source: 'file-a.txt', doc_type: 'text' } },
        { content: 'doc A content chunk 2', metadata: { source: 'file-a.txt', doc_type: 'text' } },
        { content: 'doc B chunk 1', metadata: { source: 'file-b.pdf', docType: 'pdf' } },
      ]);

      const r = await executeListKnowledgeBase({ detail_level: 'brief' });
      expect(r.totalDocuments).toBe(2);
      expect(r.totalChunks).toBe(3);

      const fileA = r.documents.find(d => d.source === 'file-a.txt');
      expect(fileA).toBeDefined();
      expect(fileA!.chunkCount).toBe(2);

      const fileB = r.documents.find(d => d.source === 'file-b.pdf');
      expect(fileB).toBeDefined();
      expect(fileB!.chunkCount).toBe(1);
    });

    it('detailed 模式应包含 contentPreview', async () => {
      const { getAllDocuments } = require('../vector-store/index');
      getAllDocuments.mockResolvedValue([
        { content: 'Hello World', metadata: { source: 'test.txt', docType: 'text' } },
      ]);

      const r = await executeListKnowledgeBase({ detail_level: 'detailed' });
      expect(r.documents[0].contentPreview).toBeDefined();
      expect(r.documents[0].contentPreview).toContain('Hello World');
    });

    it('brief 模式不应包含 contentPreview', async () => {
      const { getAllDocuments } = require('../vector-store/index');
      getAllDocuments.mockResolvedValue([
        { content: 'test', metadata: { source: 'f.txt', doc_type: 'text' } },
      ]);

      const r = await executeListKnowledgeBase({ detail_level: 'brief' });
      expect(r.documents[0].contentPreview).toBeUndefined();
    });

    it('默认 detail_level 为 brief', async () => {
      const { getAllDocuments } = require('../vector-store/index');
      getAllDocuments.mockResolvedValue([]);

      const r = await executeListKnowledgeBase({});
      expect(r.documents).toEqual([]);
    });

    it('未知 source 标记为 unknown', async () => {
      const { getAllDocuments } = require('../vector-store/index');
      getAllDocuments.mockResolvedValue([
        { content: 'c', metadata: {} },
      ]);

      const r = await executeListKnowledgeBase({});
      expect(r.documents[0].source).toBe('unknown');
      expect(r.documents[0].docType).toBe('unknown');
    });

    it('异常时应返回空结果', async () => {
      const { getAllDocuments } = require('../vector-store/index');
      getAllDocuments.mockRejectedValue(new Error('DB down'));

      const r = await executeListKnowledgeBase({});
      expect(r.documents).toEqual([]);
      expect(r.totalDocuments).toBe(0);
    });
  });
});
