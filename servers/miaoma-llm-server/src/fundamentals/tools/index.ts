import { searchKnowledgeBaseSchema, executeSearchKnowledgeBase, type SearchKnowledgeBaseParams, type SearchKnowledgeBaseResult } from './search-knowledge-base';
import { searchWebSchema, executeSearchWeb, type SearchWebParams, type SearchWebResult, validateSearchWebConfig, isSearchWebAvailable } from './search-web';
import { logger } from '../logger';

export interface ToolDefinition {
  schema: any;
  executor: (params: any) => Promise<any>;
}

export const TOOLS: Record<string, ToolDefinition> = {
  search_knowledge_base: {
    schema: searchKnowledgeBaseSchema,
    executor: executeSearchKnowledgeBase as (params: any) => Promise<any>,
  },
  search_web: {
    schema: searchWebSchema,
    executor: executeSearchWeb as (params: any) => Promise<any>,
  },
};

export function getAllToolSchemas(): any[] {
  return Object.values(TOOLS).map((t) => t.schema);
}

export async function executeTool(name: string, params: any): Promise<any> {
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
    const result = await tool.executor(params);
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

export { searchKnowledgeBaseSchema, executeSearchKnowledgeBase, type SearchKnowledgeBaseParams, type SearchKnowledgeBaseResult };
export { searchWebSchema, executeSearchWeb, type SearchWebParams, type SearchWebResult, validateSearchWebConfig, isSearchWebAvailable };
