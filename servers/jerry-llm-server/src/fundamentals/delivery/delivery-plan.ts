/**
 * DeliveryPlan —— 交付计划（两阶段交付架构·阶段一）
 *
 * 设计背景（生产案例 2026-11-19，邮件缺图 + 自动补发）：
 *   旧架构中 send_notification 在 LLM 工具循环内被调用时**立即真实发送**，
 *   与同轮并发的 generate_image 赛跑（邮件先发 → 图片后生成 → 邮件缺图），
 *   且模型自愈/流式 DSML 可再次调用外发（用户收到重复邮件）。
 *
 * 根治方案（Transactional Outbox 模式）：
 *   LLM 不再直接持有"对外发送"的权力。send_notification 执行时只登记
 *   DeliveryPlan（交付草案），真实发送由循环外的 DeliveryExecutor 统一执行：
 *   发送前完成附件引用完整性校验 + 幂等去重。
 *
 * 本文件职责：交付计划的 zod schema 与类型定义（单一事实源）。
 * Executor 见同目录 delivery-executor.ts。
 *
 * 附件引用协议：
 *   - fc://image/{key}    生成图片（工具循环阶段收集的产物）
 *   - fc://chart/{key}    图表静态 PNG（ECharts 渲染产物）
 *   - fc://mindmap/{key}  思维导图静态 PNG
 *   - fc://document/{key} 生成的文档（PDF/DOCX/HTML/MD）
 *   - http(s)://...       外部直链（DashScope OSS 等工具返回的原始 URL，透传）
 *   fc:// 引用在发送前由 Executor 从本轮 Workspace 解析为真实产物；
 *   解析不到 → 整个计划拒发（绝不发出附件残缺的邮件）。
 */

import { z } from 'zod';

// ==================== 附件引用协议 ====================

/** 支持解析的 fc:// 内部协议清单（key 为系统生成的产物标识） */
export const FC_PROTOCOL_PREFIXES = [
  'fc://image/',
  'fc://chart/',
  'fc://mindmap/',
  'fc://document/',
] as const;

/**
 * 判断 URL 是否为 fc:// 内部协议引用
 * @param url 附件 URL
 */
export function isFcProtocolUrl(url: string): boolean {
  return FC_PROTOCOL_PREFIXES.some((p) => url.startsWith(p));
}

/**
 * 判断 URL 是否为可直接下载的外部直链
 * @param url 附件 URL
 */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// ==================== Zod Schema ====================

/** 附件（引用形态）：模型传的还是 {filename, url}，url 支持协议引用 */
export const deliveryAttachmentSchema = z.object({
  filename: z.string().min(1).describe('附件文件名（含扩展名，如 chart.png）'),
  url: z
    .string()
    .min(1)
    .describe(
      '附件地址：工具返回的 fc:// 协议引用或 http(s) 外链。' +
        '发送前系统会校验 fc:// 引用真实存在，引用缺失将拒发整封邮件',
    ),
  cid: z
    .string()
    .optional()
    .describe('Content-ID，邮件内嵌图片用，可选'),
});

/** 交付计划：由 send_notification 登记Executor 在循环外消费 */
export const deliveryPlanSchema = z.object({
  channel: z
    .enum(['email', 'feishu', 'webhook'])
    .describe('交付通道（与 send_notification 三通道一致）'),
  title: z.string().min(1).max(500).describe('通知标题（邮件主题/卡片标题）'),
  content: z
    .string()
    .max(200_000)
    .describe('通知正文，Markdown 文本'),
  recipients: z
    .array(z.string())
    .optional()
    .describe('接收人列表（email 传邮箱；feishu 传 open_id/chat_id/邮箱；webhook 忽略）'),
  webhookUrl: z.string().optional().describe('webhook 通道地址，仅 webhook 时必填'),
  attachments: z
    .array(deliveryAttachmentSchema)
    .max(20)
    .optional()
    .describe('附件引用列表（fc:// 协议或 http 外链），发送前校验完整性'),
  /**
   * 幂等键：同一键的重复交付直接返回上次回执，结构上杜绝重复发送。
   * 由登记层生成（sessionId + 轮次 + 计划序号），不信任模型传入。
   */
  dedupeKey: z
    .string()
    .min(8)
    .max(200)
    .describe('幂等键（系统生成），重复键返回首次发送回执'),
  /** 登记时间戳（ms），用于回执记录与过期判断 */
  createdAt: z.number().int().positive().describe('登记时间戳（毫秒）'),
  /** 登记来源：FC 工具循环 / DSML 流式阶段（便于日志与限流归因） */
  source: z
    .enum(['fc-loop', 'dsml-stream'])
    .describe('登记来源（fc-loop=工具调用循环 / dsml-stream=流式文本协议）'),
});

export type DeliveryPlan = z.infer<typeof deliveryPlanSchema>;
export type DeliveryAttachment = z.infer<typeof deliveryAttachmentSchema>;

// ==================== dedupeKey 生成 ====================

/**
 * 生成交付计划的幂等键
 *
 * 键结构：delivery:{sessionId}:{iteration}:{index}
 * - sessionId：会话隔离
 * - iteration：FC 循环轮次 / DSML 轮次（同一轮内的重试不产生新键）
 * - index：本轮内第几个计划（允许一轮发多封给不同对象的场景）
 *
 * 为什么不含参数 hash：同轮模型改参数重调（补发场景）拿到的是**同一个键**，
 * 拿到的是首次发送的回执——这正是"补发在结构上不可能"的实现点。
 *
 * @param sessionId 会话 ID
 * @param iteration 执行轮次
 * @param index 本轮内计划序号
 */
export function buildDedupeKey(
  sessionId: string,
  iteration: number,
  index: number,
): string {
  return `delivery:${sessionId}:${iteration}:${index}`;
}

// ==================== 登记结果 ====================

/** send_notification 登记计划后返回给模型的结果（替代真实发送回执） */
export interface DeliveryPlanRegistration {
  success: true;
  type: 'delivery_plan';
  /** 计划幂等键（Executor 消费与幂等判断的依据） */
  dedupeKey: string;
  /** 通道 */
  channel: DeliveryPlan['channel'];
  /** 附件数量（fc:// 引用将在发送前校验） */
  attachmentCount: number;
  message: string;
}
