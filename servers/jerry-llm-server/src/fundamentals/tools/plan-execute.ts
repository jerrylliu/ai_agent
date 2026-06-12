/**
 * Plan-and-Execute 规划工具（增强版：支持步骤间数据绑定）
 *
 * 为 Agent 提供独立的规划能力，避免 ReAct 模式下的工具调用循环。
 * 当任务较复杂时，Agent 应先调用此工具生成执行计划，然后按计划逐步执行。
 *
 * 增强功能：
 * - 步骤间数据绑定：步骤可声明 inputMapping，引用前序步骤的输出作为输入
 * - 自动输出存储：FC 循环执行工具后自动将结果存入步骤的 output 字段
 * - 数据绑定解析：resolveDataBindings() 自动将 $stepN.output.xxx 解析为实际值
 *
 * 工作流程：
 * 1. Agent 调用 create_plan 生成步骤列表（可带 inputMapping）
 * 2. FC 循环按步骤依次调用工具，自动解析数据绑定
 * 3. 工具执行后结果自动存入步骤 output
 * 4. 下一步骤通过 inputMapping 引用前序步骤的输出
 * 5. 全部完成后计划自动标记为 completed
 */

import { logger } from '../logger';

// 内存中的计划存储（按会话隔离）
const plans = new Map<string, Plan>();

export interface PlanStep {
  id: number;
  description: string;
  toolName?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  result?: string;
  /** 步骤的结构化输出，由 FC 循环自动填充 */
  output?: any;
  /** 数据绑定映射，key 为当前工具参数名，value 为引用表达式如 "$step1.output" */
  inputMapping?: Record<string, string>;
}

export interface Plan {
  sessionId: string;
  goal: string;
  steps: PlanStep[];
  status: 'planning' | 'executing' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

// ==================== 数据绑定解析 ====================

/**
 * 解析数据绑定表达式
 * 支持格式：
 *   "$step1.output"        → 整个步骤1的输出
 *   "$step1.output.data"   → 步骤1输出的 data 字段
 *   "$step2.output.items"  → 步骤2输出的 items 字段
 *
 * @param expression 绑定表达式
 * @param plan 当前计划
 * @returns 解析后的值，解析失败返回 undefined
 */
export function resolveBinding(expression: string, plan: Plan): any {
  if (!expression || !expression.startsWith('$step')) {
    return undefined;
  }

  // 解析 $stepN.output.xxx 格式
  const match = expression.match(/^\$step(\d+)\.output(.*)$/);
  if (!match) {
    logger.warn('数据绑定：无法解析表达式', { module: 'Tool:PlanExecute', expression });
    return undefined;
  }

  const stepId = parseInt(match[1], 10);
  const pathParts = match[2] ? match[2].split('.').filter(Boolean) : [];

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) {
    logger.warn('数据绑定：引用的步骤不存在', { module: 'Tool:PlanExecute', stepId, expression });
    return undefined;
  }

  if (step.status !== 'completed') {
    logger.warn('数据绑定：引用的步骤尚未完成', { module: 'Tool:PlanExecute', stepId, stepStatus: step.status });
    return undefined;
  }

  let value = step.output;
  for (const part of pathParts) {
    if (value == null || typeof value !== 'object') {
      logger.warn('数据绑定：路径中途值为 null 或非对象', { module: 'Tool:PlanExecute', expression, pathPart: part });
      return undefined;
    }
    value = value[part];
  }

  return value;
}

/**
 * 为工具参数解析所有数据绑定
 * 遍历 params 中的每个值，如果匹配 $stepN.output.xxx 格式则替换为实际值
 *
 * @param params 原始工具参数（可能包含绑定表达式）
 * @param plan 当前计划
 * @returns 解析后的参数
 */
export function resolveDataBindings(params: Record<string, any>, plan: Plan): Record<string, any> {
  const resolved: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$step')) {
      const resolvedValue = resolveBinding(value, plan);
      if (resolvedValue !== undefined) {
        resolved[key] = resolvedValue;
        logger.info('数据绑定：已解析', { module: 'Tool:PlanExecute', key, expression: value, resolvedType: typeof resolvedValue });
      } else {
        // 解析失败，保留原始表达式（LLM 可能自行处理）
        resolved[key] = value;
        logger.warn('数据绑定：解析失败，保留原始表达式', { module: 'Tool:PlanExecute', key, expression: value });
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // 递归解析嵌套对象
      resolved[key] = resolveDataBindings(value, plan);
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * 获取指定会话的当前计划
 */
export function getSessionPlan(sessionId: string): Plan | undefined {
  return plans.get(sessionId || 'default');
}

/**
 * 将工具执行结果存储到计划步骤的 output 中
 * 由 FC 循环在工具执行成功后调用
 */
export function storeStepOutput(sessionId: string, stepId: number, output: any): void {
  const plan = plans.get(sessionId || 'default');
  if (!plan) return;

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) return;

  step.output = output;
  plan.updatedAt = new Date();

  logger.info('数据绑定：已存储步骤输出', {
    module: 'Tool:PlanExecute',
    sessionId,
    stepId,
    outputType: typeof output,
  });
}

/**
 * 查找计划中匹配指定工具名称的下一个待执行步骤
 * 用于 FC 循环判断当前工具调用是否属于某个计划步骤
 */
export function findMatchingStep(sessionId: string, toolName: string): PlanStep | undefined {
  const plan = plans.get(sessionId || 'default');
  if (!plan || plan.status !== 'executing') return undefined;

  return plan.steps.find(s =>
    s.status === 'pending' && s.toolName === toolName
  );
}

// ==================== create_plan ====================

export const createPlanSchema = {
  type: 'function' as const,
  function: {
    name: 'create_plan',
    description: '为复杂任务创建执行计划。当任务需要多个步骤、涉及多个工具调用、或用户明确要求分步执行时，先创建计划再逐步执行。支持步骤间数据绑定：通过 inputMapping 可引用前序步骤的输出作为当前步骤的输入。简单问题不需要创建计划，直接回答即可。',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '任务的最终目标描述',
        },
        steps: {
          type: 'array',
          description: '执行步骤列表，按顺序排列',
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: '步骤描述',
              },
              toolName: {
                type: 'string',
                description: '该步骤需要使用的工具名称',
              },
              inputMapping: {
                type: 'object',
                description: '数据绑定映射。key 为当前工具的参数名，value 为引用表达式如 "$step1.output" 或 "$step1.output.data"。当某个参数需要从前序步骤的输出获取时使用。',
                additionalProperties: { type: 'string' },
              },
            },
            required: ['description'],
          },
        },
      },
      required: ['goal', 'steps'],
    },
  },
};

export interface CreatePlanParams {
  goal: string;
  steps: Array<{ description: string; toolName?: string; inputMapping?: Record<string, string> }>;
}

export interface CreatePlanResult {
  planId: string;
  goal: string;
  totalSteps: number;
  steps: PlanStep[];
  message: string;
}

export async function executeCreatePlan(
  params: CreatePlanParams,
  context?: { sessionId?: string },
): Promise<CreatePlanResult> {
  const sessionId = context?.sessionId || 'default';

  const steps: PlanStep[] = params.steps.map((s, i) => ({
    id: i + 1,
    description: s.description,
    toolName: s.toolName,
    inputMapping: s.inputMapping,
    status: 'pending' as const,
  }));

  const plan: Plan = {
    sessionId,
    goal: params.goal,
    steps,
    status: 'executing',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  plans.set(sessionId, plan);

  logger.info('规划工具：创建执行计划', {
    module: 'Tool:PlanExecute',
    sessionId,
    goal: params.goal,
    stepCount: steps.length,
    hasInputMapping: steps.filter(s => s.inputMapping && Object.keys(s.inputMapping).length > 0).length,
  });

  return {
    planId: sessionId,
    goal: params.goal,
    totalSteps: steps.length,
    steps,
    message: `已创建执行计划，共 ${steps.length} 个步骤。请按顺序执行，每完成一步调用 update_plan_step 更新状态。${
      steps.some(s => s.inputMapping && Object.keys(s.inputMapping).length > 0)
        ? ' 本计划包含数据绑定，步骤间的数据会自动传递。'
        : ''
    }`,
  };
}

// ==================== update_plan_step ====================

export const updatePlanStepSchema = {
  type: 'function' as const,
  function: {
    name: 'update_plan_step',
    description: '更新执行计划中某个步骤的状态。完成一个步骤后调用此工具标记为已完成，失败则标记为失败。可附带输出数据，供后续步骤通过数据绑定引用。',
    parameters: {
      type: 'object',
      properties: {
        stepId: {
          type: 'number',
          description: '步骤编号（从1开始）',
        },
        status: {
          type: 'string',
          description: '步骤的新状态',
          enum: ['completed', 'failed', 'skipped'],
        },
        result: {
          type: 'string',
          description: '步骤执行结果的简要描述',
        },
        output: {
          description: '步骤的结构化输出数据，供后续步骤通过 $stepN.output.xxx 引用',
        },
      },
      required: ['stepId', 'status'],
    },
  },
};

export interface UpdatePlanStepParams {
  stepId: number;
  status: 'completed' | 'failed' | 'skipped';
  result?: string;
  output?: any;
}

export interface UpdatePlanStepResult {
  stepId: number;
  status: string;
  planStatus: string;
  completedSteps: number;
  totalSteps: number;
  nextStep?: PlanStep;
  message: string;
}

export async function executeUpdatePlanStep(
  params: UpdatePlanStepParams,
  context?: { sessionId?: string },
): Promise<UpdatePlanStepResult> {
  const sessionId = context?.sessionId || 'default';
  const plan = plans.get(sessionId);

  if (!plan) {
    return {
      stepId: params.stepId,
      status: params.status,
      planStatus: 'not_found',
      completedSteps: 0,
      totalSteps: 0,
      message: '未找到当前会话的执行计划，请先调用 create_plan 创建计划。',
    };
  }

  const step = plan.steps.find(s => s.id === params.stepId);
  if (!step) {
    return {
      stepId: params.stepId,
      status: params.status,
      planStatus: plan.status,
      completedSteps: plan.steps.filter(s => s.status === 'completed').length,
      totalSteps: plan.steps.length,
      message: `步骤 ${params.stepId} 不存在。`,
    };
  }

  step.status = params.status;
  step.result = params.result;
  if (params.output !== undefined) {
    step.output = params.output;
  }
  plan.updatedAt = new Date();

  const completedSteps = plan.steps.filter(s => s.status === 'completed').length;
  const failedSteps = plan.steps.filter(s => s.status === 'failed').length;
  const nextStep = plan.steps.find(s => s.status === 'pending');

  // 检查计划是否完成
  if (!nextStep) {
    plan.status = failedSteps > 0 ? 'failed' : 'completed';
  }

  logger.info('规划工具：更新步骤状态', {
    module: 'Tool:PlanExecute',
    sessionId,
    stepId: params.stepId,
    status: params.status,
    hasOutput: params.output !== undefined,
    planStatus: plan.status,
    completedSteps,
    totalSteps: plan.steps.length,
  });

  // 构建下一步的数据绑定提示
  let nextStepHint = '';
  if (nextStep?.inputMapping && Object.keys(nextStep.inputMapping).length > 0) {
    const mappings = Object.entries(nextStep.inputMapping)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    nextStepHint = `（数据绑定：${mappings}）`;
  }

  return {
    stepId: params.stepId,
    status: params.status,
    planStatus: plan.status,
    completedSteps,
    totalSteps: plan.steps.length,
    nextStep: nextStep || undefined,
    message: nextStep
      ? `步骤 ${params.stepId} 已标记为 ${params.status}。下一步：步骤 ${nextStep.id} - ${nextStep.description}${nextStepHint}`
      : `步骤 ${params.stepId} 已标记为 ${params.status}。所有步骤已完成，计划状态：${plan.status}。`,
  };
}

// ==================== get_plan ====================

export const getPlanSchema = {
  type: 'function' as const,
  function: {
    name: 'get_plan',
    description: '查看当前会话的执行计划及各步骤状态。用于在执行过程中回顾计划进度，查看各步骤的输出数据。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

export interface GetPlanResult {
  goal: string;
  status: string;
  steps: PlanStep[];
  completedSteps: number;
  totalSteps: number;
  message: string;
}

export async function executeGetPlan(
  _params: Record<string, never> = {},
  context?: { sessionId?: string },
): Promise<GetPlanResult> {
  const sessionId = context?.sessionId || 'default';
  const plan = plans.get(sessionId);

  if (!plan) {
    return {
      goal: '',
      status: 'not_found',
      steps: [],
      completedSteps: 0,
      totalSteps: 0,
      message: '当前会话没有执行计划。',
    };
  }

  const completedSteps = plan.steps.filter(s => s.status === 'completed').length;

  return {
    goal: plan.goal,
    status: plan.status,
    steps: plan.steps,
    completedSteps,
    totalSteps: plan.steps.length,
    message: `计划目标：${plan.goal}，进度：${completedSteps}/${plan.steps.length}，状态：${plan.status}`,
  };
}
