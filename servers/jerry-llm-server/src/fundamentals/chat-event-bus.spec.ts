// 在任何 import 之前注入测试用环境变量，避免 fundamentals/config.ts 启动校验失败
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

import {
  publishChatHistoryEvent,
  publishDocumentChangedEvent,
  publishKnowledgeSourceChangedEvent,
  publishSettingsChangedEvent,
  subscribeChatHistoryEvents,
  __resetChatEventBusForTest,
  type ChatHistoryEvent,
} from './chat-event-bus';

describe('chat-event-bus', () => {
  beforeEach(() => {
    __resetChatEventBusForTest();
  });

  const baseEvent = (
    over: Partial<ChatHistoryEvent> = {},
  ): ChatHistoryEvent => ({
    ownerUserId: 'u1',
    sessionId: 's1',
    role: 'assistant',
    source: 'feishu',
    at: Date.now(),
    ...over,
  });

  it('只把事件投递给匹配 ownerUserId 的订阅者', () => {
    const u1 = jest.fn();
    const u2 = jest.fn();
    subscribeChatHistoryEvents('u1', u1);
    subscribeChatHistoryEvents('u2', u2);

    publishChatHistoryEvent(baseEvent({ ownerUserId: 'u1' }));

    expect(u1).toHaveBeenCalledTimes(1);
    expect(u2).not.toHaveBeenCalled();
  });

  it('取消订阅后不再收到事件', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeChatHistoryEvents('u1', listener);
    unsubscribe();

    publishChatHistoryEvent(baseEvent());

    expect(listener).not.toHaveBeenCalled();
  });

  it('同一用户多个订阅者都能收到', () => {
    const a = jest.fn();
    const b = jest.fn();
    subscribeChatHistoryEvents('u1', a);
    subscribeChatHistoryEvents('u1', b);

    publishChatHistoryEvent(baseEvent());

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('default 用户与登录用户隔离', () => {
    const def = jest.fn();
    subscribeChatHistoryEvents('default', def);

    publishChatHistoryEvent(baseEvent({ ownerUserId: '15' }));
    expect(def).not.toHaveBeenCalled();

    publishChatHistoryEvent(baseEvent({ ownerUserId: 'default' }));
    expect(def).toHaveBeenCalledTimes(1);
  });

  // ==================== document_changed（全局广播） ====================

  it('document_changed 广播给所有在线端（不按用户隔离，文档是全局数据）', () => {
    const u1 = jest.fn();
    const u2 = jest.fn();
    const def = jest.fn();
    subscribeChatHistoryEvents('u1', u1);
    subscribeChatHistoryEvents('u2', u2);
    subscribeChatHistoryEvents('default', def);

    publishDocumentChangedEvent({
      action: 'updated',
      documentId: 7,
      title: '某文档',
    });

    expect(u1).toHaveBeenCalledTimes(1);
    expect(u2).toHaveBeenCalledTimes(1);
    expect(def).toHaveBeenCalledTimes(1);
    expect(u1).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'document_changed',
        action: 'updated',
        documentId: 7,
        title: '某文档',
      }),
    );
  });

  it('document_changed 携带 at 时间戳与缺省 title', () => {
    const listener = jest.fn();
    subscribeChatHistoryEvents('u1', listener);

    publishDocumentChangedEvent({ action: 'deleted', documentId: 8 });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'document_changed',
        action: 'deleted',
        documentId: 8,
        at: expect.any(Number),
      }),
    );
  });

  it('某个订阅者抛错时被隔离，后续订阅者仍能收到事件', () => {
    const bad = jest.fn(() => {
      throw new Error('socket 已销毁');
    });
    const good = jest.fn();
    // bad 先注册：若不隔离，good 将收不到事件
    subscribeChatHistoryEvents('u1', bad);
    subscribeChatHistoryEvents('u2', good);

    expect(() =>
      publishDocumentChangedEvent({ action: 'updated', documentId: 9 }),
    ).not.toThrow();

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  // ==================== knowledge_source_changed（全局广播） ====================

  it('knowledge_source_changed 广播给所有在线端（不按用户隔离，知识源是全局数据）', () => {
    const u1 = jest.fn();
    const u2 = jest.fn();
    const def = jest.fn();
    subscribeChatHistoryEvents('u1', u1);
    subscribeChatHistoryEvents('u2', u2);
    subscribeChatHistoryEvents('default', def);

    publishKnowledgeSourceChangedEvent({
      action: 'syncing',
      sourceId: 3,
      name: '官网文档',
    });

    expect(u1).toHaveBeenCalledTimes(1);
    expect(u2).toHaveBeenCalledTimes(1);
    expect(def).toHaveBeenCalledTimes(1);
    expect(u1).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'knowledge_source_changed',
        action: 'syncing',
        sourceId: 3,
        name: '官网文档',
        at: expect.any(Number),
      }),
    );
  });

  // ==================== settings_changed（全局广播） ====================

  it('settings_changed 广播给所有在线端且携带 section 与时间戳', () => {
    const u1 = jest.fn();
    const def = jest.fn();
    subscribeChatHistoryEvents('u1', u1);
    subscribeChatHistoryEvents('default', def);

    publishSettingsChangedEvent({ section: 'model' });
    publishSettingsChangedEvent({ section: 'features' });

    expect(u1).toHaveBeenCalledTimes(2);
    expect(def).toHaveBeenCalledTimes(2);
    expect(u1).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: 'settings_changed', section: 'model' }),
    );
    expect(u1).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: 'settings_changed', section: 'features' }),
    );
  });

  it('普通聊天事件仍按 ownerUserId 隔离（不被全局广播放宽影响）', () => {
    const def = jest.fn();
    subscribeChatHistoryEvents('default', def);

    publishChatHistoryEvent(baseEvent({ ownerUserId: '15' }));
    expect(def).not.toHaveBeenCalled();
  });
});
