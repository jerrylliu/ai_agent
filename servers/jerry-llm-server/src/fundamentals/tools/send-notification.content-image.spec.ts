/**
 * fundamentals/tools/send-notification.content-image.spec.ts
 *
 * 验证"正文 Markdown 图片自动转附件"能力：
 * 知识库检索结果中的图片以 `![图片 N](http://.../images/...)` 形式出现在 AI 回复中，
 * 模型调用 send_notification 时通常只把整段文本复制进 content，不主动填 attachments，
 * 导致图片在邮件/飞书中丢失。服务端应在发送前自动提取正文图片 URL 转为附件。
 *
 * 覆盖场景：
 *   1. email 通道：content 中的图片自动成为内嵌附件，HTML 正文替换为占位文字
 *   2. 去重：同一 URL 出现多次只提取一次；已在 attachments 中的 URL 不重复提取
 *   3. feishu 通道：卡片正文替换为占位文字，图片上传后作为图片消息发出
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    notify: {
      feishuAppId: 'test-app',
      feishuAppSecret: 'test-secret',
      feishuDomain: 'https://open.feishu.cn',
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpUser: 'u@x.com',
      smtpPass: 'pwd',
      smtpFrom: 'u@x.com',
    },
  },
}));

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

jest.mock('./multimodal-output', () => ({
  isChartImageUrl: jest.fn().mockReturnValue(false),
  parseChartImageUrl: jest.fn(),
  chartPngDataUri: jest.fn(),
  isMindmapImageUrl: jest.fn().mockReturnValue(false),
  parseMindmapImageUrl: jest.fn(),
  mindmapPngDataUri: jest.fn(),
}));

jest.mock('./generate-document', () => ({
  isDocumentUrl: jest.fn().mockReturnValue(false),
  getCachedDocument: jest.fn(),
}));

jest.mock('../feishu-notify.service', () => ({
  uploadImage: jest.fn(),
  uploadFile: jest.fn(),
  sendCardMessage: jest.fn(),
  sendImageMessage: jest.fn(),
  sendFileMessage: jest.fn(),
  detectReceiveIdType: jest.fn(),
  resolveOpenIdByEmail: jest.fn(),
  buildCardJson: jest.fn(),
}));

import nodemailer from 'nodemailer';
import {
  executeSendNotification,
  validateSendNotificationConfig,
} from './send-notification';
import {
  uploadImage as feishuUploadImage,
  sendCardMessage,
  sendImageMessage,
  detectReceiveIdType,
  buildCardJson,
} from '../feishu-notify.service';

const mockCreateTransport = nodemailer.createTransport as jest.Mock;
const mockSendMail = jest.fn();
const mockUploadImage = feishuUploadImage as jest.Mock;
const mockSendCardMessage = sendCardMessage as jest.Mock;
const mockSendImageMessage = sendImageMessage as jest.Mock;
const mockDetectReceiveIdType = detectReceiveIdType as jest.Mock;
const mockBuildCardJson = buildCardJson as jest.Mock;

/** 模拟图片下载：返回 3 字节假 PNG 数据 */
const FAKE_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e]);

const originalFetch = global.fetch;

beforeAll(() => {
  // 触发模块级 feishuAvailable / emailAvailable 标志初始化
  validateSendNotificationConfig();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockResolvedValue({ messageId: 'msg-1' });
  mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

  // 所有 http(s) 附件下载统一返回假图片
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => FAKE_IMAGE_BYTES.buffer,
    headers: { get: () => 'image/png' },
  }) as unknown as typeof fetch;

  // 飞书链路 mock
  mockDetectReceiveIdType.mockReturnValue('chat_id');
  mockSendCardMessage.mockResolvedValue({ success: true, messageId: 'card-1' });
  mockUploadImage.mockResolvedValue({ success: true, key: 'img_key_1' });
  mockSendImageMessage.mockResolvedValue({ success: true, messageId: 'img-msg-1' });
  mockBuildCardJson.mockImplementation((params: unknown) => ({ __card: true, params }));
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('email 通道：正文图片自动转附件', () => {
  it('应从 content 提取 Markdown 图片作为内嵌附件发送，正文替换为占位文字', async () => {
    const result = await executeSendNotification({
      channel: 'email',
      title: '液氮资料',
      content:
        '知识库中找到以下信息：\n![图片 1](http://localhost:3000/images/68/img_0.png)\n以上是液氮杜瓦冷罐的介绍。',
      recipients: ['user@example.com'],
    });
    expect(result.success).toBe(true);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0][0];
    // 自动提取的图片成为内嵌附件，文件名取自 URL 最后一段
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe('img_0.png');
    expect(mail.attachments[0].contentDisposition).toBe('inline');
    expect(mail.attachments[0].cid).toBeDefined();
    // HTML 正文：Markdown 图片语法被替换为占位文字，图片通过 cid 内嵌展示
    expect(mail.html).toContain('[图片 1：见下方附件]');
    expect(mail.html).not.toContain('![');
    expect(mail.html).toContain(`cid:${mail.attachments[0].cid}`);
  });

  it('同一 URL 出现多次只提取一次；已在 attachments 中的 URL 不重复提取', async () => {
    const result = await executeSendNotification({
      channel: 'email',
      title: 't',
      content:
        '![图片 1](http://x.com/a.png)\n重复一次 ![图片 2](http://x.com/a.png)\n![图片 3](http://x.com/b.png)',
      recipients: ['user@example.com'],
      attachments: [{ filename: 'b-manual.png', url: 'http://x.com/b.png' }],
    });
    expect(result.success).toBe(true);

    const mail = mockSendMail.mock.calls[0][0];
    // b.png（手动传入，正文重复出现但未重复提取） + a.png（自动提取一次）
    expect(mail.attachments).toHaveLength(2);
    const filenames = mail.attachments.map((a: { filename: string }) => a.filename).sort();
    expect(filenames).toEqual(['a.png', 'b-manual.png']);
  });
});

describe('feishu 通道：正文图片自动转附件', () => {
  it('卡片正文替换图片语法为占位文字，图片上传后作为图片消息发出', async () => {
    const result = await executeSendNotification({
      channel: 'feishu',
      title: '液氮资料',
      content: '检索结果如下：\n![图片 1](http://localhost:3000/images/68/img_0.png)',
      recipients: ['oc_chat123'],
    });
    expect(result.success).toBe(true);

    // 卡片正文不含 Markdown 图片语法
    expect(mockBuildCardJson).toHaveBeenCalledTimes(1);
    const cardArg = mockBuildCardJson.mock.calls[0][0] as { content: string };
    expect(cardArg.content).toContain('[图片 1：见下方附件]');
    expect(cardArg.content).not.toContain('![');

    // 图片已上传素材库并作为独立图片消息发出
    expect(mockUploadImage).toHaveBeenCalledTimes(1);
    expect(mockSendImageMessage).toHaveBeenCalledTimes(1);
  });
});
