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
import crypto from 'crypto';
import { z } from 'zod';
import { logger } from '../logger';
import { config } from '../config';
import { isChartImageUrl, parseChartImageUrl, chartPngDataUri, isMindmapImageUrl, parseMindmapImageUrl, mindmapPngDataUri } from './multimodal-output';
import { isDocumentUrl, getCachedDocument } from './generate-document';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';
import { metrics } from '../metrics';
import {
  uploadImage as feishuUploadImage,
  uploadFile as feishuUploadFile,
  sendCardMessage,
  sendImageMessage,
  sendFileMessage,
  detectReceiveIdType,
  resolveOpenIdByEmail,
  buildCardJson,
} from '../feishu-notify.service';

// ==================== 配置常量 ====================

/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 15000;

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

// 单个附件 schema：filename 必填，url / content / cid 均可选
const sendNotificationAttachmentSchema = z.object({
  filename: z
    .string()
    .min(1)
    .describe(
      '附件文件名（含扩展名，如 report.pdf、star-sky.png、readme.md）。扩展名决定 MIME 类型',
    ),
  url: z
    .string()
    .optional()
    .describe(
      '附件文件的 URL。接受：generate_image 返回的 images[].url、generate_chart 返回的 imageUrl、create_mindmap 返回的 imageUrl、search_knowledge_base 结果中 ![图片 N](http://...) 的图片 URL，或任意 http/https URL / base64 data URI',
    ),
  content: z
    .string()
    .optional()
    .describe('Base64 编码的文件内容（如无 url 可用此字段），支持任意文件类型'),
  cid: z
    .string()
    .optional()
    .describe('Content-ID。图片文件设置此值后可嵌入正文，非图片文件忽略'),
});

export const sendNotificationParamsSchema = z.object({
  channel: z
    .enum(['feishu', 'email', 'webhook'])
    .describe(
      '通知通道，三选一：\n' +
      '- **feishu**：通过飞书自建应用 OpenAPI 发送。**所有"发到飞书"/"发到飞书群"/"发到飞书的某某群"的请求都必须用此通道**。支持发给个人 open_id (ou_xxx)、群聊 chat_id (oc_xxx)、邮箱、user_id；支持互动卡片、图片消息、文件消息。\n' +
      '- **email**：通过 SMTP 发邮件，recipients 传邮箱地址。\n' +
      '- **webhook**：通过用户**显式提供**的 HTTP POST URL（钉钉群机器人、企微群机器人、自建服务等）。**仅当用户明确给出 https:// 开头的 Webhook 地址时才用此通道**。⚠️ 不要为"发飞书群"选 webhook —— 飞书群已通过 feishu 通道 + chat_id 直接发送，不需要 Webhook。',
    ),
  title: z.string().min(1).describe('通知标题（邮件主题、卡片标题）'),
  content: z
    .string()
    .min(1)
    .describe('通知正文，支持 Markdown 文本。webhook 通道会原样作为 text 字段发送'),
  recipients: z
    .array(z.string())
    .optional()
    .describe(
      '接收人列表。feishu 通道支持四种 ID：① 邮箱（飞书绑定的邮箱）② open_id（ou_ 开头，个人）③ chat_id（oc_ 开头，群聊）④ user_id（企业内编号）；email 通道传邮箱地址；webhook 通道忽略此参数。\n' +
      '⚠️ 重要规则：\n' +
      '- 用户明确指定接收人时（"发到 xx 群"/"发给 yy 用户"），**只**发给该指定接收人，不要额外追加其他记忆里的接收人。\n' +
      '- 用户提到群名称（如"测试群""超级群"）时，应使用群的 chat_id (oc_xxx)，不要把群名字符串当 recipient 传入。\n' +
      '- 同一个通知**不要拆成多次工具调用**：所有需要发的接收人放进同一个 recipients 数组，一次调用完成。',
    ),
  webhookUrl: z
    .string()
    .optional()
    .describe(
      'Webhook 地址，仅 channel=webhook 时必填，必须是 https 开头的外网地址',
    ),
  attachments: z
    .array(sendNotificationAttachmentSchema)
    .optional()
    .describe(
      '附件列表，**全部三个通道（feishu/email/webhook）均生效**。\n' +
      '- email 通道：图片自动内嵌正文，PDF/Word/Markdown 等作为邮件附件。\n' +
      '- feishu 通道：图片上传飞书素材库后作为「图片消息」单独发出，可点击放大；PDF/Word/Excel 作为「文件消息」发出，群里可在线预览。\n' +
      '- 重要：用户要求"把图发飞书""把 PDF 发飞书""三个东西都发飞书"等场景，**必须**把 generate_chart / create_mindmap / generate_image / generate_document 返回的 url（含 fc:// 协议）填入此字段，不能只在 content 里描述文字。少传 attachments 等于没发附件。',
    ),
});

export type SendNotificationParams = z.infer<typeof sendNotificationParamsSchema>;

export const sendNotificationSchema = buildToolJsonSchema(
  'send_notification',
  '发送通知到飞书/邮件/Webhook（钉钉、企业微信群机器人）。当用户要求"通知""提醒""把结果发给某人""任务完成后告诉我"等场景时使用。也可作为工作流末尾步骤，把搜索/分析结果主动推送出去。',
  sendNotificationParamsSchema,
);

// ==================== 类型定义 ====================

export interface SendNotificationResult {
  success: boolean;
  channel: string;
  /** 已发送的接收人数量；webhook 通道为 1 */
  delivered: number;
  /** 发送失败时的错误信息汇总 */
  errors?: string[];
  /** 服务端返回的消息 ID（飞书）/ messageId（邮件）等便于追溯的标识 */
  refIds?: string[];
  /**
   * 结构化错误反馈：当工具失败时给 LLM 的修正建议。
   * LLM 看到 suggestion.hint 后会自动调整参数重试，无需用户介入。
   * 仅在能明确给出修正方案的失败场景下出现（如：channel 选错、参数缺失）。
   */
  suggestion?: {
    /** 建议的动作类型 */
    action: 'switch_channel' | 'add_param' | 'fix_recipient';
    /** 建议切换到的目标通道（仅 switch_channel 时填） */
    to?: string;
    /** 用户可读的原因 */
    reason: string;
    /** LLM 可直接据此构造下一次调用的参数提示 */
    hint: string;
  };
}

// ==================== 正文 Markdown 图片处理 ====================
//
// 背景：知识库检索结果中的图片以 `![图片 N](http://.../images/...)` Markdown 语法
// 进入 AI 回复。模型调用本工具时通常只把整段文本复制进 content，
// 不会主动把图片 URL 填进 attachments —— 导致图片在邮件/飞书中丢失。
// 因此发送前由服务端自动提取正文图片 URL 转为附件，保证"图随文走"（不赌模型行为）。

/**
 * 提取正文中的 Markdown 图片语法（alt + url）
 * 仅匹配 http/https URL；fc:// 内部协议与 data URI 不会出现在正文中，无需处理
 */
function extractMarkdownImages(content: string): Array<{ alt: string; url: string }> {
  // 每次调用创建新正则，避免 /g 正则 lastIndex 共享状态陷阱
  const regex = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const results: Array<{ alt: string; url: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    results.push({ alt: match[1], url: match[2] });
  }
  return results;
}

/**
 * 为自动提取的图片推断附件文件名：
 * 优先取 URL path 最后一段（含合法图片扩展名时采纳），否则用序号兜底命名
 */
function inferImageFilenameFromUrl(url: string, index: number): string {
  try {
    const basename = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(basename)) {
      return basename;
    }
  } catch {
    // URL 解析失败走兜底命名
  }
  return `image_${index + 1}.png`;
}

/**
 * 自动提取正文中的 Markdown 图片 URL，补充到 attachments
 * 去重规则：
 *   - 已在 attachments 中出现的 URL 不重复添加
 *   - 同一 URL 在正文中出现多次只提取一次
 */
function mergeContentImagesIntoAttachments(params: SendNotificationParams): void {
  const images = extractMarkdownImages(params.content);
  if (images.length === 0) return;

  const existingUrls = new Set(
    (params.attachments || []).map((a) => a.url).filter((u): u is string => !!u),
  );
  const autoAttachments = images
    .filter((img) => !existingUrls.has(img.url))
    .filter((img, idx, arr) => arr.findIndex((x) => x.url === img.url) === idx)
    .map((img, i) => ({
      filename: inferImageFilenameFromUrl(img.url, i),
      url: img.url,
    }));
  if (autoAttachments.length === 0) return;

  params.attachments = [...(params.attachments || []), ...autoAttachments];
  logger.info('send_notification：从正文自动提取图片转为附件', {
    module: 'Tool:SendNotification',
    count: autoAttachments.length,
    urls: autoAttachments.map((a) => a.url),
  });
}

/**
 * 将正文中的 Markdown 图片语法替换为占位文字
 * 用于邮件 HTML / 飞书卡片等不支持 Markdown 图片渲染的通道，
 * 图片本体已作为附件单独发送，正文保留占位提示即可
 */
function replaceMarkdownImagesWithPlaceholder(content: string): string {
  return content.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, alt: string) => `[${alt || '图片'}：见下方附件]`,
  );
}

// ==================== 飞书通道 ====================

/**
 * 解析附件 URL 到二进制 Buffer
 * 处理流程：
 *   1. data URI → 直接解码
 *   2. fc://chart/xxx / fc://mindmap/xxx → 调用对应渲染器拿 PNG
 *   3. fc://document/xxx → 从持久化服务读取
 *   4. http(s) URL → 网络下载
 * 与 downloadAttachmentToBase64 共享逻辑，但返回 Buffer 而非 base64 字符串
 */
async function resolveAttachmentBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  // 复用邮件通道已有的 base64 解析逻辑
  const result = await downloadAttachmentToBase64(url);
  if (!result) return null;
  return {
    buffer: Buffer.from(result.base64, 'base64'),
    mimeType: result.mimeType,
  };
}

/**
 * 生成消息幂等 uuid（F1 防止重复发送）
 * 同一个 (channel, recipient, title, content, attachments) 组合在 5 分钟内会得到相同 uuid
 * 飞书侧会拒绝相同 uuid 的重复请求
 */
function buildIdempotentUuid(
  receiveId: string,
  title: string,
  content: string,
  attachmentCount: number,
): string {
  // 时间窗口：5 分钟内的请求视为同一次，超过则允许重发
  const timeWindow = Math.floor(Date.now() / (5 * 60 * 1000));
  const raw = `${receiveId}|${title}|${content}|${attachmentCount}|${timeWindow}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * 发送飞书消息（A3 互动卡片 + A1 图片 + A2 文件）
 *
 * 发送策略：
 *   1. 主消息 = 互动卡片（标题/正文/字段列表/查看原图链接）
 *   2. 图片附件 → 上传后作为独立图片消息发出（飞书卡片对图片支持有限）
 *   3. 非图片附件 → 上传后作为独立文件消息发出
 *
 * 失败容忍：
 *   - 单个 recipient 失败不影响其他人
 *   - 附件上传失败时降级为"卡片 + 错误提示"，主消息照常发送
 */
async function sendFeishuMessage(params: SendNotificationParams): Promise<SendNotificationResult> {
  if (!feishuAvailable) {
    return {
      success: false,
      channel: 'feishu',
      delivered: 0,
      errors: ['飞书通道未配置 NOTIFY_FEISHU_APP_ID/SECRET'],
    };
  }
  if (!params.recipients || params.recipients.length === 0) {
    return {
      success: false,
      channel: 'feishu',
      delivered: 0,
      errors: ['recipients 不能为空'],
      suggestion: {
        action: 'fix_recipient',
        reason: '飞书通道必须指定接收人',
        hint: '请提供 recipients 数组：发个人用 open_id（ou_xxx）或邮箱、发群用 chat_id（oc_xxx）。',
      },
    };
  }

  // ----- 处理附件：分为图片/文件，统一预先上传到飞书素材库 -----
  const imageAttachments: Array<{ filename: string; key: string; sourceUrl?: string }> = [];
  const fileAttachments: Array<{ filename: string; key: string; sizeKB: number }> = [];
  const attachmentErrors: string[] = [];

  if (params.attachments && params.attachments.length > 0) {
    for (let i = 0; i < params.attachments.length; i++) {
      const att = params.attachments[i];
      const filename = att.filename || `attachment_${i + 1}.bin`;

      // 优先使用 url，其次使用 content（base64）
      let buffer: Buffer | undefined;
      let mimeType = inferMimeType(filename);

      if (att.url) {
        const resolved = await resolveAttachmentBuffer(att.url);
        if (resolved) {
          buffer = resolved.buffer;
          if (resolved.mimeType && resolved.mimeType !== 'application/octet-stream') {
            mimeType = resolved.mimeType;
          }
        }
      } else if (att.content) {
        let base64 = att.content;
        if (base64.startsWith('data:')) {
          const parsed = parseDataUri(base64);
          if (parsed) {
            mimeType = parsed.mimeType;
            base64 = parsed.base64;
          }
        }
        buffer = Buffer.from(base64, 'base64');
      }

      if (!buffer) {
        attachmentErrors.push(`附件 ${filename} 内容获取失败`);
        continue;
      }

      const isImage = isImageMime(mimeType);

      if (isImage) {
        // 上传图片素材
        const r = await feishuUploadImage('', buffer);
        if (r.success && r.key) {
          imageAttachments.push({
            filename,
            key: r.key,
            sourceUrl: att.url && (att.url.startsWith('http://') || att.url.startsWith('https://')) ? att.url : undefined,
          });
        } else {
          attachmentErrors.push(`图片 ${filename} 上传失败: ${r.error}`);
          logger.warn('飞书附件：图片上传失败', { module: 'SendNotification', filename, error: r.error });
        }
      } else {
        // 上传文件素材
        const r = await feishuUploadFile('', filename, buffer);
        if (r.success && r.key) {
          fileAttachments.push({
            filename,
            key: r.key,
            sizeKB: Math.round(buffer.length / 1024),
          });
        } else {
          attachmentErrors.push(`文件 ${filename} 上传失败: ${r.error}`);
          logger.warn('飞书附件：文件上传失败', { module: 'SendNotification', filename, error: r.error });
        }
      }
    }
  }

  // ----- 构建互动卡片（包含附件清单字段） -----
  const cardFields: Array<{ label: string; value: string }> = [];
  if (imageAttachments.length > 0) {
    cardFields.push({
      label: '图片附件',
      value: imageAttachments.map((img) => `• ${img.filename}${img.sourceUrl ? ` ([原图](${img.sourceUrl}))` : ''}`).join('\n'),
    });
  }
  if (fileAttachments.length > 0) {
    cardFields.push({
      label: '文件附件',
      value: fileAttachments.map((f) => `• ${f.filename} (${f.sizeKB} KB)`).join('\n'),
    });
  }
  if (attachmentErrors.length > 0) {
    cardFields.push({
      label: '⚠️ 附件警告',
      value: attachmentErrors.join('\n'),
    });
  }

  const card = buildCardJson({
    title: params.title,
    // lark_md 不支持 Markdown 图片语法，替换为占位文字（图片会作为独立图片消息发出）
    content: replaceMarkdownImagesWithPlaceholder(params.content),
    headerColor: 'blue',
    fields: cardFields.length > 0 ? cardFields : undefined,
  });

  const errors: string[] = [];
  const refIds: string[] = [];
  let delivered = 0;

  // 串行发送：飞书 IM API 有 5 QPS 限制
  for (const originalRecipient of params.recipients) {
    // 接收人解析：先按字面识别（邮箱/open_id/chat_id/user_id）
    // 邮箱场景下，先尝试直发；如果飞书返回"找不到用户"类错误，
    // 自动调 contact API 把邮箱换成 open_id 再重试（C1 兜底）
    let recipient = originalRecipient;
    let idType = detectReceiveIdType(recipient);
    const uuid = buildIdempotentUuid(recipient, params.title, params.content, (params.attachments || []).length);

    // 1) 发送主卡片消息
    let cardResult = await sendCardMessage(recipient, idType, card, uuid);

    // 1.1) 邮箱发送失败时的兜底：反查 open_id 重发
    //      飞书邮箱直发要求收件人邮箱必须等于其飞书绑定邮箱；如果用户用了别名/工号邮箱，
    //      直发会失败但 contact API 通常能查到（只要拥有 contact:user.email:readonly 权限）
    if (!cardResult.success && idType === 'email') {
      const openId = await resolveOpenIdByEmail(originalRecipient);
      if (openId) {
        recipient = openId;
        idType = 'open_id';
        const retryUuid = buildIdempotentUuid(recipient, params.title, params.content, (params.attachments || []).length);
        cardResult = await sendCardMessage(recipient, idType, card, retryUuid);
      }
    }

    if (!cardResult.success) {
      errors.push(`recipient=${originalRecipient}: ${cardResult.error}`);
      metrics.feishuMessageSent.inc({ channel: 'card', status: 'failure' });
      continue;
    }
    if (cardResult.messageId) refIds.push(cardResult.messageId);
    metrics.feishuMessageSent.inc({ channel: 'card', status: 'success' });

    // 用最终生效的 recipient/idType 发送附件，保持与主卡片同一目标用户
    const attachmentUuid = buildIdempotentUuid(recipient, params.title, params.content, (params.attachments || []).length);

    // 飞书 uuid 限制：仅 [0-9a-zA-Z]，最长 50 字符。
    // 直接拼 attachmentUuid+img.key 会含下划线且长度超限 → field validation failed。
    // 改为对每个附件再做一次 MD5 哈希，得到 32 位纯 hex 字符串。
    const subUuid = (kind: string, key: string): string =>
      crypto.createHash('md5').update(`${attachmentUuid}|${kind}|${key}`).digest('hex');

    // 2) 逐个发送图片消息（每个图片单独发，飞书原生预览体验最佳）
    for (const img of imageAttachments) {
      const r = await sendImageMessage(recipient, idType, img.key, subUuid('img', img.key));
      if (!r.success) {
        errors.push(`recipient=${originalRecipient}, 图片 ${img.filename}: ${r.error}`);
        metrics.feishuMessageSent.inc({ channel: 'image', status: 'failure' });
      } else {
        if (r.messageId) refIds.push(r.messageId);
        metrics.feishuMessageSent.inc({ channel: 'image', status: 'success' });
      }
    }

    // 3) 逐个发送文件消息
    for (const f of fileAttachments) {
      const r = await sendFileMessage(recipient, idType, f.key, subUuid('file', f.key));
      if (!r.success) {
        errors.push(`recipient=${originalRecipient}, 文件 ${f.filename}: ${r.error}`);
        metrics.feishuMessageSent.inc({ channel: 'file', status: 'failure' });
      } else {
        if (r.messageId) refIds.push(r.messageId);
        metrics.feishuMessageSent.inc({ channel: 'file', status: 'success' });
      }
    }

    delivered++;
  }

  return {
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
  // 正文中的 Markdown 图片语法（![图片 N](url)）在邮件客户端无法渲染，
  // 先替换为占位文字（图片本体已作为内嵌附件展示在下方），再做 HTML 转义
  const bodyHtml = replaceMarkdownImagesWithPlaceholder(content)
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
    const option = await parseChartImageUrl(url);
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
    const mermaidCode = await parseMindmapImageUrl(url);
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
    return {
      success: false,
      channel: 'email',
      delivered: 0,
      errors: ['recipients 中没有合法邮箱地址'],
      suggestion: {
        action: 'fix_recipient',
        reason: 'email 通道需要标准邮箱格式（如 user@example.com），但收到的 recipients 中没有任何符合该格式。',
        hint: '若用户给的是飞书 ID（ou_/oc_ 开头），请改用 channel="feishu"；若是 webhook URL，请改用 channel="webhook"。',
      },
    };
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
    // 结构化错误反馈：LLM 看到 suggestion 会自动改 channel 重试
    // 90% 触发场景：用户说"发飞书群"，LLM 误选 webhook（飞书群 ≠ Webhook）
    return {
      success: false,
      channel: 'webhook',
      delivered: 0,
      errors: ['webhookUrl 不能为空'],
      suggestion: {
        action: 'switch_channel',
        to: 'feishu',
        reason: 'webhook 通道需要 webhookUrl 参数，但用户未提供。若用户提到"飞书群/飞书"，应改用 feishu 通道发送。',
        hint: '若用户需求是发飞书群，请改用 channel="feishu" + recipients=["oc_xxx"]（群的 chat_id）；若是发钉钉/企微群，请向用户索要 webhook URL。',
      },
    };
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
export async function executeSendNotification(rawParams: unknown): Promise<SendNotificationResult> {
  const parsed = safeParseToolParams(sendNotificationParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('send_notification：参数校验失败', {
      module: 'Tool:SendNotification',
      error: parsed.error,
    });
    return {
      success: false,
      channel: (rawParams as { channel?: string })?.channel || 'unknown',
      delivered: 0,
      errors: [`参数校验失败: ${parsed.error}`],
    };
  }
  const params = parsed.data;

  // 自动提取正文 Markdown 图片转附件（保证"图随文走"，不依赖模型主动传 attachments）
  mergeContentImagesIntoAttachments(params);

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
