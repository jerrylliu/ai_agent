/**
 * execute_workflow 工具 - 让 LLM 触发预置流水线
 *
 * 当 LLM 识别到任务匹配某个预置流水线时，可调用此工具一键执行整条流水线，
 * 而无需自己规划多个工具调用。
 *
 * 使用场景：
 * - 用户："帮我搜知识库里的 React，然后画图"
 *   → LLM 调用 execute_workflow({ templateId: 'search_kb_and_chart' })
 *
 * 设计：
 * - 仅触发预置模板，不接受任意 JSON 流水线（避免 LLM 输出错误结构）
 * - 自定义流水线请用 create_plan + inputMapping
 */

import { logger } from '../logger';
import { executeWorkflow, type ToolExecutor } from './workflow-engine';
import { getPipelineTemplate, listPipelineTemplates, hasPipelineTemplate } from './pipeline-templates';

// 工具执行器引用，由 tools/index.ts 在初始化时注入（避免循环依赖）
let toolExecutorRef: ToolExecutor | null = null;

export function setWorkflowToolExecutor(executor: ToolExecutor): void {
  toolExecutorRef = executor;
}

// ==================== Schema ====================

/**
 * 动态构建 schema，把可用模板列表写到 enum 中
 * 这样 LLM 只能从合法模板中选择
 */
export function buildExecuteWorkflowSchema() {
  const templates = listPipelineTemplates();
  const templateIds = templates.map(t => t.id);
  const templateDescriptions = templates
    .map(t => `${t.id}: ${t.name} - ${t.description}`)
    .join('\n  ');

  return {
    type: 'function' as const,
    function: {
      name: 'execute_workflow',
      description: `触发预置工作流（流水线），一键执行多个工具的组合。当用户的需求匹配某个预置流水线时，优先使用此工具，比手动调用多个工具更稳定。

可用流水线：
  ${templateDescriptions}

如果以上流水线都不匹配用户需求，请改用 create_plan 创建自定义计划。`,
      parameters: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '要执行的流水线模板 ID',
            enum: templateIds.length > 0 ? templateIds : undefined,
          },
          userInput: {
            type: 'string',
            description: '用户原始问题或主题（流水线内的步骤会通过 ${context.userInput} 引用此值）',
          },
        },
        required: ['templateId', 'userInput'],
      },
    },
  };
}

// ==================== 执行函数 ====================

export interface ExecuteWorkflowParams {
  templateId: string;
  userInput: string;
}

export interface ExecuteWorkflowResult {
  workflowId: string;
  status: 'completed' | 'failed' | 'partial' | 'not_found';
  message: string;
  steps?: Array<{ stepId: string; status: string; durationMs: number; error?: string }>;
  finalOutput?: any;
}

export async function executeExecuteWorkflow(
  params: ExecuteWorkflowParams,
  context?: { userId?: string; sessionId?: string; res?: any },
): Promise<ExecuteWorkflowResult> {
  const { templateId, userInput } = params;

  logger.info('execute_workflow：收到调用请求', {
    module: 'Tool:ExecuteWorkflow',
    templateId,
    userInputLength: userInput?.length || 0,
    userInputPreview: userInput?.substring(0, 100),
    userId: context?.userId,
    sessionId: context?.sessionId,
    hasRes: !!context?.res,
  });

  if (!hasPipelineTemplate(templateId)) {
    const available = listPipelineTemplates().map(t => t.id).join(', ');
    logger.warn('execute_workflow：未知模板，拒绝执行', {
      module: 'Tool:ExecuteWorkflow',
      templateId,
      availableTemplates: available,
    });
    return {
      workflowId: templateId,
      status: 'not_found',
      message: `流水线模板 "${templateId}" 不存在。可用模板：${available}`,
    };
  }

  if (!toolExecutorRef) {
    logger.error('execute_workflow：工具执行器未注入', {
      module: 'Tool:ExecuteWorkflow',
      templateId,
    });
    return {
      workflowId: templateId,
      status: 'failed',
      message: 'Workflow 引擎未初始化（工具执行器未注入）',
    };
  }

  const template = getPipelineTemplate(templateId)!;

  logger.info('execute_workflow：触发流水线执行', {
    module: 'Tool:ExecuteWorkflow',
    templateId,
    templateName: template.name,
    stepCount: template.steps.length,
    stepTools: template.steps.map(s => s.tool).join(' -> '),
    userId: context?.userId,
    sessionId: context?.sessionId,
  });

  const startTime = Date.now();
  const result = await executeWorkflow(
    template,
    {
      userInput,
      sessionId: context?.sessionId,
      userId: context?.userId,
    },
    toolExecutorRef,
    context?.res,
  );

  logger.info('execute_workflow：流水线执行返回', {
    module: 'Tool:ExecuteWorkflow',
    templateId,
    status: result.status,
    successCount: result.steps.filter(s => s.status === 'success').length,
    failedCount: result.steps.filter(s => s.status === 'failed').length,
    skippedCount: result.steps.filter(s => s.status === 'skipped').length,
    totalDurationMs: result.totalDurationMs,
    wallClockMs: Date.now() - startTime,
  });

  return {
    workflowId: result.workflowId,
    status: result.status,
    message: `流水线 "${template.name}" 执行${
      result.status === 'completed' ? '成功' :
      result.status === 'partial' ? '部分成功' : '失败'
    }，共 ${result.steps.length} 个步骤，耗时 ${result.totalDurationMs}ms`,
    steps: result.steps.map(s => ({
      stepId: s.stepId,
      status: s.status,
      durationMs: s.durationMs,
      error: s.error,
    })),
    finalOutput: result.finalOutput,
  };
}
