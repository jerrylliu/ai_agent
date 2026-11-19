/**
 * DeliveryPlanStore —— 交付计划持久化（两阶段交付·可靠性补全）
 *
 * 问题背景（架构评审 2026-11-19）：
 *   DeliveryPlan 只存在于请求级内存变量，进程在"登记后、收口执行前"崩溃
 *   （Docker 重启/OOM）会导致计划静默蒸发——模型已告知用户"已登记"，
 *   邮件却永不发送且无任何痕迹。这违背 Outbox 语义：计划应是"持久承诺"。
 *
 * 方案：
 *   1. 登记时同步写 Redis（delivery:plan:{dedupeKey}，TTL 1h——正常轮次
 *      收口在秒级完成，1h 已是数量级冗余）
 *   2. 收口执行完成后删键
 *   3. 定时扫描（每 5 分钟）：超过 PLAN_STALE_MS 仍未执行的挂起计划 →
 *      补偿执行（Executor 幂等键保证不重发）或超限丢弃
 *
 * Redis 降级：不可用时静默跳过（与项目 Redis 可选架构一致），
 * 此时语义退回"内存计划"——可用性优先于可靠性，与旧架构一致不劣化。
 */

import { logger } from '../logger';
import { getRedis } from '../redis-client';
import { type DeliveryPlan } from './delivery-plan';
import {
  executeDeliveryPlans,
  type DeliveryWorkspace,
} from './delivery-executor';
import { resolveFcAssetFromStores } from './asset-resolver';

const PLAN_KEY_PREFIX = 'delivery:plan:';

/** 挂起计划过期阈值：超过此时间未收口执行的计划由扫描器补偿 */
export const PLAN_STALE_MS = 60 * 1000;

/** 单条挂起计划的 Redis TTL：1 小时（收口秒级完成，此为数量级冗余） */
const PLAN_TTL_SECONDS = 60 * 60;

/** 扫描器单轮最多补偿的计划数：防止雪崩（重启后大量挂起计划一次性外发） */
const MAX_COMPENSATE_PER_SCAN = 3;

/** 补偿尝试上限：同一计划被扫描器补偿超过此次数仍失败则放弃（防毒计划无限重试） */
const MAX_COMPENSATION_ATTEMPTS = 2;

function planRedisKey(dedupeKey: string): string {
  return `${PLAN_KEY_PREFIX}${dedupeKey}`;
}

/**
 * 登记计划到 Redis（挂起状态）
 * 失败仅告警不阻塞：登记失败时计划仍存在于内存，收口照常执行
 * @param plan 交付计划
 */
export async function persistPendingPlan(plan: DeliveryPlan): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(
      planRedisKey(plan.dedupeKey),
      JSON.stringify(plan),
      'EX',
      PLAN_TTL_SECONDS,
    );
  } catch (e: any) {
    logger.warn('交付计划：Redis 登记失败（降级为内存计划）', {
      module: 'DeliveryPlanStore',
      dedupeKey: plan.dedupeKey,
      err: e?.message || String(e),
    });
  }
}

/**
 * 计划已被收口执行（成功/拒发/丢弃）→ 从 Redis 删除挂起记录
 * @param dedupeKey 计划幂等键
 */
export async function clearPendingPlan(dedupeKey: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(planRedisKey(dedupeKey));
  } catch (e: any) {
    logger.warn('交付计划：Redis 删键失败（已忽略）', {
      module: 'DeliveryPlanStore',
      dedupeKey,
      err: e?.message || String(e),
    });
  }
}

/**
 * 扫描并补偿挂起的交付计划（由 @nestjs/schedule 定时调用，间隔 5 分钟）
 *
 * 补偿策略：
 *   - stale 超过 PLAN_STALE_MS 的计划视为"登记后进程未走到收口"
 *   - 用权威存储 Workspace（resolveFcAssetFromStores）执行：本轮内存产物虽已
 *     随进程消失，但文档持久化（7 天）/ 图表导图 Redis 缓存（TTL 内）仍可解析，
 *     有效期内的引用正常发送；真正过期/编造的引用由 Executor 拒发并留下
 *     结构化回执（含 missingAttachments），用户可在后续对话中要求重发
 *   - 仍携带纯 http 外链附件或无附件的计划可正常发送（这类引用不依赖本轮内存）
 *
 * @returns 补偿执行的计划数
 */
export async function compensateStalePlans(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    // SCAN 而非 KEYS：生产 Redis 上 KEYS 是 O(N) 阻塞操作（项目 Redis 规范）
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        Number(cursor),
        'MATCH',
        `${PLAN_KEY_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = String(next);
      keys.push(...batch);
      if (keys.length >= MAX_COMPENSATE_PER_SCAN * 5) break; // 扫描上限，防大库慢扫
    } while (cursor !== '0');

    let compensated = 0;
    for (const key of keys.slice(0, MAX_COMPENSATE_PER_SCAN)) {
      const raw = await redis.get(key);
      if (!raw) continue;
      let plan: DeliveryPlan & { compensationAttempts?: number };
      try {
        plan = JSON.parse(raw);
      } catch {
        await redis.del(key); // 毒数据直接清理
        continue;
      }

      // 尝试次数超限：放弃并删键（记录告警，等用户在对话中主动重发）
      const attempts = (plan.compensationAttempts ?? 0) + 1;
      if (attempts > MAX_COMPENSATION_ATTEMPTS) {
        logger.warn('交付补偿：计划多次补偿失败，放弃（已删键）', {
          module: 'DeliveryPlanStore',
          dedupeKey: plan.dedupeKey,
          attempts,
        });
        await redis.del(key);
        continue;
      }

      // 补偿 Workspace：本轮内存产物已随进程丢失，改用权威存储解析——
      // 文档持久化（7 天）/ 图表导图 Redis 缓存（TTL 内）在崩溃后仍可解析，
      // 有效期内的引用不再被"恒 null"误杀；真正过期的引用仍由 Executor
      // 校验闸门拒发并留下结构化回执
      const storeWorkspace: DeliveryWorkspace = {
        resolveAsset: (ref) => resolveFcAssetFromStores(ref),
      };
      const receipts = await executeDeliveryPlans([plan], storeWorkspace);
      compensated++;

      logger.info('交付补偿：挂起计划已补偿执行', {
        module: 'DeliveryPlanStore',
        dedupeKey: plan.dedupeKey,
        channel: plan.channel,
        success: receipts[0]?.success,
        attempt: attempts,
      });

      // 尝试次数写回：Executor 拒发（缺附件）时不删键、记录 attempts 后保留，
      // 下一轮扫描若仍失败会走到放弃分支；发送成功/幂等命中才删键。
      // 若此处无条件删键，拒绝的计划每 5 分钟被重新补偿一次且 attempts 恒为 1，
      // 形成无限重试循环（复查 2026-11-19 发现）
      if (receipts[0]?.success) {
        await redis.del(key);
      } else {
        await redis.set(
          key,
          JSON.stringify({ ...plan, compensationAttempts: attempts }),
          'EX',
          PLAN_TTL_SECONDS,
        );
      }
    }
    return compensated;
  } catch (e: any) {
    logger.warn('交付补偿：扫描异常（本轮跳过）', {
      module: 'DeliveryPlanStore',
      err: e?.message || String(e),
    });
    return 0;
  }
}
