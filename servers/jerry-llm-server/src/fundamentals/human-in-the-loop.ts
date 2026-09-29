/**
 * Human-in-the-Loop 确认机制
 *
 * 对于敏感操作（删除数据、发送通知、执行代码等），
 * 工具执行前需要用户确认。
 *
 * 工作流程：
 * 1. executeTool 检测到 requiresConfirmation 的工具
 * 2. 通过 SSE 推送 confirmation_request 事件到前端
 * 3. 前端显示确认对话框
 * 4. 用户确认/拒绝后，通过 HTTP 接口回传结果
 * 5. 挂起的工具调用被恢复或取消
 *
 * 扩展：飞书双通道审批（B2）
 *   - 如果配置了 NOTIFY_FEISHU_HITL_USER（接收人 open_id/邮箱），
 *     创建确认请求时会同步发送飞书卡片，用户可在飞书点按钮审批
 *   - 飞书 / Web 任一端审批生效，另一端的请求自动失效
 */

import { logger } from './logger';
import {
  sendCardMessage,
  buildCardJson,
  detectReceiveIdType,
  updateCard,
} from './feishu-notify.service';
import { sendConfirmationResolved } from './sse-writer';
import { publishHITLEvent } from './chat-event-bus';
import { metrics } from './metrics';
import type { Response } from 'express';

// 待确认的工具调用
interface PendingConfirmation {
  id: string;
  toolName: string;
  params: any;
  paramsSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  message: string;
  resolve: (confirmed: boolean) => void;
  createdAt: Date;
  /** 数据归属用户：HITL 广播按它分发到该用户的所有端（桌面/移动/未登录 default） */
  ownerUserId: string;
  /** 飞书消息 ID（如果同步推送了飞书卡片）。用于审批后更新卡片状态 */
  feishuMessageId?: string;
  /** Web 端 SSE Response，用于飞书侧审批后反向通知 Web 关闭弹窗 */
  sseRes?: Response;
}

// 待确认队列
const pendingConfirmations = new Map<string, PendingConfirmation>();

// 确认请求超时时间（默认5分钟）
const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 需要人工确认的工具列表及其风险等级和提示信息
 * 对于有多种操作的工具，可通过 actionFilter 指定哪些操作需要确认
 */
const CONFIRMATION_CONFIG: Record<
  string,
  {
    riskLevel: 'low' | 'medium' | 'high';
    message: string;
    paramSummary: (params: any) => string;
    actionFilter?: string[];
  }
> = {
  manage_session: {
    riskLevel: 'medium',
    message: '即将执行会话管理操作',
    paramSummary: (params) =>
      `操作：${params.action}${params.title ? `，标题：${params.title}` : ''}${params.session_id ? `，会话ID：${params.session_id}` : ''}`,
    // 只有破坏性操作需要确认，只读操作（list/search/list_tags）不需要
    actionFilter: [
      'delete',
      'create',
      'rename',
      'pin',
      'unpin',
      'switch',
      'add_tag',
      'remove_tag',
      'set_category',
    ],
  },

  // ---------------- 文档管理域工具：按"增删改一律确认"规则 ----------------
  // 设计文档 ai-operate-all-interfaces-design.md：凡写操作（增/删/改）必须人工确认，
  // 只读工具（list_documents / list_document_versions）不入本表即免确认。
  // 三端（Web/手机/飞书）确认由 executeTool 中央拦截 + HITL 广播自动完成。
  create_document: {
    riskLevel: 'medium',
    message: '即将在知识库中创建新文档',
    paramSummary: (params) =>
      `标题：${(params.title || '').slice(0, 60)}，内容 ${String(params.content || '').length} 字`,
  },
  update_document: {
    riskLevel: 'medium',
    message: '即将更新文档内容（产生新版本，历史保留）',
    paramSummary: (params) =>
      `文档ID：${params.documentId}，新内容 ${String(params.content || '').length} 字`,
  },
  update_document_meta: {
    riskLevel: 'medium',
    message: '即将修改文档元信息（标签/标题/描述，不改动正文）',
    paramSummary: (params) => {
      const parts: string[] = [`文档ID：${params.documentId}`];
      if (params.title !== undefined) parts.push(`标题→${params.title}`);
      if (params.description !== undefined) parts.push('描述');
      if (params.tags !== undefined)
        parts.push(`标签→[${(params.tags as string[]).join('、') || '清空'}]`);
      return parts.join('，');
    },
  },
  delete_document: {
    riskLevel: 'high',
    message: '即将删除文档（含全部版本与向量数据，不可恢复）',
    paramSummary: (params) =>
      `文档ID：${params.documentId}${params.title ? `，标题：${params.title}` : ''}`,
  },
  restore_document_version: {
    riskLevel: 'high',
    message: '即将把文档恢复到历史版本（以旧内容生成新版本，历史保留）',
    paramSummary: (params) =>
      `版本ID：${params.versionId}${params.documentTitle ? `，文档：${params.documentTitle}` : ''}`,
  },

  // ---------------- 知识源/知识库维护工具（第 2 批） ----------------
  // 按"增删改一律确认"规则：add/delete/sync/rebuild 需确认，
  // 只读工具（list_knowledge_sources / get_knowledge_status）不入本表即免确认。
  add_knowledge_source: {
    riskLevel: 'medium',
    message: '即将添加 Web 爬取知识源（会发起网络爬取并把内容写入知识库）',
    paramSummary: (params) =>
      `名称：${(params.name || '').slice(0, 50)}，URL：${String(params.url || '').slice(0, 80)}`,
  },
  delete_knowledge_source: {
    riskLevel: 'high',
    message: '即将删除知识源（其下已爬取的页面与向量数据一并删除，不可恢复）',
    paramSummary: (params) =>
      `知识源ID：${params.sourceId}${params.name ? `，名称：${params.name}` : ''}`,
  },
  sync_knowledge_source: {
    riskLevel: 'medium',
    message: '即将触发知识源同步（爬取新内容入库，长任务）',
    paramSummary: (params) =>
      `知识源ID：${Array.isArray(params.sourceIds) ? params.sourceIds.join('、') : params.sourceIds}`,
  },
  rebuild_knowledge_index: {
    riskLevel: 'high',
    message: '即将全量重建向量索引（所有文档重新嵌入，耗时较长）',
    paramSummary: () => '全量重建知识库向量索引',
  },

  // ---------------- 设置域/收藏工具（第 3 批） ----------------
  // get_system_status / query_evaluation_stats / list_favorite_documents 为只读，免确认。
  switch_model: {
    riskLevel: 'medium',
    message: '即将切换全局对话模型（所有端同步生效）',
    paramSummary: (params) => `目标模型：${params.modelId}`,
  },
  toggle_feature: {
    riskLevel: 'medium',
    message: '即将切换功能开关全局默认（未自定义过该开关的设备自动跟随）',
    paramSummary: (params) =>
      `功能：${params.feature}，目标状态：${params.enabled ? '开启' : '关闭'}`,
  },
  toggle_document_favorite: {
    riskLevel: 'low',
    message: '即将收藏/取消收藏 AI 生成文档',
    paramSummary: (params) =>
      `${params.favorited ? '收藏' : '取消收藏'}：${params.title ? `《${String(params.title).slice(0, 50)}》` : params.key}`,
  },

  // ---------------- 三大外部 API 工具：均需要用户确认 ----------------
  // send_notification 会向第三方/用户发送消息，存在打扰风险，标记为 medium
  send_notification: {
    riskLevel: 'medium',
    message: '即将发送通知，请确认后再继续',
    paramSummary: (params) => {
      const channel = params.channel || '?';
      const recipients = Array.isArray(params.recipients)
        ? params.recipients.join(', ')
        : '';
      const target =
        params.channel === 'webhook' ? params.webhookUrl : recipients;
      return `通道：${channel}${target ? `，目标：${String(target).slice(0, 80)}` : ''}，标题：${(params.title || '').slice(0, 40)}`;
    },
  },
  // query_database 即便是只读 SELECT，也涉及外部业务数据，标记为 low（轻量提示）
  query_database: {
    riskLevel: 'low',
    message: '即将执行数据库查询',
    paramSummary: (params) => {
      const sql = (params.sql || '').replace(/\s+/g, ' ').trim();
      return `${params.purpose ? `用途：${params.purpose}；` : ''}SQL：${sql.slice(0, 120)}`;
    },
  },
  // mcp_proxy 调用外部 MCP Server，可能执行写操作（如创建文件、提交 PR），标记为 high
  mcp_proxy: {
    riskLevel: 'high',
    message: '即将调用 MCP 外部工具，可能产生副作用',
    paramSummary: (params) =>
      `${params.server}.${params.tool}（${JSON.stringify(params.arguments || {}).slice(0, 100)}）`,
  },
};

/**
 * 判断工具是否需要人工确认
 * @param toolName 工具名称
 * @param params 工具参数（用于 actionFilter 过滤）
 */
export function requiresConfirmation(toolName: string, params?: any): boolean {
  const config = CONFIRMATION_CONFIG[toolName];
  if (!config) return false;
  // 如果配置了 actionFilter，只有匹配的操作才需要确认
  if (config.actionFilter && params?.action) {
    return config.actionFilter.includes(params.action);
  }
  return true;
}

/**
 * 获取工具的确认配置
 */
export function getConfirmationConfig(toolName: string) {
  return CONFIRMATION_CONFIG[toolName] || null;
}

/**
 * 生成确认请求 ID
 */
function generateConfirmationId(): string {
  return `confirm_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * 请求用户确认
 * 返回 Promise（含确认ID），用户确认后 resolve(true)，拒绝后 resolve(false)
 * 超时后 resolve(false)
 *
 * @param ownerUserId 数据归属用户：决定多端广播（/chat/events）分发给谁，
 *                    未传视为 'default'（未登录场景）
 */
export function requestConfirmation(
  toolName: string,
  params: any,
  ownerUserId = 'default',
): Promise<boolean> & { confirmationId: string } {
  const config = CONFIRMATION_CONFIG[toolName];

  const id = generateConfirmationId();
  const promise = new Promise<boolean>((resolve) => {
    if (!config) {
      resolve(true);
      return;
    }

    const paramsSummary = config.paramSummary(params);

    const pending: PendingConfirmation = {
      id,
      toolName,
      params,
      paramsSummary,
      riskLevel: config.riskLevel,
      message: config.message,
      resolve,
      createdAt: new Date(),
      ownerUserId,
    };

    pendingConfirmations.set(id, pending);

    logger.info('人工确认：创建确认请求', {
      module: 'HumanInTheLoop',
      confirmationId: id,
      toolName,
      riskLevel: config.riskLevel,
      paramsSummary,
    });

    // 多端广播：把确认请求推给该用户的所有在线端（桌面 + 移动）。
    // 流内的 sendConfirmationRequest 仍由调用方负责（那条流本身就在收），
    // 前端按 confirmation id 幂等去重，双投递不会弹两个框。
    publishHITLEvent({
      kind: 'hitl',
      ownerUserId,
      at: Date.now(),
      payload: {
        type: 'confirmation_request',
        id,
        toolName,
        paramsSummary,
        riskLevel: config.riskLevel,
        message: config.message,
      },
    });

    // 飞书双通道：如果配置了 HITL 接收人，并行推送飞书卡片
    // 失败不影响 Web 端正常审批流程
    void sendFeishuConfirmationCard(
      id,
      toolName,
      config.riskLevel,
      config.message,
      paramsSummary,
    ).then((result) => {
      if (result && pendingConfirmations.has(id)) {
        const entry = pendingConfirmations.get(id)!;
        entry.feishuMessageId = result.messageId;
      }
    });

    // 超时自动拒绝
    setTimeout(() => {
      const entry = pendingConfirmations.get(id);
      if (entry) {
        pendingConfirmations.delete(id);
        entry.resolve(false);
        metrics.hitlResolved.inc({ action: 'timeout', source: 'web' });
        // 超时也要广播：其他端（移动/桌面）弹窗还挂着，收到后关闭
        publishHITLEvent({
          kind: 'hitl',
          ownerUserId: entry.ownerUserId,
          at: Date.now(),
          payload: {
            type: 'confirmation_resolved',
            id,
            confirmed: false,
            source: 'timeout',
          },
        });
        logger.info('人工确认：确认请求超时，自动拒绝', {
          module: 'HumanInTheLoop',
          confirmationId: id,
          toolName,
        });
      }
    }, CONFIRMATION_TIMEOUT_MS);
  });

  // 将 confirmationId 挂载到 Promise 上，方便调用方获取
  (promise as any).confirmationId = id;
  return promise as Promise<boolean> & { confirmationId: string };
}

/**
 * 关联 Web 端 SSE Response 到指定的 confirmation
 *
 * 调用时机：tools/index.ts 在调用 requestConfirmation 后立即调用此函数。
 * 用途：飞书侧或超时被解决时，能通过 SSE 推 confirmation_resolved 通知 Web 关闭弹窗。
 *
 * 之所以不放进 requestConfirmation 的入参，是为了让 HITL 模块对前端响应类型的依赖
 * 仅限于这一个可选注入点，保持单测可控。
 */
export function attachSseResponseToConfirmation(
  confirmationId: string,
  res: Response,
): void {
  const pending = pendingConfirmations.get(confirmationId);
  if (pending) {
    pending.sseRes = res;
  }
}

/**
 * 处理用户确认响应
 * @param confirmationId 确认请求 ID
 * @param confirmed 是否确认
 * @param source 审批来源（web/feishu），决定是否反向更新另一端的卡片状态
 * @returns 是否成功处理
 */
export function handleConfirmationResponse(
  confirmationId: string,
  confirmed: boolean,
  source: 'web' | 'feishu' = 'web',
): boolean {
  const pending = pendingConfirmations.get(confirmationId);
  if (!pending) {
    logger.warn('人工确认：未找到确认请求', {
      module: 'HumanInTheLoop',
      confirmationId,
    });
    return false;
  }

  pendingConfirmations.delete(confirmationId);
  pending.resolve(confirmed);

  // Prometheus 指标
  metrics.hitlResolved.inc({
    action: confirmed ? 'confirm' : 'reject',
    source,
  });

  // 多端广播：无论哪个端解决（web/feishu），都让该用户所有在线端关闭对应弹窗
  publishHITLEvent({
    kind: 'hitl',
    ownerUserId: pending.ownerUserId,
    at: Date.now(),
    payload: {
      type: 'confirmation_resolved',
      id: confirmationId,
      confirmed,
      source,
    },
  });

  logger.info('人工确认：用户响应', {
    module: 'HumanInTheLoop',
    confirmationId,
    toolName: pending.toolName,
    confirmed,
    source,
  });

  // 飞书侧审批 → 通过 SSE 反向通知 Web 端关闭那个还在等待的弹窗
  // Web 侧审批不需要推（因为弹窗是用户自己点击关闭的）
  if (source === 'feishu' && pending.sseRes) {
    try {
      sendConfirmationResolved(pending.sseRes, {
        id: confirmationId,
        confirmed,
        source: 'feishu',
      });
    } catch (e: any) {
      logger.warn('SSE 推送 confirmation_resolved 失败', {
        module: 'HumanInTheLoop',
        confirmationId,
        error: e.message,
      });
    }
  }

  // 双通道协同：如果 Web 端先确认，且飞书卡片已发出，则反向更新飞书卡片
  // 避免飞书侧用户看到一张永远停在"待审批"的死卡片
  if (source === 'web' && pending.feishuMessageId) {
    void updateFeishuHITLCard(
      pending.feishuMessageId,
      pending.toolName,
      confirmed,
      'Web 端用户',
    ).catch((e) => {
      logger.warn('双通道：反向更新飞书卡片失败', {
        module: 'HumanInTheLoop',
        confirmationId,
        error: e.message,
      });
    });
  }

  return true;
}

/**
 * 获取确认请求关联的飞书消息 ID（供 feishu-event.controller 在飞书侧确认后更新卡片）
 * 由于 handleConfirmationResponse 调用后会删除 entry，所以需要在调用前先取一次
 */
export function getFeishuMessageIdForConfirmation(
  confirmationId: string,
): string | undefined {
  return pendingConfirmations.get(confirmationId)?.feishuMessageId;
}

/**
 * 获取待确认请求的信息（用于 SSE 推送）
 */
export function getPendingConfirmationInfo(confirmationId: string) {
  const pending = pendingConfirmations.get(confirmationId);
  if (!pending) return null;

  return {
    id: pending.id,
    toolName: pending.toolName,
    paramsSummary: pending.paramsSummary,
    riskLevel: pending.riskLevel,
    message: pending.message,
  };
}

/**
 * 注册自定义工具的确认配置
 */
export function registerConfirmationConfig(
  toolName: string,
  config: {
    riskLevel: 'low' | 'medium' | 'high';
    message: string;
    paramSummary: (params: any) => string;
  },
): void {
  CONFIRMATION_CONFIG[toolName] = config;
  logger.info('人工确认：注册工具确认配置', {
    module: 'HumanInTheLoop',
    toolName,
    riskLevel: config.riskLevel,
  });
}

// ==================== 飞书双通道审批（B2/B3） ====================

/** 飞书 HITL 确认卡片：审批结果值 */
function buildHITLButtons(confirmationId: string) {
  return [
    {
      text: '✅ 确认执行',
      value: { action: 'confirm', confirmation_id: confirmationId },
      type: 'primary' as const,
    },
    {
      text: '❌ 拒绝',
      value: { action: 'reject', confirmation_id: confirmationId },
      type: 'danger' as const,
    },
  ];
}

/**
 * 向飞书发送 HITL 确认卡片
 * 失败时静默降级（仅记录日志），不影响 Web 端审批
 */
async function sendFeishuConfirmationCard(
  confirmationId: string,
  toolName: string,
  riskLevel: string,
  message: string,
  paramsSummary: string,
): Promise<{ messageId: string } | null> {
  const hitlUser = process.env.NOTIFY_FEISHU_HITL_USER;
  if (!hitlUser) {
    // 未配置飞书 HITL 接收人，跳过
    return null;
  }

  try {
    const card = buildCardJson({
      title: `🔐 操作确认：${toolName}`,
      content: `${message}\n\n**${riskLevel === 'high' ? '⚠️ 高' : riskLevel === 'medium' ? '⚡ 中' : 'ℹ️ 低'}风险操作**\n\`${paramsSummary}\``,
      headerColor:
        riskLevel === 'high'
          ? 'red'
          : riskLevel === 'medium'
            ? 'yellow'
            : 'blue',
      buttons: buildHITLButtons(confirmationId),
    });

    const idType = detectReceiveIdType(hitlUser);
    const result = await sendCardMessage(hitlUser, idType, card);
    if (!result.success || !result.messageId) {
      logger.warn('飞书 HITL 卡片发送失败', {
        module: 'HumanInTheLoop',
        confirmationId,
        error: result.error,
      });
      return null;
    }

    logger.info('飞书 HITL 卡片已发送', {
      module: 'HumanInTheLoop',
      confirmationId,
      messageId: result.messageId,
    });

    return { messageId: result.messageId };
  } catch (e: any) {
    logger.warn('飞书 HITL 卡片发送异常', {
      module: 'HumanInTheLoop',
      confirmationId,
      error: e.message,
    });
    return null;
  }
}

/**
 * 构建"已处理"卡片 JSON（无副作用，纯函数）
 *
 * 与 updateFeishuHITLCard 的区别：
 *   - updateFeishuHITLCard：异步调 PATCH /im/v1/messages/{id} 更新（Web 端先点时使用）
 *   - buildHITLResolvedCard：纯函数返回 JSON，用于飞书回调的"同步响应"模式
 *
 * 同步响应模式：飞书回调请求的响应 body 直接带 `card` 字段，飞书后端会用这个 JSON
 * 替换用户手机上看到的卡片，**零延迟**生效。比 PATCH 异步更新快几百毫秒到几秒。
 */
export function buildHITLResolvedCard(
  toolName: string,
  confirmed: boolean,
  operator: string,
): Record<string, unknown> {
  const resultIcon = confirmed ? '✅ 已确认' : '❌ 已拒绝';
  const timestamp = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
  });
  return buildCardJson({
    title: `🔐 操作确认：${toolName}（已处理）`,
    content: `${resultIcon}\n\n操作者：${operator}\n时间：${timestamp}`,
    headerColor: confirmed ? 'green' : 'grey',
    // 无 buttons，按钮自然消失
  });
}

/**
 * 更新飞书 HITL 卡片状态（B3 卡片状态机）
 *
 * 双向调用：
 *   - 飞书侧点按钮 → feishu-event.controller 调用
 *   - Web 侧点确认 → handleConfirmationResponse 内部反向调用
 *
 * 更新后卡片移除按钮，标题改为"操作结果"，正文显示谁在何时做了什么决定
 */
export async function updateFeishuHITLCard(
  messageId: string,
  toolName: string,
  confirmed: boolean,
  operator: string,
): Promise<void> {
  const resultIcon = confirmed ? '✅ 已确认' : '❌ 已拒绝';
  const timestamp = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
  });
  const card = buildCardJson({
    title: `🔐 操作确认：${toolName}（已处理）`,
    content: `${resultIcon}\n\n操作者：${operator}\n时间：${timestamp}`,
    headerColor: confirmed ? 'green' : 'grey',
    // 无 buttons，按钮自然消失
  });

  const result = await updateCard(messageId, card);
  if (!result.success) {
    logger.warn('飞书 HITL 卡片更新失败', {
      module: 'HumanInTheLoop',
      messageId,
      error: result.error,
    });
  }
}
