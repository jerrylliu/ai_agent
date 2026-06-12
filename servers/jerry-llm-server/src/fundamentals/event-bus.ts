/**
 * 事件总线
 *
 * 简单的发布/订阅模式事件总线，用于模块间解耦通信。
 *
 * 核心事件：
 * - knowledge-base-updated：知识库内容变更（文档增删改、版本激活/归档），
 *   缓存模块监听此事件自动清缓存，避免在每个变更点手动调 cache.clear()
 *
 * 使用方式：
 *   // 发布事件
 *   eventBus.emit('knowledge-base-updated', '文档上传');
 *
 *   // 监听事件
 *   eventBus.on('knowledge-base-updated', (reason) => { ... });
 */

type EventHandler = (...args: any[]) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  /**
   * 监听事件
   */
  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  /**
   * 取消监听
   */
  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  /**
   * 发布事件，通知所有监听者
   */
  emit(event: string, ...args: any[]): void {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (error: any) {
        // 事件处理器异常不影响其他处理器和发布者
        console.error(`[EventBus] 事件 "${event}" 处理器异常:`, error.message);
      }
    }
  }
}

/** 全局事件总线单例 */
export const eventBus = new EventBus();
