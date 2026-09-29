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
  /** 事件种类标记：chat_history 总线复用（HITL 广播用 'hitl'，缺省视为 chat_history） */
  kind?: 'chat_history';
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
 * HITL（人工确认）多端广播事件
 *
 * 为什么复用 chat 事件总线：确认请求原先只通过"触发它的那条聊天 SSE 流"推送，
 * 换设备（如手机端空闲、未在流式接收）时收不到任何提示，而飞书卡片是服务端
 * 主动推送所以能收到。把确认请求/解决结果广播到该用户的所有 /chat/events
 * 长连接后，桌面端与移动端都能弹窗，与飞书双通道对齐。
 */
export interface HITLBusEvent {
  kind: 'hitl';
  /** 数据归属用户 */
  ownerUserId: string;
  /** 事件时间戳（毫秒） */
  at: number;
  /** SSE data 帧内容（与流内 confirmation_request / confirmation_resolved 事件结构一致） */
  payload:
    | {
        type: 'confirmation_request';
        id: string;
        toolName: string;
        paramsSummary: string;
        riskLevel: 'low' | 'medium' | 'high';
        message: string;
      }
    | {
        type: 'confirmation_resolved';
        id: string;
        confirmed: boolean;
        source: 'web' | 'feishu' | 'timeout';
      };
}

/**
 * 文档域变更事件（document_changed）
 *
 * 为什么广播给所有用户：文档域当前没有按用户隔离（listDocuments 返回全部文档），
 * 与聊天"按 ownerUserId 分发"不同，文档变更属于全局数据变更，
 * 任何在线端的文档面板都应刷新。前端收到后防抖重拉列表。
 */
export interface DocumentChangedEvent {
  kind: 'document_changed';
  /** 动作类型：created=新建文档 / updated=新增版本或改元信息 / deleted=删除文档 */
  action: 'created' | 'updated' | 'deleted';
  /** 受影响的文档 ID */
  documentId: number;
  /** 文档标题（便于前端提示与排障，不必反查） */
  title?: string;
  /** 事件时间戳（毫秒） */
  at: number;
}

/**
 * 知识源变更事件（knowledge_source_changed）
 *
 * 广播给所有用户：与文档域一致，知识源是全局数据（无用户隔离），
 * 任何在线端的知识源管理面板都应刷新。前端收到后防抖重拉列表。
 */
export interface KnowledgeSourceChangedEvent {
  kind: 'knowledge_source_changed';
  /** 动作类型：created=新增源 / updated=修改源配置 / deleted=删除源 / syncing=开始同步 */
  action: 'created' | 'updated' | 'deleted' | 'syncing';
  /** 受影响的知识源 ID */
  sourceId: number;
  /** 知识源名称（便于前端提示与排障） */
  name?: string;
  /** 事件时间戳（毫秒） */
  at: number;
}

/**
 * 设置变更事件（settings_changed）
 *
 * 广播给所有用户：当前模型（currentModelId）与功能全局默认值是服务端全局状态，
 * 不分用户。前端收到后刷新模型显示/重新拉取全局功能默认值。
 */
export interface SettingsChangedEvent {
  kind: 'settings_changed';
  /** 变更区块：model=当前对话模型切换 / features=功能开关全局默认 */
  section: 'model' | 'features';
  /** 事件时间戳（毫秒） */
  at: number;
}

/** 总线上的事件联合类型：订阅方按 kind 分流 */
export type ChatBusEvent =
  | ChatHistoryEvent
  | HITLBusEvent
  | DocumentChangedEvent
  | KnowledgeSourceChangedEvent
  | SettingsChangedEvent;

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
 * 发布一条 HITL 确认广播事件（确认请求创建 / 被解决）。
 * 失败只 warn，绝不影响主链路（HITL 主流程是流内 SSE + 飞书卡片，广播只是多端同步增强）。
 */
export function publishHITLEvent(event: HITLBusEvent): void {
  try {
    emitter.emit(CHANNEL, event);
  } catch (e: any) {
    logger.warn('发布 HITL 广播事件失败（忽略）', {
      module: 'ChatEventBus',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

/**
 * 发布一条文档域变更事件（广播给所有在线端，见 DocumentChangedEvent 注释）。
 * 失败只 warn，绝不影响主链路（落库已经成功）。
 */
export function publishDocumentChangedEvent(event: {
  action: 'created' | 'updated' | 'deleted';
  documentId: number;
  title?: string;
}): void {
  try {
    emitter.emit(CHANNEL, {
      kind: 'document_changed',
      at: Date.now(),
      ...event,
    });
  } catch (e: any) {
    logger.warn('发布文档变更事件失败（忽略）', {
      module: 'ChatEventBus',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

/**
 * 发布一条知识源变更事件（广播给所有在线端，见 KnowledgeSourceChangedEvent 注释）。
 * 失败只 warn，绝不影响主链路（落库已经成功）。
 */
export function publishKnowledgeSourceChangedEvent(event: {
  action: 'created' | 'updated' | 'deleted' | 'syncing';
  sourceId: number;
  name?: string;
}): void {
  try {
    emitter.emit(CHANNEL, {
      kind: 'knowledge_source_changed',
      at: Date.now(),
      ...event,
    });
  } catch (e: any) {
    logger.warn('发布知识源变更事件失败（忽略）', {
      module: 'ChatEventBus',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

/**
 * 发布一条设置变更事件（广播给所有在线端，见 SettingsChangedEvent 注释）。
 * 失败只 warn，绝不影响主链路。
 */
export function publishSettingsChangedEvent(event: {
  section: 'model' | 'features';
}): void {
  try {
    emitter.emit(CHANNEL, {
      kind: 'settings_changed',
      at: Date.now(),
      ...event,
    });
  } catch (e: any) {
    logger.warn('发布设置变更事件失败（忽略）', {
      module: 'ChatEventBus',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

/**
 * 订阅指定用户的 chat_history / HITL 广播事件（按 kind 分流）。
 * 返回取消订阅函数，SSE 连接关闭时必须调用，避免监听器泄漏。
 */
export function subscribeChatHistoryEvents(
  ownerUserId: string,
  listener: (event: ChatBusEvent) => void,
): () => void {
  const handler = (event: ChatBusEvent) => {
    // 全局数据变更事件广播给所有连接；chat_history/HITL 按用户隔离
    if (
      event.kind !== 'document_changed' &&
      event.kind !== 'knowledge_source_changed' &&
      event.kind !== 'settings_changed' &&
      event.ownerUserId !== ownerUserId
    )
      return;
    // 按订阅者隔离异常：某个连接写入失败（如刚断开的 SSE socket）不能中断
    // EventEmitter 的遍历，否则排在其后的订阅者会丢事件（document_changed 全局广播时影响面最大）
    try {
      listener(event);
    } catch (e: any) {
      logger.warn('chat 事件订阅者处理失败（已隔离，不影响其他订阅者）', {
        module: 'ChatEventBus',
        ownerUserId,
        kind: event.kind,
        err: (e?.message || String(e)).slice(0, 200),
      });
    }
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
