/**
 * fundamentals/tools/plan-execute.schema.spec.ts
 *
 * create_plan / update_plan_step / get_plan 三个 Tool 的 zod schema 测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  createPlanSchema,
  createPlanParamsSchema,
  updatePlanStepSchema,
  updatePlanStepParamsSchema,
  getPlanSchema,
  getPlanParamsSchema,
} from './plan-execute';

describe('createPlanSchema', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(createPlanSchema.type).toBe('function');
    expect(createPlanSchema.function.name).toBe('create_plan');
  });

  it('goal / steps 必填', () => {
    const params = createPlanSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['goal', 'steps']);
  });

  it('steps 应为 array<object>，items.required 含 description', () => {
    const params = createPlanSchema.function.parameters as any;
    expect(params.properties.steps.type).toBe('array');
    expect(params.properties.steps.items.type).toBe('object');
    expect(params.properties.steps.items.required).toContain('description');
  });

  it('inputMapping 应是 string -> string 字典（additionalProperties.type=string）', () => {
    const params = createPlanSchema.function.parameters as any;
    const im = params.properties.steps.items.properties.inputMapping;
    expect(im.type).toBe('object');
    expect(im.additionalProperties).toEqual({ type: 'string' });
  });

  it('合法输入应通过', () => {
    const r = createPlanParamsSchema.safeParse({
      goal: '搜索并画图',
      steps: [
        { description: '步骤1', toolName: 'search_web' },
        {
          description: '步骤2',
          toolName: 'create_mindmap',
          inputMapping: { content: '$step1.output' },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('空 steps 数组应被拦截', () => {
    const r = createPlanParamsSchema.safeParse({ goal: 'g', steps: [] });
    expect(r.success).toBe(false);
  });

  it('step 缺 description 应被拦截', () => {
    const r = createPlanParamsSchema.safeParse({
      goal: 'g',
      steps: [{ toolName: 'search_web' }],
    });
    expect(r.success).toBe(false);
  });

  it('inputMapping 含非字符串值应被拦截', () => {
    const r = createPlanParamsSchema.safeParse({
      goal: 'g',
      steps: [{ description: 's', inputMapping: { x: 123 as any } }],
    });
    expect(r.success).toBe(false);
  });
});

describe('updatePlanStepSchema', () => {
  it('stepId / status 必填', () => {
    const params = updatePlanStepSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['status', 'stepId']);
  });

  it('status enum 应为 completed / failed / skipped', () => {
    const params = updatePlanStepSchema.function.parameters as any;
    expect(params.properties.status.enum).toEqual([
      'completed',
      'failed',
      'skipped',
    ]);
  });

  it('合法输入应通过', () => {
    const r = updatePlanStepParamsSchema.safeParse({
      stepId: 1,
      status: 'completed',
      output: { foo: 'bar' },
    });
    expect(r.success).toBe(true);
  });

  it('stepId=0 应被拦截（必须 positive）', () => {
    const r = updatePlanStepParamsSchema.safeParse({
      stepId: 0,
      status: 'completed',
    });
    expect(r.success).toBe(false);
  });

  it('status 越界应被拦截', () => {
    const r = updatePlanStepParamsSchema.safeParse({
      stepId: 1,
      status: 'pending' as any,
    });
    expect(r.success).toBe(false);
  });
});

describe('getPlanSchema', () => {
  it('应为空入参', () => {
    const params = getPlanSchema.function.parameters as any;
    expect(params.type).toBe('object');
    // properties 可以是 {} 或 undefined，required 应为空或不存在
    expect(params.required ?? []).toEqual([]);
  });

  it('空对象应通过', () => {
    const r = getPlanParamsSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});
