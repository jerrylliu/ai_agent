/**
 * fundamentals/tools/document-manager.spec.ts
 *
 * 「AI 操作界面·文档管理域」5 个新工具的单元测试
 * 覆盖：list_documents 过滤边界 / update_document_meta 空参守卫与空数组清空 /
 * delete_document 标题核对防误删 / list_document_versions / restore_document_version
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../model-provider', () => ({
  createLLM: jest.fn(),
  buildModelConfig: jest.fn().mockReturnValue({ temperature: 0.3 }),
}));

import {
  listDocumentsSchema,
  updateDocumentMetaSchema,
  deleteDocumentSchema,
  listDocumentVersionsSchema,
  restoreDocumentVersionSchema,
  executeListDocuments,
  executeUpdateDocumentMeta,
  executeDeleteDocument,
  executeListDocumentVersions,
  executeRestoreDocumentVersion,
  initDocumentTools,
} from './document-ops';

describe('document-manager 工具（AI 操作界面·文档管理域）', () => {
  let mockService: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockService = {
      listDocuments: jest.fn(),
      updateDocument: jest.fn(),
      getDocument: jest.fn(),
      deleteDocument: jest.fn(),
      listVersions: jest.fn(),
      getVersion: jest.fn(),
      restoreVersion: jest.fn(),
    };
    initDocumentTools(mockService as any);
  });

  /* ==================== Schema ==================== */

  describe('Schema', () => {
    it('list_documents 全部参数可选（filter 缺省 = all）', () => {
      // 全可选 schema 的 required 键会被省略（undefined），等价于空数组
      expect(listDocumentsSchema.function.parameters.required ?? []).toEqual(
        [],
      );
    });

    it('update_document_meta 仅 documentId 必填', () => {
      expect(updateDocumentMetaSchema.function.parameters.required).toEqual([
        'documentId',
      ]);
    });

    it('delete_document 仅 documentId 必填（title 为核对用可选参数）', () => {
      expect(deleteDocumentSchema.function.parameters.required).toEqual([
        'documentId',
      ]);
    });

    it('list_document_versions 仅 documentId 必填', () => {
      expect(listDocumentVersionsSchema.function.parameters.required).toEqual([
        'documentId',
      ]);
    });

    it('restore_document_version 仅 versionId 必填', () => {
      expect(restoreDocumentVersionSchema.function.parameters.required).toEqual(
        ['versionId'],
      );
    });
  });

  /* ==================== executeListDocuments ==================== */

  describe('executeListDocuments', () => {
    it('filter=untagged 只返回无标签文档（tags 为 JSON 字符串形态）', async () => {
      mockService.listDocuments.mockResolvedValue([
        { id: 1, title: '有标签A', tags: JSON.stringify(['a']) },
        { id: 2, title: '无标签B', tags: null },
        { id: 3, title: '有标签C', tags: JSON.stringify(['x', 'y']) },
        { id: 4, title: '无标签D', tags: '非法JSON' },
        { id: 5, title: '无标签E', tags: [] },
      ]);

      const result = await executeListDocuments({ filter: 'untagged' });

      expect(result.success).toBe(true);
      expect(result.total).toBe(3);
      expect(result.documents.map((d) => d.documentId)).toEqual([2, 4, 5]);
    });

    it('filter=keyword 大小写不敏感匹配标题，缺少 keyword 时明确报错', async () => {
      mockService.listDocuments.mockResolvedValue([
        { id: 1, title: 'Wiki Gate Report', tags: [] },
        { id: 2, title: '测试文档', tags: [] },
      ]);

      const hit = await executeListDocuments({
        filter: 'keyword',
        keyword: 'wiki',
      });
      expect(hit.total).toBe(1);
      expect(hit.documents[0].documentId).toBe(1);

      const miss = await executeDocumentsWithoutKeyword();
      expect(miss.success).toBe(false);
      expect(miss.message).toContain('keyword');
    });

    /** 提取 helper：keyword 缺失场景 */
    async function executeDocumentsWithoutKeyword() {
      return executeListDocuments({ filter: 'keyword' });
    }

    it('limit 截断返回并提示总数', async () => {
      mockService.listDocuments.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({
          id: i + 1,
          title: `doc-${i + 1}`,
          tags: [],
        })),
      );

      const result = await executeListDocuments({ limit: 2 });

      expect(result.returned).toBe(2);
      expect(result.total).toBe(5);
      expect(result.message).toContain('5');
    });
  });

  /* ==================== executeUpdateDocumentMeta ==================== */

  describe('executeUpdateDocumentMeta', () => {
    it('空数组 tags 语义 = 清空全部标签（!== undefined 判断守卫）', async () => {
      mockService.updateDocument.mockResolvedValue({
        id: 7,
        title: 'T',
        tags: [],
      });

      const result = await executeUpdateDocumentMeta({
        documentId: 7,
        tags: [],
      });

      expect(result.success).toBe(true);
      expect(mockService.updateDocument).toHaveBeenCalledWith(7, {
        title: undefined,
        description: undefined,
        tags: [],
      });
      expect(result.message).toContain('已清空');
    });

    it('三个字段全部未传时拒绝调用（避免无意义写库）', async () => {
      const result = await executeUpdateDocumentMeta({ documentId: 7 });

      expect(result.success).toBe(false);
      expect(mockService.updateDocument).not.toHaveBeenCalled();
    });

    it('只传 tags 时不触碰标题与描述（undefined 字段透传）', async () => {
      mockService.updateDocument.mockResolvedValue({
        id: 7,
        title: '原标题',
        tags: ['新标签'],
      });

      await executeUpdateDocumentMeta({ documentId: 7, tags: ['新标签'] });

      expect(mockService.updateDocument).toHaveBeenCalledWith(7, {
        title: undefined,
        description: undefined,
        tags: ['新标签'],
      });
    });
  });

  /* ==================== executeDeleteDocument ==================== */

  describe('executeDeleteDocument', () => {
    it('标题核对不符时拒绝删除（防 LLM 张冠李戴误删）', async () => {
      mockService.getDocument.mockResolvedValue({ id: 3, title: '真实标题' });

      const result = await executeDeleteDocument({
        documentId: 3,
        title: '错误的标题',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('标题核对失败');
      expect(mockService.deleteDocument).not.toHaveBeenCalled();
    });

    it('标题核对通过后执行删除', async () => {
      mockService.getDocument.mockResolvedValue({ id: 3, title: '真实标题' });

      const result = await executeDeleteDocument({
        documentId: 3,
        title: '真实标题',
      });

      expect(result.success).toBe(true);
      expect(mockService.deleteDocument).toHaveBeenCalledWith(3, 'agent');
      expect(result.message).toContain('真实标题');
    });

    it('不传 title 时跳过核对直接删除（核对为可选增强）', async () => {
      mockService.getDocument.mockResolvedValue({ id: 3, title: '真实标题' });

      const result = await executeDeleteDocument({ documentId: 3 });

      expect(result.success).toBe(true);
      expect(mockService.deleteDocument).toHaveBeenCalled();
    });
  });

  /* ==================== executeListDocumentVersions ==================== */

  describe('executeListDocumentVersions', () => {
    it('返回版本清单并带文档标题', async () => {
      mockService.getDocument.mockResolvedValue({ id: 9, title: 'T9' });
      mockService.listVersions.mockResolvedValue([
        {
          id: 101,
          versionNumber: 2,
          status: 'active',
          parsingStatus: 'SUCCESS',
          createdAt: new Date('2026-09-29T00:00:00Z'),
        },
        {
          id: 100,
          versionNumber: 1,
          status: 'archived',
          parsingStatus: 'SUCCESS',
          createdAt: new Date('2026-09-28T00:00:00Z'),
        },
      ]);

      const result = await executeListDocumentVersions({ documentId: 9 });

      expect(result.success).toBe(true);
      expect(result.documentTitle).toBe('T9');
      expect(result.versions).toHaveLength(2);
      expect(result.versions[0].versionId).toBe(101);
      expect(result.versions[0].versionNumber).toBe(2);
    });
  });

  /* ==================== executeRestoreDocumentVersion ==================== */

  describe('executeRestoreDocumentVersion', () => {
    it('标题核对不符时拒绝恢复', async () => {
      mockService.getVersion.mockResolvedValue({
        id: 100,
        documentId: 9,
        versionNumber: 1,
      });
      mockService.getDocument.mockResolvedValue({ id: 9, title: '真实标题' });

      const result = await executeRestoreDocumentVersion({
        versionId: 100,
        documentTitle: '错误的标题',
      });

      expect(result.success).toBe(false);
      expect(mockService.restoreVersion).not.toHaveBeenCalled();
    });

    it('核对通过后调用 restoreVersion 并返回新版本号', async () => {
      mockService.getVersion.mockResolvedValue({
        id: 100,
        documentId: 9,
        versionNumber: 1,
      });
      mockService.getDocument.mockResolvedValue({ id: 9, title: '真实标题' });
      mockService.restoreVersion.mockResolvedValue({
        document: { id: 9, title: '真实标题' },
        version: { versionNumber: 3 },
      });

      const result = await executeRestoreDocumentVersion({
        versionId: 100,
        documentTitle: '真实标题',
      });

      expect(result.success).toBe(true);
      expect(result.restoredFromVersionNumber).toBe(1);
      expect(result.newVersionNumber).toBe(3);
      expect(mockService.restoreVersion).toHaveBeenCalledWith(100, 'agent');
    });

    it('服务未初始化时返回结构化失败而非抛异常', async () => {
      initDocumentTools(null as any);

      const result = await executeRestoreDocumentVersion({ versionId: 100 });

      expect(result.success).toBe(false);
      expect(result.message).toContain('未初始化');
    });
  });
});
