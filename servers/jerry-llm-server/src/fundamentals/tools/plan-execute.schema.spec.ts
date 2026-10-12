/**
 * fundamentals/tools/plan-execute.schema.spec.ts
 *
 * create_plan / update_plan_step / get_plan 三个 Tool 的 zod schema 测试
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock 飞书服务，避免触发 config 解析（fail-fast 缺少 JWT_SECRET）
jest.mock('../feishu-notify.service', () => ({
  sendCardMessage: jest.fn().mockResolvedValue({ success: false }),
  buildCardJson: jest.fn().mockReturnValue({}),
  detectReceiveIdType: jest.fn().mockReturnValue('email'),
  updateCard: jest.fn().mockResolvedValue({ success: true }),
}));

import {
  createPlanSchema,
  createPlanParamsSchema,
  updatePlanStepSchema,
  updatePlanStepParamsSchema,
  getPlanSchema,
  getPlanParamsSchema,
} from './plan-execute';
import { safeParseToolParams } from './_helpers';

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

  // ==================== 参数形态容错回归（生产案例 2026-10-12 12:19） ====================
  // 形态容错由 safeParseToolParams 的 schema 导向全局归一化提供，
  // 因此这些用例走 safeParseToolParams 真实路径（与生产执行路径一致）

  it('steps 传 JSON 字符串应解析为数组并通过（多余字段被剥离）', () => {
    const r = safeParseToolParams(createPlanParamsSchema, {
      goal: '重庆天气图表',
      steps: JSON.stringify([
        {
          step: 1,
          description: '查询重庆未来天气预报数据',
          tool: 'get_weather',
          params: { city: '重庆', type: 'daily' },
        },
        {
          step: 2,
          description: '联网搜索最近国外新闻',
          tool: 'search_web',
          inputMapping: { data: '$step1.output' },
        },
      ]),
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.steps).toHaveLength(2);
      expect(r.data.steps[0].description).toBe('查询重庆未来天气预报数据');
      expect(r.data.steps[1].inputMapping).toEqual({ data: '$step1.output' });
    }
  });

  it('goal 缺失误传 title 时应别名兜底', () => {
    const r = safeParseToolParams(createPlanParamsSchema, {
      title: '重庆天气图表 + 国外新闻PDF → 邮件与飞书推送',
      steps: [{ description: '步骤1' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.goal).toBe('重庆天气图表 + 国外新闻PDF → 邮件与飞书推送');
    }
  });

  it('完整复现生产日志：steps JSON 字符串 + title 别名 + 多余字段应通过', () => {
    const r = safeParseToolParams(createPlanParamsSchema, {
      title: '重庆天气图表 + 国外新闻PDF → 邮件与飞书推送',
      steps:
        '[{"step": 1, "description": "查询重庆未来天气预报数据", "tool": "get_weather", "params": {"city": "重庆", "type": "daily"}}, {"step": 2, "description": "联网搜索最近国外新闻", "tool": "search_web"}]',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.goal).toBe('重庆天气图表 + 国外新闻PDF → 邮件与飞书推送');
      expect(r.data.steps).toHaveLength(2);
      expect(r.data.steps[0].description).toBe('查询重庆未来天气预报数据');
    }
  });

  it('steps 传非法 JSON 字符串应保持失败（不给模糊兜底）', () => {
    const r = safeParseToolParams(createPlanParamsSchema, {
      goal: 'g',
      steps: '这不是JSON',
    });
    expect(r.success).toBe(false);
  });

  it('goal 与 title 同时存在时应优先 goal', () => {
    const r = safeParseToolParams(createPlanParamsSchema, {
      goal: '真正的目标',
      title: '别名的标题',
      steps: [{ description: 's' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.goal).toBe('真正的目标');
    }
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
