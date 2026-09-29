/**
 * fundamentals/tools/document-ops.spec.ts
 *
 * document-ops 工具单元测试
 * Mock DocumentService, LangChain, diff，测试 schema 和核心逻辑
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

jest.mock('@langchain/core/messages', () => ({
  HumanMessage: class {},
  SystemMessage: class {},
}));

jest.mock('diff', () => ({
  diffLines: jest.fn(),
}));

import {
  createDocumentSchema,
  updateDocumentSchema,
  executeCreateDocument,
  executeUpdateDocument,
  initDocumentTools,
} from './document-ops';

describe('document-ops 工具', () => {
  /* ====================================================================
   * Schema
   * ==================================================================*/
  describe('Schema', () => {
    it('create_document 应要求 title 和 content 必填', () => {
      expect(createDocumentSchema.function.parameters.required).toEqual(
        expect.arrayContaining(['title', 'content']),
      );
    });

    it('update_document 应要求 documentId 和 content 必填', () => {
      expect(updateDocumentSchema.function.parameters.required).toEqual(
        expect.arrayContaining(['documentId', 'content']),
      );
    });
  });

  /* ====================================================================
   * executeCreateDocument
   * ==================================================================*/
  describe('executeCreateDocument', () => {
    it('DocumentService 未注入时应返回失败', async () => {
      // reset modules to clear static injection
      jest.resetModules();
      const fresh = require('./document-ops');
      const r = await fresh.executeCreateDocument({
        title: 'test',
        content: 'hello',
      });
      expect(r.success).toBe(false);
      expect(r.message).toContain('未初始化');
    });

    it('DocumentService 注入后应委托上传', async () => {
      jest.resetModules();
      const fresh = require('./document-ops');
      const mockService = {
        uploadDocument: jest
          .fn()
          .mockResolvedValue({ document: { id: 42 }, version: {} }),
      };
      fresh.initDocumentTools(mockService);

      const r = await fresh.executeCreateDocument({
        title: 'test',
        content: 'hello',
        tags: ['ai'],
      });
      expect(mockService.uploadDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          buffer: expect.any(Buffer),
          originalname: 'test.md',
          mimetype: 'text/markdown',
        }),
        expect.objectContaining({
          title: 'test',
          tags: ['ai'],
        }),
      );
      expect(r.success).toBe(true);
      expect(r.documentId).toBe(42);
    });
  });

  /* ====================================================================
   * executeUpdateDocument
   * ==================================================================*/
  describe('executeUpdateDocument', () => {
    it('未注入时应返回失败', async () => {
      jest.resetModules();
      const fresh = require('./document-ops');
      const r = await fresh.executeUpdateDocument({
        documentId: 1,
        content: 'updated',
      });
      expect(r.success).toBe(false);
      expect(r.message).toContain('未初始化');
    });

    it('提供 tags 时应调用 updateDocument 更新标签元信息', async () => {
      jest.resetModules();
      const fresh = require('./document-ops');
      const mockService = {
        uploadDocument: jest.fn().mockResolvedValue({
          document: { id: 7 },
          version: { versionNumber: 2 },
        }),
        updateDocument: jest.fn().mockResolvedValue({ id: 7 }),
      };
      fresh.initDocumentTools(mockService);

      const r = await fresh.executeUpdateDocument({
        documentId: 7,
        content: 'updated',
        tags: ['a', 'b'],
      });
      expect(r.success).toBe(true);
      expect(mockService.uploadDocument).toHaveBeenCalled();
      expect(mockService.updateDocument).toHaveBeenCalledWith(7, {
        tags: ['a', 'b'],
      });
    });

    it('tags 为空数组时应生效（清空语义，不能被 truthy 判断吞掉）', async () => {
      jest.resetModules();
      const fresh = require('./document-ops');
      const mockService = {
        uploadDocument: jest.fn().mockResolvedValue({
          document: { id: 7 },
          version: { versionNumber: 2 },
        }),
        updateDocument: jest.fn().mockResolvedValue({ id: 7 }),
      };
      fresh.initDocumentTools(mockService);

      const r = await fresh.executeUpdateDocument({
        documentId: 7,
        content: 'updated',
        tags: [],
      });
      expect(r.success).toBe(true);
      expect(mockService.updateDocument).toHaveBeenCalledWith(7, { tags: [] });
    });

    it('不传 tags 且不传 title 时不应调用 updateDocument', async () => {
      jest.resetModules();
      const fresh = require('./document-ops');
      const mockService = {
        uploadDocument: jest.fn().mockResolvedValue({
          document: { id: 7 },
          version: { versionNumber: 3 },
        }),
        updateDocument: jest.fn(),
      };
      fresh.initDocumentTools(mockService);

      const r = await fresh.executeUpdateDocument({
        documentId: 7,
        content: 'updated',
      });
      expect(r.success).toBe(true);
      expect(mockService.updateDocument).not.toHaveBeenCalled();
    });
  });
});
