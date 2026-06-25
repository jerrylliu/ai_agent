/**
 * processIncomingMessage 单测（D1/D2 入口）
 *
 * 覆盖：
 *   - 非文本消息 / 空文本 / 群里没 @ AI → 忽略
 *   - promptInvoker 未注入 → 走兜底错误消息
 *   - 锁竞争 → 提示用户稍后
 *   - 正常流：发占位 → 调 promptInvoker → flush → 释放锁
 *   - promptInvoker 抛错 → 兜底改写占位消息
 */

// 所有 mock 必须在 import 顶层文件之前

const mockAcquireLock = jest.fn();
const mockSendPlainTextMessage = jest.fn();
const mockSendCardMessage = jest.fn();
const mockUpdateCard = jest.fn();
const mockUploadImage = jest.fn();
const mockSendImageMessage = jest.fn();
const mockGetOrCreateChatSession = jest.fn();
const mockClearChatSession = jest.fn();
const redisMockState = { ready: false };

jest.mock('./distributed-lock', () => ({
  acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
}));

jest.mock('./redis-client', () => ({
  getRedis: () => null,
  isRedisReady: () => redisMockState.ready,
}));

jest.mock('./config', () => ({
  config: {
    notify: {
      feishuBotOpenId: 'ou_bot_official', // 测试用：群聊精确 @ 匹配
      feishuChatUserId: 'default',
    },
  },
}));

jest.mock('./feishu-notify.service', () => ({
  sendPlainTextMessage: (...args: unknown[]) => mockSendPlainTextMessage(...args),
  sendCardMessage: (...args: unknown[]) => mockSendCardMessage(...args),
  updateCard: (...args: unknown[]) => mockUpdateCard(...args),
  uploadImage: (...args: unknown[]) => mockUploadImage(...args),
  sendImageMessage: (...args: unknown[]) => mockSendImageMessage(...args),
  buildCardJson: (params: { title: string; content: string; headerColor?: string }) => ({
    header: { title: { tag: 'plain_text', content: params.title }, template: params.headerColor ?? 'blue' },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: params.content } }],
  }),
}));

jest.mock('./feishu/feishu-chat-session', () => ({
  buildSessionKey: (params: { chatType: string; chatId: string; senderOpenId: string; ownerUserId?: string }) => {
    const ownerPrefix = params.ownerUserId ? `owner:${params.ownerUserId}:` : '';
    return params.chatType === 'p2p'
      ? `${ownerPrefix}p2p:${params.senderOpenId}`
      : `${ownerPrefix}group:${params.chatId}:${params.senderOpenId}`;
  },
  getOrCreateChatSession: (...args: unknown[]) => mockGetOrCreateChatSession(...args),
  clearChatSession: (...args: unknown[]) => mockClearChatSession(...args),
}));

jest.mock('./human-in-the-loop', () => ({
  handleConfirmationResponse: jest.fn(),
  getFeishuMessageIdForConfirmation: jest.fn(),
  updateFeishuHITLCard: jest.fn(),
  buildHITLResolvedCard: jest.fn(() => ({})),
}));

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  processIncomingMessage,
  setFeishuPromptInvoker,
  setFeishuSessionCleaner,
  __resetFeishuEventDedupForTest,
} from './feishu-event-processor';

const noopLogger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function buildEvent(overrides: { message?: Record<string, any>; sender?: Record<string, any> } = {}): any {
  return {
    sender: {
      sender_id: { open_id: 'ou_alice' },
      ...overrides.sender,
    },
    message: {
      message_id: 'om_msg_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我查个天气' }),
      mentions: [],
      ...overrides.message,
    },
  };
}

describe('processIncomingMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetFeishuEventDedupForTest();
    // 默认：锁成功
    mockAcquireLock.mockResolvedValue({
      release: jest.fn().mockResolvedValue(true),
    });
    mockGetOrCreateChatSession.mockResolvedValue('session-uuid-1');
    mockClearChatSession.mockResolvedValue(undefined);
    mockUploadImage.mockResolvedValue({ success: true, key: 'img_key_1' });
    mockSendImageMessage.mockResolvedValue({ success: true, messageId: 'om_img_1' });
    mockSendCardMessage.mockResolvedValue({
      success: true,
      messageId: 'om_placeholder',
    });
    mockUpdateCard.mockResolvedValue({ success: true });
    setFeishuPromptInvoker(null);
    setFeishuSessionCleaner(null);
  });

  afterAll(() => {
    setFeishuPromptInvoker(null);
    setFeishuSessionCleaner(null);
  });

  it('非文本消息直接忽略', async () => {
    setFeishuPromptInvoker(jest.fn());
    await processIncomingMessage(
      buildEvent({ message: { message_type: 'image' } }),
      noopLogger,
    );
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSendPlainTextMessage).not.toHaveBeenCalled();
  });

  it('空文本忽略', async () => {
    setFeishuPromptInvoker(jest.fn());
    await processIncomingMessage(
      buildEvent({ message: { content: JSON.stringify({ text: '   ' }) } }),
      noopLogger,
    );
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it('群聊但未 @ 机器人 → 忽略', async () => {
    setFeishuPromptInvoker(jest.fn());
    await processIncomingMessage(
      buildEvent({
        message: {
          chat_type: 'group',
          mentions: [],
          content: JSON.stringify({ text: '路人甲对话' }),
        },
      }),
      noopLogger,
    );
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it('群聊 @ 机器人 → 进入主流程，且 @ 占位符被剥离', async () => {
    const invoker = jest.fn().mockResolvedValue(undefined);
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(
      buildEvent({
        message: {
          chat_type: 'group',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_official' }, name: '小助手' }],
          content: JSON.stringify({ text: '@_user_1 帮我查天气' }),
        },
      }),
      noopLogger,
    );

    expect(invoker).toHaveBeenCalled();
    expect(invoker.mock.calls[0][0].message).toBe('帮我查天气');
  });

  it('群聊只 @ 了别人（不是 bot）→ 忽略', async () => {
    const invoker = jest.fn().mockResolvedValue(undefined);
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(
      buildEvent({
        message: {
          chat_type: 'group',
          // 只 @ 张三，没 @ bot
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_zhangsan' }, name: '张三' }],
          content: JSON.stringify({ text: '@_user_1 帮我看下' }),
        },
      }),
      noopLogger,
    );
    expect(invoker).not.toHaveBeenCalled();
  });

  it('兼容飞书 SDK 的 { header, event } 包裹结构', async () => {
    const invoker = jest.fn(async ({ res }) => {
      res.write('event: content\ndata: "包裹结构正常"\n\n');
    });
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(
      {
        header: { event_id: 'evt_wrapped_1' },
        event: buildEvent(),
      },
      noopLogger,
    );

    expect(mockAcquireLock).toHaveBeenCalledTimes(1);
    expect(invoker).toHaveBeenCalledWith(
      expect.objectContaining({ message: '帮我查个天气' }),
    );
    expect(mockUpdateCard).toHaveBeenCalledWith(
      'om_placeholder',
      expect.objectContaining({ elements: expect.any(Array) }),
    );
  });

  it('event_id 重复 → 第二次直接忽略（幂等）', async () => {
    const invoker = jest.fn().mockResolvedValue(undefined);
    setFeishuPromptInvoker(invoker);

    const event = buildEvent();
    (event as any).event_id = 'evt_dup_1';

    await processIncomingMessage(event, noopLogger);
    await processIncomingMessage(event, noopLogger);

    // 仅第一次进入主流程
    expect(mockAcquireLock).toHaveBeenCalledTimes(1);
    expect(invoker).toHaveBeenCalledTimes(1);
  });

  it('promptInvoker 未注入 → 发兜底错误，不进入主流程', async () => {
    await processIncomingMessage(buildEvent(), noopLogger);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSendPlainTextMessage).toHaveBeenCalledWith(
      'oc_chat_1',
      'chat_id',
      expect.stringContaining('暂时不可用'),
    );
  });

  it('锁被占 → 发"上一条还在处理中"，不调 invoker', async () => {
    setFeishuPromptInvoker(jest.fn());
    mockAcquireLock.mockResolvedValueOnce(null);

    await processIncomingMessage(buildEvent(), noopLogger);

    expect(mockSendPlainTextMessage).toHaveBeenCalledWith(
      'oc_chat_1',
      'chat_id',
      expect.stringContaining('上一条还在处理中'),
    );
  });

  it('飞书清空指令应删除平台会话和飞书映射，不进入 Agent', async () => {
    const invoker = jest.fn();
    const cleaner = jest.fn().mockResolvedValue(undefined);
    setFeishuPromptInvoker(invoker);
    setFeishuSessionCleaner(cleaner);

    await processIncomingMessage(
      buildEvent({ message: { content: JSON.stringify({ text: '/clear' }) } }),
      noopLogger,
    );

    expect(cleaner).toHaveBeenCalledWith({ sessionId: 'session-uuid-1', userId: 'default' });
    expect(mockClearChatSession).toHaveBeenCalledWith('owner:default:p2p:ou_alice');
    expect(mockSendPlainTextMessage).toHaveBeenCalledWith(
      'oc_chat_1',
      'chat_id',
      expect.stringContaining('已清空聊天记录'),
    );
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(invoker).not.toHaveBeenCalled();
  });

  it('群聊清空指令只清当前群和当前发送人的映射', async () => {
    const invoker = jest.fn();
    const cleaner = jest.fn().mockResolvedValue(undefined);
    setFeishuPromptInvoker(invoker);
    setFeishuSessionCleaner(cleaner);

    await processIncomingMessage(
      buildEvent({
        sender: { sender_id: { open_id: 'ou_group_alice' } },
        message: {
          chat_type: 'group',
          chat_id: 'oc_group_1',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_official' }, name: '小助手' }],
          content: JSON.stringify({ text: '@_user_1 /clear' }),
        },
      }),
      noopLogger,
    );

    expect(cleaner).toHaveBeenCalledWith({ sessionId: 'session-uuid-1', userId: 'default' });
    expect(mockClearChatSession).toHaveBeenCalledWith('owner:default:group:oc_group_1:ou_group_alice');
    expect(mockSendPlainTextMessage).toHaveBeenCalledWith(
      'oc_group_1',
      'chat_id',
      expect.stringContaining('已清空聊天记录'),
    );
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(invoker).not.toHaveBeenCalled();
  });

  it('正常流：发占位 → 调 invoker → 释放锁', async () => {
    const releaseLock = jest.fn().mockResolvedValue(true);
    mockAcquireLock.mockResolvedValueOnce({ release: releaseLock });

    const invoker = jest.fn(async ({ res }) => {
      // 模拟 Agent 写出 content 帧（res 是 fakeRes，会触发 editor.appendDelta）
      res.write('event: content\ndata: "你好，今天天气晴"\n\n');
    });
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(buildEvent(), noopLogger);

    expect(mockSendCardMessage).toHaveBeenCalledWith(
      'oc_chat_1',
      'chat_id',
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: 'AI 回复中...' }),
        }),
      }),
    );
    expect(invoker).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '帮我查个天气',
        sessionId: 'session-uuid-1',
        userId: 'feishu:ou_alice',
      }),
    );
    // finalize 会强制 flush 一次 → updateCard('om_placeholder', card)
    expect(mockUpdateCard).toHaveBeenCalledWith(
      'om_placeholder',
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({ content: '你好，今天天气晴' }),
          }),
        ]),
      }),
    );
    // finalize 后还会再 PATCH 一次 done=true，避免飞书卡片停留在"AI 回复中..."
    const lastUpdateCardCall = mockUpdateCard.mock.calls[mockUpdateCard.mock.calls.length - 1];
    expect(lastUpdateCardCall[0]).toBe('om_placeholder');
    expect(lastUpdateCardCall[1]).toEqual(
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: 'AI 回复' }),
          template: 'green',
        }),
      }),
    );
    expect(releaseLock).toHaveBeenCalled();
  });

  it('回复含 Markdown 图片 → 卡片剥离图片链接，并发原生 image 消息', async () => {
    const invoker = jest.fn(async ({ res }) => {
      res.write('event: content\ndata: "骑士图片已生成好了！\\n\\n![骑士](https://example.com/knight.png)"\n\n');
    });
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(buildEvent(), noopLogger);

    // 卡片最终内容不应再包含图片 Markdown 链接
    const lastUpdateCardCall = mockUpdateCard.mock.calls[mockUpdateCard.mock.calls.length - 1];
    const cardContent = lastUpdateCardCall[1].elements[0].text.content as string;
    expect(cardContent).not.toContain('https://example.com/knight.png');
    expect(cardContent).toContain('骑士图片已生成好了');

    // 图片应通过原生 image 消息发送
    expect(mockUploadImage).toHaveBeenCalledWith('https://example.com/knight.png');
    expect(mockSendImageMessage).toHaveBeenCalledWith('oc_chat_1', 'chat_id', 'img_key_1', expect.any(String));
  });

  it('回复含被反引号包裹的图片链接 → 也能正确提取并发原生图片', async () => {
    const invoker = jest.fn(async ({ res }) => {
      res.write('event: content\ndata: "![生成的图片](`https://example.com/star.png`)"\n\n');
    });
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(buildEvent(), noopLogger);

    expect(mockUploadImage).toHaveBeenCalledWith('https://example.com/star.png');
    expect(mockSendImageMessage).toHaveBeenCalledWith('oc_chat_1', 'chat_id', 'img_key_1', expect.any(String));
  });

  it('Agent 没输出任何内容 → 占位消息改成"没有生成内容"', async () => {
    const invoker = jest.fn().mockResolvedValue(undefined);
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(buildEvent(), noopLogger);

    expect(mockUpdateCard).toHaveBeenCalledWith(
      'om_placeholder',
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({ content: expect.stringContaining('没有生成内容') }),
          }),
        ]),
      }),
    );
  });

  it('promptInvoker 抛错 → 占位消息改成失败提示，仍释放锁', async () => {
    const releaseLock = jest.fn().mockResolvedValue(true);
    mockAcquireLock.mockResolvedValueOnce({ release: releaseLock });

    const invoker = jest.fn().mockRejectedValue(new Error('LLM 挂了'));
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(buildEvent(), noopLogger);

    expect(mockUpdateCard).toHaveBeenCalledWith(
      'om_placeholder',
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({ content: expect.stringContaining('LLM 挂了') }),
          }),
        ]),
      }),
    );
    expect(releaseLock).toHaveBeenCalled();
  });

  it('占位卡片发送失败 → 流式累积，最终一次性以新文本消息发出', async () => {
    mockSendCardMessage
      .mockResolvedValueOnce({ success: false, error: 'rate limited' }); // 占位卡片发送失败
    mockSendPlainTextMessage.mockResolvedValueOnce({ success: true }); // 兜底新文本消息成功

    const invoker = jest.fn(async ({ res }) => {
      res.write('event: content\ndata: "降级后的内容"\n\n');
    });
    setFeishuPromptInvoker(invoker);

    await processIncomingMessage(buildEvent(), noopLogger);

    expect(mockSendPlainTextMessage).toHaveBeenCalledTimes(1);
    expect(mockSendPlainTextMessage).toHaveBeenLastCalledWith(
      'oc_chat_1',
      'chat_id',
      '降级后的内容',
    );
    // 没有 placeholderMessageId，所以不应调 updateCard
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });
});
