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
