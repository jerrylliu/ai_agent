/**
 * delivery-plan-store 单元测试
 * 覆盖：登记持久化 / 删键 / 补偿扫描（stale 计划补偿、毒数据清理、尝试上限、防雪崩）
 */

const redisStore = new Map<string, string>();
const redisGet = jest.fn(async (k: string) => redisStore.get(k));
const redisSet = jest.fn(
  async (k: string, v: string, _mode: string, _ttl: number) => {
    redisStore.set(k, v);
  },
);
const redisDel = jest.fn(async (k: string) => {
  redisStore.delete(k);
});
const redisScan = jest.fn(async (
  cursor: number,
  _match: string,
  _pattern: string,
  _count: string,
) => {
  // 简化模拟：一次性返回所有匹配键，cursor 结束
  const all = [...redisStore.keys()].filter((k) =>
    k.startsWith('delivery:plan:'),
  );
  return [0, all];
});

jest.mock('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../redis-client.js', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet, del: redisDel, scan: redisScan }),
}));

jest.mock('./delivery-executor', () => ({
  executeDeliveryPlans: jest.fn(),
}));

import {
  persistPendingPlan,
  clearPendingPlan,
  compensateStalePlans,
} from './delivery-plan-store.js';
import { executeDeliveryPlans } from './delivery-executor';

import type { DeliveryPlan } from './delivery-plan.js';
import { buildDedupeKey } from './delivery-plan.js';

const mockedExecute = executeDeliveryPlans as jest.Mock;

function makePlan(overrides: Partial<DeliveryPlan> = {}): DeliveryPlan {
  return {
    channel: 'email',
    title: '测试',
    content: '正文',
    recipients: ['u@x.com'],
    dedupeKey: buildDedupeKey('s1', 1, 0),
    createdAt: Date.now(),
    source: 'fc-loop',
    ...overrides,
  };
}

beforeEach(() => {
  redisStore.clear();
  jest.clearAllMocks();
});

describe('persistPendingPlan / clearPendingPlan', () => {
  it('登记 → Redis 有键；清理 → 键删除', async () => {
    const plan = makePlan();
    await persistPendingPlan(plan);
    expect(redisStore.has(`delivery:plan:${plan.dedupeKey}`)).toBe(true);

    await clearPendingPlan(plan.dedupeKey);
    expect(redisStore.has(`delivery:plan:${plan.dedupeKey}`)).toBe(false);
  });

  it('Redis set 抛异常 → 静默降级不抛出', async () => {
    redisSet.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      persistPendingPlan(makePlan()),
    ).resolves.toBeUndefined();
  });
});

describe('compensateStalePlans', () => {
  it('挂起计划被补偿执行并删键', async () => {
    const plan = makePlan();
    await persistPendingPlan(plan);
    mockedExecute.mockResolvedValue([
      { dedupeKey: plan.dedupeKey, success: true, channel: 'email', delivered: 1, idempotentHit: false, sentAt: Date.now() },
    ]);

    const n = await compensateStalePlans();

    expect(n).toBe(1);
    expect(mockedExecute).toHaveBeenCalledTimes(1);
    // 补偿用空 Workspace（本轮内存产物已不可信）
    const [plansArg, wsArg] = mockedExecute.mock.calls[0];
    expect(plansArg[0].dedupeKey).toBe(plan.dedupeKey);
    expect(wsArg.resolveAsset('fc://document/x')).toBeNull();
    expect(redisStore.has(`delivery:plan:${plan.dedupeKey}`)).toBe(false);
  });

  it('毒数据（非法 JSON）直接清理，不阻塞其他计划', async () => {
    redisStore.set('delivery:plan:bad', 'not-json{{{');
    const good = makePlan();
    await persistPendingPlan(good);
    mockedExecute.mockResolvedValue([
      { dedupeKey: good.dedupeKey, success: true, channel: 'email', delivered: 1, idempotentHit: false, sentAt: Date.now() },
    ]);

    const n = await compensateStalePlans();

    expect(n).toBe(1); // 只补偿了合法计划
    expect(redisStore.has('delivery:plan:bad')).toBe(false);
    expect(redisStore.has(`delivery:plan:${good.dedupeKey}`)).toBe(false);
  });

  it('超过补偿尝试上限的计划被放弃删键', async () => {
    const plan = makePlan();
    // 模拟已尝试 2 次（达到 MAX_COMPENSATION_ATTEMPTS）
    await persistPendingPlan({ ...plan, } as DeliveryPlan);
    redisStore.set(
      `delivery:plan:${plan.dedupeKey}`,
      JSON.stringify({ ...plan, compensationAttempts: 2 }),
    );

    const n = await compensateStalePlans();

    expect(n).toBe(0);
    expect(mockedExecute).not.toHaveBeenCalled();
    expect(redisStore.has(`delivery:plan:${plan.dedupeKey}`)).toBe(false);
  });

  it('防雪崩：单轮最多补偿 3 个（MAX_COMPENSATE_PER_SCAN）', async () => {
    for (let i = 0; i < 5; i++) {
      await persistPendingPlan(makePlan({ dedupeKey: buildDedupeKey('s', 1, i) }));
    }
    mockedExecute.mockResolvedValue([
      { success: true, channel: 'email', delivered: 1, idempotentHit: false, sentAt: Date.now() },
    ]);

    const n = await compensateStalePlans();

    expect(n).toBe(3);
    expect(mockedExecute).toHaveBeenCalledTimes(3);
    expect(redisStore.size).toBe(2); // 剩余 2 个留给下一轮
  });

  it('无挂起计划 → 返回 0，Executor 不被调用', async () => {
    const n = await compensateStalePlans();
    expect(n).toBe(0);
    expect(mockedExecute).not.toHaveBeenCalled();
  });
});
