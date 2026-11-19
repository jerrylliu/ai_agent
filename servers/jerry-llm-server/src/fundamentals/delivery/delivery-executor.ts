/**
 * DeliveryExecutor —— 交付执行器（两阶段交付架构·阶段二）
 *
 * 职责：在 LLM 工具循环**之外**，统一消费 DeliveryPlan，完成真实发送。
 * 是整个系统唯一允许触发对外发送（SMTP/飞书/Webhook）的出口。
 *
 * 执行流水线（顺序即闸门）：
 *   1. 幂等检查：dedupeKey 在 Redis 已有回执 → 直接返回首次回执，不重发
 *      （Redis 不可用降级为跳过幂等，与项目 Redis 可选架构一致）
 *   2. 附件完整性校验：fc:// 引用必须能在 Workspace 解析为真实产物，
 *      解析不到 → **拒发整个计划**，返回缺失清单（根治"缺图邮件先发出去"）
 *   3. 真实发送：复用 dispatchNotification（收件人归一化/附件下载/三通道
 *      路由都在其内部，本层不重复实现）。注意调用的是纯发送函数而非工具
 *      入口 executeSendNotification——后者已是"登记"语义，调用它会形成
 *      登记套登记死循环（设计审查 2026-11-19 发现）
 *   4. 回执落 Redis（TTL 24h）并返回
 *
 * 与 send-notification 的关系：
 *   executeSendNotification（工具入口）只登记 DeliveryPlan（聊天链路）或
 *   兼容直发（工作流无收集器场景）；本 Executor 由 prompt.ts 循环收口处
 *   调用，消费计划时通过 dispatchNotification（纯发送函数）真实发送。
 *
 * Workspace 解耦：
 *   Executor 不直接依赖 collectedImages 等具体收集数组，而是通过
 *   DeliveryWorkspace 接口取产物。prompt.ts 接线时提供实现，单测提供 mock。
 */

import { logger } from '../logger.js';
import { getRedis } from '../redis-client.js';
import {
  type DeliveryPlan,
  type DeliveryAttachment,
  isFcProtocolUrl,
  isHttpUrl,
} from './delivery-plan.js';
import {
  dispatchNotification,
  type SendNotificationParams,
  type SendNotificationResult,
} from '../tools/send-notification.js';

// ==================== Workspace 接口 ====================

/** 已解析产物：真实可下载的地址（http 外链或本服务可访问地址） */
export interface ResolvedAsset {
  /** 解析后的可下载 URL（替换 fc:// 引用传给发送层） */
  url: string;
  /** 产物文件名（优先用 Workspace 中登记的名字，模型传的 filename 作兜底） */
  filename?: string;
}

/**
 * 交付工作区：本轮工具循环收集的产物注册表
 * prompt.ts 在收口处用 collectedImages/collectedChartOptions/collectedFileCards 构造实现
 */
export interface DeliveryWorkspace {
  /**
   * 按 fc:// 协议引用解析产物
   * @param ref 形如 fc://image/{key}、fc://document/{key} 的引用
   * @returns 解析成功返回真实产物地址；解析不到返回 null（触发拒发）
   */
  resolveAsset: (ref: string) => Promise<ResolvedAsset | null> | ResolvedAsset | null;
}

// ==================== 回执 ====================

export interface DeliveryReceipt {
  /** 幂等键 */
  dedupeKey: string;
  /** 是否真实发送成功 */
  success: boolean;
  channel: string;
  delivered: number;
  /** 发送层返回的错误信息 */
  errors?: string[];
  /** 拒发时的缺失附件清单（发送层 errors 之外的结构化信息） */
  missingAttachments?: Array<{ filename: string; url: string }>;
  /** 邮件/飞书 message ID 等追溯标识 */
  refIds?: string[];
  /** true=本次为幂等命中，返回的是首次发送的回执，未重复发送 */
  idempotentHit: boolean;
  /** 发送时间戳（ms） */
  sentAt: number;
}

/** 回执 Redis TTL：24 小时（跨会话去重窗口，按生产邮件重发频率定） */
const RECEIPT_TTL_SECONDS = 24 * 60 * 60;

const RECEIPT_KEY_PREFIX = 'delivery:receipt:';

function receiptRedisKey(dedupeKey: string): string {
  return `${RECEIPT_KEY_PREFIX}${dedupeKey}`;
}

// ==================== 附件校验 ====================

/**
 * 校验并解析计划中的全部附件引用
 *
 * 校验规则：
 *   - fc:// 引用：必须能从 Workspace 解析到真实产物，否则记入缺失清单
 *   - http(s)：外链透传（可下载性由发送层的下载重试与 skippedAttachments 机制兜底）
 *   - 其他协议（ftp:/data:/相对路径等）：视为非法引用，记入缺失清单
 *     （旧架构下编造的 fc:// 地址会在发送层被静默跳过，用户收到无附件邮件；
 *      现在闸门前移：编造引用 = 整封拒发）
 *
 * @returns 全部解析成功返回替换后的附件列表；有缺失返回 null + 缺失清单
 */
async function validateAttachments(
  attachments: DeliveryAttachment[] | undefined,
  workspace: DeliveryWorkspace,
): Promise<
  | { ok: true; resolved: SendNotificationParams['attachments'] }
  | { ok: false; missing: Array<{ filename: string; url: string }> }
> {
  if (!attachments || attachments.length === 0) {
    return { ok: true, resolved: undefined };
  }

  const resolved: SendNotificationParams['attachments'] = [];
  const missing: Array<{ filename: string; url: string }> = [];

  for (const att of attachments) {
    if (isHttpUrl(att.url)) {
      // 外链直接透传
      resolved.push({ filename: att.filename, url: att.url, cid: att.cid });
      continue;
    }
    if (isFcProtocolUrl(att.url)) {
      const asset = await workspace.resolveAsset(att.url);
      if (asset) {
        resolved.push({
          filename: asset.filename || att.filename,
          url: asset.url,
          cid: att.cid,
        });
        continue;
      }
      logger.warn('交付校验：fc:// 引用无法解析', {
        module: 'DeliveryExecutor',
        url: att.url,
        filename: att.filename,
      });
      missing.push({ filename: att.filename, url: att.url });
      continue;
    }
    // 非法协议
    logger.warn('交付校验：非法附件协议', {
      module: 'DeliveryExecutor',
      url: att.url,
      filename: att.filename,
    });
    missing.push({ filename: att.filename, url: att.url });
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, resolved };
}

// ==================== 主流程 ====================

/**
 * 执行单个交付计划（幂等 → 校验 → 发送 → 回执）
 *
 * @param plan 交付计划
 * @param workspace 本轮产物注册表
 * @returns 交付回执（成功/拒发/幂等命中均返回结构化回执，不抛异常）
 */
export async function executeDeliveryPlan(
  plan: DeliveryPlan,
  workspace: DeliveryWorkspace,
): Promise<DeliveryReceipt> {
  const { dedupeKey } = plan;
  const sentAt = Date.now();

  // ---------- 1. 幂等检查 ----------
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(receiptRedisKey(dedupeKey));
      if (cached) {
        const prior = JSON.parse(cached) as DeliveryReceipt;
        logger.info('交付执行：幂等命中，返回首次回执（未重复发送）', {
          module: 'DeliveryExecutor',
          dedupeKey,
          firstSentAt: prior.sentAt,
        });
        return { ...prior, idempotentHit: true };
      }
    } catch (e: any) {
      // 幂等检查失败不阻塞发送（宁可重复风险也不丢邮件？不——见下方设计权衡：
      // 检查失败继续走校验+发送，与"Redis 降级仍可用"的项目原则一致）
      logger.warn('交付执行：幂等检查失败（降级继续）', {
        module: 'DeliveryExecutor',
        dedupeKey,
        err: e?.message || String(e),
      });
    }
  }

  // ---------- 2. 附件完整性校验（发送前闸门） ----------
  const validation = await validateAttachments(plan.attachments, workspace);
  if (!validation.ok) {
    const receipt: DeliveryReceipt = {
      dedupeKey,
      success: false,
      channel: plan.channel,
      delivered: 0,
      errors: [
        `附件完整性校验失败，整封拒发（缺 ${validation.missing.length} 个附件）：` +
          validation.missing
            .map((m) => `${m.filename}(${m.url})`)
            .join('、'),
      ],
      missingAttachments: validation.missing,
      idempotentHit: false,
      sentAt,
    };
    logger.warn('交付执行：附件校验失败拒发', {
      module: 'DeliveryExecutor',
      dedupeKey,
      channel: plan.channel,
      missing: validation.missing,
    });
    // 拒发结果同样写回执：模型若拿同一 dedupeKey 重试，拿到的是"校验失败"回执
    // 而不是被误判为"已发送"——引导它修正引用后由新键重新登记
    if (redis) {
      try {
        await redis.set(
          receiptRedisKey(dedupeKey),
          JSON.stringify(receipt),
          'EX',
          RECEIPT_TTL_SECONDS,
        );
      } catch (e: any) {
        logger.warn('交付执行：拒发回执写入 Redis 失败（已忽略）', {
          module: 'DeliveryExecutor',
          dedupeKey,
          err: e?.message || String(e),
        });
      }
    }
    return receipt;
  }

  // ---------- 3. 真实发送（复用现有发送通道） ----------
  const sendParams: SendNotificationParams = {
    channel: plan.channel,
    title: plan.title,
    content: plan.content,
    recipients: plan.recipients,
    webhookUrl: plan.webhookUrl,
    attachments: validation.resolved,
  };
  let sendResult: SendNotificationResult;
  try {
    sendResult = await dispatchNotification(sendParams);
  } catch (e: any) {
    sendResult = {
      success: false,
      channel: plan.channel,
      delivered: 0,
      errors: [`发送通道异常：${e?.message || String(e)}`],
    };
  }

  // ---------- 4. 回执落 Redis + 返回 ----------
  const receipt: DeliveryReceipt = {
    dedupeKey,
    success: sendResult.success,
    channel: sendResult.channel,
    delivered: sendResult.delivered,
    errors: sendResult.errors,
    refIds: sendResult.refIds,
    idempotentHit: false,
    sentAt,
  };
  if (redis) {
    try {
      await redis.set(
        receiptRedisKey(dedupeKey),
        JSON.stringify(receipt),
        'EX',
        RECEIPT_TTL_SECONDS,
      );
    } catch (e: any) {
      logger.warn('交付执行：发送回执写入 Redis 失败（已忽略）', {
        module: 'DeliveryExecutor',
        dedupeKey,
        err: e?.message || String(e),
      });
    }
  }

  logger.info('交付执行：完成', {
    module: 'DeliveryExecutor',
    dedupeKey,
    channel: receipt.channel,
    success: receipt.success,
    delivered: receipt.delivered,
    attachmentCount: validation.resolved?.length || 0,
  });
  return receipt;
}

/**
 * 批量执行交付计划（prompt.ts 循环收口处调用）
 *
 * @param plans 本轮登记的全部计划
 * @param workspace 本轮产物注册表
 * @returns 与 plans 等长的回执数组（顺序对应）
 */
export async function executeDeliveryPlans(
  plans: DeliveryPlan[],
  workspace: DeliveryWorkspace,
): Promise<DeliveryReceipt[]> {
  if (plans.length === 0) return [];
  logger.info('交付执行：开始批量执行', {
    module: 'DeliveryExecutor',
    planCount: plans.length,
    channels: plans.map((p) => p.channel),
  });
  // 计划间串行：不同计划可能发往同一收件人，串行保证到达顺序可预期，
  // 也避免并发下两个计划同时通过幂等检查（Redis get/set 非原子）
  const receipts: DeliveryReceipt[] = [];
  for (const plan of plans) {
    receipts.push(await executeDeliveryPlan(plan, workspace));
  }
  return receipts;
}
