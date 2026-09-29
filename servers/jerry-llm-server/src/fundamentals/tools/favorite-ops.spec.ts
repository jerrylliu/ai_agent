/**
 * fundamentals/tools/favorite-ops.spec.ts
 *
 * 收藏操作工具单元测试
 * Mock GeneratedDocumentService，验证用户隔离、标题核对与 setFavorite 调用。
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { toggleDocumentFavoriteSchema } from './favorite-ops';

describe('favorite-ops 工具', () => {
  /* ====================================================================
   * Schema
   * ==================================================================*/
  describe('Schema', () => {
    it('toggle_document_favorite 应要求 key 与 favorited 必填', () => {
      expect(
        toggleDocumentFavoriteSchema.function.parameters.required,
      ).toEqual(expect.arrayContaining(['key', 'favorited']));
    });
  });

  /* ====================================================================
   * executeListFavoriteDocuments
   * ==================================================================*/
  describe('executeListFavoriteDocuments', () => {
    it('服务未注入时应返回失败', async () => {
      jest.resetModules();
      const fresh = require('./favorite-ops');
      const r = await fresh.executeListFavoriteDocuments({});
      expect(r.success).toBe(false);
      expect(r.message).toContain('未初始化');
    });

    it('应按 context.userId 隔离查询并映射字段', async () => {
      jest.resetModules();
      const fresh = require('./favorite-ops');
      const listFavorites = jest.fn().mockResolvedValue([
        {
          key: 'gen_abc',
          title: '周报',
          format: 'docx',
          createdAt: new Date('2026-09-29T00:00:00Z'),
          expiresAt: new Date('2026-10-06T00:00:00Z'),
          favorited: true,
        },
      ]);
      fresh.initFavoriteOps({ listFavorites });

      const r = await fresh.executeListFavoriteDocuments({}, { userId: '15' });
      expect(listFavorites).toHaveBeenCalledWith('15');
      expect(r.success).toBe(true);
      expect(r.total).toBe(1);
      expect(r.documents[0]).toMatchObject({
        key: 'gen_abc',
        title: '周报',
        format: 'docx',
      });
    });
  });

  /* ====================================================================
   * executeToggleDocumentFavorite
   * ==================================================================*/
  describe('executeToggleDocumentFavorite', () => {
    it('文档不存在时应返回失败', async () => {
      jest.resetModules();
      const fresh = require('./favorite-ops');
      const setFavorite = jest.fn();
      fresh.initFavoriteOps({
        findByKey: jest.fn().mockResolvedValue(null),
        setFavorite,
      });

      const r = await fresh.executeToggleDocumentFavorite(
        { key: 'gen_missing', favorited: true },
        { userId: '15' },
      );
      expect(r.success).toBe(false);
      expect(r.message).toContain('不存在');
      expect(setFavorite).not.toHaveBeenCalled();
    });

    it('不属于当前用户的文档应被拒绝', async () => {
      jest.resetModules();
      const fresh = require('./favorite-ops');
      const setFavorite = jest.fn();
      fresh.initFavoriteOps({
        findByKey: jest
          .fn()
          .mockResolvedValue({ key: 'gen_x', title: '别人的文档', userId: '99' }),
        setFavorite,
      });

      const r = await fresh.executeToggleDocumentFavorite(
        { key: 'gen_x', favorited: true },
        { userId: '15' },
      );
      expect(r.success).toBe(false);
      expect(r.message).toContain('不属于当前用户');
      expect(setFavorite).not.toHaveBeenCalled();
    });

    it('标题核对不符时应拒绝执行', async () => {
      jest.resetModules();
      const fresh = require('./favorite-ops');
      const setFavorite = jest.fn();
      fresh.initFavoriteOps({
        findByKey: jest
          .fn()
          .mockResolvedValue({ key: 'gen_y', title: '真实标题', userId: null }),
        setFavorite,
      });

      const r = await fresh.executeToggleDocumentFavorite(
        { key: 'gen_y', favorited: true, title: '错误标题' },
        { userId: '15' },
      );
      expect(r.success).toBe(false);
      expect(r.message).toContain('标题核对失败');
      expect(setFavorite).not.toHaveBeenCalled();
    });

    it('核对通过时应以单参 findByKey + 三参 setFavorite 执行', async () => {
      jest.resetModules();
      const fresh = require('./favorite-ops');
      const findByKey = jest
        .fn()
        .mockResolvedValue({ key: 'gen_z', title: '周报', userId: '15' });
      const setFavorite = jest
        .fn()
        .mockResolvedValue({ key: 'gen_z', title: '周报', favorited: true });
      fresh.initFavoriteOps({ findByKey, setFavorite });

      const r = await fresh.executeToggleDocumentFavorite(
        { key: 'gen_z', favorited: true, title: '周报' },
        { userId: '15' },
      );
      // findByKey 按 key 全局查（单参数），归属校验在工具层显式做
      expect(findByKey).toHaveBeenCalledWith('gen_z');
      expect(findByKey).toHaveBeenCalledTimes(1);
      expect(setFavorite).toHaveBeenCalledWith('gen_z', '15', true);
      expect(r.success).toBe(true);
      expect(r.favorited).toBe(true);
    });

    it('setFavorite 拒绝（返回 null）时应返回失败', async () => {
      jest.resetModules();
      const fresh = require('./favorite-ops');
      fresh.initFavoriteOps({
        findByKey: jest
          .fn()
          .mockResolvedValue({ key: 'gen_w', title: '周报', userId: null }),
        setFavorite: jest.fn().mockResolvedValue(null),
      });

      const r = await fresh.executeToggleDocumentFavorite(
        { key: 'gen_w', favorited: false },
        { userId: '15' },
      );
      expect(r.success).toBe(false);
      expect(r.message).toContain('拒绝');
    });
  });
});
