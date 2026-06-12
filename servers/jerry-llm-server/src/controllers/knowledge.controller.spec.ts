/**
 * controllers/knowledge.controller.spec.ts
 *
 * KnowledgeController 单元测试
 * 覆盖：uploadToKnowledgeBase / getKnowledgeBaseStatus
 *
 * 注意：DocumentService 依赖链包含 ESM 模块（@langchain），
 * 全部在 import 前 mock 掉，避免 Jest 解析 ESM 崩溃。
 */

/* =====================================================================
 * Mock 所有 DocumentService/KSS 的依赖链
 * ==================================================================*/
jest.mock('../fundamentals/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../services/document.service', () => ({
  DocumentService: class {
    uploadDocument = jest.fn();
    getKnowledgeStats = jest.fn();
    deleteDocument = jest.fn();
    deleteAllDocuments = jest.fn();
    listDocuments = jest.fn();
    getDocument = jest.fn();
  },
}));

jest.mock('../services/knowledge-source.service', () => ({
  KnowledgeSourceService: class {
    getTotalPageCount = jest.fn();
    findAll = jest.fn();
  },
}));

jest.mock('../fundamentals/rag-service', () => ({
  __esModule: true,
  handleDocumentUpload: jest.fn(),
  getKnowledgeBaseStatus: jest.fn().mockResolvedValue({}),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeController } from './knowledge.controller';
import { DocumentService } from '../services/document.service';
import { KnowledgeSourceService } from '../services/knowledge-source.service';

describe('KnowledgeController', () => {
  let controller: KnowledgeController;
  let documentService: any;
  let knowledgeSourceService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [KnowledgeController],
      providers: [
        { provide: DocumentService, useValue: new (DocumentService as any)() },
        { provide: KnowledgeSourceService, useValue: new (KnowledgeSourceService as any)() },
      ],
    }).compile();

    controller = module.get<KnowledgeController>(KnowledgeController);
    documentService = module.get(DocumentService);
    knowledgeSourceService = module.get(KnowledgeSourceService);

    knowledgeSourceService.getTotalPageCount.mockResolvedValue(10);
    knowledgeSourceService.findAll.mockResolvedValue([]);
    documentService.getKnowledgeStats.mockResolvedValue({
      documentCount: 5,
      activeVersionCount: 5,
      totalVersionCount: 7,
      totalFileSizeBytes: 102400,
      documents: [],
    });
  });

  /* ====================================================================
   * uploadToKnowledgeBase
   * ==================================================================*/
  describe('uploadToKnowledgeBase', () => {
    it('无文件时应返回失败', async () => {
      const r = await controller.uploadToKnowledgeBase(undefined);
      expect(r.success).toBe(false);
      expect(r.message).toContain('请选择');
    });

    it('应委托 DocumentService.uploadDocument', async () => {
      documentService.uploadDocument.mockResolvedValue({
        version: { versionNumber: 1 },
        document: {},
      });
      const file = {
        buffer: Buffer.from('test'),
        originalname: 'test.txt',
        size: 100,
        mimetype: 'text/plain',
      };
      const r = await controller.uploadToKnowledgeBase(file);
      expect(r.success).toBe(true);
      expect(documentService.uploadDocument).toHaveBeenCalledWith(
        { buffer: file.buffer, originalname: file.originalname, size: file.size, mimetype: file.mimetype },
        { title: 'test', operator: 'anonymous' },
      );
    });

    it('上传失败时应返回失败', async () => {
      documentService.uploadDocument.mockRejectedValue(new Error('DB error'));
      const file = {
        buffer: Buffer.from('t'),
        originalname: 'f.txt',
        size: 1,
        mimetype: 'text/plain',
      };
      const r = await controller.uploadToKnowledgeBase(file);
      expect(r.success).toBe(false);
    });
  });

  /* ====================================================================
   * getKnowledgeBaseStatus
   * ==================================================================*/
  describe('getKnowledgeBaseStatus', () => {
    it('应返回知识库状态', async () => {
      const r = await controller.getKnowledgeBaseStatus();
      expect(r.status).toBe('ready');
      expect(r.uploadedDocumentCount).toBe(5);
      expect(r.knowledgeSourcePageCount).toBe(10);
      expect(r.documentCount).toBe(15);
    });
  });
});
