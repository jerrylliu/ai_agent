/**
 * fundamentals/tools/send-notification.suggestion.spec.ts
 *
 * 验证 P3-1 结构化错误反馈（suggestion 字段）
 *
 * 失败场景下 send_notification 应返回 suggestion 字段，引导 LLM 自动改参重试：
 *   1. webhook 通道缺少 webhookUrl → suggestion 引导切到 feishu
 *   2. feishu 通道 recipients 为空 → suggestion 提示提供 recipients
 *   3. email 通道 recipients 都不是邮箱 → suggestion 引导切到对应通道
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 让 feishu 通道"已配置"，进入 recipients 校验逻辑
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

jest.mock('../feishu-notify.service', () => ({
  uploadImage: jest.fn(),
  uploadFile: jest.fn(),
  sendCardMessage: jest.fn(),
  sendImageMessage: jest.fn(),
  sendFileMessage: jest.fn(),
  detectReceiveIdType: jest.fn(),
  resolveOpenIdByEmail: jest.fn(),
}));

import { executeSendNotification, validateSendNotificationConfig } from './send-notification';

describe('send_notification 结构化错误反馈（suggestion）', () => {
  beforeAll(() => {
    // 触发模块级 feishuAvailable / emailAvailable 标志初始化
    validateSendNotificationConfig();
  });
  describe('webhook 通道', () => {
    it('缺少 webhookUrl 时应返回 suggestion=switch_channel→feishu', async () => {
      const result = await executeSendNotification({
        channel: 'webhook',
        title: '测试',
        content: '内容',
      });
      expect(result.success).toBe(false);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion?.action).toBe('switch_channel');
      expect(result.suggestion?.to).toBe('feishu');
      expect(result.suggestion?.hint).toContain('feishu');
      expect(result.suggestion?.hint).toContain('chat_id');
    });
  });

  describe('feishu 通道', () => {
    it('recipients 为空时应返回 suggestion=fix_recipient', async () => {
      const result = await executeSendNotification({
        channel: 'feishu',
        title: '测试',
        content: '内容',
        recipients: [],
      });
      expect(result.success).toBe(false);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion?.action).toBe('fix_recipient');
      expect(result.suggestion?.hint).toContain('open_id');
      expect(result.suggestion?.hint).toContain('chat_id');
    });
  });

  describe('email 通道', () => {
    it('recipients 都不是合法邮箱时应返回 suggestion=fix_recipient', async () => {
      const result = await executeSendNotification({
        channel: 'email',
        title: '测试',
        content: '内容',
        // 故意填飞书 ID 模拟 LLM 选错通道
        recipients: ['ou_abc123', 'oc_def456'],
      });
      expect(result.success).toBe(false);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion?.action).toBe('fix_recipient');
      expect(result.suggestion?.hint).toContain('feishu');
    });
  });
});
