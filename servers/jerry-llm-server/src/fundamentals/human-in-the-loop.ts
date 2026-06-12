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
 */

import { logger } from './logger';

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
}

// 待确认队列
const pendingConfirmations = new Map<string, PendingConfirmation>();

// 确认请求超时时间（默认5分钟）
const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 需要人工确认的工具列表及其风险等级和提示信息
 * 对于有多种操作的工具，可通过 actionFilter 指定哪些操作需要确认
 */
const CONFIRMATION_CONFIG: Record<string, {
  riskLevel: 'low' | 'medium' | 'high';
  message: string;
  paramSummary: (params: any) => string;
  actionFilter?: string[];
}> = {
  manage_session: {
    riskLevel: 'medium',
    message: '即将执行会话管理操作',
    paramSummary: (params) => `操作：${params.action}${params.title ? `，标题：${params.title}` : ''}${params.session_id ? `，会话ID：${params.session_id}` : ''}`,
    // 只有破坏性操作需要确认，只读操作（list/search/list_tags）不需要
    actionFilter: ['delete', 'create', 'rename', 'pin', 'unpin', 'switch', 'add_tag', 'remove_tag', 'set_category'],
  },

  // ---------------- 三大外部 API 工具：均需要用户确认 ----------------
  // send_notification 会向第三方/用户发送消息，存在打扰风险，标记为 medium
  send_notification: {
    riskLevel: 'medium',
    message: '即将发送通知，请确认后再继续',
    paramSummary: (params) => {
      const channel = params.channel || '?';
      const recipients = Array.isArray(params.recipients) ? params.recipients.join(', ') : '';
      const target = params.channel === 'webhook' ? params.webhookUrl : recipients;
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
    paramSummary: (params) => `${params.server}.${params.tool}（${JSON.stringify(params.arguments || {}).slice(0, 100)}）`,
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
 */
export function requestConfirmation(
  toolName: string,
  params: any,
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
    };

    pendingConfirmations.set(id, pending);

    logger.info('人工确认：创建确认请求', {
      module: 'HumanInTheLoop',
      confirmationId: id,
      toolName,
      riskLevel: config.riskLevel,
      paramsSummary,
    });

    // 超时自动拒绝
    setTimeout(() => {
      const entry = pendingConfirmations.get(id);
      if (entry) {
        pendingConfirmations.delete(id);
        entry.resolve(false);
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
 * 处理用户确认响应
 * @returns 是否成功处理
 */
export function handleConfirmationResponse(
  confirmationId: string,
  confirmed: boolean,
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

  logger.info('人工确认：用户响应', {
    module: 'HumanInTheLoop',
    confirmationId,
    toolName: pending.toolName,
    confirmed,
  });

  return true;
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
