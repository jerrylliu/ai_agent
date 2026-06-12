/**
 * 事件总线单元测试
 */

import { eventBus } from './event-bus';

describe('EventBus', () => {
  afterEach(() => {
    // 清理所有事件监听器，避免测试间干扰
    (eventBus as any).handlers.clear();
  });

  describe('on / emit', () => {
    it('应能监听并接收事件', () => {
      const handler = jest.fn();
      eventBus.on('test-event', handler);
      eventBus.emit('test-event', 'arg1', 'arg2');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('同一事件支持多个监听器', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      eventBus.on('multi-event', handler1);
      eventBus.on('multi-event', handler2);
      eventBus.emit('multi-event');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('无监听器时 emit 不应报错', () => {
      expect(() => eventBus.emit('non-existent-event')).not.toThrow();
    });

    it('同一处理器重复注册不应重复调用', () => {
      const handler = jest.fn();
      eventBus.on('dup-event', handler);
      eventBus.on('dup-event', handler); // 重复注册
      eventBus.emit('dup-event');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('off', () => {
    it('取消监听后不再接收事件', () => {
      const handler = jest.fn();
      eventBus.on('off-event', handler);
      eventBus.off('off-event', handler);
      eventBus.emit('off-event');

      expect(handler).not.toHaveBeenCalled();
    });

    it('取消未注册的处理器不应报错', () => {
      const handler = jest.fn();
      expect(() => eventBus.off('non-existent', handler)).not.toThrow();
    });

    it('只取消指定处理器，不影响其他', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      eventBus.on('partial-event', handler1);
      eventBus.on('partial-event', handler2);
      eventBus.off('partial-event', handler1);
      eventBus.emit('partial-event');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('异常隔离', () => {
    it('一个处理器异常不影响其他处理器', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('handler error');
      });
      const normalHandler = jest.fn();

      eventBus.on('error-event', errorHandler);
      eventBus.on('error-event', normalHandler);
      eventBus.emit('error-event');

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler).toHaveBeenCalledTimes(1);
    });

    it('处理器异常不应影响 emit 调用者', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('handler error');
      });
      eventBus.on('error-event', errorHandler);

      expect(() => eventBus.emit('error-event')).not.toThrow();
    });
  });
});
