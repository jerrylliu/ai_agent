import { z } from 'zod';
import { logger } from '../logger';

// ==================== Zod Schema ====================

const ManageSessionActionSchema = z.enum([
  'list',
  'create',
  'delete',
  'rename',
  'pin',
  'unpin',
  'switch',
  'search',
]);

const ManageSessionParamsSchema = z.object({
  action: ManageSessionActionSchema.describe(
    '要执行的操作：list=列出会话, create=新建会话, delete=删除会话, rename=重命名, pin=置顶, unpin=取消置顶, switch=切换到某会话, search=搜索会话',
  ),
  session_id: z
    .string()
    .optional()
    .describe('目标会话ID（delete/rename/pin/unpin/switch 时必填）'),
  title: z
    .string()
    .optional()
    .describe('会话标题（create 时为新会话标题，rename 时为新标题）'),
  keyword: z
    .string()
    .optional()
    .describe('搜索关键词（search 时使用，按标题模糊匹配）'),
});

// ==================== FC Tool Schema ====================

export const manageSessionSchema = {
  type: 'function' as const,
  function: {
    name: 'manage_session',
    description:
      '管理用户的会话（对话），包括创建、删除、重命名、置顶/取消置顶、切换、查询列表等操作。当用户想用自然语言操作界面上的会话功能时使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list',
            'create',
            'delete',
            'rename',
            'pin',
            'unpin',
            'switch',
            'search',
          ],
          description:
            '要执行的操作：list=列出会话, create=新建会话, delete=删除会话, rename=重命名, pin=置顶, unpin=取消置顶, switch=切换到某会话, search=搜索会话',
        },
        session_id: {
          type: 'string',
          description:
            '目标会话ID（delete/rename/pin/unpin/switch 时必填）',
        },
        title: {
          type: 'string',
          description:
            '会话标题（create 时为新会话标题，rename 时为新标题）',
        },
        keyword: {
          type: 'string',
          description: '搜索关键词（search 时使用，按标题模糊匹配）',
        },
      },
      required: ['action'],
    },
  },
};

// ==================== Types ====================

export type ManageSessionAction = z.infer<typeof ManageSessionActionSchema>;

export interface ManageSessionParams {
  action: ManageSessionAction;
  session_id?: string;
  title?: string;
  keyword?: string;
}

export interface ManageSessionResult {
  success: boolean;
  message: string;
  frontend_action?: {
    type:
      | 'switch_session'
      | 'create_session'
      | 'delete_session'
      | 'refresh_sessions';
    payload: any;
  };
  data?: any;
}

// ==================== AppService 引用 ====================

// 通过 initManageSession 注入 AppService 实例
let appServiceInstance: any = null;

export function initManageSession(appService: any): void {
  appServiceInstance = appService;
  logger.info('manage_session 工具已初始化', { module: 'Tool:ManageSession' });
}

// ==================== Executor ====================

export async function executeManageSession(
  params: ManageSessionParams,
  context?: { userId?: string },
): Promise<ManageSessionResult> {
  const startTime = Date.now();
  const userId = context?.userId || 'default';

  logger.info('FC工具 [manage_session] 开始执行', {
    module: 'Tool:ManageSession',
    action: params.action,
    userId,
    rawParams: JSON.stringify(params),
  });

  // Zod 校验
  const parseResult = ManageSessionParamsSchema.safeParse(params);
  if (!parseResult.success) {
    const errorMsg = parseResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    logger.warn('FC工具 [manage_session] 参数校验失败', {
      module: 'Tool:ManageSession',
      errors: errorMsg,
    });
    return {
      success: false,
      message: `参数校验失败: ${errorMsg}`,
    };
  }

  const validated = parseResult.data;

  if (!appServiceInstance) {
    logger.error('FC工具 [manage_session] AppService 未初始化', {
      module: 'Tool:ManageSession',
    });
    return {
      success: false,
      message: '会话管理服务未初始化，请稍后重试',
    };
  }

  try {
    switch (validated.action) {
      case 'list':
        return await handleList(userId);
      case 'create':
        return await handleCreate(userId, validated.title);
      case 'delete':
        return await handleDelete(userId, validated.session_id);
      case 'rename':
        return await handleRename(userId, validated.session_id, validated.title);
      case 'pin':
        return await handlePin(userId, validated.session_id);
      case 'unpin':
        return await handleUnpin(userId, validated.session_id);
      case 'switch':
        return await handleSwitch(userId, validated.session_id);
      case 'search':
        return await handleSearch(userId, validated.keyword);
      default:
        return {
          success: false,
          message: `不支持的操作: ${validated.action}`,
        };
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error('FC工具 [manage_session] 执行失败', {
      module: 'Tool:ManageSession',
      action: validated.action,
      duration,
      error: error.message,
    });
    return {
      success: false,
      message: `操作失败: ${error.message}`,
    };
  }
}

// ==================== Action Handlers ====================

async function handleList(userId: string): Promise<ManageSessionResult> {
  const sessions = await appServiceInstance.getSessions(userId);

  if (sessions.length === 0) {
    return {
      success: true,
      message: '当前没有任何会话。',
    };
  }

  const sessionList = sessions.map((s: any, i: number) => {
    const pinTag = s.isPinned ? ' [置顶]' : '';
    const time = new Date(s.updatedAt).toLocaleString('zh-CN');
    return `${i + 1}. "${s.title}" (ID: ${s.sessionId})${pinTag} - 更新于 ${time}`;
  });

  return {
    success: true,
    message: `共有 ${sessions.length} 个会话：\n${sessionList.join('\n')}`,
    data: { sessions },
  };
}

async function handleCreate(
  userId: string,
  title?: string,
): Promise<ManageSessionResult> {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const sessionTitle = title || '新对话';

  const session = await appServiceInstance.createSession(
    sessionId,
    sessionTitle,
    userId,
  );

  logger.info('FC工具 [manage_session] 创建会话成功', {
    module: 'Tool:ManageSession',
    sessionId,
    title: sessionTitle,
  });

  return {
    success: true,
    message: `已创建新会话"${sessionTitle}"（ID: ${sessionId}）`,
    frontend_action: {
      type: 'create_session',
      payload: { sessionId, title: sessionTitle },
    },
    data: { session },
  };
}

async function handleDelete(
  userId: string,
  sessionId?: string,
): Promise<ManageSessionResult> {
  if (!sessionId) {
    return {
      success: false,
      message: '删除会话需要提供 session_id 参数。请先用 list 查看会话列表获取 ID。',
    };
  }

  // 先查找会话确认存在
  const session = await appServiceInstance.getSessionBySessionId(sessionId);
  if (!session) {
    return {
      success: false,
      message: `未找到 ID 为 ${sessionId} 的会话。`,
    };
  }

  const title = session.title;
  await appServiceInstance.deleteSession(sessionId, userId);

  logger.info('FC工具 [manage_session] 删除会话成功', {
    module: 'Tool:ManageSession',
    sessionId,
    title,
  });

  return {
    success: true,
    message: `已删除会话"${title}"（ID: ${sessionId}）`,
    frontend_action: {
      type: 'delete_session',
      payload: { sessionId },
    },
  };
}

async function handleRename(
  userId: string,
  sessionId?: string,
  newTitle?: string,
): Promise<ManageSessionResult> {
  if (!sessionId) {
    return {
      success: false,
      message: '重命名会话需要提供 session_id 参数。请先用 list 查看会话列表获取 ID。',
    };
  }
  if (!newTitle || !newTitle.trim()) {
    return {
      success: false,
      message: '重命名会话需要提供新的标题（title 参数）。',
    };
  }

  const session = await appServiceInstance.getSessionBySessionId(sessionId);
  if (!session) {
    return {
      success: false,
      message: `未找到 ID 为 ${sessionId} 的会话。`,
    };
  }

  const oldTitle = session.title;
  await appServiceInstance.updateSessionTitle(sessionId, newTitle.trim(), userId);

  logger.info('FC工具 [manage_session] 重命名会话成功', {
    module: 'Tool:ManageSession',
    sessionId,
    oldTitle,
    newTitle: newTitle.trim(),
  });

  return {
    success: true,
    message: `已将会话"${oldTitle}"重命名为"${newTitle.trim()}"`,
    frontend_action: {
      type: 'refresh_sessions',
      payload: {},
    },
  };
}

async function handlePin(
  userId: string,
  sessionId?: string,
): Promise<ManageSessionResult> {
  if (!sessionId) {
    return {
      success: false,
      message: '置顶会话需要提供 session_id 参数。请先用 list 查看会话列表获取 ID。',
    };
  }

  const session = await appServiceInstance.getSessionBySessionId(sessionId);
  if (!session) {
    return {
      success: false,
      message: `未找到 ID 为 ${sessionId} 的会话。`,
    };
  }

  if (session.isPinned) {
    return {
      success: true,
      message: `会话"${session.title}"已经是置顶状态。`,
    };
  }

  await appServiceInstance.toggleSessionPin(sessionId, userId);

  return {
    success: true,
    message: `已置顶会话"${session.title}"`,
    frontend_action: {
      type: 'refresh_sessions',
      payload: {},
    },
  };
}

async function handleUnpin(
  userId: string,
  sessionId?: string,
): Promise<ManageSessionResult> {
  if (!sessionId) {
    return {
      success: false,
      message: '取消置顶需要提供 session_id 参数。请先用 list 查看会话列表获取 ID。',
    };
  }

  const session = await appServiceInstance.getSessionBySessionId(sessionId);
  if (!session) {
    return {
      success: false,
      message: `未找到 ID 为 ${sessionId} 的会话。`,
    };
  }

  if (!session.isPinned) {
    return {
      success: true,
      message: `会话"${session.title}"当前未置顶。`,
    };
  }

  await appServiceInstance.toggleSessionPin(sessionId, userId);

  return {
    success: true,
    message: `已取消置顶会话"${session.title}"`,
    frontend_action: {
      type: 'refresh_sessions',
      payload: {},
    },
  };
}

async function handleSwitch(
  userId: string,
  sessionId?: string,
): Promise<ManageSessionResult> {
  if (!sessionId) {
    return {
      success: false,
      message: '切换会话需要提供 session_id 参数。请先用 list 查看会话列表获取 ID。',
    };
  }

  const session = await appServiceInstance.getSessionBySessionId(sessionId);
  if (!session) {
    return {
      success: false,
      message: `未找到 ID 为 ${sessionId} 的会话。`,
    };
  }

  return {
    success: true,
    message: `已切换到会话"${session.title}"`,
    frontend_action: {
      type: 'switch_session',
      payload: { sessionId },
    },
  };
}

async function handleSearch(
  userId: string,
  keyword?: string,
): Promise<ManageSessionResult> {
  if (!keyword || !keyword.trim()) {
    return {
      success: false,
      message: '搜索会话需要提供关键词（keyword 参数）。',
    };
  }

  const sessions = await appServiceInstance.getSessions(userId);
  const matched = sessions.filter((s: any) =>
    s.title.toLowerCase().includes(keyword.toLowerCase()),
  );

  if (matched.length === 0) {
    return {
      success: true,
      message: `未找到包含"${keyword}"的会话。`,
    };
  }

  const sessionList = matched.map((s: any, i: number) => {
    const pinTag = s.isPinned ? ' [置顶]' : '';
    const time = new Date(s.updatedAt).toLocaleString('zh-CN');
    return `${i + 1}. "${s.title}" (ID: ${s.sessionId})${pinTag} - 更新于 ${time}`;
  });

  return {
    success: true,
    message: `找到 ${matched.length} 个匹配"${keyword}"的会话：\n${sessionList.join('\n')}`,
    data: { sessions: matched },
  };
}
