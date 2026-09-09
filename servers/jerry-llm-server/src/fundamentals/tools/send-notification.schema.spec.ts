/**
 * fundamentals/tools/send-notification.schema.spec.ts
 *
 * send_notification 工具的 zod schema → OpenAI Function Schema 转换测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    notify: {
      feishuAppId: '',
      feishuAppSecret: '',
      smtpHost: '',
      smtpUser: '',
      smtpPass: '',
    },
  },
}));

// 阻断 multimodal-output / generate-document 依赖（schema 测试不需要）
jest.mock('./multimodal-output', () => ({
  isChartImageUrl: jest.fn(),
  parseChartImageUrl: jest.fn(),
  chartPngDataUri: jest.fn(),
  isMindmapImageUrl: jest.fn(),
  parseMindmapImageUrl: jest.fn(),
  mindmapPngDataUri: jest.fn(),
}));

jest.mock('./generate-document', () => ({
  isDocumentUrl: jest.fn(),
  getCachedDocument: jest.fn(),
}));

import {
  sendNotificationSchema,
  sendNotificationParamsSchema,
} from './send-notification';

describe('sendNotificationSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(sendNotificationSchema.type).toBe('function');
    expect(sendNotificationSchema.function.name).toBe('send_notification');
  });

  it('channel / title / content 必填，其它可选', () => {
    const params = sendNotificationSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['channel', 'content', 'title']);
    for (const k of ['recipients', 'webhookUrl', 'attachments']) {
      expect(params.required).not.toContain(k);
    }
  });

  it('channel 应为 enum [feishu, email, webhook]', () => {
    const params = sendNotificationSchema.function.parameters as any;
    expect(params.properties.channel.enum).toEqual(['feishu', 'email', 'webhook']);
  });

  it('attachments 应为 array<object>，items.filename 必填', () => {
    const params = sendNotificationSchema.function.parameters as any;
    const att = params.properties.attachments;
    expect(att.type).toBe('array');
    expect(att.items.type).toBe('object');
    expect(att.items.required).toEqual(['filename']);
  });

  it('recipients 应为 array<string>', () => {
    const params = sendNotificationSchema.function.parameters as any;
    expect(params.properties.recipients.type).toBe('array');
    expect(params.properties.recipients.items.type).toBe('string');
  });
});

describe('sendNotificationParamsSchema 校验', () => {
  it('合法 webhook 输入应通过', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'webhook',
      title: '完成通知',
      content: '任务完成',
      webhookUrl: 'https://example.com/hook',
    });
    expect(r.success).toBe(true);
  });

  it('合法 email + 附件应通过', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'email',
      title: 't',
      content: 'c',
      recipients: ['a@b.com'],
      attachments: [{ filename: 'report.pdf', url: 'https://x.com/a.pdf' }],
    });
    expect(r.success).toBe(true);
  });

  it('channel 越界应被拦截', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'sms',
      title: 't',
      content: 'c',
    });
    expect(r.success).toBe(false);
  });

  it('空 title 应被拦截', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'email',
      title: '',
      content: 'c',
    });
    expect(r.success).toBe(false);
  });

  it('attachments 缺 filename 应被拦截', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'email',
      title: 't',
      content: 'c',
      attachments: [{ url: 'https://x.com/a.pdf' } as any],
    });
    expect(r.success).toBe(false);
  });
});

// ==================== 字符串形态容错（生产事故回归） ====================
// 背景：模型把 recipients/attachments 传成单个字符串导致校验失败、邮件静默丢失。
// schema 层 preprocess 应自动归一化，保证送达。
describe('sendNotificationParamsSchema 字符串形态容错', () => {
  it('recipients 传单个字符串应归一化为数组', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'email',
      title: 't',
      content: 'c',
      recipients: 'user@qq.com',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.recipients).toEqual(['user@qq.com']);
  });

  it('attachments 传单个 URL 字符串应归一化为对象数组并推断 filename', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'email',
      title: 't',
      content: 'c',
      attachments: 'https://x.com/files/chart.png',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.attachments).toEqual([
        { filename: 'chart.png', url: 'https://x.com/files/chart.png' },
      ]);
    }
  });

  it('attachments 传无扩展名 URL 应使用通用文件名', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'feishu',
      title: 't',
      content: 'c',
      attachments: 'fc://chart/abc123',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.attachments).toEqual([{ filename: 'attachment', url: 'fc://chart/abc123' }]);
    }
  });

  it('数组形态入参不受容错影响（原有行为不变）', () => {
    const r = sendNotificationParamsSchema.safeParse({
      channel: 'email',
      title: 't',
      content: 'c',
      recipients: ['a@b.com', 'c@d.com'],
      attachments: [{ filename: 'a.pdf', url: 'https://x.com/a.pdf' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.recipients).toEqual(['a@b.com', 'c@d.com']);
      expect(r.data.attachments).toEqual([{ filename: 'a.pdf', url: 'https://x.com/a.pdf' }]);
    }
  });
});
