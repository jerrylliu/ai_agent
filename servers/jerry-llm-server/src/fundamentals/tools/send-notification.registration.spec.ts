/**
 * fundamentals/tools/send-notification.registration.spec.ts
 *
 * 验证两阶段交付的登记模式：
 *   - 有 deliveryPlans 收集器（聊天链路）→ 只登记 DeliveryPlan，不真实发送
 *   - 单计划守卫：同轮第二次调用被拒绝并给结构化建议
 *   - 无收集器（工作流兼容路径）→ 保持旧行为立即发送
 *   - 幂等键生成：sessionId/iteration 参与，同轮登记键稳定
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

jest.mock('../metrics', () => ({
  metrics: { increment: jest.fn(), observe: jest.fn(), gauge: jest.fn() },
}));

// delivery-plan-store 依赖 redis-client：真实模块会在 import 期初始化连接，
// 必须整体 mock 掉（登记模式测试只关心 plans 数组，不关心 Redis 写入）
jest.mock('../redis-client', () => ({
  getRedis: () => null, // 降级为无 Redis，persistPendingPlan 静默跳过
}));

import type { ToolContext } from './index';
import type { DeliveryPlan } from '../delivery/delivery-plan';
import {
  executeSendNotification,
  validateSendNotificationConfig,
} from './send-notification';
import {
  uploadImage as feishuUploadImage,
  sendCardMessage,
} from '../feishu-notify.service';

const makeContext = (
  overrides: Partial<ToolContext> = {},
): ToolContext & { deliveryPlans: DeliveryPlan[] } => ({
  sessionId: 'sess-1',
  iteration: 3,
  source: 'fc-loop',
  deliveryPlans: [],
  ...overrides,
});

const validParams = {
  channel: 'email',
  title: '春季推送',
  content: '正文',
  recipients: ['user@qq.com'],
  attachments: [{ filename: 'spring.png', url: 'https://cdn/spring.png' }],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('executeSendNotification 登记模式', () => {
  it('有收集器 → 登记 DeliveryPlan，不真实发送（feishu 上传/发卡未被调用）', async () => {
    const ctx = makeContext();
    const result = await executeSendNotification(
      { ...validParams, channel: 'feishu', recipients: ['oc_group1'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.planRegistered).toBe(true);
    expect(result.delivered).toBe(0); // 未真实送达
    expect(ctx.deliveryPlans).toHaveLength(1);

    const plan = ctx.deliveryPlans[0];
    expect(plan.channel).toBe('feishu');
    expect(plan.title).toBe('春季推送');
    expect(plan.source).toBe('fc-loop');
    expect(plan.dedupeKey).toBe('delivery:sess-1:3:0');
    // fc:// 无关：http 附件原样进入计划，等 Executor 校验
    expect(plan.attachments?.[0].url).toBe('https://cdn/spring.png');
    // 真实发送通道未被触碰
    expect(feishuUploadImage).not.toHaveBeenCalled();
    expect(sendCardMessage).not.toHaveBeenCalled();
  });

  it('DSML 流式来源 → plan.source 标记为 dsml-stream，幂等键用 streamRound', async () => {
    const ctx = makeContext({ source: 'dsml-stream', iteration: 1 });
    await executeSendNotification(validParams, ctx);

    expect(ctx.deliveryPlans[0].source).toBe('dsml-stream');
    expect(ctx.deliveryPlans[0].dedupeKey).toBe('delivery:sess-1:1:0');
  });

  it('单计划守卫改为多计划上限：前 3 个正常登记（dedupeKey 序号递增），第 4 个被拒', async () => {
    const ctx = makeContext();
    for (let i = 0; i < 3; i++) {
      const r = await executeSendNotification(
        { ...validParams, title: `第${i + 1}封` },
        ctx,
      );
      expect(r.success).toBe(true);
      expect(ctx.deliveryPlans[i].dedupeKey).toBe(
        `delivery:sess-1:3:${i}`,
      );
    }
    // 第 4 次调用：达上限被拒
    const fourth = await executeSendNotification(validParams, ctx);
    expect(fourth.success).toBe(false);
    expect(fourth.errors?.[0]).toContain('已达上限');
    expect(ctx.deliveryPlans).toHaveLength(3);
  });

  it('正文 Markdown 图片仍会合并进计划的 attachments（图随文走）', async () => {
    const ctx = makeContext();
    await executeSendNotification(
      {
        ...validParams,
        attachments: undefined,
        content: '看图 ![春](https://cdn/a.png) 和 ![夏](https://cdn/a.png)',
      },
      ctx,
    );

    const atts = ctx.deliveryPlans[0].attachments ?? [];
    expect(atts).toHaveLength(1); // 同 URL 去重
    expect(atts[0].url).toBe('https://cdn/a.png');
  });

  it('参数校验失败 → 不登记（收集器保持为空）', async () => {
    const ctx = makeContext();
    const result = await executeSendNotification({ title: '' }, ctx);

    expect(result.success).toBe(false);
    expect(ctx.deliveryPlans).toHaveLength(0);
  });
});

describe('executeSendNotification 兼容路径（工作流无收集器）', () => {
  it('无收集器 → 保持旧行为真实发送（email 通道走 SMTP，nodemailer 被触碰）', async () => {
    // emailAvailable 标志由 validateSendNotificationConfig 依据 config mock 设置，
    // 不调用则通道不可用，sendEmail 提前返回错误而不会触碰 nodemailer
    validateSendNotificationConfig();
    const nodemailer = require('nodemailer');
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'm-1' });
    nodemailer.default.createTransport.mockReturnValue({ sendMail });

    const result = await executeSendNotification(validParams); // 不传 context

    // 直发路径：不走登记（planRegistered 未设置）
    expect(result.planRegistered).toBeUndefined();
    // 发送层被真实调用（结果取决于 mock 的 SMTP 响应）
    expect(nodemailer.default.createTransport).toHaveBeenCalled();
  });
});
