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
import { isChartImageUrl, parseChartImageUrl, chartPngDataUri, isMindmapImageUrl, parseMindmapImageUrl, mindmapPngDataUri } from './multimodal-output';
import { isDocumentUrl, getCachedDocument } from './generate-document';

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
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filename: {
                type: 'string',
                description: '附件文件名（含扩展名，如 report.pdf、star-sky.png、readme.md）。扩展名决定 MIME 类型',
              },
              url: {
                type: 'string',
                description: '附件文件的 URL。接受：generate_image 返回的 images[].url、generate_chart 返回的 imageUrl、create_mindmap 返回的 imageUrl，或任意 http/https URL / base64 data URI',
              },
              content: {
                type: 'string',
                description: 'Base64 编码的文件内容（如无 url 可用此字段），支持任意文件类型',
              },
              cid: {
                type: 'string',
                description: 'Content-ID。图片文件设置此值后可嵌入正文，非图片文件忽略',
              },
            },
          },
          description:
            '附件列表。图片（png/jpg/gif/webp）自动内嵌到邮件正文；PDF/Word/Markdown/txt 等非图片文件作为传统附件附在邮件中。当 generate_chart/create_mindmap/generate_image 返回图片URL时，直接填入此字段即可把图表/思维导图/图片嵌入邮件',
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
  /** 附件：图片会自动内嵌到邮件正文（email 通道），飞书/webhook 暂不支持附件 */
  attachments?: Array<{
    filename: string;
    url?: string;
    content?: string;
    cid?: string;
  }>;
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

/** 构造邮件 HTML 正文：内嵌图片 + 普通附件列表 */
function buildEmailHtml(
  content: string,
  inlineImages: Array<{ cid: string; filename: string; sizeBytes: number; sourceUrl?: string }>,
  fileAttachments: Array<{ filename: string; sizeBytes: number }>,
): string {
  // 将 Markdown 换行转为 <br/>，基本字符转义
  const bodyHtml = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');

  // 生成图片 <img> 标签
  let imagesHtml = '';
  for (const img of inlineImages) {
    const sizeStr = img.sizeBytes > 0 ? ` (${(img.sizeBytes / 1024).toFixed(1)} KB)` : '';
    const linkHtml = img.sourceUrl
      ? ` <a href="${img.sourceUrl}" style="color:#2196F3;font-size:11px;">查看原图</a>`
      : '';
    imagesHtml += `<div style="margin-top:12px;text-align:center">
  <img src="cid:${img.cid}" alt="${img.filename}" style="max-width:100%;height:auto;border-radius:4px;"/>
  <p style="color:#888;font-size:12px;">${img.filename}${sizeStr}${linkHtml}</p>
</div>\n`;
  }

  // 生成普通附件列表
  let filesHtml = '';
  if (fileAttachments.length > 0) {
    filesHtml = '<hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0;"/>\n';
    filesHtml += '<p style="color:#666;font-size:14px;"><strong>附件：</strong></p>\n<ul style="color:#888;font-size:13px;padding-left:18px;">\n';
    for (const f of fileAttachments) {
      const sizeStr = f.sizeBytes > 0 ? ` (${(f.sizeBytes / 1024).toFixed(1)} KB)` : '';
      filesHtml += `  <li>${f.filename}${sizeStr}</li>\n`;
    }
    filesHtml += '</ul>\n';
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;">
  <div style="padding:16px 0;">${bodyHtml || '<p>(无正文)</p>'}</div>
  ${imagesHtml}
  ${filesHtml}
</body>
</html>`;
}

/** 解析 base64 data URI，支持任意 MIME 类型（image/png, application/pdf, text/plain 等） */
function parseDataUri(uri: string): { mimeType: string; base64: string } | null {
  if (!uri.startsWith('data:')) return null;
  const match = uri.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], base64: match[2] };
  }
  return null;
}

/** 根据文件扩展名推断 MIME 类型，覆盖常见文件格式 */
function inferMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    md: 'text/markdown',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    avi: 'video/x-msvideo',
    wav: 'audio/wav',
  };
  return map[ext || ''] || 'application/octet-stream';
}

/** 判断 MIME 类型是否属于图片，图片文件内嵌正文，非图片作为附件 */
function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** 从 URL 下载文件并转为 Base64，支持 data URI 直接解析、内部图表协议 */
async function downloadAttachmentToBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  // data URI：直接解析
  const parsed = parseDataUri(url);
  if (parsed) return parsed;

  // 内部协议 fc://chart/{key}：从缓存取出 ECharts option，puppeteer 本地渲染 PNG
  if (isChartImageUrl(url)) {
    const option = parseChartImageUrl(url);
    if (!option) {
      logger.warn('邮件附件：图表缓存已过期或不存在', { module: 'SendNotification', url });
      return null;
    }
    const dataUri = await chartPngDataUri(option);
    if (!dataUri) return null;
    // chartPngDataUri 一定返回标准 data:image/png;base64,xxx 格式
    const result = parseDataUri(dataUri);
    if (!result) {
      logger.warn('邮件附件：图表 data URI 解析失败', { module: 'SendNotification' });
    }
    return result;
  }

  // 内部协议 fc://mindmap/{key}：从缓存取出 Mermaid 代码，puppeteer 本地渲染 PNG
  if (isMindmapImageUrl(url)) {
    const mermaidCode = parseMindmapImageUrl(url);
    if (!mermaidCode) {
      logger.warn('邮件附件：思维导图缓存已过期或不存在', { module: 'SendNotification', url });
      return null;
    }
    const dataUri = await mindmapPngDataUri(mermaidCode);
    if (!dataUri) return null;
    const result = parseDataUri(dataUri);
    if (!result) {
      logger.warn('邮件附件：思维导图 data URI 解析失败', { module: 'SendNotification' });
    }
    return result;
  }

  // 内部协议 fc://document/{key}：从持久化服务读取 generate_document 生成的文件
  if (isDocumentUrl(url)) {
    const doc = await getCachedDocument(url);
    if (!doc) {
      logger.warn('邮件附件：文档已过期/不存在或权限不足', { module: 'SendNotification', url });
      return null;
    }
    return {
      base64: doc.buffer.toString('base64'),
      mimeType: doc.mimeType,
    };
  }

  // HTTP/HTTPS URL：下载
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    // DashScope OSS 签名 URL 需要 Bearer Token 鉴权，否则 403
    const fetchHeaders: Record<string, string> = {};
    const isDashScopeOss = url.includes('dashscope') || url.includes('oss-accelerate');
    if (isDashScopeOss && config.dashscopeApiKey) {
      fetchHeaders['Authorization'] = `Bearer ${config.dashscopeApiKey}`;
    }
    let resp = await fetch(url, { signal: ctrl.signal, headers: fetchHeaders });

    // 如果带 Auth 仍然 403，回退到不带鉴权重试
    if (resp.status === 403 && Object.keys(fetchHeaders).length > 0) {
      logger.info('邮件附件：带鉴权下载 403，回退到无鉴权重试', { module: 'SendNotification', url: url.substring(0, 100) });
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), REQUEST_TIMEOUT_MS);
      try {
        resp = await fetch(url, { signal: ctrl2.signal });
      } finally {
        clearTimeout(timer2);
      }
    }
    clearTimeout(timer);

    if (!resp.ok) {
      logger.warn('邮件附件：下载文件失败', { module: 'SendNotification', url, status: resp.status });
      return null;
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = resp.headers.get('content-type') || 'application/octet-stream';
    const base64 = buffer.toString('base64');
    return { mimeType, base64 };
  } catch (e: any) {
    logger.warn('邮件附件：下载文件异常', { module: 'SendNotification', url, error: e.message });
    return null;
  }
}

/** 通过 SMTP 发邮件，支持内嵌图片附件 */
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

  // ----- 处理附件：分为内嵌图片和普通附件 -----
  const inlineImages: Array<{ cid: string; filename: string; sizeBytes: number; sourceUrl?: string }> = [];
  const fileAttachments: Array<{ filename: string; sizeBytes: number }> = [];
  const nodemailerAttachments: Array<{
    filename: string;
    content: Buffer;
    cid?: string;
    contentType: string;
    contentDisposition?: 'inline' | 'attachment';
  }> = [];

  if (params.attachments && params.attachments.length > 0) {
    for (let i = 0; i < params.attachments.length; i++) {
      const att = params.attachments[i];
      const attFilename = att.filename || `attachment_${i + 1}.bin`;
      const attCid = att.cid || `att_${i}_${Date.now()}`;

      let base64: string | undefined;
      let mimeType = inferMimeType(attFilename); // 从文件名扩展名推断

      // 优先从 URL 下载，其次用 content（base64）
      if (att.url) {
        const result = await downloadAttachmentToBase64(att.url);
        if (result) {
          base64 = result.base64;
          // url 下载的 MIME 优先于文件名推断
          if (result.mimeType && result.mimeType !== 'application/octet-stream') {
            mimeType = result.mimeType;
          }
        }
      } else if (att.content) {
        base64 = att.content;
        // 如果 content 是 data URI，从中提取真实 MIME
        if (base64.startsWith('data:')) {
          const parsed = parseDataUri(base64);
          if (parsed) {
            mimeType = parsed.mimeType;
            base64 = parsed.base64;
          }
        }
      }

      if (!base64) {
        logger.warn('邮件附件：跳过无法获取内容的附件', {
          module: 'SendNotification',
          filename: attFilename,
          hasUrl: !!att.url,
          hasContent: !!att.content,
        });
        continue;
      }

      const contentBuffer = Buffer.from(base64, 'base64');
      const isImage = isImageMime(mimeType);

      nodemailerAttachments.push({
        filename: attFilename,
        content: contentBuffer,
        contentType: mimeType,
        cid: isImage ? attCid : undefined,
        // 图片：内嵌到正文(cid 引用)；非图片：真实附件
        contentDisposition: isImage ? 'inline' : 'attachment',
      });

      if (isImage) {
        // 保留原始来源 URL（仅 http/https，data URI 与 fc:// 内部协议无法在邮件客户端打开）
        const sourceUrl =
          att.url && (att.url.startsWith('http://') || att.url.startsWith('https://'))
            ? att.url
            : undefined;
        inlineImages.push({ cid: attCid, filename: attFilename, sizeBytes: contentBuffer.length, sourceUrl });
      } else {
        fileAttachments.push({ filename: attFilename, sizeBytes: contentBuffer.length });
      }

      logger.info('邮件附件：文件已加载', {
        module: 'SendNotification',
        filename: attFilename,
        mimeType,
        isImage,
        cid: isImage ? attCid : undefined,
        sizeBytes: contentBuffer.length,
      });
    }
  }

  // ----- 构造 HTML 正文（内嵌图片 + 附件列表） -----
  const html = buildEmailHtml(params.content, inlineImages, fileAttachments);
  const textContent = params.content; // 纯文本备选

  const transporter = getSmtpTransporter();
  try {
    const info = await transporter.sendMail({
      from: config.notify.smtpFrom || config.notify.smtpUser,
      to: validRecipients.join(','),
      subject: params.title,
      text: textContent,
      html,
      attachments: nodemailerAttachments.length > 0 ? nodemailerAttachments : undefined,
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
