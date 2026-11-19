/**
 * DeliveryExecutor 单元测试
 * 覆盖四大关键行为：缺资产拒发 / 幂等命中 / 引用解析成功发送 / 发送失败回执
 *
 * Mock 策略：
 *   - executeSendNotification（发送通道）：只断言被调用与入参，不真发
 *   - getRedis（幂等存储）：内存 Map 模拟 get/set
 *   - logger：mock 掉避免测试输出噪音
 */

import { executeDeliveryPlan, executeDeliveryPlans } from './delivery-executor.js';
import type { DeliveryWorkspace } from './delivery-executor.js';
import type { DeliveryPlan } from './delivery-plan.js';
import { buildDedupeKey } from './delivery-plan.js';

const redisStore = new Map<string, string>();
const redisGet = jest.fn(async (k: string) => redisStore.get(k));
const redisSet = jest.fn(
  async (k: string, v: string, _mode: string, _ttl: number) => {
    redisStore.set(k, v);
  },
);

jest.mock('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../redis-client.js', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet }),
}));

jest.mock('../tools/send-notification.js', () => ({
  dispatchNotification: jest.fn(),
}));

import { dispatchNotification } from '../tools/send-notification.js';

const mockedSend = dispatchNotification as jest.Mock;

/** 构造基础计划 */
function makePlan(overrides: Partial<DeliveryPlan> = {}): DeliveryPlan {
  return {
    channel: 'email',
    title: '春天主题推送',
    content: '正文',
    recipients: ['user@qq.com'],
    attachments: undefined,
    dedupeKey: buildDedupeKey('sess1', 1, 0),
    createdAt: Date.now(),
    source: 'fc-loop',
    ...overrides,
  };
}

/** 内存 Workspace：fc://image/{key} 可解析，其余解析不到 */
function makeWorkspace(): DeliveryWorkspace & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveAsset: (ref: string) => {
      calls.push(ref);
      if (ref.startsWith('fc://image/')) {
        return { url: `https://cdn.example.com/${ref.slice('fc://image/'.length)}.png`, filename: 'spring.png' };
      }
      return null;
    },
  };
}

beforeEach(() => {
  redisStore.clear();
  jest.clearAllMocks();
});

describe('executeDeliveryPlan', () => {
  it('附件全部可解析 → 发送层收到替换后的真实 URL', async () => {
    mockedSend.mockResolvedValue({
      success: true,
      channel: 'email',
      delivered: 1,
      refIds: ['msg-1'],
    });
    const ws = makeWorkspace();
    const receipt = await executeDeliveryPlan(
      makePlan({
        attachments: [
          { filename: 'spring.png', url: 'fc://image/img1' },
          { filename: 'chart.png', url: 'https://x.com/chart.png' },
        ],
      }),
      ws,
    );

    expect(receipt.success).toBe(true);
    expect(receipt.idempotentHit).toBe(false);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const sentAttachments = mockedSend.mock.calls[0][0].attachments;
    expect(sentAttachments[0].url).toBe('https://cdn.example.com/img1.png');
    expect(sentAttachments[1].url).toBe('https://x.com/chart.png'); // 外链透传
    // 回执已写入 Redis
    expect(redisStore.has(`delivery:receipt:${receipt.dedupeKey}`)).toBe(true);
  });

  it('fc:// 引用解析不到 → 整封拒发，发送层不被调用', async () => {
    const ws = makeWorkspace();
    const receipt = await executeDeliveryPlan(
      makePlan({
        attachments: [
          { filename: 'spring.png', url: 'fc://image/good' },
          { filename: 'ghost.pdf', url: 'fc://document/missing' }, // workspace 不解析 document
          { filename: 'junk.txt', url: 'ftp://bad' },
        ],
      }),
      ws,
    );

    expect(receipt.success).toBe(false);
    expect(receipt.delivered).toBe(0);
    expect(receipt.missingAttachments).toHaveLength(2);
    expect(receipt.missingAttachments?.map((m) => m.filename)).toEqual([
      'ghost.pdf',
      'junk.txt',
    ]);
    expect(mockedSend).not.toHaveBeenCalled(); // 关键：绝不发出附件残缺的邮件
    expect(receipt.errors?.[0]).toContain('附件完整性校验失败');
  });

  it('同一 dedupeKey 重复执行 → 幂等命中，返回首次回执且不再调用发送层', async () => {
    mockedSend.mockResolvedValue({
      success: true,
      channel: 'email',
      delivered: 1,
      refIds: ['first'],
    });
    const plan = makePlan({ attachments: [{ filename: 'a.png', url: 'https://x/a.png' }] });

    const first = await executeDeliveryPlan(plan, makeWorkspace());
    expect(first.success).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(1);

    // 第二次调用（模型"补发"场景）：不同参数也拿到同一键
    const second = await executeDeliveryPlan(
      { ...plan, title: '补发标题', attachments: [{ filename: 'b.png', url: 'https://x/b.png' }] },
      makeWorkspace(),
    );

    expect(mockedSend).toHaveBeenCalledTimes(1); // 发送层只被调用一次
    expect(second.idempotentHit).toBe(true);
    expect(second.refIds).toEqual(['first']); // 返回的是首次回执
  });

  it('发送层抛异常 → 返回结构化失败回执（不向上抛）', async () => {
    mockedSend.mockRejectedValue(new Error('SMTP connection timeout'));
    const receipt = await executeDeliveryPlan(
      makePlan({ attachments: [{ filename: 'a.png', url: 'https://x/a.png' }] }),
      makeWorkspace(),
    );

    expect(receipt.success).toBe(false);
    expect(receipt.errors?.[0]).toContain('SMTP connection timeout');
    expect(receipt.delivered).toBe(0);
  });

  it('发送层返回业务失败 → 回执透传错误信息', async () => {
    mockedSend.mockResolvedValue({
      success: false,
      channel: 'email',
      delivered: 0,
      errors: ['recipients 不能为空'],
    });
    const receipt = await executeDeliveryPlan(makePlan({ recipients: [] }), makeWorkspace());

    expect(receipt.success).toBe(false);
    expect(receipt.errors).toEqual(['recipients 不能为空']);
  });

  it('无附件计划直接发送（纯文本通知不受校验影响）', async () => {
    mockedSend.mockResolvedValue({ success: true, channel: 'email', delivered: 1 });
    const receipt = await executeDeliveryPlan(makePlan({ attachments: undefined }), makeWorkspace());

    expect(receipt.success).toBe(true);
    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: undefined }),
    );
  });
});

describe('executeDeliveryPlans', () => {
  it('空计划列表返回空回执', async () => {
    expect(await executeDeliveryPlans([], makeWorkspace())).toEqual([]);
  });

  it('多计划串行执行，回执顺序与计划一一对应', async () => {
    mockedSend
      .mockResolvedValueOnce({ success: true, channel: 'email', delivered: 1, refIds: ['m1'] })
      .mockResolvedValueOnce({ success: false, channel: 'email', delivered: 0, errors: ['x'] });

    const plans = [
      makePlan({ dedupeKey: buildDedupeKey('s', 1, 0) }),
      makePlan({ dedupeKey: buildDedupeKey('s', 1, 1) }),
    ];
    const receipts = await executeDeliveryPlans(plans, makeWorkspace());

    expect(receipts).toHaveLength(2);
    expect(receipts[0].success).toBe(true);
    expect(receipts[1].success).toBe(false);
    // 串行：第二次调用发生在第一次完成之后（mock 调用顺序可证）
    expect(mockedSend.mock.calls[0][0].title).toBe('春天主题推送');
  });

  it('两个相同 dedupeKey 的计划 → 第二个命中幂等（结构上防重发）', async () => {
    mockedSend.mockResolvedValue({ success: true, channel: 'email', delivered: 1, refIds: ['once'] });
    const sameKey = buildDedupeKey('s', 1, 0);
    const receipts = await executeDeliveryPlans(
      [makePlan({ dedupeKey: sameKey }), makePlan({ dedupeKey: sameKey, title: '另一封' })],
      makeWorkspace(),
    );

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(receipts[0].idempotentHit).toBe(false);
    expect(receipts[1].idempotentHit).toBe(true);
    expect(receipts[1].refIds).toEqual(['once']);
  });
});
