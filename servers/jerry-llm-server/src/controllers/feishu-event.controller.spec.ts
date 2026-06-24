/**
 * controllers/feishu-event.controller.spec.ts
 *
 * FeishuEventController 单元测试
 * 覆盖：
 *   1. URL 验证挑战（url_verification）
 *   2. Token 校验（开启/不开启）
 *   3. v1/v2 schema 兼容
 *   4. 卡片按钮 confirm/reject 同步响应（含 toast + card 字段）
 *   5. 重复点击/超时（confirmation 不存在）
 *   6. 异常 payload 防御
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// logger mock（防止 winston 加载链）
const mockLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('nest-winston', () => ({
  WINSTON_MODULE_NEST_PROVIDER: 'WINSTON_MODULE_NEST_PROVIDER',
}));

// mock human-in-the-loop：所有飞书相关函数返回可控值
jest.mock('../fundamentals/human-in-the-loop.js', () => ({
  handleConfirmationResponse: jest.fn(),
  getFeishuMessageIdForConfirmation: jest.fn(),
  updateFeishuHITLCard: jest.fn().mockResolvedValue({ success: true }),
  buildHITLResolvedCard: jest.fn().mockReturnValue({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: 'resolved' } },
    elements: [],
  }),
}));

// mock feishu-notify.service：避免触发 config 解析
jest.mock('../fundamentals/feishu-notify.service.js', () => ({
  verifyEventToken: jest.fn(),
  handleEventVerification: jest.fn(),
}));

import { FeishuEventController } from './feishu-event.controller';
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

describe('FeishuEventController', () => {
  let controller: FeishuEventController;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NOTIFY_FEISHU_VERIFICATION_TOKEN;
    controller = new FeishuEventController(mockLogger as any);
  });

  // ============================================================
  // URL 验证（首次保存订阅）
  // ============================================================
  describe('URL 验证挑战', () => {
    it('应返回 challenge', async () => {
      (handleEventVerification as jest.Mock).mockReturnValue({
        challenge: 'abc-xyz',
      });
      const result = await controller.handleFeishuEvent({
        type: 'url_verification',
        challenge: 'abc-xyz',
        token: 'whatever',
      });
      expect(result).toEqual({ challenge: 'abc-xyz' });
    });

    it('handleEventVerification 返回 null 时应继续走 token 校验流程', async () => {
      (handleEventVerification as jest.Mock).mockReturnValue(null);
      (verifyEventToken as jest.Mock).mockReturnValue(true);
      const result = await controller.handleFeishuEvent({
        type: 'url_verification',
      });
      // 既不是 url_verification 也无 event，应返回 ok
      expect(result).toEqual({ code: 0, msg: 'ok' });
    });
  });

  // ============================================================
  // Token 校验
  // ============================================================
  describe('Token 校验', () => {
    it('未配置 verificationToken 应跳过校验，进入路由', async () => {
      delete process.env.NOTIFY_FEISHU_VERIFICATION_TOKEN;
      const result = await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'unknown.event' },
        event: { type: 'unknown' },
      });
      expect(verifyEventToken).not.toHaveBeenCalled();
      expect(result).toEqual({ code: 0, msg: 'ok' });
    });

    it('配置后 token 不通过应返回 403', async () => {
      process.env.NOTIFY_FEISHU_VERIFICATION_TOKEN = 'expected-token';
      (verifyEventToken as jest.Mock).mockReturnValue(false);
      const result = await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'card.action.trigger', token: 'wrong' },
        event: {},
      });
      expect(result).toEqual({ code: 403, msg: 'invalid token' });
    });

    it('配置后 token 通过应继续走路由', async () => {
      process.env.NOTIFY_FEISHU_VERIFICATION_TOKEN = 'expected-token';
      (verifyEventToken as jest.Mock).mockReturnValue(true);
      const result = await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'unknown.event', token: 'expected-token' },
        event: { type: 'unknown' },
      });
      expect(result).toEqual({ code: 0, msg: 'ok' });
    });

    it('v1 schema 应从顶层 token 字段取值', async () => {
      process.env.NOTIFY_FEISHU_VERIFICATION_TOKEN = 'expected-token';
      (verifyEventToken as jest.Mock).mockReturnValue(true);
      await controller.handleFeishuEvent({
        type: 'event_callback',
        token: 'expected-token',
        event: { type: 'unknown' },
      });
      // 校验函数被调用，且传入的是 v1 顶层 token
      expect(verifyEventToken).toHaveBeenCalledWith(
        'expected-token',
        'expected-token',
      );
    });
  });

  // ============================================================
  // 卡片按钮 confirm/reject
  // ============================================================
  describe('卡片按钮事件', () => {
    beforeEach(() => {
      (verifyEventToken as jest.Mock).mockReturnValue(true);
    });

    const cardEventBody = {
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_user_001' },
        action: {
          tag: 'button',
          value: { action: 'confirm', confirmation_id: 'confirm_xxx' },
        },
        context: { open_message_id: 'om_message_001' },
      },
    };

    it('confirm 成功应返回同步响应卡片 + success toast', async () => {
      (handleConfirmationResponse as jest.Mock).mockReturnValue(true);
      const result: any = await controller.handleFeishuEvent(cardEventBody);

      // 1. 调用 handleConfirmationResponse(confirmId, true, 'feishu')
      expect(handleConfirmationResponse).toHaveBeenCalledWith(
        'confirm_xxx',
        true,
        'feishu',
      );
      // 2. 返回成功 toast
      expect(result.toast).toEqual({ type: 'success', content: '✅ 已确认' });
      // 3. 返回 card.type=raw + card.data
      expect(result.card.type).toBe('raw');
      expect(result.card.data).toBeDefined();
      // 4. 异步 PATCH 兜底
      expect(updateFeishuHITLCard).toHaveBeenCalledWith(
        'om_message_001',
        '操作',
        true,
        '飞书用户 ou_user_001',
      );
    });

    it('reject 应返回 info toast', async () => {
      (handleConfirmationResponse as jest.Mock).mockReturnValue(true);
      const result: any = await controller.handleFeishuEvent({
        ...cardEventBody,
        event: {
          ...cardEventBody.event,
          action: {
            tag: 'button',
            value: { action: 'reject', confirmation_id: 'confirm_xxx' },
          },
        },
      });
      expect(handleConfirmationResponse).toHaveBeenCalledWith(
        'confirm_xxx',
        false,
        'feishu',
      );
      expect(result.toast).toEqual({ type: 'info', content: '❌ 已拒绝' });
    });

    it('confirmation 不存在/已过期应返回 warning toast 且 code=0', async () => {
      (handleConfirmationResponse as jest.Mock).mockReturnValue(false);
      const result: any = await controller.handleFeishuEvent(cardEventBody);
      expect(result.code).toBe(0);
      expect(result.toast.type).toBe('warning');
      expect(result.toast.content).toContain('已被处理或已超过');
      // 不应再异步 PATCH（避免无意义请求）
      expect(updateFeishuHITLCard).not.toHaveBeenCalled();
    });

    it('action.value 缺失应返回 400', async () => {
      const result: any = await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'ou_x' },
          action: { tag: 'button' }, // 缺 value
          context: { open_message_id: 'om_001' },
        },
      });
      expect(result).toEqual({ code: 400, msg: 'missing action value' });
    });

    it('value 中缺少 confirmation_id 应返回 400', async () => {
      const result: any = await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'ou_x' },
          action: { tag: 'button', value: { action: 'confirm' } },
          context: { open_message_id: 'om_001' },
        },
      });
      expect(result).toEqual({ code: 400, msg: 'missing fields' });
    });

    it('open_message_id 缺失时应尝试 fallback 查询 HITL 内置 Map', async () => {
      (handleConfirmationResponse as jest.Mock).mockReturnValue(true);
      (getFeishuMessageIdForConfirmation as jest.Mock).mockReturnValue('om_fallback');

      await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'ou_x' },
          action: {
            tag: 'button',
            value: { action: 'confirm', confirmation_id: 'cid' },
          },
          // 注意：故意不提供 context.open_message_id
        },
      });
      expect(getFeishuMessageIdForConfirmation).toHaveBeenCalledWith('cid');
      expect(updateFeishuHITLCard).toHaveBeenCalledWith(
        'om_fallback',
        '操作',
        true,
        expect.any(String),
      );
    });

    it('open_message_id + fallback 都没有时应跳过异步 PATCH，但同步卡片仍返回', async () => {
      (handleConfirmationResponse as jest.Mock).mockReturnValue(true);
      (getFeishuMessageIdForConfirmation as jest.Mock).mockReturnValue(undefined);

      const result: any = await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'ou_x' },
          action: {
            tag: 'button',
            value: { action: 'confirm', confirmation_id: 'cid' },
          },
        },
      });
      // 没有 message_id 不应触发异步 PATCH
      expect(updateFeishuHITLCard).not.toHaveBeenCalled();
      // 但同步卡片必须返回
      expect(result.card.type).toBe('raw');
      expect(buildHITLResolvedCard).toHaveBeenCalled();
    });

    it('operator 缺失时应使用 unknown', async () => {
      (handleConfirmationResponse as jest.Mock).mockReturnValue(true);
      await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          action: {
            tag: 'button',
            value: { action: 'confirm', confirmation_id: 'cid' },
          },
          context: { open_message_id: 'om_x' },
        },
      });
      expect(buildHITLResolvedCard).toHaveBeenCalledWith('操作', true, '飞书用户 unknown');
    });
  });

  // ============================================================
  // 路由兜底
  // ============================================================
  describe('未识别事件', () => {
    beforeEach(() => {
      (verifyEventToken as jest.Mock).mockReturnValue(true);
    });

    it('未识别 event_type 应返回 ok', async () => {
      const result = await controller.handleFeishuEvent({
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1' },
        event: { type: 'im.message.receive_v1' },
      });
      expect(result).toEqual({ code: 0, msg: 'ok' });
    });

    it('完全空 body 应返回 ok', async () => {
      const result = await controller.handleFeishuEvent({});
      expect(result).toEqual({ code: 0, msg: 'ok' });
    });
  });
});
