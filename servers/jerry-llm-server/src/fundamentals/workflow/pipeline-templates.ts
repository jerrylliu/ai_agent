/**
 * Pipeline 模板库 - 预置高频流水线
 *
 * 这些模板覆盖常见的多步骤场景，用户可通过 execute_workflow 工具按 ID 触发，
 * 也可作为 LLM 自定义流水线的参考样例。
 *
 * 使用方式：
 *   const tpl = getPipelineTemplate('search_and_chart');
 *   await executeWorkflow(tpl, { userInput: '...', sessionId, userId }, executor, res);
 */

import type { WorkflowDefinition } from './workflow-engine';
import { logger } from '../logger';

/**
 * 模板1：知识库搜索 → 生成图表
 * 适用场景："帮我搜下知识库里的 XX，然后画个图"
 */
const SEARCH_KB_AND_CHART: WorkflowDefinition = {
  id: 'search_kb_and_chart',
  name: '知识库搜索并生成图表',
  description: '从知识库搜索相关内容，将结果可视化为图表',
  steps: [
    {
      id: 'step1',
      description: '在知识库中搜索相关文档',
      tool: 'search_knowledge_base',
      params: {
        query: '${context.userInput}',
      },
    },
    {
      id: 'step2',
      description: '基于搜索结果生成图表',
      tool: 'generate_chart',
      params: {
        chartType: 'bar',
        title: '搜索结果分析',
        // 注意：实际 generate_chart 需要 data 字段，
        // 这里直接传入搜索结果作为参考；LLM 在调用时若需精确数据应改用 create_plan
        data: '$step1.output',
      },
      onError: 'continue',
    },
  ],
};

/**
 * 模板2：联网搜索 → 抓取详细网页 → 生成摘要文档
 * 适用场景："搜一下 XX 最新动态，把详细内容整理成文档"
 */
const WEB_SEARCH_AND_DOCUMENT: WorkflowDefinition = {
  id: 'web_search_and_document',
  name: '联网搜索并整理为文档',
  description: '联网搜索最新信息，深度抓取内容，整理为知识库文档',
  steps: [
    {
      id: 'step1',
      description: '联网搜索最新信息',
      tool: 'search_web',
      params: {
        query: '${context.userInput}',
      },
    },
    {
      id: 'step2',
      description: '将搜索结果创建为文档',
      tool: 'create_document',
      params: {
        title: '${context.userInput} - 搜索结果汇总',
        content: '$step1.output',
      },
      onError: 'continue',
    },
  ],
};

/**
 * 模板3：知识库搜索 → 生成思维导图
 * 适用场景："帮我把 XX 相关知识做成思维导图"
 */
const SEARCH_KB_AND_MINDMAP: WorkflowDefinition = {
  id: 'search_kb_and_mindmap',
  name: '知识库搜索并生成思维导图',
  description: '从知识库搜索相关内容，整理为思维导图',
  steps: [
    {
      id: 'step1',
      description: '在知识库中搜索相关文档',
      tool: 'search_knowledge_base',
      params: {
        query: '${context.userInput}',
      },
    },
    {
      id: 'step2',
      description: '将搜索结果整理为思维导图',
      tool: 'create_mindmap',
      params: {
        title: '${context.userInput}',
        content: '$step1.output',
      },
      onError: 'continue',
    },
  ],
};

/**
 * 模板4：联网搜索 → 生成思维导图
 * 适用场景："搜一下 XX 最新进展并做成思维导图"
 */
const WEB_SEARCH_AND_MINDMAP: WorkflowDefinition = {
  id: 'web_search_and_mindmap',
  name: '联网搜索并生成思维导图',
  description: '联网搜索最新信息，整理为思维导图',
  steps: [
    {
      id: 'step1',
      description: '联网搜索最新信息',
      tool: 'search_web',
      params: {
        query: '${context.userInput}',
      },
    },
    {
      id: 'step2',
      description: '将搜索结果整理为思维导图',
      tool: 'create_mindmap',
      params: {
        title: '${context.userInput}',
        content: '$step1.output',
      },
      onError: 'continue',
    },
  ],
};

/**
 * 所有预置模板
 */
const TEMPLATES: Record<string, WorkflowDefinition> = {
  search_kb_and_chart: SEARCH_KB_AND_CHART,
  web_search_and_document: WEB_SEARCH_AND_DOCUMENT,
  search_kb_and_mindmap: SEARCH_KB_AND_MINDMAP,
  web_search_and_mindmap: WEB_SEARCH_AND_MINDMAP,
};

/**
 * 根据 ID 获取流水线模板
 */
export function getPipelineTemplate(id: string): WorkflowDefinition | undefined {
  const template = TEMPLATES[id];
  if (template) {
    logger.debug('Pipeline 模板：命中', {
      module: 'PipelineTemplates',
      templateId: id,
      stepCount: template.steps.length,
    });
  } else {
    logger.warn('Pipeline 模板：未找到', {
      module: 'PipelineTemplates',
      templateId: id,
      available: Object.keys(TEMPLATES).join(', '),
    });
  }
  return template;
}

/**
 * 获取所有模板的简要清单（供 LLM 选择）
 */
export function listPipelineTemplates(): Array<{ id: string; name: string; description: string }> {
  return Object.values(TEMPLATES).map(tpl => ({
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
  }));
}

/**
 * 检查是否存在指定 ID 的模板
 */
export function hasPipelineTemplate(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, id);
}
