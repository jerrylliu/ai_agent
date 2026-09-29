/**
 * fundamentals/tools/knowledge-source-ops.spec.ts
 *
 * 知识源操作工具单元测试
 * Mock KnowledgeSourceService / DocumentService / rag-service，测试 schema 与核心逻辑
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// executeGetKnowledgeStatus 内部动态 import('../rag-service.js')，
// moduleNameMapper 会把 .js 后缀映射回本 mock
jest.mock('../rag-service', () => ({
  getKnowledgeBaseStatus: jest.fn().mockResolvedValue({ collection: 'kb' }),
}));

import {
  addKnowledgeSourceSchema,
  syncKnowledgeSourceSchema,
  rebuildKnowledgeIndexSchema,
} from './knowledge-source-ops';

describe('knowledge-source-ops 工具', () => {
  /* ====================================================================
   * Schema
   * ==================================================================*/
  describe('Schema', () => {
    it('add_knowledge_source 应要求 name 和 url 必填', () => {
      expect(addKnowledgeSourceSchema.function.parameters.required).toEqual(
        expect.arrayContaining(['name', 'url']),
      );
    });

    it('sync_knowledge_source 应要求 sourceIds 必填', () => {
      expect(syncKnowledgeSourceSchema.function.parameters.required).toEqual(
        expect.arrayContaining(['sourceIds']),
      );
    });

    it('rebuild_knowledge_index 应要求 confirm 必填', () => {
      expect(
        rebuildKnowledgeIndexSchema.function.parameters.required,
      ).toEqual(expect.arrayContaining(['confirm']));
    });
  });

  /* ====================================================================
   * executeListKnowledgeSources
   * ==================================================================*/
  describe('executeListKnowledgeSources', () => {
    it('服务未注入时应返回失败', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const r = await fresh.executeListKnowledgeSources();
      expect(r.success).toBe(false);
      expect(r.message).toContain('未初始化');
    });

    it('注入后应映射同步状态字段', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {
          findAll: jest.fn().mockResolvedValue([
            {
              id: 1,
              name: '官网文档',
              type: 'web',
              enabled: true,
              lastSyncStatus: 'success',
              lastSyncAt: new Date('2026-09-29T00:00:00Z'),
              hasContentUpdate: true,
            },
          ]),
        },
        documentService: {},
      });

      const r = await fresh.executeListKnowledgeSources();
      expect(r.success).toBe(true);
      expect(r.total).toBe(1);
      expect(r.sources[0]).toMatchObject({
        sourceId: 1,
        name: '官网文档',
        type: 'web',
        lastSyncStatus: 'success',
        hasContentUpdate: true,
      });
    });
  });

  /* ====================================================================
   * executeAddKnowledgeSource
   * ==================================================================*/
  describe('executeAddKnowledgeSource', () => {
    it('只支持 web 类型：create 应固定传 type=web', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const create = jest.fn().mockResolvedValue({ id: 9, name: '博客' });
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: { create },
        documentService: {},
      });

      const r = await fresh.executeAddKnowledgeSource({
        name: '博客',
        url: 'https://example.com',
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '博客',
          type: 'web',
          config: { url: 'https://example.com' },
        }),
      );
      expect(r.success).toBe(true);
      expect(r.sourceId).toBe(9);
    });

    it('url 非法时应参数校验失败且不调用 create', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const create = jest.fn();
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: { create },
        documentService: {},
      });

      const r = await fresh.executeAddKnowledgeSource({
        name: '坏源',
        url: 'not-a-url',
      });
      expect(r.success).toBe(false);
      expect(r.message).toContain('参数校验失败');
      expect(create).not.toHaveBeenCalled();
    });
  });

  /* ====================================================================
   * executeDeleteKnowledgeSource
   * ==================================================================*/
  describe('executeDeleteKnowledgeSource', () => {
    it('名称核对不符时应拒绝删除', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const remove = jest.fn();
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {
          findOne: jest.fn().mockResolvedValue({ id: 3, name: '真实名称' }),
          remove,
        },
        documentService: {},
      });

      const r = await fresh.executeDeleteKnowledgeSource({
        sourceId: 3,
        name: '张冠李戴',
      });
      expect(r.success).toBe(false);
      expect(r.message).toContain('名称核对失败');
      expect(remove).not.toHaveBeenCalled();
    });

    it('名称匹配时应执行删除', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const remove = jest.fn().mockResolvedValue(undefined);
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {
          findOne: jest.fn().mockResolvedValue({ id: 3, name: '官网文档' }),
          remove,
        },
        documentService: {},
      });

      const r = await fresh.executeDeleteKnowledgeSource({
        sourceId: 3,
        name: '官网文档',
      });
      expect(r.success).toBe(true);
      expect(remove).toHaveBeenCalledWith(3);
      expect(r.name).toBe('官网文档');
    });
  });

  /* ====================================================================
   * executeSyncKnowledgeSource
   * ==================================================================*/
  describe('executeSyncKnowledgeSource', () => {
    it('正在同步中的源应跳过且不触发 syncSource', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const syncSource = jest.fn().mockResolvedValue(undefined);
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {
          findOne: jest
            .fn()
            .mockResolvedValue({ id: 5, name: '同步中', lastSyncStatus: 'syncing' }),
          syncSource,
        },
        documentService: {},
      });

      const r = await fresh.executeSyncKnowledgeSource({ sourceIds: [5] });
      expect(r.started).toEqual([]);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0].reason).toContain('正在同步');
      expect(syncSource).not.toHaveBeenCalled();
    });

    it('正常源应启动后台同步并立即返回', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const syncSource = jest.fn().mockResolvedValue(undefined);
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {
          findOne: jest
            .fn()
            .mockResolvedValue({ id: 6, name: '待同步', lastSyncStatus: 'success' }),
          syncSource,
        },
        documentService: {},
      });

      const r = await fresh.executeSyncKnowledgeSource({ sourceIds: [6] });
      expect(r.started).toEqual([6]);
      expect(r.success).toBe(true);
      expect(syncSource).toHaveBeenCalledWith(6);
    });
  });

  /* ====================================================================
   * executeGetKnowledgeStatus
   * ==================================================================*/
  describe('executeGetKnowledgeStatus', () => {
    it('应汇总上传文档数与知识源页面数', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {
          getTotalPageCount: jest.fn().mockResolvedValue(5),
        },
        documentService: {
          getKnowledgeStats: jest.fn().mockResolvedValue({
            documentCount: 10,
            activeVersionCount: 12,
            totalChunkCount: 100,
            lastUpdatedAt: null,
          }),
          getReindexProgress: jest.fn().mockReturnValue(null),
        },
      });

      const r = await fresh.executeGetKnowledgeStatus();
      expect(r.success).toBe(true);
      expect(r.status.documentCount).toBe(10);
      expect(r.status.knowledgeSourcePageCount).toBe(5);
      expect(r.status.totalDocumentCount).toBe(15);
      expect(r.status.totalChunkCount).toBe(100);
      expect(r.status.reindexProgress).toEqual({});
    });
  });

  /* ====================================================================
   * executeRebuildKnowledgeIndex
   * ==================================================================*/
  describe('executeRebuildKnowledgeIndex', () => {
    it('confirm 非 true 时应拒绝执行', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const enqueueFullReindex = jest.fn();
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {},
        documentService: { enqueueFullReindex },
      });

      const r = await fresh.executeRebuildKnowledgeIndex({ confirm: false });
      expect(r.success).toBe(false);
      expect(r.message).toContain('confirm');
      expect(enqueueFullReindex).not.toHaveBeenCalled();
    });

    it('confirm=true 时应启动全量重建', async () => {
      jest.resetModules();
      const fresh = require('./knowledge-source-ops');
      const enqueueFullReindex = jest.fn().mockResolvedValue({
        enqueued: 10,
        progress: { running: true },
      });
      fresh.initKnowledgeSourceTools({
        knowledgeSourceService: {},
        documentService: { enqueueFullReindex },
      });

      const r = await fresh.executeRebuildKnowledgeIndex({ confirm: true });
      expect(r.success).toBe(true);
      expect(enqueueFullReindex).toHaveBeenCalledTimes(1);
    });
  });
});
