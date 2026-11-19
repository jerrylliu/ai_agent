/**
 * 交付计划补偿定时任务
 *
 * 职责：定期扫描 Redis 中超时未执行的挂起交付计划并补偿执行。
 * 闭环：send_notification 登记时 persistPendingPlan 落 Redis →
 *       正常轮次收口执行后 clearPendingPlan 删键 →
 *       进程在收口前崩溃的"孤儿计划"由本任务补偿（Outbox 可靠性闭环）。
 *
 * 补偿语义：用空 Workspace 执行（本轮内存产物已随崩溃丢失）——
 * 纯 http 附件/无附件计划可正常发送；fc:// 引用会被 Executor
 * 校验闸门拒发并留下结构化回执，用户可在对话中要求重发。
 *
 * 间隔 5 分钟（@Cron），单轮最多补偿 3 个（防重启雪崩，见 store 内 MAX_COMPENSATE_PER_SCAN）
 */

import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { logger } from '../fundamentals/logger.js';
import { compensateStalePlans } from '../fundamentals/delivery/delivery-plan-store.js';

@Injectable()
export class DeliveryCompensationSchedulerService {
  /**
   * 每 5 分钟扫描一次挂起交付计划
   * compensateStalePlans 内部已做降级（Redis 不可用直接返回 0）与防雪崩（单轮上限）
   */
  @Cron('*/5 * * * *')
  async compensatePendingPlans(): Promise<void> {
    try {
      const compensated = await compensateStalePlans();
      if (compensated > 0) {
        logger.info('交付补偿任务：本轮补偿完成', {
          module: 'DeliveryCompensationScheduler',
          compensated,
        });
      }
    } catch (e: any) {
      // 定时任务永不向上抛（@nestjs/schedule 吞掉异常也会打印堆栈，显式记录更清晰）
      logger.error('交付补偿任务：执行异常', {
        module: 'DeliveryCompensationScheduler',
        error: e?.message || String(e),
      });
    }
  }
}
