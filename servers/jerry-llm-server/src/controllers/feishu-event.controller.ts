/**
 * 飞书事件订阅控制器
 *
 * 职责：
 *   1. 注册飞书事件回调 URL（B1）
 *   2. 处理 URL 验证（飞书首次配置时的 challenge 验证）
 *   3. 验证事件 Token（F3 安全加固，不加密订阅模式）
 *   4. 处理卡片按钮点击事件（card.action.trigger → 路由到 HITL）
 *   5. 更新卡片状态（B3 卡片状态机：变灰、显示确认人）
 *
 * 兼容飞书事件 schema v1（旧）和 v2（新）：
 *   v1: { type: "event_callback", token, event: { type, ... } }
 *   v2: { schema: "2.0", header: { event_type, token, ... }, event: { ... } }
 *
 * 卡片按钮 action.value 由 buildHITLButtons 生成：
 *   { action: "confirm" | "reject", confirmation_id: "xxx" }
 */
import { Controller, Post, Body, HttpCode, Inject } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type { LoggerService } from '@nestjs/common';
import {
  handleConfirmationResponse,
  getFeishuMessageIdForConfirmation,
  updateFeishuHITLCard,
  buildHITLResolvedCard,
} from '../fundamentals/human-in-the-loop.js';
import {
  verifyEventToken,
  handleEventVerification,
} from '../fundamentals/feishu-notify.service.js';

@Controller('api/feishu')
export class FeishuEventController {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
  ) {}

  /**
   * POST /api/feishu/event
   * 飞书事件订阅回调地址
   */
  @Post('event')
  @HttpCode(200)
  async handleFeishuEvent(@Body() body: any): Promise<any> {
    // ----- 1. URL 验证挑战（飞书后台首次保存 URL 时触发） -----
    if (body?.type === 'url_verification') {
      this.logger.log?.('收到飞书 URL 验证请求', 'FeishuEventController');
      const challenge = handleEventVerification(body);
      if (challenge) return challenge;
    }

    // ----- 2. 从 body 中提取 token（兼容 v1/v2 schema） -----
    // v1: body.token (顶层)
    // v2: body.header.token
    const bodyToken: string | undefined = body?.header?.token ?? body?.token;
    const verificationToken = process.env.NOTIFY_FEISHU_VERIFICATION_TOKEN || '';

    if (verificationToken) {
      const isValid = verifyEventToken(bodyToken, verificationToken);
      if (!isValid) {
        this.logger.warn?.(
          '飞书事件回调：Token 校验失败，拒绝请求',
          'FeishuEventController',
        );
        return { code: 403, msg: 'invalid token' };
      }
    } else {
      this.logger.warn?.(
        '飞书事件回调：未配置 VERIFICATION_TOKEN，跳过校验（开发模式）',
        'FeishuEventController',
      );
    }

    // ----- 3. 路由事件（兼容 v1/v2） -----
    // v1: { type: "event_callback", event: { type: "card.action.trigger", ... } }
    // v2: { schema: "2.0", header: { event_type: "card.action.trigger" }, event: {...} }
    const eventType: string | undefined =
      body?.header?.event_type ?? body?.event?.type;
    const event = body?.event;

    if (!event || !eventType) {
      return { code: 0, msg: 'ok' };
    }

    switch (eventType) {
      case 'card.action.trigger':
        return this.handleCardAction(event);
      default:
        this.logger.log?.(
          `收到未处理的事件类型: ${eventType}`,
          'FeishuEventController',
        );
        return { code: 0, msg: 'ok' };
    }
  }

  /**
   * 处理卡片按钮点击事件（B2/B3）
   *
   * 飞书 card.action.trigger 事件结构（节选）：
   *   {
   *     operator: { open_id, user_id, ... },
   *     action: { tag: "button", value: { action, confirmation_id } },
   *     context: { open_message_id, open_chat_id, ... },
   *   }
   *
   * 注意：飞书不返回 card_id，需要用 open_message_id 调用更新接口
   */
  private async handleCardAction(event: any): Promise<{
    code?: number;
    msg?: string;
    toast?: { type: string; content: string };
    card?: { type: string; data: Record<string, unknown> };
  }> {
    const messageId: string | undefined =
      event?.context?.open_message_id ?? event?.open_message_id;
    const action = event?.action;
    const operatorId: string =
      event?.operator?.open_id ||
      event?.operator?.user_id ||
      'unknown';

    if (!action?.value) {
      this.logger.warn?.(
        '卡片按钮事件：缺少 action.value',
        'FeishuEventController',
      );
      return { code: 400, msg: 'missing action value' };
    }

    const { confirmation_id, action: actionType } = action.value as {
      confirmation_id?: string;
      action?: string;
    };
    const isConfirm = actionType === 'confirm';

    if (!confirmation_id || !actionType) {
      this.logger.warn?.(
        '卡片按钮事件：value 中缺少 confirmation_id 或 action',
        'FeishuEventController',
      );
      return { code: 400, msg: 'missing fields' };
    }

    this.logger.log?.(
      `卡片按钮: confirmation_id=${confirmation_id}, action=${actionType}, operator=${operatorId}, messageId=${messageId}`,
      'FeishuEventController',
    );

    // 1) 先取出关联的 feishuMessageId（兼容飞书未透传 open_message_id 的情况）
    const fallbackMessageId =
      messageId || getFeishuMessageIdForConfirmation(confirmation_id);

    // 2) 执行 HITL 确认/拒绝（source='feishu' 避免 HITL 内部再次反向更新卡片）
    const success = handleConfirmationResponse(
      confirmation_id,
      isConfirm,
      'feishu',
    );

    if (!success) {
      // confirmation 已被消费（重复点击）或已超时（5 分钟）。
      // 注意：必须返回 code=0，否则飞书会按 90 秒间隔重试 3 次（参考飞书 OpenAPI 文档）。
      // 用 toast 字段反馈给用户"已处理或已过期"，体验更好。
      this.logger.warn?.(
        `confirmation_id 未找到或已过期: ${confirmation_id}`,
        'FeishuEventController',
      );
      return {
        code: 0,
        msg: 'ok',
        toast: {
          type: 'warning',
          content: '⚠️ 该审批请求已被处理或已超过 5 分钟有效期',
        },
      };
    }

    // 3) 更新卡片：按钮消失 + 显示结果
    //
    // 使用"同步响应"模式：直接把新卡片 JSON 放进响应体的 `card` 字段，飞书后端会用
    // 它替换用户手机上的卡片，**零延迟**生效。比额外发 PATCH 请求异步更新快几百毫秒。
    //
    // 兜底：极少数情况下飞书要求 message_id 才能拿到上下文，这时同步响应可能不生效，
    // 我们再异步 PATCH 一次保底（fire-and-forget，不阻塞返回）。
    const resolvedCard = buildHITLResolvedCard(
      '操作',
      isConfirm,
      `飞书用户 ${operatorId}`,
    );
    if (fallbackMessageId) {
      void updateFeishuHITLCard(
        fallbackMessageId,
        '操作',
        isConfirm,
        `飞书用户 ${operatorId}`,
      ).catch(() => {
        // 兜底 PATCH 失败不影响主流程，因为同步响应已经覆盖了显示
      });
    }

    return {
      toast: {
        type: isConfirm ? 'success' : 'info',
        content: isConfirm ? '✅ 已确认' : '❌ 已拒绝',
      },
      card: {
        type: 'raw',
        data: resolvedCard,
      },
    };
  }
}
