import { searchKnowledgeBaseSchema, executeSearchKnowledgeBase, type SearchKnowledgeBaseParams, type SearchKnowledgeBaseResult } from './search-knowledge-base';
import { searchWebSchema, executeSearchWeb, type SearchWebParams, type SearchWebResult, validateSearchWebConfig, isSearchWebAvailable } from './search-web';
import { getWeatherSchema, executeGetWeather, type GetWeatherParams, type GetWeatherResult, validateWeatherConfig, isWeatherAvailable } from './get-weather';
import { calculateSchema, executeCalculate, type CalculateParams, type CalculateResult } from './calculate';
import { manageSessionSchema, executeManageSession, initManageSession, type ManageSessionParams, type ManageSessionResult } from './manage-session';
import { logger } from '../logger';

export interface ToolContext {
  userId?: string;
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

  const tools: Record<string, ToolDefinition> = {
    search_knowledge_base: {
      schema: searchKnowledgeBaseSchema,
      executor: executeSearchKnowledgeBase as (params: any) => Promise<any>,
    },
    calculate: {
      schema: calculateSchema,
      executor: executeCalculate as (params: any) => Promise<any>,
    },
    manage_session: {
      schema: manageSessionSchema,
      executor: executeManageSession as (params: any, context?: ToolContext) => Promise<any>,
    },
  };

  if (isSearchWebAvailable()) {
    tools.search_web = {
      schema: searchWebSchema,
      executor: executeSearchWeb as (params: any) => Promise<any>,
    };
    logger.info('工具注册：search_web 已启用', { module: 'ToolRegistry' });
  } else {
    logger.info('工具注册：search_web 未配置，跳过注册', { module: 'ToolRegistry' });
  }

  if (isWeatherAvailable()) {
    tools.get_weather = {
      schema: getWeatherSchema,
      executor: executeGetWeather as (params: any) => Promise<any>,
    };
    logger.info('工具注册：get_weather 已启用', { module: 'ToolRegistry' });
  } else {
    logger.info('工具注册：get_weather 未配置，跳过注册', { module: 'ToolRegistry' });
  }

  return tools;
}

export const TOOLS: Record<string, ToolDefinition> = buildToolsMap();

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
  search_web: '联网搜索实时信息，涉及最新新闻或实时数据时使用，不用于查天气',
  get_weather: '查询城市天气，包括实时天气和预报，不用于其他搜索',
  calculate: '执行数学计算，复杂运算时使用，简单加减可直接回答',
  manage_session: '管理会话操作，包括新建删除重命名置顶切换',
};

/**
 * 预计算的工具参数压缩描述
 * 只为 required 参数提供精简描述，可选参数在压缩模式下会被移除
 */
const TOOL_COMPACT_PARAM_DESCRIPTIONS: Record<string, Record<string, string>> = {
  search_knowledge_base: {
    query: '搜索查询语句',
  },
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
async function generateCompactDescriptionWithLLM(toolName: string, fullDescription: string): Promise<string> {
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
    const compact = (typeof result.content === 'string' ? result.content : '').trim();
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
    logger.warn('LLM 生成压缩描述异常，降级处理', { module: 'ToolRegistry', toolName, compact });
    return fullDescription.split(/[。.]/)[0] || fullDescription.substring(0, 30);
  } catch (error: any) {
    logger.warn('LLM 生成压缩描述失败，降级处理', {
      module: 'ToolRegistry',
      toolName,
      error: error.message,
    });
    return fullDescription.split(/[。.]/)[0] || fullDescription.substring(0, 30);
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
  const missing = allNames.filter(name => !TOOL_COMPACT_DESCRIPTIONS[name]);
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

    const compact = await generateCompactDescriptionWithLLM(name, tool.schema.function.description);
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
export async function getToolSchemasForModel(modelId: string, options?: { contextLength?: number; supportsFC?: boolean; query?: string }): Promise<any[]> {
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
      .filter(name => TOOLS[name])
      .map(name => TOOLS[name].schema);
  }

  // 小上下文或 FC 弱：核心工具 + 压缩 Schema
  const coreTools = ['search_knowledge_base', 'calculate'];
  // FC 能力弱但上下文够大：多给几个工具（但压缩 Schema）
  const extendedTools = ['search_knowledge_base', 'calculate', 'search_web', 'get_weather'];
  const filteredNames = allNames.filter(name =>
    (effectiveCtx >= 8192 ? extendedTools : coreTools).includes(name)
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
    .filter(name => TOOLS[name])
    .map(name => compressSchema(TOOLS[name].schema));
}

// ==================== 动态工具选择（工具 > 15 时激活） ====================

/**
 * 工具语义描述，用于关键词匹配检索
 * 当工具数量超过 TOOL_RETRIEVAL_THRESHOLD 时，根据用户 query 匹配最相关的工具
 */
const TOOL_SEMANTIC_DESCRIPTIONS: Record<string, string> = {
  search_knowledge_base: '搜索 知识库 文档 上传 文件 内容 查找 资料',
  search_web: '联网 搜索 网页 互联网 最新 新闻 实时 在线 查询',
  get_weather: '天气 气温 温度 下雨 晴天 阴天 湿度 风力 空气质量 预报',
  calculate: '计算 数学 运算 算术 公式 三角函数 对数 开方 乘除',
  manage_session: '会话 对话 新建 删除 重命名 置顶 切换 管理',
};

/** 动态工具选择阈值，工具数超过此值才启用 */
const TOOL_RETRIEVAL_THRESHOLD = 15;

/** 动态选择返回的最大工具数 */
const TOOL_RETRIEVAL_TOP_K = 8;

/**
 * 基于用户 query 动态选择最相关的工具
 * 使用关键词匹配评分，工具数 <= TOOL_RETRIEVAL_THRESHOLD 时直接返回全量
 *
 * @param query 用户输入的查询文本
 * @returns 选出的工具名称列表
 */
export function selectToolsByQuery(query: string): string[] {
  const allNames = getAvailableToolNames();

  // 工具数未超过阈值，不需要动态选择
  if (allNames.length <= TOOL_RETRIEVAL_THRESHOLD) {
    return allNames;
  }

  if (!query || query.trim().length === 0) {
    // 无 query 时返回核心工具
    const coreTools = allNames.filter(name =>
      ['search_knowledge_base', 'calculate'].includes(name)
    );
    return coreTools.length > 0 ? coreTools : allNames.slice(0, TOOL_RETRIEVAL_TOP_K);
  }

  const queryLower = query.toLowerCase();
  const queryChars = new Set(queryLower.split(''));

  // 计算每个工具与 query 的相关性分数
  const scored = allNames.map(name => {
    const desc = TOOL_SEMANTIC_DESCRIPTIONS[name] || name;
    const descLower = desc.toLowerCase();
    let score = 0;

    // 关键词精确匹配
    const keywords = descLower.split(/\s+/);
    for (const kw of keywords) {
      if (queryLower.includes(kw)) {
        score += 3; // 精确匹配权重高
      }
    }

    // 字符级重叠度（处理中文无空格的情况）
    let charOverlap = 0;
    for (const char of queryChars) {
      if (descLower.includes(char) && /[\u4e00-\u9fff]/.test(char)) {
        charOverlap++;
      }
    }
    score += charOverlap * 0.5;

    // 工具名匹配
    if (queryLower.includes(name.toLowerCase())) {
      score += 5;
    }

    return { name, score };
  });

  // 按分数降序排列，取 Top-K
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, TOOL_RETRIEVAL_TOP_K).map(s => s.name);

  logger.info('动态工具选择', {
    module: 'ToolRegistry',
    query: query.substring(0, 100),
    totalTools: allNames.length,
    selectedTools: selected.join(', '),
    topScores: scored.slice(0, TOOL_RETRIEVAL_TOP_K).map(s => `${s.name}(${s.score.toFixed(1)})`).join(', '),
  });

  return selected;
}

export async function executeTool(name: string, params: any, context?: ToolContext): Promise<any> {
  const tool = TOOLS[name];
  if (!tool) {
    logger.error('FC工具注册中心：尝试执行未注册的工具', {
      module: 'ToolRegistry',
      toolName: name,
      availableTools: Object.keys(TOOLS),
    });
    throw new Error(`未知工具: ${name}，可用工具: ${Object.keys(TOOLS).join(', ')}`);
  }

  logger.info('FC工具注册中心：开始执行工具', {
    module: 'ToolRegistry',
    toolName: name,
    rawParams: JSON.stringify(params).substring(0, 500),
  });

  const startTime = Date.now();
  try {
    const result = await tool.executor(params, context);
    const duration = Date.now() - startTime;

    const resultSummary = typeof result === 'object' && result !== null
      ? JSON.stringify(result).substring(0, 500)
      : String(result).substring(0, 500);

    logger.info('FC工具注册中心：工具执行完成', {
      module: 'ToolRegistry',
      toolName: name,
      duration,
      resultPreview: resultSummary,
    });
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

export { searchKnowledgeBaseSchema, executeSearchKnowledgeBase, type SearchKnowledgeBaseParams, type SearchKnowledgeBaseResult };
export { searchWebSchema, executeSearchWeb, type SearchWebParams, type SearchWebResult, validateSearchWebConfig, isSearchWebAvailable };
export { getWeatherSchema, executeGetWeather, type GetWeatherParams, type GetWeatherResult, validateWeatherConfig, isWeatherAvailable };
export { calculateSchema, executeCalculate, type CalculateParams, type CalculateResult };
export { manageSessionSchema, executeManageSession, type ManageSessionParams, type ManageSessionResult };
