/**
 * fundamentals/tools/send-notification.skipped-attachments.spec.ts
 *
 * 验证"附件失败不静默"（方案 C）：
 * 模型编造 fc://document URL（用标题拼凑）或文档已过期时，附件会被跳过。
 * 此前工具仍返回干净的 success:true，LLM 误以为附件已发出，用户收到空附件消息。
 * 现在跳过的附件以 skippedAttachments 回传，并附 suggestion 引导 LLM 重试/说明。
 *
 * 覆盖场景：
 *   1. email 通道：fc://document 解析失败 → success 仍为 true 但 skippedAttachments 有记录 + suggestion
 *   2. feishu 通道：同样的编造 URL → 跳过记录 + 卡片带附件警告 + suggestion
 *   3. 混合：一个可下载 + 一个编造 → 只跳过编造的那个
 *   4. feishu 素材上传失败 → 同样计入 skippedAttachments
 *   5. webhook 通道传附件 → 附件全部标记未发送（webhook 仅支持文本）
 *   6. 全部正常 → 无 skippedAttachments、无 suggestion（回归保护）
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
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
  isDocumentUrl: jest.fn().mockImplementation((url: string) =>
    url.startsWith('fc://document/'),
  ),
  getCachedDocument: jest.fn().mockResolvedValue(null),
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
import { executeSendNotification, validateSendNotificationConfig } from './send-notification';
import {
  uploadImage as feishuUploadImage,
  sendCardMessage,
  detectReceiveIdType,
  buildCardJson,
} from '../feishu-notify.service';

const mockCreateTransport = nodemailer.createTransport as jest.Mock;
const mockSendMail = jest.fn();
const mockUploadImage = feishuUploadImage as jest.Mock;
const mockSendCardMessage = sendCardMessage as jest.Mock;
const mockDetectReceiveIdType = detectReceiveIdType as jest.Mock;
const mockBuildCardJson = buildCardJson as jest.Mock;

const FAKE_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44]);
const originalFetch = global.fetch;

beforeAll(() => {
  // 触发模块级 feishuAvailable / emailAvailable 标志初始化
  validateSendNotificationConfig();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockResolvedValue({ messageId: 'msg-1' });
  mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });
  mockDetectReceiveIdType.mockReturnValue('chat_id');
  mockSendCardMessage.mockResolvedValue({ success: true, messageId: 'card-1' });
  mockBuildCardJson.mockImplementation((params: unknown) => ({
    __card: true,
    params,
  }));
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('send_notification 附件失败不静默（skippedAttachments）', () => {
  it('email：编造的 fc://document URL → 发送成功但 skippedAttachments 记录 + suggestion', async () => {
    const result = await executeSendNotification({
      channel: 'email',
      title: '2026年中秋月饼销量盘点',
      content: '报告见附件',
      recipients: ['user@example.com'],
      attachments: [
        { filename: '2026年中秋月饼销量盘点.pdf', url: 'fc://document/2026月饼销量盘点' },
      ],
    });

    // 主邮件正常发出（收件人合法、正文非空）
    expect(result.success).toBe(true);
    expect(result.delivered).toBe(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // 附件被显式回传，而不是静默丢弃
    expect(result.skippedAttachments).toHaveLength(1);
    expect(result.skippedAttachments?.[0].filename).toBe(
      '2026年中秋月饼销量盘点.pdf',
    );
    expect(result.skippedAttachments?.[0].url).toBe(
      'fc://document/2026月饼销量盘点',
    );
    expect(result.skippedAttachments?.[0].reason).toContain('获取失败');
    expect(result.suggestion).toBeDefined();
    expect(result.suggestion?.action).toBe('fix_params');
    expect(result.suggestion?.hint).toContain('重新生成');
  });

  it('feishu：编造的 fc://document URL → 跳过记录 + 卡片附件警告 + suggestion', async () => {
    const result = await executeSendNotification({
      channel: 'feishu',
      title: '2026年中秋月饼销量盘点',
      content: '报告见附件',
      recipients: ['oc_chat123'],
      attachments: [
        { filename: '2026年中秋月饼销量盘点.pdf', url: 'fc://document/2026月饼销量盘点' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toBe(1);
    expect(result.skippedAttachments).toHaveLength(1);
    expect(result.skippedAttachments?.[0].reason).toContain('获取失败');
    expect(result.suggestion).toBeDefined();

    // 卡片上仍有用户可见的附件警告字段
    expect(mockBuildCardJson).toHaveBeenCalledTimes(1);
    const cardArg = mockBuildCardJson.mock.calls[0][0] as {
      fields: Array<{ label: string; value: string }>;
    };
    const warnField = cardArg.fields?.find((f) => f.label === '⚠️ 附件警告');
    expect(warnField).toBeDefined();
    expect(warnField?.value).toContain('2026年中秋月饼销量盘点.pdf');
  });

  it('email：混合附件 → 只跳过解析失败的，可下载的正常附上', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => FAKE_PDF_BYTES.buffer,
      headers: { get: () => 'application/pdf' },
    }) as unknown as typeof fetch;

    const result = await executeSendNotification({
      channel: 'email',
      title: 't',
      content: 'c',
      recipients: ['user@example.com'],
      attachments: [
        { filename: 'good.pdf', url: 'http://x.com/good.pdf' },
        { filename: 'fake.pdf', url: 'fc://document/fake-key' },
      ],
    });

    expect(result.success).toBe(true);
    // good.pdf 正常附上
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe('good.pdf');
    // fake.pdf 单独被跳过
    expect(result.skippedAttachments).toHaveLength(1);
    expect(result.skippedAttachments?.[0].filename).toBe('fake.pdf');
  });

  it('feishu：素材上传失败 → 计入 skippedAttachments', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => FAKE_PDF_BYTES.buffer,
      headers: { get: () => 'application/pdf' },
    }) as unknown as typeof fetch;

    const { uploadFile } = jest.requireMock('../feishu-notify.service') as {
      uploadFile: jest.Mock;
    };
    uploadFile.mockResolvedValue({ success: false, error: 'quota exceeded' });

    const result = await executeSendNotification({
      channel: 'feishu',
      title: 't',
      content: 'c',
      recipients: ['oc_chat123'],
      attachments: [{ filename: 'doc.pdf', url: 'http://x.com/doc.pdf' }],
    });

    expect(result.success).toBe(true);
    expect(result.skippedAttachments).toHaveLength(1);
    expect(result.skippedAttachments?.[0].filename).toBe('doc.pdf');
    expect(result.skippedAttachments?.[0].reason).toContain('上传失败');
    expect(result.suggestion).toBeDefined();
  });

  it('webhook：传附件时全部标记未发送并建议换通道', async () => {
    const result = await executeSendNotification({
      channel: 'webhook',
      title: 't',
      content: 'c',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x',
      attachments: [
        { filename: 'a.pdf', url: 'fc://document/a' },
        { filename: 'b.png', url: 'http://x.com/b.png' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.skippedAttachments).toHaveLength(2);
    expect(result.skippedAttachments?.every((s) =>
      s.reason.includes('仅支持文本'),
    )).toBe(true);
    expect(result.suggestion?.hint).toContain('feishu');
  });

  it('email：全部附件正常 → 无 skippedAttachments 无 suggestion（回归保护）', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => FAKE_PDF_BYTES.buffer,
      headers: { get: () => 'application/pdf' },
    }) as unknown as typeof fetch;

    const result = await executeSendNotification({
      channel: 'email',
      title: 't',
      content: 'c',
      recipients: ['user@example.com'],
      attachments: [{ filename: 'ok.pdf', url: 'http://x.com/ok.pdf' }],
    });

    expect(result.success).toBe(true);
    expect(result.skippedAttachments).toBeUndefined();
    expect(result.suggestion).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});
