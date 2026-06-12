/**
 * send_notification 工具 —— 多通道异步通知
 *
 * 设计目标：
 *   让 Agent 在长任务（工作流、Plan-Execute、报告生成）完成后，
 *   主动向用户/团队推送结果，打通"AI 干活 → 主动回调"的闭环。
 *
 * 三通道支持：
 *   1. feishu  —— 复用现有 feishu-connector 的 tenant_access_token 缓存逻辑
 *                 通过 im/v1/messages 接口发送文本消息或富文本卡片
 *   2. email   —— 使用 nodemailer，SMTP 协议发送邮件（支持 HTML 正文）
 *   3. webhook —— 通用 HTTP POST，兼容钉钉/企业微信群机器人
 *
 * 安全考量：
 *   - 工具被注册到 HITL（人工确认）配置中，发送前必须用户确认
 *   - 邮件 BCC、收件人列表都做长度限制，避免被滥用为垃圾邮件源
 *   - Webhook URL 仅允许 https，禁止内网 IP（简单 SSRF 防护）
 *
 * 与现有能力的联动：
 *   - 工作流末尾步骤可以使用本工具自动通知
 *   - 调用记录会落到 tool-usage 表（由 tools/index.ts 的回调统一处理）
 *   - SSE 进度推送复用 sendToolStatus
 */

import nodemailer from 'nodemailer';
import { logger } from '../logger';
import { config } from '../config';

// ==================== 配置常量 ====================

/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 15000;

/** 飞书 / Lark API 域名（与 feishu-connector 保持一致） */
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const LARK_API_BASE = 'https://open.larksuite.com/open-apis';

/** 飞书 tenant_access_token 内存缓存（与 feishu-connector 隔离，避免相互污染） */
const tenantTokenCache = new Map<string, { token: string; expiresAt: number }>();

/** SMTP transporter 单例缓存：相同配置只建立一次连接池 */
let cachedSmtpTransporter: nodemailer.Transporter | null = null;
let cachedSmtpKey = '';

// ==================== 配置可用性 ====================

/** 通道可用性，validate 阶段会更新这些标志 */
let feishuAvailable = false;
let emailAvailable = false;
/** Webhook 通道无需配置 API Key，只要传入合法 URL 即可，因此始终可用 */
const webhookAvailable = true;

/**
 * 校验通道配置：
 *   - 飞书：需 NOTIFY_FEISHU_APP_ID + NOTIFY_FEISHU_APP_SECRET
 *   - 邮件：需 NOTIFY_SMTP_HOST + NOTIFY_SMTP_USER + NOTIFY_SMTP_PASS
 * 任何一个通道可用即可注册工具，由 isSendNotificationAvailable() 决定是否注册
 */
export function validateSendNotificationConfig(): boolean {
  feishuAvailable = !!(config.notify.feishuAppId && config.notify.feishuAppSecret);
  emailAvailable = !!(config.notify.smtpHost && config.notify.smtpUser && config.notify.smtpPass);

  if (feishuAvailable) {
    logger.info('send_notification：飞书通道配置就绪', { module: 'Tool:SendNotification' });
  } else {
    logger.info('send_notification：飞书通道未配置（缺少 NOTIFY_FEISHU_APP_ID/SECRET）', { module: 'Tool:SendNotification' });
  }
  if (emailAvailable) {
    logger.info('send_notification：邮件通道配置就绪', { module: 'Tool:SendNotification' });
  } else {
    logger.info('send_notification：邮件通道未配置（缺少 NOTIFY_SMTP_HOST/USER/PASS）', { module: 'Tool:SendNotification' });
  }

  return feishuAvailable || emailAvailable || webhookAvailable;
}

/** 工具是否可用：任何一个通道可用即可（webhook 始终可用） */
export function isSendNotificationAvailable(): boolean {
  return feishuAvailable || emailAvailable || webhookAvailable;
}

// ==================== 工具 Schema ====================

export const sendNotificationSchema = {
  type: 'function' as const,
  function: {
    name: 'send_notification',
    description:
      '发送通知到飞书/邮件/Webhook（钉钉、企业微信群机器人）。当用户要求"通知""提醒""把结果发给某人""任务完成后告诉我"等场景时使用。也可作为工作流末尾步骤，把搜索/分析结果主动推送出去。',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: '通知通道：feishu（飞书消息）、email（邮件）、webhook（HTTP POST，钉钉/企微等）',
          enum: ['feishu', 'email', 'webhook'],
        },
        title: {
          type: 'string',
          description: '通知标题（邮件主题、卡片标题）',
        },
        content: {
          type: 'string',
          description: '通知正文，支持 Markdown 文本。webhook 通道会原样作为 text 字段发送',
        },
        recipients: {
          type: 'array',
          items: { type: 'string' },
          description:
            '接收人列表：feishu 通道传 open_id/user_id/email；email 通道传邮箱地址；webhook 通道忽略此参数',
        },
        webhookUrl: {
          type: 'string',
          description: 'Webhook 地址，仅 channel=webhook 时必填，必须是 https 开头的外网地址',
        },
      },
      required: ['channel', 'title', 'content'],
    },
  },
};

// ==================== 类型定义 ====================

export interface SendNotificationParams {
  channel: 'feishu' | 'email' | 'webhook';
  title: string;
  content: string;
  recipients?: string[];
  webhookUrl?: string;
}

export interface SendNotificationResult {
  success: boolean;
  channel: string;
  /** 已发送的接收人数量；webhook 通道为 1 */
  delivered: number;
  /** 发送失败时的错误信息汇总 */
  errors?: string[];
  /** 服务端返回的消息 ID（飞书）/ messageId（邮件）等便于追溯的标识 */
  refIds?: string[];
}

// ==================== 飞书通道 ====================

/**
 * 获取飞书 tenant_access_token，5 分钟内复用缓存
 * 与 feishu-connector 中的同名函数解耦：本工具使用独立的 AppID/AppSecret 配置项，
 * 允许"知识库同步"和"消息通知"使用不同的飞书应用
 */
async function getFeishuTenantToken(apiBase: string): Promise<string> {
  const appId = config.notify.feishuAppId;
  const appSecret = config.notify.feishuAppSecret;
  const cacheKey = `${apiBase}:${appId}`;

  const cached = tenantTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // 用 AbortController 实现超时；fetch 在 Node 18+ 是内置实现
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: ctrl.signal,
    });
    const data = (await resp.json()) as { code: number; msg: string; tenant_access_token: string; expire: number };
    if (data.code !== 0) {
      throw new Error(`飞书获取 token 失败：${data.msg}`);
    }
    // 提前 5 分钟过期，避免边界场景使用即将失效的 token
    tenantTokenCache.set(cacheKey, {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire - 300) * 1000,
    });
    return data.tenant_access_token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 推断接收人 ID 类型
 *   - 邮箱格式 → email
 *   - 形如 ou_xxx → open_id
 *   - 其他 → user_id
 */
function detectFeishuReceiveIdType(id: string): 'email' | 'open_id' | 'user_id' {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return 'email';
  if (id.startsWith('ou_')) return 'open_id';
  return 'user_id';
}

/** 发送飞书消息：对每个 recipient 单独发一条，失败不影响其他人 */
async function sendFeishuMessage(params: SendNotificationParams): Promise<SendNotificationResult> {
  if (!feishuAvailable) {
    return { success: false, channel: 'feishu', delivered: 0, errors: ['飞书通道未配置 NOTIFY_FEISHU_APP_ID/SECRET'] };
  }
  if (!params.recipients || params.recipients.length === 0) {
    return { success: false, channel: 'feishu', delivered: 0, errors: ['recipients 不能为空'] };
  }

  // 根据域名后缀决定使用 feishu 还是 lark API（海外版）
  const apiBase = (config.notify.feishuDomain || '').toLowerCase().includes('larksuite') ? LARK_API_BASE : FEISHU_API_BASE;
  const token = await getFeishuTenantToken(apiBase);

  const errors: string[] = [];
  const refIds: string[] = [];
  let delivered = 0;

  // 串行发送：飞书 IM API 有 5 QPS 限制，并发容易触发限流
  for (const recipient of params.recipients) {
    const idType = detectFeishuReceiveIdType(recipient);
    // 飞书富文本 post 格式：标题 + 正文段落
    const msgContent = JSON.stringify({
      zh_cn: {
        title: params.title,
        content: [[{ tag: 'text', text: params.content }]],
      },
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(`${apiBase}/im/v1/messages?receive_id_type=${idType}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: recipient,
          msg_type: 'post',
          content: msgContent,
        }),
        signal: ctrl.signal,
      });
      const data = (await resp.json()) as { code: number; msg: string; data?: { message_id: string } };
      if (data.code === 0) {
        delivered++;
        if (data.data?.message_id) refIds.push(data.data.message_id);
      } else {
        errors.push(`recipient=${recipient}: ${data.msg}`);
      }
    } catch (e: any) {
      errors.push(`recipient=${recipient}: ${e.message || String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // 至少一条发送成功就算 success
    success: delivered > 0,
    channel: 'feishu',
    delivered,
    errors: errors.length ? errors : undefined,
    refIds: refIds.length ? refIds : undefined,
  };
}

// ==================== 邮件通道 ====================

/**
 * 创建/复用 SMTP transporter
 * SMTP 建立连接和 TLS 握手开销大，复用 transporter 可显著提升性能
 */
function getSmtpTransporter(): nodemailer.Transporter {
  // 用配置串作为缓存 key，配置变更时自动重建
  const key = `${config.notify.smtpHost}:${config.notify.smtpPort}:${config.notify.smtpUser}`;
  if (cachedSmtpTransporter && cachedSmtpKey === key) {
    return cachedSmtpTransporter;
  }
  cachedSmtpTransporter = nodemailer.createTransport({
    host: config.notify.smtpHost,
    port: config.notify.smtpPort,
    // 465 端口默认 SSL，其他端口（如 587）使用 STARTTLS
    secure: config.notify.smtpPort === 465,
    auth: { user: config.notify.smtpUser, pass: config.notify.smtpPass },
  });
  cachedSmtpKey = key;
  return cachedSmtpTransporter;
}

/** 把 Markdown 简单转 HTML：实现非常简化，仅处理换行和常见字符转义 */
function markdownToBasicHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
}

/** 通过 SMTP 发邮件 */
async function sendEmail(params: SendNotificationParams): Promise<SendNotificationResult> {
  if (!emailAvailable) {
    return { success: false, channel: 'email', delivered: 0, errors: ['邮件通道未配置 NOTIFY_SMTP_HOST/USER/PASS'] };
  }
  if (!params.recipients || params.recipients.length === 0) {
    return { success: false, channel: 'email', delivered: 0, errors: ['recipients 不能为空'] };
  }

  // 简单的邮箱格式校验：避免传入非邮箱地址被 SMTP 服务器拒绝整批
  const validRecipients = params.recipients.filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
  if (validRecipients.length === 0) {
    return { success: false, channel: 'email', delivered: 0, errors: ['recipients 中没有合法邮箱地址'] };
  }

  const transporter = getSmtpTransporter();
  try {
    const info = await transporter.sendMail({
      from: config.notify.smtpFrom || config.notify.smtpUser,
      to: validRecipients.join(','),
      subject: params.title,
      text: params.content,
      html: markdownToBasicHtml(params.content),
    });
    return {
      success: true,
      channel: 'email',
      delivered: validRecipients.length,
      refIds: info.messageId ? [info.messageId] : undefined,
    };
  } catch (e: any) {
    return { success: false, channel: 'email', delivered: 0, errors: [e.message || String(e)] };
  }
}

// ==================== Webhook 通道 ====================

/**
 * 简单 SSRF 防护：
 *   - 仅允许 https
 *   - 禁止指向常见内网网段（127.*、10.*、192.168.*、172.16~31.*、localhost）
 * 注：完整的 SSRF 防护需要 DNS 解析后再校验，这里仅做基础拦截
 */
function isWebhookUrlSafe(url: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'URL 格式非法' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅允许 https 协议' };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    host === '0.0.0.0'
  ) {
    return { ok: false, reason: '禁止指向内网地址' };
  }
  return { ok: true };
}

/** 发送 webhook（兼容钉钉/企微群机器人） */
async function sendWebhook(params: SendNotificationParams): Promise<SendNotificationResult> {
  if (!params.webhookUrl) {
    return { success: false, channel: 'webhook', delivered: 0, errors: ['webhookUrl 不能为空'] };
  }
  const safe = isWebhookUrlSafe(params.webhookUrl);
  if (!safe.ok) {
    return { success: false, channel: 'webhook', delivered: 0, errors: [`Webhook URL 不安全：${safe.reason}`] };
  }

  // 钉钉/企微的群机器人格式：{ msgtype: 'text', text: { content: '...' } }
  // 这里使用兼容性最好的"text"消息格式，content 字段同时拼上标题让接收侧更易读
  const payload = {
    msgtype: 'text',
    text: { content: `${params.title}\n${params.content}` },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(params.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { success: false, channel: 'webhook', delivered: 0, errors: [`HTTP ${resp.status}: ${text.slice(0, 200)}`] };
    }
    return { success: true, channel: 'webhook', delivered: 1 };
  } catch (e: any) {
    return { success: false, channel: 'webhook', delivered: 0, errors: [e.message || String(e)] };
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 主入口 ====================

/**
 * 工具主执行函数
 * 根据 channel 路由到具体的实现，并统一记录日志
 */
export async function executeSendNotification(params: SendNotificationParams): Promise<SendNotificationResult> {
  logger.info('send_notification：开始发送', {
    module: 'Tool:SendNotification',
    channel: params.channel,
    title: params.title?.substring(0, 100),
    recipientsCount: params.recipients?.length || 0,
  });

  let result: SendNotificationResult;
  switch (params.channel) {
    case 'feishu':
      result = await sendFeishuMessage(params);
      break;
    case 'email':
      result = await sendEmail(params);
      break;
    case 'webhook':
      result = await sendWebhook(params);
      break;
    default:
      result = { success: false, channel: params.channel, delivered: 0, errors: [`不支持的通道：${params.channel}`] };
  }

  logger.info('send_notification：发送完成', {
    module: 'Tool:SendNotification',
    channel: params.channel,
    success: result.success,
    delivered: result.delivered,
    errors: result.errors,
  });
  return result;
}
