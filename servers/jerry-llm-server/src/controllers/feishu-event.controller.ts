/**
 * 飞书事件订阅控制器（HTTP 回调模式）
 *
 * 职责：
 *   1. 注册飞书事件回调 URL（B1）
 *   2. 处理 URL 验证（飞书首次配置时的 challenge 验证）
 *   3. 验证事件 Token（F3 安全加固，不加密订阅模式）
 *   4. 处理卡片按钮点击事件（card.action.trigger → 路由到 HITL）
 *
 * 兼容飞书事件 schema v1（旧）和 v2（新）：
 *   v1: { type: "event_callback", token, event: { type, ... } }
 *   v2: { schema: "2.0", header: { event_type, token, ... }, event: { ... } }
 *
 * 卡片按钮 action.value 由 buildHITLButtons 生成：
 *   { action: "confirm" | "reject", confirmation_id: "xxx" }
 *
 * 注意：业务逻辑已抽到 feishu-event-processor.ts，本 Controller 只做
 * "HTTP 协议层校验 + 转发到业务函数"。长连接模式（FeishuWSClient）
 * 共用同一业务函数。本路由在 EVENT_MODE=ws 时不会被飞书调用，但保留注册
 * 不会有任何运行时副作用。
 */
import { Controller, Post, Body, HttpCode, Inject } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type { LoggerService } from '@nestjs/common';
import {
  verifyEventToken,
  handleEventVerification,
} from '../fundamentals/feishu-notify.service.js';
import { processCardAction } from '../fundamentals/feishu-event-processor.js';

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
        return processCardAction(event, this.logger, 'FeishuEventController');
      default:
        this.logger.log?.(
          `收到未处理的事件类型: ${eventType}`,
          'FeishuEventController',
        );
        return { code: 0, msg: 'ok' };
    }
  }
}
