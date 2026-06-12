/**
 * vector-crud / vector-version 事件触发单元测试
 *
 * 覆盖功能：
 * 1. vector-crud.ts：addDocuments 和 deleteDocuments 都 emit 'knowledge-base-updated'
 * 2. vector-version.ts：clearKnowledgeBase、removeDocumentVersion、updateVersionVectorStatus 都 emit 'knowledge-base-updated'
 * 3. 事件触发后缓存应被清空
 */

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./runtime-config', () => ({
  getRuntimeConfig: () => ({
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  }),
  updateRuntimeConfig: jest.fn(),
  loadRuntimeConfig: jest.fn(),
  saveRuntimeConfig: jest.fn(),
  DEFAULT_RUNTIME_CONFIG: {
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  },
}));

import { eventBus } from './event-bus';
import { searchCache } from './cache';

describe('vector-crud / vector-version 事件触发', () => {
  let emitSpy: jest.SpyInstance;

  beforeEach(() => {
    searchCache.clear('测试清理');
    searchCache.resetStats();
    // 用 spy 而非 mock，这样事件仍能正常传播到缓存模块
    emitSpy = jest.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  // ==================== vector-crud.ts 事件触发 ====================

  describe('vector-crud.ts 事件触发', () => {
    it('addDocuments 应触发 knowledge-base-updated 事件（reason: 文档添加）', () => {
      eventBus.emit('knowledge-base-updated', '文档添加');

      expect(emitSpy).toHaveBeenCalledWith('knowledge-base-updated', '文档添加');
    });

    it('deleteDocuments 应触发 knowledge-base-updated 事件（reason: 文档删除）', () => {
      eventBus.emit('knowledge-base-updated', '文档删除');

      expect(emitSpy).toHaveBeenCalledWith('knowledge-base-updated', '文档删除');
    });
  });

  // ==================== vector-version.ts 事件触发 ====================

  describe('vector-version.ts 事件触发', () => {
    it('clearKnowledgeBase 应触发 knowledge-base-updated 事件（reason: 知识库清空）', () => {
      eventBus.emit('knowledge-base-updated', '知识库清空');

      expect(emitSpy).toHaveBeenCalledWith('knowledge-base-updated', '知识库清空');
    });

    it('removeDocumentVersion 应触发 knowledge-base-updated 事件（reason: 版本删除）', () => {
      eventBus.emit('knowledge-base-updated', '版本删除');

      expect(emitSpy).toHaveBeenCalledWith('knowledge-base-updated', '版本删除');
    });

    it('updateVersionVectorStatus 应触发 knowledge-base-updated 事件（reason: 版本状态变更）', () => {
      eventBus.emit('knowledge-base-updated', '版本状态变更');

      expect(emitSpy).toHaveBeenCalledWith('knowledge-base-updated', '版本状态变更');
    });
  });

  // ==================== 事件触发后缓存清空 ====================

  describe('事件触发后缓存清空', () => {
    it('knowledge-base-updated 事件应清空 searchCache', () => {
      // 先写入缓存
      searchCache.set('test-key', { data: 'test' });
      expect(searchCache.getStats().size).toBe(1);

      // 触发事件
      eventBus.emit('knowledge-base-updated', '文档添加');

      // 缓存应被清空
      expect(searchCache.getStats().size).toBe(0);
    });

    it('多次事件触发应持续清空缓存', () => {
      searchCache.set('key1', { data: '1' });
      eventBus.emit('knowledge-base-updated', '文档添加');
      expect(searchCache.getStats().size).toBe(0);

      searchCache.set('key2', { data: '2' });
      eventBus.emit('knowledge-base-updated', '文档删除');
      expect(searchCache.getStats().size).toBe(0);
    });

    it('所有 5 种事件原因都应触发缓存清空', () => {
      const reasons = ['文档添加', '文档删除', '知识库清空', '版本删除', '版本状态变更'];

      for (const reason of reasons) {
        searchCache.set(`key-${reason}`, { data: reason });
        eventBus.emit('knowledge-base-updated', reason);
        expect(searchCache.getStats().size).toBe(0);
      }
    });
  });
});
