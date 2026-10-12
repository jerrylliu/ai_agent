import {
  searchKnowledgeBaseSchema,
  executeSearchKnowledgeBase,
  type SearchKnowledgeBaseParams,
  type SearchKnowledgeBaseResult,
} from './search-knowledge-base';
import {
  searchWebSchema,
  executeSearchWeb,
  type SearchWebParams,
  type SearchWebResult,
  validateSearchWebConfig,
  isSearchWebAvailable,
} from './search-web';
import {
  getWeatherSchema,
  executeGetWeather,
  type GetWeatherParams,
  type GetWeatherResult,
  validateWeatherConfig,
  isWeatherAvailable,
} from './get-weather';
import {
  calculateSchema,
  executeCalculate,
  type CalculateParams,
  type CalculateResult,
} from './calculate';
import {
  manageSessionSchema,
  executeManageSession,
  initManageSession,
  type ManageSessionParams,
  type ManageSessionResult,
} from './manage-session';
import {
  listKnowledgeBaseSchema,
  executeListKnowledgeBase,
  type ListKnowledgeBaseParams,
  type ListKnowledgeBaseResult,
} from './list-knowledge-base';
import {
  createPlanSchema,
  executeCreatePlan,
  type CreatePlanParams,
  type CreatePlanResult,
  updatePlanStepSchema,
  executeUpdatePlanStep,
  type UpdatePlanStepParams,
  type UpdatePlanStepResult,
  getPlanSchema,
  executeGetPlan,
  type GetPlanResult,
  resolveDataBindings,
  getSessionPlan,
  storeStepOutput,
  findMatchingStep,
  preloadSessionPlan,
} from './plan-execute';
import {
  crawlWebpageSchema,
  executeCrawlWebpage,
  type CrawlWebpageParams,
  type CrawlWebpageResult,
} from './crawl-webpage';
import {
  createDocumentSchema,
  executeCreateDocument,
  type CreateDocumentParams,
  type CreateDocumentResult,
  updateDocumentSchema,
  executeUpdateDocument,
  type UpdateDocumentParams,
  type UpdateDocumentResult,
  summarizeDocumentSchema,
  executeSummarizeDocument,
  type SummarizeDocumentParams,
  type SummarizeDocumentResult,
  compareDocumentsSchema,
  executeCompareDocuments,
  type CompareDocumentsParams,
  type CompareDocumentsResult,
  listDocumentsSchema,
  executeListDocuments,
  updateDocumentMetaSchema,
  executeUpdateDocumentMeta,
  deleteDocumentSchema,
  executeDeleteDocument,
  listDocumentVersionsSchema,
  executeListDocumentVersions,
  restoreDocumentVersionSchema,
  executeRestoreDocumentVersion,
  initDocumentTools,
} from './document-ops';
import {
  listKnowledgeSourcesSchema,
  executeListKnowledgeSources,
  addKnowledgeSourceSchema,
  executeAddKnowledgeSource,
  deleteKnowledgeSourceSchema,
  executeDeleteKnowledgeSource,
  syncKnowledgeSourceSchema,
  executeSyncKnowledgeSource,
  getKnowledgeStatusSchema,
  executeGetKnowledgeStatus,
  rebuildKnowledgeIndexSchema,
  executeRebuildKnowledgeIndex,
} from './knowledge-source-ops';
import {
  getSystemStatusSchema,
  executeGetSystemStatus,
  switchModelSchema,
  executeSwitchModel,
  toggleFeatureSchema,
  executeToggleFeature,
} from './settings-ops';
import {
  queryEvaluationStatsSchema,
  executeQueryEvaluationStats,
} from './evaluation-ops';
import {
  listFavoriteDocumentsSchema,
  executeListFavoriteDocuments,
  toggleDocumentFavoriteSchema,
  executeToggleDocumentFavorite,
} from './favorite-ops';
import {
  generateChartSchema,
  executeGenerateChart,
  type GenerateChartParams,
  type GenerateChartResult,
  generateImageSchema,
  executeGenerateImage,
  type GenerateImageParams,
  type GenerateImageResult,
  createMindmapSchema,
  executeCreateMindmap,
  type CreateMindmapParams,
  type CreateMindmapResult,
} from './multimodal-output';
import {
  generateDocumentSchema,
  executeGenerateDocument,
  type GenerateDocumentParams,
  type GenerateDocumentResult,
  type GenerateDocumentIntent,
} from './generate-document';
import {
  sendNotificationSchema,
  executeSendNotification,
  validateSendNotificationConfig,
  isSendNotificationAvailable,
  type SendNotificationParams,
  type SendNotificationResult,
} from './send-notification';
import {
  queryDatabaseSchema,
  executeQueryDatabase,
  validateQueryDatabaseConfig,
  isQueryDatabaseAvailable,
  type QueryDatabaseParams,
  type QueryDatabaseResult,
} from './query-database';
import {
  buildMcpProxySchema,
  executeMcpProxy,
  validateMcpProxyConfig,
  isMcpProxyAvailable,
  initMcpProxy,
  type McpProxyParams,
  type McpProxyResult,
} from './mcp-proxy';
import {
  buildExecuteWorkflowSchema,
  executeExecuteWorkflow,
  setWorkflowToolExecutor,
  type ExecuteWorkflowParams,
  type ExecuteWorkflowResult,
} from '../workflow/execute-workflow-tool';
import { setWorkflowNotifier } from '../workflow/workflow-engine';
import { logger } from '../logger';
import {
  requiresConfirmation,
  requestConfirmation,
  getPendingConfirmationInfo,
  attachSseResponseToConfirmation,
} from '../human-in-the-loop';
import { sendConfirmationRequest } from '../sse-writer';
import { applySelfHealing } from './self-healing';
// 动态工具选择：核心算法在 tool-selection.ts（仅依赖 logger，可独立单测）。
// 独立原因见该文件头注释——barrel 拖带 40+ 重依赖导致原逻辑零测试覆盖
import {
  selectToolsByQuery as selectToolsByNames,
  TOOL_RETRIEVAL_THRESHOLD,
} from './tool-selection';

export interface ToolContext {
  userId?: string;
  sessionId?: string;
  modelId?: string;
  res?: any; // SSE Response 对象，用于推送确认请求
  imageModel?: string; // 用户偏好的图片生成模型
  originalQuery?: string; // 用户原始输入（用于缓存 key 生成，避免 LLM 生成的工具参数有微小差异导致缓存不命中）
  /**
   * 请求级"文档导出意图"收集器（P1）
   *
   * generate_document 只登记标题 + 格式，正文由 prompt.ts 在流式结束后从本轮回复正文中取。
   * 必须由每次请求单独创建（不能是模块级变量），否则并发请求会互相污染。
   */
  docIntents?: GenerateDocumentIntent[];
}

// 工具调用记录回调，由外部注入（避免循环依赖）
let toolUsageCallback:
  | ((data: {
      userId?: string;
      sessionId?: string;
      toolName: string;
      success: boolean;
      durationMs: number;
      paramsSummary?: string;
      errorMessage?: string;
      modelId?: string;
    }) => Promise<any>)
  | null = null;

/**
 * 注入工具调用记录回调
 * 在 AppModule 初始化时调用，将 ToolUsageService 的保存方法注入
 */
export function setToolUsageCallback(
  callback: (data: {
    userId?: string;
    sessionId?: string;
    toolName: string;
    success: boolean;
    durationMs: number;
    paramsSummary?: string;
    errorMessage?: string;
    modelId?: string;
  }) => Promise<any>,
): void {
  toolUsageCallback = callback;
}

export interface ToolDefinition {
  schema: any;
  executor: (params: any, context?: ToolContext) => Promise<any>;
}

/**
 * 根据配置动态构建可用工具列表
 * 未配置 API Key 的工具不会被注册，模型不会尝试调用
 */
function buildToolsMap(): Record<string, ToolDefinition> {
  // 先执行配置验证，设置可用性标志
  validateSearchWebConfig();
  validateWeatherConfig();
  // 三个新工具的配置验证：根据可用性决定是否注册
  validateSendNotificationConfig();
  validateQueryDatabaseConfig();
  validateMcpProxyConfig();

  const tools: Record<string, ToolDefinition> = {
    search_knowledge_base: {
      schema: searchKnowledgeBaseSchema,
      executor: executeSearchKnowledgeBase as (params: any) => Promise<any>,
    },
    list_knowledge_base: {
      schema: listKnowledgeBaseSchema,
      executor: executeListKnowledgeBase as (params: any) => Promise<any>,
    },
    calculate: {
      schema: calculateSchema,
      executor: executeCalculate as (params: any) => Promise<any>,
    },
    manage_session: {
      schema: manageSessionSchema,
      executor: executeManageSession as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    create_plan: {
      schema: createPlanSchema,
      executor: executeCreatePlan as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    update_plan_step: {
      schema: updatePlanStepSchema,
      executor: executeUpdatePlanStep as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    get_plan: {
      schema: getPlanSchema,
      executor: executeGetPlan as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    crawl_webpage: {
      schema: crawlWebpageSchema,
      executor: executeCrawlWebpage as (params: any) => Promise<any>,
    },
    create_document: {
      schema: createDocumentSchema,
      executor: executeCreateDocument as (params: any) => Promise<any>,
    },
    update_document: {
      schema: updateDocumentSchema,
      executor: executeUpdateDocument as (params: any) => Promise<any>,
    },
    summarize_document: {
      schema: summarizeDocumentSchema,
      executor: executeSummarizeDocument as (params: any) => Promise<any>,
    },
    compare_documents: {
      schema: compareDocumentsSchema,
      executor: executeCompareDocuments as (params: any) => Promise<any>,
    },
    list_documents: {
      schema: listDocumentsSchema,
      executor: executeListDocuments as (params: any) => Promise<any>,
    },
    update_document_meta: {
      schema: updateDocumentMetaSchema,
      executor: executeUpdateDocumentMeta as (params: any) => Promise<any>,
    },
    delete_document: {
      schema: deleteDocumentSchema,
      executor: executeDeleteDocument as (params: any) => Promise<any>,
    },
    list_document_versions: {
      schema: listDocumentVersionsSchema,
      executor: executeListDocumentVersions as (params: any) => Promise<any>,
    },
    restore_document_version: {
      schema: restoreDocumentVersionSchema,
      executor: executeRestoreDocumentVersion as (params: any) => Promise<any>,
    },
    // ---------------- 知识源管理域（第 2 批） ----------------
    list_knowledge_sources: {
      schema: listKnowledgeSourcesSchema,
      executor: executeListKnowledgeSources as (params: any) => Promise<any>,
    },
    add_knowledge_source: {
      schema: addKnowledgeSourceSchema,
      executor: executeAddKnowledgeSource as (params: any) => Promise<any>,
    },
    delete_knowledge_source: {
      schema: deleteKnowledgeSourceSchema,
      executor: executeDeleteKnowledgeSource as (params: any) => Promise<any>,
    },
    sync_knowledge_source: {
      schema: syncKnowledgeSourceSchema,
      executor: executeSyncKnowledgeSource as (params: any) => Promise<any>,
    },
    get_knowledge_status: {
      schema: getKnowledgeStatusSchema,
      executor: executeGetKnowledgeStatus as (params: any) => Promise<any>,
    },
    rebuild_knowledge_index: {
      schema: rebuildKnowledgeIndexSchema,
      executor: executeRebuildKnowledgeIndex as (params: any) => Promise<any>,
    },
    // ---------------- 设置域 / 评估 / 收藏（第 3 批） ----------------
    get_system_status: {
      schema: getSystemStatusSchema,
      executor: executeGetSystemStatus as (params: any) => Promise<any>,
    },
    switch_model: {
      schema: switchModelSchema,
      executor: executeSwitchModel as (params: any) => Promise<any>,
    },
    toggle_feature: {
      schema: toggleFeatureSchema,
      executor: executeToggleFeature as (params: any) => Promise<any>,
    },
    // 以下三个工具按当前用户隔离，executor 需要 ToolContext.userId
    query_evaluation_stats: {
      schema: queryEvaluationStatsSchema,
      executor: executeQueryEvaluationStats as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    list_favorite_documents: {
      schema: listFavoriteDocumentsSchema,
      executor: executeListFavoriteDocuments as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    toggle_document_favorite: {
      schema: toggleDocumentFavoriteSchema,
      executor: executeToggleDocumentFavorite as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    generate_chart: {
      schema: generateChartSchema,
      executor: executeGenerateChart as (params: any) => Promise<any>,
    },
    generate_image: {
      schema: generateImageSchema,
      executor: executeGenerateImage as (params: any) => Promise<any>,
    },
    create_mindmap: {
      schema: createMindmapSchema,
      executor: executeCreateMindmap as (params: any) => Promise<any>,
    },
    generate_document: {
      schema: generateDocumentSchema,
      executor: executeGenerateDocument as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
    execute_workflow: {
      schema: buildExecuteWorkflowSchema(),
      executor: executeExecuteWorkflow as (
        params: any,
        context?: ToolContext,
      ) => Promise<any>,
    },
  };

  if (isSearchWebAvailable()) {
    tools.search_web = {
      schema: searchWebSchema,
      executor: executeSearchWeb as (params: any) => Promise<any>,
    };
    logger.info('工具注册：search_web 已启用', { module: 'ToolRegistry' });
  } else {
    logger.info('工具注册：search_web 未配置，跳过注册', {
      module: 'ToolRegistry',
    });
  }

  if (isWeatherAvailable()) {
    tools.get_weather = {
      schema: getWeatherSchema,
      executor: executeGetWeather as (params: any) => Promise<any>,
    };
    logger.info('工具注册：get_weather 已启用', { module: 'ToolRegistry' });
  } else {
    logger.info('工具注册：get_weather 未配置，跳过注册', {
      module: 'ToolRegistry',
    });
  }

  // ---------------- send_notification（飞书/邮件/Webhook 任一通道可用即注册） ----------------
  if (isSendNotificationAvailable()) {
    tools.send_notification = {
      schema: sendNotificationSchema,
      executor: executeSendNotification as (params: any) => Promise<any>,
    };
    logger.info('工具注册：send_notification 已启用', {
      module: 'ToolRegistry',
    });
  } else {
    logger.info('工具注册：send_notification 未配置，跳过注册', {
      module: 'ToolRegistry',
    });
  }

  // ---------------- query_database（外部业务库 NL2SQL） ----------------
  if (isQueryDatabaseAvailable()) {
    tools.query_database = {
      schema: queryDatabaseSchema,
      executor: executeQueryDatabase as (params: any) => Promise<any>,
    };
    logger.info('工具注册：query_database 已启用', { module: 'ToolRegistry' });
  } else {
    logger.info('工具注册：query_database 未配置，跳过注册', {
      module: 'ToolRegistry',
    });
  }

  // ---------------- mcp_proxy（接入 MCP 生态） ----------------
  // 注意：buildMcpProxySchema 在初始化阶段返回的是空 tools 列表的 schema，
  // 实际工具列表在 initMcpProxy() 完成后才填充；不影响 LLM 通过 description 感知工具用途
  if (isMcpProxyAvailable()) {
    tools.mcp_proxy = {
      schema: buildMcpProxySchema(),
      executor: executeMcpProxy as (params: any) => Promise<any>,
    };
    logger.info(
      '工具注册：mcp_proxy 已启用（实际工具列表将在 onModuleInit 后异步加载）',
      { module: 'ToolRegistry' },
    );
  } else {
    logger.info('工具注册：mcp_proxy 未配置 NOTIFY_MCP_SERVERS，跳过注册', {
      module: 'ToolRegistry',
    });
  }

  return tools;
}

export const TOOLS: Record<string, ToolDefinition> = buildToolsMap();

// 将 executeTool 注入到 workflow 引擎，让流水线步骤复用统一的工具执行链路
// 必须在 TOOLS 构建完成后注入，避免循环依赖
setWorkflowToolExecutor(async (toolName, params, ctx) => {
  return executeTool(toolName, params, {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    res: ctx.res,
  });
});

// E1：工作流引擎执行结束后的声明式通知发送器
// 直接复用 send_notification 工具的执行链路，免去工作流定义里再写一遍发送步骤
// 设计：notify 配置失败不抛错（仅 warn），但 send_notification 自身的失败仍由其内部 errors 字段携带
setWorkflowNotifier(
  async ({ channel, title, content, recipients, webhookUrl }) => {
    const result = await executeSendNotification({
      channel,
      title,
      content,
      recipients,
      webhookUrl,
    } as any);
    if (!result?.success) {
      // 把工具内部的失败原因往上抛，让 dispatchWorkflowNotify 的 try/catch 捕获后只记 warn
      throw new Error(
        `send_notification 失败：${(result?.errors ?? ['unknown']).join('; ').slice(0, 200)}`,
      );
    }
  },
);

export function getAllToolSchemas(): any[] {
  return Object.values(TOOLS).map((t) => t.schema);
}

// ==================== Schema 压缩：预计算描述 + 参数精简 ====================

/**
 * 预计算的工具压缩描述（语义蒸馏）
 * 公式：动作 + 对象 + 关键约束/触发条件 + 负面边界
 * 使用自然短句而非符号分隔，小模型对自然语言理解更好
 * 新增工具时需在此处补充 compact 版本
 */
const TOOL_COMPACT_DESCRIPTIONS: Record<string, string> = {
  search_knowledge_base: '搜索知识库文档，涉及已上传文档时使用，不用于通用问题',
  list_knowledge_base:
    '列出知识库所有文档清单，用户问知识库有什么内容时使用，不用于搜索具体内容',
  search_web: '联网搜索实时信息，涉及最新新闻或实时数据时使用，不用于查天气',
  get_weather: '查询城市天气，包括实时天气和预报，不用于其他搜索',
  calculate: '执行数学计算，复杂运算时使用，简单加减可直接回答',
  manage_session: '管理会话操作，包括新建删除重命名置顶切换',
  create_plan: '为复杂任务创建执行计划，支持步骤间数据绑定，简单问题不需要',
  update_plan_step: '更新计划步骤状态及输出，完成或失败时调用',
  get_plan: '查看当前执行计划进度，回顾计划时使用',
  crawl_webpage: '深度抓取网页全文内容，搜索摘要不够详细时使用，较慢',
  create_document: '在知识库中创建新文档，用户需要新建文档或记录笔记时使用',
  update_document: '更新已有文档内容，上传新版本保留历史',
  summarize_document: '对指定文档生成摘要，快速了解文档核心内容',
  compare_documents: '对比两个文档差异，查看新增删除内容',
  list_documents: '列出文档清单可筛无标签文档，整理文档或找文档ID时使用',
  update_document_meta: '只改文档标签标题描述不改正文，打标签时优先用',
  delete_document: '删除文档含全部版本，不可恢复，删除前需确认',
  list_document_versions: '列出文档历史版本，查看版本或准备恢复时使用',
  restore_document_version: '恢复文档到历史版本生成新版本，回退内容时使用',
  list_knowledge_sources: '列出知识源爬取源清单含同步状态，管理爬取源或找ID时使用',
  add_knowledge_source: '添加Web爬取知识源并入库，用户要订阅网站内容时使用，飞书源不支持',
  delete_knowledge_source: '删除知识源含已爬页面与向量数据，不可恢复',
  sync_knowledge_source: '触发知识源同步爬取入库，长任务启动后查状态',
  get_knowledge_status: '查看知识库统计向量库状态与索引重建进度',
  rebuild_knowledge_index: '全量重建向量索引的重活，检索质量异常时才用',
  get_system_status: '查看系统设置当前模型Key是否配置功能开关状态',
  switch_model: '切换全局对话模型所有端生效，Key未配置会失败',
  toggle_feature: '开关记忆摘要等功能的全局默认，未自定义设备自动跟随',
  query_evaluation_stats: '查询回答质量评估统计点赞点踩与AI判分编造明细',
  list_favorite_documents: '列出用户收藏的AI生成文档清单',
  toggle_document_favorite: '收藏或取消收藏AI生成文档防自动清理',
  generate_chart: '生成图表，折线柱状饼图等，数据可视化时使用',
  generate_image: '文生图，根据文字描述生成图片，需要图片时使用',
  create_mindmap: '生成思维导图，整理知识结构梳理逻辑时使用',
  generate_document:
    '导出文档文件(PDF/Word/HTML/MD)，只传标题与格式，正文写在回复正文里',
  execute_workflow: '一键执行预置流水线，多步任务匹配模板时优先用此工具',
  send_notification: '发送通知到飞书邮件Webhook，任务完成或主动提醒时使用',
  query_database: '查询外部业务库执行SELECT语句，需要业务数据时使用',
  mcp_proxy: '调用MCP生态工具如GitHub文件系统Slack等，扩展能力时使用',
};

/**
 * 预计算的工具参数压缩描述
 * 只为 required 参数提供精简描述，可选参数在压缩模式下会被移除
 */
const TOOL_COMPACT_PARAM_DESCRIPTIONS: Record<
  string,
  Record<string, string>
> = {
  search_knowledge_base: {
    query: '搜索查询语句',
  },
  list_knowledge_base: {},
  search_web: {
    query: '搜索查询语句',
  },
  get_weather: {
    city: '城市名或城市ID',
  },
  calculate: {
    expression: '数学表达式',
  },
  manage_session: {
    action: '操作类型',
  },
  create_plan: {
    goal: '任务目标',
    steps: '执行步骤列表',
  },
  update_plan_step: {
    stepId: '步骤编号',
    status: '新状态',
  },
  crawl_webpage: {
    url: '网页地址',
  },
  create_document: {
    title: '文档标题',
    content: '文档内容',
  },
  update_document: {
    documentId: '文档ID',
    content: '新内容',
  },
  summarize_document: {
    documentId: '文档ID',
  },
  compare_documents: {
    documentId1: '第一个文档ID',
    documentId2: '第二个文档ID',
  },
  list_documents: {},
  update_document_meta: {
    documentId: '文档ID',
  },
  delete_document: {
    documentId: '文档ID',
  },
  list_document_versions: {
    documentId: '文档ID',
  },
  restore_document_version: {
    versionId: '版本ID',
  },
  list_knowledge_sources: {},
  add_knowledge_source: {
    name: '知识源名称',
    url: '爬取起始URL',
  },
  delete_knowledge_source: {
    sourceId: '知识源ID',
  },
  sync_knowledge_source: {
    sourceIds: '知识源ID列表',
  },
  get_knowledge_status: {},
  rebuild_knowledge_index: {
    confirm: '是否确认执行',
  },
  get_system_status: {},
  switch_model: {
    modelId: '目标模型ID',
  },
  toggle_feature: {
    feature: '功能开关名',
    enabled: '目标状态',
  },
  query_evaluation_stats: {},
  list_favorite_documents: {},
  toggle_document_favorite: {
    key: '文档key',
    favorited: '目标状态',
  },
  generate_chart: {
    chartType: '图表类型',
  },
  generate_image: {
    prompt: '图片描述',
  },
  create_mindmap: {
    title: '中心主题',
    content: '思维导图内容',
  },
  generate_document: {
    title: '文档标题',
    format: '输出格式',
  },
  execute_workflow: {
    templateId: '流水线模板ID',
    userInput: '用户原始问题',
  },
  send_notification: {
    channel: '通道类型',
    title: '通知标题',
    content: '通知正文',
  },
  query_database: {
    sql: 'SELECT 语句',
  },
  mcp_proxy: {
    server: 'MCP Server 名称',
    tool: '工具名',
  },
};

/**
 * 压缩工具 Schema，减少 token 占用
 * 1. 使用预计算的压缩描述替代原始长描述
 * 2. 移除非 required 的参数（小模型处理不了可选参数）
 * 3. 移除 default/minimum/maximum 等非必要字段
 * 4. 保留 enum（对 required 参数可能是必要的）
 */
function compressSchema(schema: any): any {
  if (!schema?.function) return schema;

  const toolName = schema.function.name;
  const fn = schema.function;
  const compactDesc = TOOL_COMPACT_DESCRIPTIONS[toolName];
  const compactParams = TOOL_COMPACT_PARAM_DESCRIPTIONS[toolName];

  const compressed: any = {
    type: schema.type,
    function: {
      name: fn.name,
      description: compactDesc || fn.description,
      parameters: {
        type: 'object',
        properties: {} as Record<string, any>,
        required: fn.parameters?.required || [],
      },
    },
  };

  // 只保留 required 参数，移除可选参数
  const requiredSet = new Set(fn.parameters?.required || []);
  if (fn.parameters?.properties) {
    for (const [key, value] of Object.entries(fn.parameters.properties)) {
      if (!requiredSet.has(key)) continue;
      const prop: any = value;
      const compressedProp: any = { type: prop.type };
      // 使用预计算的参数描述，没有则保留原始描述
      if (compactParams?.[key]) {
        compressedProp.description = compactParams[key];
      } else if (prop.description) {
        compressedProp.description = prop.description;
      }
      // 保留 enum（对 required 参数可能是必要的）
      if (prop.enum) compressedProp.enum = prop.enum;
      compressed.function.parameters.properties[key] = compressedProp;
    }
  }

  return compressed;
}

// ==================== LLM 辅助生成压缩描述（工具 > 15 时激活） ====================

/**
 * 使用 LLM 为工具生成压缩描述
 * 当工具数量超过 TOOL_RETRIEVAL_THRESHOLD 且缺少预计算描述时调用
 * 生成后自动写入 TOOL_COMPACT_DESCRIPTIONS，后续请求直接复用
 */
async function generateCompactDescriptionWithLLM(
  toolName: string,
  fullDescription: string,
): Promise<string> {
  // 动态导入避免循环依赖
  const { createLLM, buildModelConfig } = await import('../model-provider.js');
  const { HumanMessage } = await import('@langchain/core/messages');

  const llm = createLLM(buildModelConfig('deepseek:deepseek-v4-flash'));
  const prompt = `你是一个工具描述压缩专家。请将以下工具描述压缩为一句话，要求：
1. 包含：动作+对象+关键触发条件+负面边界（可选）
2. 使用自然短句，不要用符号分隔
3. 不超过30个字
4. 保留关键约束，不要丢失负面边界

工具名：${toolName}
原始描述：${fullDescription}

压缩描述：`;

  try {
    const result = await llm.invoke([new HumanMessage(prompt)]);
    const compact = (
      typeof result.content === 'string' ? result.content : ''
    ).trim();
    if (compact && compact.length > 0 && compact.length < 60) {
      logger.info('LLM 生成压缩描述成功', {
        module: 'ToolRegistry',
        toolName,
        originalLength: fullDescription.length,
        compactLength: compact.length,
        compact,
      });
      return compact;
    }
    // LLM 输出异常，降级使用原始描述的第一句
    logger.warn('LLM 生成压缩描述异常，降级处理', {
      module: 'ToolRegistry',
      toolName,
      compact,
    });
    return (
      fullDescription.split(/[。.]/)[0] || fullDescription.substring(0, 30)
    );
  } catch (error: any) {
    logger.warn('LLM 生成压缩描述失败，降级处理', {
      module: 'ToolRegistry',
      toolName,
      error: error.message,
    });
    return (
      fullDescription.split(/[。.]/)[0] || fullDescription.substring(0, 30)
    );
  }
}

/**
 * 确保所有工具都有压缩描述
 * 工具数 <= 15 时直接跳过（使用预计算的 TOOL_COMPACT_DESCRIPTIONS）
 * 工具数 > 15 时，对缺少预计算描述的工具调用 LLM 生成
 */
async function ensureCompactDescriptions(): Promise<void> {
  const allNames = getAvailableToolNames();

  // 工具数未超过阈值，不需要 LLM 辅助
  if (allNames.length <= TOOL_RETRIEVAL_THRESHOLD) {
    return;
  }

  // 检查哪些工具缺少压缩描述
  const missing = allNames.filter((name) => !TOOL_COMPACT_DESCRIPTIONS[name]);
  if (missing.length === 0) return;

  logger.info('工具数超过阈值，启动 LLM 辅助生成压缩描述', {
    module: 'ToolRegistry',
    totalTools: allNames.length,
    missingCompactDesc: missing.join(', '),
  });

  // 逐个生成（避免并发请求打爆 LLM）
  for (const name of missing) {
    const tool = TOOLS[name];
    if (!tool?.schema?.function?.description) continue;

    const compact = await generateCompactDescriptionWithLLM(
      name,
      tool.schema.function.description,
    );
    TOOL_COMPACT_DESCRIPTIONS[name] = compact;
  }
}

/**
 * 根据模型能力返回裁剪后的工具 Schema 列表
 * 基于模型实际能力（contextLength + supportsFC）而非 ID 前缀判断
 * 小上下文或 FC 能力弱的模型：核心工具 + 压缩 Schema
 * 长上下文且 FC 能力强的模型：全量工具 + 原始 Schema
 *
 * 异步原因：工具数 > 15 时可能需要调用 LLM 生成压缩描述
 */
export async function getToolSchemasForModel(
  modelId: string,
  options?: { contextLength?: number; supportsFC?: boolean; query?: string },
): Promise<any[]> {
  // 工具数 > 15 时，确保所有工具都有压缩描述（可能触发 LLM 生成）
  await ensureCompactDescriptions();

  // 从元数据获取能力，未提供时走降级逻辑
  const contextLength = options?.contextLength;
  const supportsFC = options?.supportsFC;
  const query = options?.query;

  // 降级判断：无元数据时根据 provider 粗略推断
  const isLocalProvider = modelId.startsWith('ollama:');
  const effectiveCtx = contextLength ?? (isLocalProvider ? 4096 : 32768);
  const effectiveFC = supportsFC ?? !isLocalProvider;

  let allNames = getAvailableToolNames();

  // 动态工具选择：工具数 > 15 时，根据 query 筛选最相关的工具
  if (allNames.length > TOOL_RETRIEVAL_THRESHOLD && query) {
    const selectedNames = selectToolsByQuery(query);
    allNames = selectedNames;
    logger.info('动态工具选择已激活', {
      module: 'ToolRegistry',
      modelId,
      query: query.substring(0, 100),
      selectedTools: selectedNames.join(', '),
    });
  }

  const needCompress = effectiveCtx < 8192 || !effectiveFC;

  // 长上下文 + FC 能力强：全量注册（如果经过动态选择，则只注册选中的工具）
  if (!needCompress) {
    return allNames
      .filter((name) => TOOLS[name])
      .map((name) => TOOLS[name].schema);
  }

  // 小上下文或 FC 弱：核心工具 + 压缩 Schema
  const coreTools = [
    'search_knowledge_base',
    'list_knowledge_base',
    'calculate',
  ];
  // FC 能力弱但上下文够大：多给几个工具（但压缩 Schema）
  // 包含新增的外部 API 集成工具：send_notification / query_database / mcp_proxy
  const extendedTools = [
    'search_knowledge_base',
    'list_knowledge_base',
    'calculate',
    'search_web',
    'get_weather',
    'send_notification',
    'query_database',
    'mcp_proxy',
  ];
  const filteredNames = allNames.filter((name) =>
    (effectiveCtx >= 8192 ? extendedTools : coreTools).includes(name),
  );

  logger.info('模型工具裁剪', {
    module: 'ToolRegistry',
    modelId,
    contextLength: effectiveCtx,
    supportsFC: effectiveFC,
    allTools: allNames.join(', '),
    filteredTools: filteredNames.join(', '),
    schemaCompressed: true,
  });

  return filteredNames
    .filter((name) => TOOLS[name])
    .map((name) => compressSchema(TOOLS[name].schema));
}

// ==================== 动态工具选择（工具 > 15 时激活） ====================

/**
 * 基于用户 query 动态选择最相关的工具（委托 tool-selection 模块）
 *
 * @param query 用户输入的查询文本
 * @returns 选出的工具名称列表
 */
export function selectToolsByQuery(query: string): string[] {
  return selectToolsByNames(query, getAvailableToolNames());
}

export async function executeTool(
  name: string,
  params: any,
  context?: ToolContext,
): Promise<any> {
  const tool = TOOLS[name];
  if (!tool) {
    logger.error('FC工具注册中心：尝试执行未注册的工具', {
      module: 'ToolRegistry',
      toolName: name,
      availableTools: Object.keys(TOOLS),
    });
    throw new Error(
      `未知工具: ${name}，可用工具: ${Object.keys(TOOLS).join(', ')}`,
    );
  }

  logger.info('FC工具注册中心：开始执行工具', {
    module: 'ToolRegistry',
    toolName: name,
    rawParams: JSON.stringify(params).substring(0, 500),
  });

  // 人工确认机制：敏感工具需要用户确认后才执行
  if (requiresConfirmation(name, params)) {
    logger.info('FC工具注册中心：工具需要人工确认', {
      module: 'ToolRegistry',
      toolName: name,
    });

    const confirmedPromise = requestConfirmation(name, params, context?.userId);

    // 推送确认请求到前端
    const pendingInfo = getPendingConfirmationInfo(
      confirmedPromise.confirmationId,
    );
    if (pendingInfo && context?.res) {
      sendConfirmationRequest(context.res, pendingInfo);
      // 关联 SSE Response，让飞书侧审批后能通过 SSE 通知 Web 关闭弹窗
      attachSseResponseToConfirmation(
        confirmedPromise.confirmationId,
        context.res,
      );
    }

    const confirmed = await confirmedPromise;

    if (!confirmed) {
      logger.info('FC工具注册中心：用户拒绝执行工具', {
        module: 'ToolRegistry',
        toolName: name,
      });
      throw new Error(`用户拒绝了工具 ${name} 的执行`);
    }

    logger.info('FC工具注册中心：用户确认执行工具', {
      module: 'ToolRegistry',
      toolName: name,
    });
  }

  const startTime = Date.now();
  try {
    // 图片模型偏好：如果用户指定了偏好模型，覆盖工具参数中的 model
    if (name === 'generate_image' && context?.imageModel) {
      params = { ...params, model: context.imageModel };
    }

    const rawResult = await tool.executor(params, context);
    // Self-Healing：失败结果若带 suggestion，追加 _selfHealing 元信息引导 LLM 自愈
    const healed = applySelfHealing({
      toolName: name,
      sessionId: context?.sessionId,
      result: rawResult,
    });
    const result = healed.result;
    const duration = Date.now() - startTime;

    const resultSummary =
      typeof result === 'object' && result !== null
        ? JSON.stringify(result).substring(0, 500)
        : String(result).substring(0, 500);

    logger.info('FC工具注册中心：工具执行完成', {
      module: 'ToolRegistry',
      toolName: name,
      duration,
      resultPreview: resultSummary,
    });

    // 异步持久化工具调用指标
    if (toolUsageCallback) {
      toolUsageCallback({
        userId: context?.userId,
        sessionId: context?.sessionId,
        toolName: name,
        success: true,
        durationMs: duration,
        paramsSummary: JSON.stringify(params).substring(0, 500),
        modelId: context?.modelId,
      }).catch((err: any) => {
        logger.error('工具调用指标持久化失败', {
          module: 'ToolRegistry',
          error: String(err),
        });
      });
    }

    return result;
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error('FC工具注册中心：工具执行失败', {
      module: 'ToolRegistry',
      toolName: name,
      duration,
      error: error.message,
      errorStack: error.stack?.substring(0, 500),
    });

    // 异步持久化工具调用指标（失败）
    if (toolUsageCallback) {
      toolUsageCallback({
        userId: context?.userId,
        sessionId: context?.sessionId,
        toolName: name,
        success: false,
        durationMs: duration,
        paramsSummary: JSON.stringify(params).substring(0, 500),
        errorMessage: error.message?.substring(0, 500),
        modelId: context?.modelId,
      }).catch((err: any) => {
        logger.error('工具调用指标持久化失败', {
          module: 'ToolRegistry',
          error: String(err),
        });
      });
    }

    throw error;
  }
}

export function hasTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

export function getAvailableToolNames(): string[] {
  return Object.keys(TOOLS);
}

export { initManageSession };
export { initMcpProxy };

export {
  searchKnowledgeBaseSchema,
  executeSearchKnowledgeBase,
  type SearchKnowledgeBaseParams,
  type SearchKnowledgeBaseResult,
};
export {
  listKnowledgeBaseSchema,
  executeListKnowledgeBase,
  type ListKnowledgeBaseParams,
  type ListKnowledgeBaseResult,
};
export {
  searchWebSchema,
  executeSearchWeb,
  type SearchWebParams,
  type SearchWebResult,
  validateSearchWebConfig,
  isSearchWebAvailable,
};
export {
  getWeatherSchema,
  executeGetWeather,
  type GetWeatherParams,
  type GetWeatherResult,
  validateWeatherConfig,
  isWeatherAvailable,
};
export {
  calculateSchema,
  executeCalculate,
  type CalculateParams,
  type CalculateResult,
};
export {
  manageSessionSchema,
  executeManageSession,
  type ManageSessionParams,
  type ManageSessionResult,
};
export {
  createPlanSchema,
  executeCreatePlan,
  type CreatePlanParams,
  type CreatePlanResult,
  updatePlanStepSchema,
  executeUpdatePlanStep,
  type UpdatePlanStepParams,
  type UpdatePlanStepResult,
  getPlanSchema,
  executeGetPlan,
  type GetPlanResult,
  resolveDataBindings,
  getSessionPlan,
  storeStepOutput,
  findMatchingStep,
  preloadSessionPlan,
};
export {
  sendNotificationSchema,
  executeSendNotification,
  type SendNotificationParams,
  type SendNotificationResult,
  validateSendNotificationConfig,
  isSendNotificationAvailable,
};
export {
  queryDatabaseSchema,
  executeQueryDatabase,
  type QueryDatabaseParams,
  type QueryDatabaseResult,
  validateQueryDatabaseConfig,
  isQueryDatabaseAvailable,
};
export {
  buildMcpProxySchema,
  executeMcpProxy,
  type McpProxyParams,
  type McpProxyResult,
  validateMcpProxyConfig,
  isMcpProxyAvailable,
};
