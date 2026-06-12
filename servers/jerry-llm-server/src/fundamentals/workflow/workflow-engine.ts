/**
 * Workflow Engine - 工作流执行引擎
 *
 * 解决三大痛点：
 * 1. 工具组合：通过 JSON 定义把多个工具串成流水线，步骤间自动传递数据
 * 2. 自动化：预置模板支持一键执行，无需 LLM 自行规划
 * 3. 可观测：每个步骤的执行进度、结果、错误通过 SSE 实时推送
 *
 * 设计要点：
 * - 复用现有 ToolDefinition.executor，不重写工具
 * - 支持参数模板（${context.xxx}）和数据绑定（$stepN.output.xxx）
 * - 错误隔离：单步失败不影响整体（可配置 onError: 'continue' | 'abort'）
 * - 复用 SSE 推送，与 FC 循环共享前端事件协议
 */

import type { Response } from 'express';
import { logger } from '../logger';
import { sendToolStatus, sendWorkflowEvent } from '../sse-writer';

// ==================== 类型定义 ====================

/** 单步定义 */
export interface WorkflowStep {
  /** 步骤 ID（流水线内唯一） */
  id: string;
  /** 步骤描述（用于日志和 SSE 推送） */
  description: string;
  /** 调用的工具名（必须是 TOOLS 中已注册的工具） */
  tool: string;
  /**
   * 参数模板，支持两种引用：
   * - ${context.xxx}：从 workflow context 取值（用户输入、会话信息等）
   * - $stepN.output / $stepN.output.field：引用前序步骤的输出
   * - 字面量：直接传入
   */
  params: Record<string, any>;
  /** 错误处理策略，默认 abort */
  onError?: 'abort' | 'continue';
}

/** 流水线定义 */
export interface WorkflowDefinition {
  /** 流水线唯一标识 */
  id: string;
  /** 流水线名称（用户可见） */
  name: string;
  /** 流水线描述 */
  description: string;
  /** 步骤列表（顺序执行） */
  steps: WorkflowStep[];
}

/** 单步执行结果 */
export interface StepResult {
  stepId: string;
  status: 'success' | 'failed' | 'skipped';
  output?: any;
  error?: string;
  durationMs: number;
}

/** 流水线执行结果 */
export interface WorkflowResult {
  workflowId: string;
  status: 'completed' | 'failed' | 'partial';
  steps: StepResult[];
  totalDurationMs: number;
  finalOutput?: any;
}

/** 执行上下文 */
export interface WorkflowContext {
  /** 用户输入（一般是用户的原始问题） */
  userInput?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 用户 ID */
  userId?: string;
  /** 自定义参数（用于参数模板 ${context.xxx} 引用） */
  [key: string]: any;
}

// ==================== 参数解析 ====================

/**
 * 从对象按路径取值。支持 a.b.c 格式
 */
function getByPath(obj: any, path: string): any {
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  let value = obj;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[part];
  }
  return value;
}

/**
 * 解析单个值
 * - 字符串 "${context.xxx}" → context 中的值
 * - 字符串 "$stepN.output.xxx" → 前序步骤输出
 * - 字符串中夹杂模板（如 "查询：${context.userInput}"）→ 字符串拼接
 * - 其他类型 → 原样返回
 */
function resolveValue(value: any, context: WorkflowContext, stepOutputs: Record<string, any>): any {
  if (typeof value !== 'string') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // 递归解析对象
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = resolveValue(v, context, stepOutputs);
      }
      return resolved;
    }
    if (Array.isArray(value)) {
      return value.map(item => resolveValue(item, context, stepOutputs));
    }
    return value;
  }

  // 整体引用 $stepN.output[.field]
  // $step 后面跟的是步骤 ID（可以是 step1, s1, myStep 等任意字符串，以 .output 结束）
  const stepRefMatch = value.match(/^\$step([^./]+)\.output(.*)$/);
  if (stepRefMatch) {
    const stepId = stepRefMatch[1];
    const path = stepRefMatch[2].replace(/^\./, '');
    const stepOutput = stepOutputs[stepId];
    if (stepOutput === undefined) {
      logger.warn('Workflow：引用的步骤输出不存在', {
        module: 'WorkflowEngine',
        stepId,
        expression: value,
        availableStepIds: Object.keys(stepOutputs).join(', ') || '(none)',
      });
      return undefined;
    }
    const resolved = path ? getByPath(stepOutput, path) : stepOutput;
    logger.debug('Workflow：步骤引用已解析', {
      module: 'WorkflowEngine',
      expression: value,
      stepId,
      path: path || '(whole)',
      resolvedType: typeof resolved,
      resolvedIsUndefined: resolved === undefined,
    });
    return resolved;
  }

  // 整体引用 ${context.xxx}
  const wholeContextMatch = value.match(/^\$\{context\.([^}]+)\}$/);
  if (wholeContextMatch) {
    const path = wholeContextMatch[1];
    const resolved = getByPath(context, path);
    logger.debug('Workflow：上下文引用已解析', {
      module: 'WorkflowEngine',
      expression: value,
      contextPath: path,
      resolvedType: typeof resolved,
      resolvedIsUndefined: resolved === undefined,
    });
    return resolved;
  }

  // 字符串中夹杂模板：进行字符串替换
  let hasTemplateMatch = false;
  const replaced = value.replace(/\$\{context\.([^}]+)\}/g, (_match, path) => {
    hasTemplateMatch = true;
    const v = getByPath(context, path);
    if (v === undefined) {
      logger.warn('Workflow：模板字符串中的上下文路径未定义', {
        module: 'WorkflowEngine',
        original: value,
        contextPath: path,
      });
    }
    return v === undefined ? '' : String(v);
  });
  if (hasTemplateMatch) {
    logger.debug('Workflow：模板字符串已替换', {
      module: 'WorkflowEngine',
      original: value,
      replaced,
    });
  }
  return replaced;
}

/** 解析整个 params 对象 */
function resolveParams(
  params: Record<string, any>,
  context: WorkflowContext,
  stepOutputs: Record<string, any>,
): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    resolved[key] = resolveValue(value, context, stepOutputs);
  }
  return resolved;
}

// ==================== 执行引擎 ====================

/** 工具执行器函数类型（避免循环依赖，由调用方注入） */
export type ToolExecutor = (toolName: string, params: any, ctx: { userId?: string; sessionId?: string; res?: Response }) => Promise<any>;

/**
 * 执行流水线
 *
 * @param workflow 流水线定义
 * @param context 执行上下文（用户输入、会话信息等）
 * @param toolExecutor 工具执行器（由 tools/index.ts 提供）
 * @param res SSE Response（用于实时推送进度），可选
 */
export async function executeWorkflow(
  workflow: WorkflowDefinition,
  context: WorkflowContext,
  toolExecutor: ToolExecutor,
  res?: Response,
): Promise<WorkflowResult> {
  const startTime = Date.now();
  const stepResults: StepResult[] = [];
  const stepOutputs: Record<string, any> = {};

  logger.info('Workflow：开始执行', {
    module: 'WorkflowEngine',
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepCount: workflow.steps.length,
    userId: context.userId,
    sessionId: context.sessionId,
    userInputPreview: typeof context.userInput === 'string' ? context.userInput.substring(0, 100) : undefined,
    stepIds: workflow.steps.map(s => s.id).join(' -> '),
    stepTools: workflow.steps.map(s => s.tool).join(' -> '),
    sseEnabled: !!res,
  });

  // 推送流水线开始事件
  if (res) {
    sendWorkflowEvent(res, 'workflow_start', {
      workflowId: workflow.id,
      name: workflow.name,
      totalSteps: workflow.steps.length,
    });
  }

  let aborted = false;

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepStartTime = Date.now();
    const stepLogContext = {
      module: 'WorkflowEngine',
      workflowId: workflow.id,
      stepIndex: i + 1,
      totalSteps: workflow.steps.length,
      stepId: step.id,
      tool: step.tool,
      onError: step.onError ?? 'abort',
    };

    if (aborted) {
      logger.info('Workflow：因上一步失败 abort，跳过当前步骤', stepLogContext);
      stepResults.push({
        stepId: step.id,
        status: 'skipped',
        durationMs: 0,
      });
      continue;
    }

    logger.info('Workflow：步骤开始', {
      ...stepLogContext,
      description: step.description,
      paramsKeys: Object.keys(step.params || {}).join(', '),
    });

    // 推送步骤开始事件
    if (res) {
      sendWorkflowEvent(res, 'workflow_step_start', {
        workflowId: workflow.id,
        stepId: step.id,
        stepIndex: i + 1,
        totalSteps: workflow.steps.length,
        description: step.description,
        tool: step.tool,
      });
      sendToolStatus(res, step.tool, 'executing');
    }

    // 解析参数
    let resolvedParams: Record<string, any>;
    try {
      logger.debug('Workflow：开始解析步骤参数', {
        ...stepLogContext,
        rawParams: JSON.stringify(step.params).substring(0, 500),
      });
      resolvedParams = resolveParams(step.params, context, stepOutputs);
      logger.info('Workflow：步骤参数解析完成', {
        ...stepLogContext,
        resolvedParamsKeys: Object.keys(resolvedParams).join(', '),
        resolvedParamsPreview: JSON.stringify(resolvedParams).substring(0, 500),
      });
    } catch (paramError: any) {
      const errMsg = `参数解析失败: ${paramError.message}`;
      logger.error('Workflow：参数解析失败', {
        ...stepLogContext,
        error: errMsg,
        errorStack: paramError.stack?.substring(0, 500),
      });
      stepResults.push({
        stepId: step.id,
        status: 'failed',
        error: errMsg,
        durationMs: Date.now() - stepStartTime,
      });
      if (res) {
        sendWorkflowEvent(res, 'workflow_step_done', {
          workflowId: workflow.id,
          stepId: step.id,
          status: 'failed',
          error: errMsg,
        });
        sendToolStatus(res, step.tool, 'done', { error: true });
      }
      if ((step.onError ?? 'abort') === 'abort') {
        logger.warn('Workflow：onError=abort，标记后续步骤跳过', stepLogContext);
        aborted = true;
      }
      continue;
    }

    // 执行工具
    try {
      logger.debug('Workflow：开始调用工具', stepLogContext);
      const output = await toolExecutor(step.tool, resolvedParams, {
        userId: context.userId,
        sessionId: context.sessionId,
        res,
      });

      stepOutputs[step.id] = output;
      // 同时以步骤序号（1-based）作为别名存储，让 $step1 可以引用第 1 个步骤
      // 无论步骤 ID 是 "step1"、"s1" 还是 "search_step"，$step1 都能正确引用
      stepOutputs[String(i + 1)] = output;
      const stepDurationMs = Date.now() - stepStartTime;
      stepResults.push({
        stepId: step.id,
        status: 'success',
        output,
        durationMs: stepDurationMs,
      });

      logger.info('Workflow：步骤执行成功', {
        ...stepLogContext,
        durationMs: stepDurationMs,
        outputType: typeof output,
        outputPreview: typeof output === 'string'
          ? output.substring(0, 200)
          : JSON.stringify(output).substring(0, 200),
      });

      if (res) {
        sendWorkflowEvent(res, 'workflow_step_done', {
          workflowId: workflow.id,
          stepId: step.id,
          status: 'success',
          durationMs: stepDurationMs,
        });
        sendToolStatus(res, step.tool, 'done');
      }
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const stepDurationMs = Date.now() - stepStartTime;
      logger.error('Workflow：步骤执行失败', {
        ...stepLogContext,
        durationMs: stepDurationMs,
        error: errMsg,
        errorStack: error?.stack?.substring(0, 500),
      });

      stepResults.push({
        stepId: step.id,
        status: 'failed',
        error: errMsg,
        durationMs: stepDurationMs,
      });

      if (res) {
        sendWorkflowEvent(res, 'workflow_step_done', {
          workflowId: workflow.id,
          stepId: step.id,
          status: 'failed',
          error: errMsg,
        });
        sendToolStatus(res, step.tool, 'done', { error: true });
      }

      if ((step.onError ?? 'abort') === 'abort') {
        logger.warn('Workflow：onError=abort，标记后续步骤跳过', stepLogContext);
        aborted = true;
      } else {
        logger.info('Workflow：onError=continue，继续执行后续步骤', stepLogContext);
      }
    }
  }

  // 计算流水线整体状态
  const failedCount = stepResults.filter(r => r.status === 'failed').length;
  const successCount = stepResults.filter(r => r.status === 'success').length;
  let status: 'completed' | 'failed' | 'partial';
  if (failedCount === 0) {
    status = 'completed';
  } else if (successCount === 0) {
    status = 'failed';
  } else {
    status = 'partial';
  }

  // 最后一个成功步骤的输出作为流水线最终输出
  const lastSuccess = [...stepResults].reverse().find(r => r.status === 'success');
  const finalOutput = lastSuccess?.output;

  const totalDurationMs = Date.now() - startTime;

  logger.info('Workflow：执行完成', {
    module: 'WorkflowEngine',
    workflowId: workflow.id,
    status,
    successCount,
    failedCount,
    totalDurationMs,
  });

  // 推送流水线完成事件
  if (res) {
    sendWorkflowEvent(res, 'workflow_complete', {
      workflowId: workflow.id,
      status,
      totalSteps: workflow.steps.length,
      successCount,
      failedCount,
      totalDurationMs,
    });
  }

  return {
    workflowId: workflow.id,
    status,
    steps: stepResults,
    totalDurationMs,
    finalOutput,
  };
}

/**
 * 校验流水线定义的合法性
 * 用于在执行前快速发现错误（如引用了不存在的步骤）
 */
export function validateWorkflow(workflow: WorkflowDefinition): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const stepIds = new Set<string>();

  if (!workflow.id) errors.push('流水线必须有 id');
  if (!workflow.steps || workflow.steps.length === 0) errors.push('流水线必须至少包含一个步骤');

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step.id) {
      errors.push(`步骤 ${i + 1} 缺少 id`);
      continue;
    }
    if (stepIds.has(step.id)) {
      errors.push(`步骤 ${step.id} 的 id 重复`);
    }
    if (!step.tool) {
      errors.push(`步骤 ${step.id} 缺少 tool`);
    }

    // 校验数据绑定引用的步骤是否在前面定义过
    if (step.params) {
      const refs = collectStepReferences(step.params);
      for (const ref of refs) {
        // 纯数字引用是步骤序号（1-based），检查序号是否 <= 当前步骤索引
        const refAsIndex = parseInt(ref, 10);
        if (!isNaN(refAsIndex) && String(refAsIndex) === ref) {
          if (refAsIndex > i + 1) {
            errors.push(`步骤 ${step.id} 引用了后定义的步骤序号 $step${ref}（当前是第 ${i + 1} 步）`);
          }
          // 序号引用始终有效（只要不超过当前步骤），不需要在 stepIds 中查找
        } else {
          // 非数字引用按步骤 ID 查找
          if (!stepIds.has(ref)) {
            errors.push(`步骤 ${step.id} 引用了未定义或后定义的步骤 ${ref}`);
          }
        }
      }
    }

    stepIds.add(step.id);
  }

  return { valid: errors.length === 0, errors };
}

/** 递归收集 params 中所有 $stepN 引用 */
function collectStepReferences(params: any): string[] {
  const refs: string[] = [];
  if (typeof params === 'string') {
    const match = params.match(/^\$step([^./]+)\.output/);
    if (match) refs.push(match[1]);
  } else if (Array.isArray(params)) {
    for (const item of params) refs.push(...collectStepReferences(item));
  } else if (params && typeof params === 'object') {
    for (const v of Object.values(params)) refs.push(...collectStepReferences(v));
  }
  return refs;
}
