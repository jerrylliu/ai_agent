/**
 * 聊天事件总线（Web 端实时同步）
 *
 * 目的：当 chat_history 被任意来源写入（Web 自身、飞书入站回复、Web→飞书后回流等），
 * 通过 SSE 实时通知到对应用户的 Web 端，替代原来的 5 秒轮询为主、轮询降级为兜底。
 *
 * 设计：
 *   - 进程内 EventEmitter，按 ownerUserId 分组分发，避免跨用户串消息。
 *   - 单实例部署足够；多实例时可在此基础上接 Redis pub/sub（当前不引入，避免过度设计）。
 *   - 事件体只携带 sessionId / role / 时间戳等"信号"，不带消息正文：
 *     前端收到信号后按现有接口重新拉取，复用既有渲染与鉴权逻辑，避免重复实现。
 */

import { EventEmitter } from 'events';
import { logger } from './logger.js';

/** chat_history 写入事件 */
export interface ChatHistoryEvent {
  /** 数据归属用户（与 session.userId 一致；未登录为 'default'） */
  ownerUserId: string;
  /** 受影响的会话 */
  sessionId: string;
  /**
   * 事件类型：
   *   - 'upsert'：新增/写入一条消息（默认）
   *   - 'deleted'：会话被删除或清空（飞书 /clear、Web 删除会话）
   */
  type?: 'upsert' | 'deleted';
  /** 触发写入的消息角色（type=deleted 时无意义） */
  role: string;
  /** 事件来源，便于前端按需处理与排障 */
  source: 'web' | 'feishu';
  /** 事件时间戳（毫秒） */
  at: number;
}

const emitter = new EventEmitter();
// 单进程内订阅者可能较多（每个打开页面的用户一个连接），放宽上限避免 warning
emitter.setMaxListeners(0);

const CHANNEL = 'chat-history';

/**
 * 发布一条 chat_history 写入事件。
 * 失败只 warn，绝不影响主链路（落库已经成功）。
 */
export function publishChatHistoryEvent(event: ChatHistoryEvent): void {
  try {
    emitter.emit(CHANNEL, { type: 'upsert', ...event });
  } catch (e: any) {
    logger.warn('发布聊天事件失败（忽略）', {
      module: 'ChatEventBus',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

/**
 * 发布会话删除/清空事件，让正在查看该会话的 Web 端实时感知（不必等轮询兜底）。
 * source 用于排障：'feishu' 表示飞书 /clear，'web' 表示 Web 端删除。
 */
export function publishSessionDeletedEvent(args: {
  ownerUserId: string;
  sessionId: string;
  source: 'web' | 'feishu';
}): void {
  publishChatHistoryEvent({
    ownerUserId: args.ownerUserId,
    sessionId: args.sessionId,
    type: 'deleted',
    role: 'system',
    source: args.source,
    at: Date.now(),
  });
}

/**
 * 订阅指定用户的 chat_history 事件。
 * 返回取消订阅函数，SSE 连接关闭时必须调用，避免监听器泄漏。
 */
export function subscribeChatHistoryEvents(
  ownerUserId: string,
  listener: (event: ChatHistoryEvent) => void,
): () => void {
  const handler = (event: ChatHistoryEvent) => {
    if (event.ownerUserId !== ownerUserId) return;
    listener(event);
  };
  emitter.on(CHANNEL, handler);
  return () => {
    emitter.off(CHANNEL, handler);
  };
}

/** 仅测试用：移除所有监听器 */
export function __resetChatEventBusForTest(): void {
  emitter.removeAllListeners(CHANNEL);
}
