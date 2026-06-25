/**
 * 飞书事件长连接客户端（WebSocket 模式）
 *
 * 背景：
 *   HTTP 回调模式需要公网可访问的回调地址（cpolar/Cloudflare Tunnel/自建 frp），
 *   开发期间内网穿透地址会变 + cpolar 免费版会注入广告页导致 JSON 解析失败。
 *   飞书官方提供 WebSocket 长连接模式：由服务端主动连飞书，事件通过长连接推下来，
 *   无需公网地址、无需 URL 验证、无需签名校验。
 *
 * 设计：
 *   - 单例长连接，进程退出时优雅关闭
 *   - 业务逻辑复用 feishu-event-processor.ts，HTTP 与 WS 共用一份代码
 *   - 卡片更新双保险：handler 返回值经 SDK 回包给飞书做同步替换 + 异步 PATCH 兜底
 *   - 日志统一走 Winston，module='FeishuWSClient'
 *
 * 注意事项（来自飞书官方文档）：
 *   1. 长连接模式接收到消息后需要在 3 秒内处理完成
 *   2. 集群模式：多客户端只会随机一个收到消息
 *   3. 仅支持事件订阅，不支持回调订阅（这里只用到事件订阅，OK）
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';
import { processCardAction, processIncomingMessage } from './feishu-event-processor.js';

let wsClient: Lark.WSClient | null = null;
let started = false;

/**
 * 适配 processCardAction 期望的 MinimalLogger 接口
 * Winston logger 通过 meta 字段记录 module，包一层把第二参数 context 字符串
 * 转成 meta 对象。
 */
const wsLoggerAdapter = {
  log: (msg: string, _ctx?: string) =>
    logger.info(msg, { module: 'FeishuWSClient' }),
  warn: (msg: string, _ctx?: string) =>
    logger.warn(msg, { module: 'FeishuWSClient' }),
  error: (msg: string, _ctx?: string) =>
    logger.error(msg, { module: 'FeishuWSClient' }),
};

/**
 * 启动飞书事件长连接
 *
 * @returns true 表示已尝试启动；false 表示因配置缺失或重复调用而跳过
 */
export function startFeishuWsClient(opts: {
  appId: string;
  appSecret: string;
  domain?: string;
}): boolean {
  if (started) {
    logger.warn('飞书长连接已启动，跳过重复初始化', {
      module: 'FeishuWSClient',
    });
    return false;
  }
  if (!opts.appId || !opts.appSecret) {
    logger.warn('飞书 AppId/AppSecret 未配置，跳过长连接启动', {
      module: 'FeishuWSClient',
    });
    return false;
  }

  // domain 留空（NOTIFY_FEISHU_DOMAIN 未配置）时使用 SDK 默认值 Domain.Feishu，
  // 即 https://open.feishu.cn；配置含 'larksuite' 才走海外 Lark
  const domain: Lark.Domain | undefined =
    opts.domain && opts.domain.includes('larksuite')
      ? Lark.Domain.Lark
      : undefined;

  wsClient = new Lark.WSClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
  });

  // EventDispatcher.register 的类型只暴露了官方文档中已发布的事件签名，
  // card.action.trigger 不在 IHandles 类型表里（运行时支持，类型未补全），
  // 这里用宽松类型注册。
  const dispatcher = new Lark.EventDispatcher({}).register({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    'card.action.trigger': async (data: any) => {
      try {
        // SDK 会把 handler 返回值通过 WebSocket 回包给飞书后端，
        // 飞书用 result.card 同步替换用户手机上的卡片、用 result.toast 弹提示，
        // 与 HTTP 同步响应一致，processCardAction 内部已构造好该结构。
        const result = await processCardAction(
          data,
          wsLoggerAdapter,
          'FeishuWSClient',
        );
        return result;
      } catch (err) {
        const e = err as Error;
        logger.error('处理 card.action.trigger 失败', {
          module: 'FeishuWSClient',
          error: e.message,
          stack: e.stack,
        });
        return { toast: { type: 'error', content: '处理失败' } };
      }
    },
    // D1/D2：入站消息（私聊 + 群里 @ AI）
    // 飞书要求 handler 3 秒内返回，所以这里立刻返回，业务用 setImmediate 异步化
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    'im.message.receive_v1': async (data: any) => {
      setImmediate(() => {
        processIncomingMessage(data, wsLoggerAdapter, 'FeishuWSClient').catch(
          (err: Error) => {
            logger.warn('处理 im.message.receive_v1 失败（异步流程）', {
              module: 'FeishuWSClient',
              error: err.message,
              stack: err.stack,
            });
          },
        );
      });
      // 长连接无 ACK body，return undefined
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // 异步建立长连接，不阻塞 NestJS 启动
  void wsClient
    .start({ eventDispatcher: dispatcher })
    .then(() => {
      logger.info('飞书长连接已建立', { module: 'FeishuWSClient' });
    })
    .catch((err: Error) => {
      logger.error('飞书长连接启动失败', {
        module: 'FeishuWSClient',
        error: err.message,
        stack: err.stack,
      });
    });

  started = true;
  return true;
}

/**
 * 关闭飞书长连接（进程退出时调用）
 */
export function closeFeishuWsClient(): void {
  if (!wsClient || !started) return;
  try {
    wsClient.close({ force: false });
    logger.info('飞书长连接已关闭', { module: 'FeishuWSClient' });
  } catch (err) {
    const e = err as Error;
    logger.warn('飞书长连接关闭失败（忽略）', {
      module: 'FeishuWSClient',
      error: e.message,
    });
  } finally {
    wsClient = null;
    started = false;
  }
}
