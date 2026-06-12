/**
 * Plan-Execute 数据绑定单元测试（P0）
 *
 * 验证：
 * 1. resolveBinding 表达式解析（成功/失败/边界）
 * 2. resolveDataBindings 整体参数解析
 * 3. storeStepOutput 输出持久化
 * 4. findMatchingStep 步骤查找
 * 5. create_plan / update_plan_step / get_plan 工具基本流程
 */

// Mock logger，避免依赖真实日志系统
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  executeCreatePlan,
  executeUpdatePlanStep,
  executeGetPlan,
  resolveBinding,
  resolveDataBindings,
  storeStepOutput,
  findMatchingStep,
  getSessionPlan,
  type Plan,
} from './plan-execute';

describe('Plan-Execute 数据绑定（P0）', () => {
  // 每个测试用独立的 sessionId，避免共享内存计划相互污染
  let testSessionCounter = 0;
  const newSession = () => `test-session-${++testSessionCounter}-${Date.now()}`;

  describe('create_plan / update_plan_step / get_plan 基础流程', () => {
    it('应能创建一个包含数据绑定的计划', async () => {
      const sessionId = newSession();
      const result = await executeCreatePlan(
        {
          goal: '搜索并画图',
          steps: [
            { description: '搜索知识库', toolName: 'search_knowledge_base' },
            {
              description: '基于结果画图',
              toolName: 'generate_chart',
              inputMapping: { data: '$step1.output.results' },
            },
          ],
        },
        { sessionId },
      );

      expect(result.totalSteps).toBe(2);
      expect(result.steps[0].id).toBe(1);
      expect(result.steps[1].inputMapping).toEqual({ data: '$step1.output.results' });
      expect(result.message).toContain('数据绑定');
    });

    it('应能查询计划进度', async () => {
      const sessionId = newSession();
      await executeCreatePlan(
        { goal: 'g', steps: [{ description: 's1' }, { description: 's2' }] },
        { sessionId },
      );

      const plan = await executeGetPlan({}, { sessionId });
      expect(plan.totalSteps).toBe(2);
      expect(plan.completedSteps).toBe(0);
      expect(plan.status).toBe('executing');
    });

    it('查询不存在的计划应返回 not_found', async () => {
      const sessionId = newSession();
      const result = await executeGetPlan({}, { sessionId });
      expect(result.status).toBe('not_found');
      expect(result.totalSteps).toBe(0);
    });

    it('update_plan_step 应能更新步骤状态并附带 output', async () => {
      const sessionId = newSession();
      await executeCreatePlan(
        { goal: 'g', steps: [{ description: 's1' }, { description: 's2' }] },
        { sessionId },
      );

      const result = await executeUpdatePlanStep(
        { stepId: 1, status: 'completed', result: '搜索完成', output: { items: [1, 2, 3] } },
        { sessionId },
      );

      expect(result.status).toBe('completed');
      expect(result.completedSteps).toBe(1);
      expect(result.nextStep?.id).toBe(2);

      // 验证 output 已存储
      const plan = getSessionPlan(sessionId);
      expect(plan?.steps[0].output).toEqual({ items: [1, 2, 3] });
    });

    it('全部步骤完成后计划状态应变为 completed', async () => {
      const sessionId = newSession();
      await executeCreatePlan(
        { goal: 'g', steps: [{ description: 's1' }] },
        { sessionId },
      );
      await executeUpdatePlanStep({ stepId: 1, status: 'completed' }, { sessionId });
      const plan = await executeGetPlan({}, { sessionId });
      expect(plan.status).toBe('completed');
    });

    it('步骤失败时整体计划状态应变为 failed', async () => {
      const sessionId = newSession();
      await executeCreatePlan(
        { goal: 'g', steps: [{ description: 's1' }] },
        { sessionId },
      );
      await executeUpdatePlanStep({ stepId: 1, status: 'failed' }, { sessionId });
      const plan = await executeGetPlan({}, { sessionId });
      expect(plan.status).toBe('failed');
    });

    it('更新不存在的步骤应返回提示', async () => {
      const sessionId = newSession();
      await executeCreatePlan({ goal: 'g', steps: [{ description: 's1' }] }, { sessionId });
      const result = await executeUpdatePlanStep({ stepId: 99, status: 'completed' }, { sessionId });
      expect(result.message).toContain('不存在');
    });
  });

  describe('resolveBinding 表达式解析', () => {
    function buildPlan(sessionId: string, stepOutput: any): Plan {
      return {
        sessionId,
        goal: 'test',
        steps: [
          { id: 1, description: 's1', status: 'completed', output: stepOutput },
          { id: 2, description: 's2', status: 'pending' },
        ],
        status: 'executing',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    it('"$step1.output" 应返回整个 output', () => {
      const plan = buildPlan('s', { foo: 'bar' });
      expect(resolveBinding('$step1.output', plan)).toEqual({ foo: 'bar' });
    });

    it('"$step1.output.foo" 应返回字段值', () => {
      const plan = buildPlan('s', { foo: 'bar', baz: 1 });
      expect(resolveBinding('$step1.output.foo', plan)).toBe('bar');
    });

    it('"$step1.output.a.b" 应支持深层路径', () => {
      const plan = buildPlan('s', { a: { b: { c: 42 } } });
      expect(resolveBinding('$step1.output.a.b', plan)).toEqual({ c: 42 });
      expect(resolveBinding('$step1.output.a.b.c', plan)).toBe(42);
    });

    it('引用未完成的步骤应返回 undefined', () => {
      const plan = buildPlan('s', null);
      plan.steps[0].status = 'pending';
      expect(resolveBinding('$step1.output', plan)).toBeUndefined();
    });

    it('引用不存在的步骤应返回 undefined', () => {
      const plan = buildPlan('s', { foo: 'bar' });
      expect(resolveBinding('$step99.output', plan)).toBeUndefined();
    });

    it('非 $step 开头的字符串应返回 undefined', () => {
      const plan = buildPlan('s', { foo: 'bar' });
      expect(resolveBinding('hello', plan)).toBeUndefined();
      expect(resolveBinding('', plan)).toBeUndefined();
    });

    it('路径中途为 null 时应返回 undefined', () => {
      const plan = buildPlan('s', { a: null });
      expect(resolveBinding('$step1.output.a.b', plan)).toBeUndefined();
    });

    it('output 为字符串时取 .field 应返回 undefined', () => {
      const plan = buildPlan('s', 'hello');
      expect(resolveBinding('$step1.output', plan)).toBe('hello');
      expect(resolveBinding('$step1.output.x', plan)).toBeUndefined();
    });
  });

  describe('resolveDataBindings 整体参数解析', () => {
    function buildPlan(stepOutput: any): Plan {
      return {
        sessionId: 's',
        goal: 'test',
        steps: [
          { id: 1, description: 's1', status: 'completed', output: stepOutput },
        ],
        status: 'executing',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    it('应将 $stepN 字符串值替换为实际数据', () => {
      const plan = buildPlan({ items: ['a', 'b'] });
      const resolved = resolveDataBindings(
        { data: '$step1.output.items', staticParam: 'literal' },
        plan,
      );
      expect(resolved).toEqual({
        data: ['a', 'b'],
        staticParam: 'literal',
      });
    });

    it('解析失败时应保留原始表达式（不抛错）', () => {
      const plan = buildPlan({ foo: 'bar' });
      const resolved = resolveDataBindings(
        { x: '$step99.output.something' },
        plan,
      );
      // 解析失败时应保留原表达式
      expect(resolved.x).toBe('$step99.output.something');
    });

    it('应递归解析嵌套对象', () => {
      const plan = buildPlan({ value: 100 });
      const resolved = resolveDataBindings(
        {
          nested: { inner: '$step1.output.value' },
          arr: [1, 2, 3], // 数组按字面量保留
        },
        plan,
      );
      expect(resolved.nested.inner).toBe(100);
      expect(resolved.arr).toEqual([1, 2, 3]);
    });

    it('字面量参数应原样保留', () => {
      const plan = buildPlan({ x: 1 });
      const resolved = resolveDataBindings(
        { num: 42, str: 'hello', bool: true, nullVal: null },
        plan,
      );
      expect(resolved).toEqual({ num: 42, str: 'hello', bool: true, nullVal: null });
    });
  });

  describe('storeStepOutput / findMatchingStep', () => {
    it('storeStepOutput 应能将工具结果存到匹配步骤的 output 字段', async () => {
      const sessionId = newSession();
      await executeCreatePlan(
        { goal: 'g', steps: [{ description: 's1', toolName: 'search_web' }] },
        { sessionId },
      );

      storeStepOutput(sessionId, 1, { results: ['r1', 'r2'] });
      const plan = getSessionPlan(sessionId);
      expect(plan?.steps[0].output).toEqual({ results: ['r1', 'r2'] });
    });

    it('storeStepOutput 对不存在的会话应静默返回（不抛错）', () => {
      expect(() => storeStepOutput('non-existent', 1, { x: 1 })).not.toThrow();
    });

    it('findMatchingStep 应返回首个匹配工具名的 pending 步骤', async () => {
      const sessionId = newSession();
      await executeCreatePlan(
        {
          goal: 'g',
          steps: [
            { description: 's1', toolName: 'search_web' },
            { description: 's2', toolName: 'generate_chart' },
          ],
        },
        { sessionId },
      );

      const matched = findMatchingStep(sessionId, 'search_web');
      expect(matched?.id).toBe(1);

      const matchedChart = findMatchingStep(sessionId, 'generate_chart');
      expect(matchedChart?.id).toBe(2);

      // 未注册工具应返回 undefined
      expect(findMatchingStep(sessionId, 'nonexistent_tool')).toBeUndefined();
    });

    it('已完成的步骤不应被 findMatchingStep 命中', async () => {
      const sessionId = newSession();
      await executeCreatePlan(
        { goal: 'g', steps: [{ description: 's1', toolName: 'search_web' }] },
        { sessionId },
      );
      await executeUpdatePlanStep({ stepId: 1, status: 'completed' }, { sessionId });

      // 步骤完成且计划状态变为 completed 后，findMatchingStep 应返回 undefined
      expect(findMatchingStep(sessionId, 'search_web')).toBeUndefined();
    });

    it('计划不存在时 findMatchingStep 应返回 undefined', () => {
      expect(findMatchingStep('non-existent', 'search_web')).toBeUndefined();
    });
  });

  describe('端到端：创建计划→执行→数据绑定', () => {
    it('完整模拟：第1步搜索 → 第2步基于第1步结果绘图', async () => {
      const sessionId = newSession();

      // Step 1: 创建带数据绑定的计划
      await executeCreatePlan(
        {
          goal: '搜索并画图',
          steps: [
            { description: '搜索', toolName: 'search_knowledge_base' },
            {
              description: '画图',
              toolName: 'generate_chart',
              inputMapping: { dataset: '$step1.output.items' },
            },
          ],
        },
        { sessionId },
      );

      // Step 2: 模拟 FC 循环执行第1步成功
      const matchedStep1 = findMatchingStep(sessionId, 'search_knowledge_base');
      expect(matchedStep1?.id).toBe(1);
      const step1Output = { items: [{ name: 'A', value: 10 }, { name: 'B', value: 20 }] };
      storeStepOutput(sessionId, 1, step1Output);
      await executeUpdatePlanStep({ stepId: 1, status: 'completed' }, { sessionId });

      // Step 3: 第2步执行前应用数据绑定
      const matchedStep2 = findMatchingStep(sessionId, 'generate_chart');
      expect(matchedStep2?.id).toBe(2);
      expect(matchedStep2?.inputMapping).toEqual({ dataset: '$step1.output.items' });

      const plan = getSessionPlan(sessionId)!;
      const llmArgs = { chartType: 'bar' }; // LLM 提供的部分参数
      const merged = { ...llmArgs, ...matchedStep2!.inputMapping };
      const resolvedArgs = resolveDataBindings(merged, plan);

      expect(resolvedArgs.chartType).toBe('bar');
      expect(resolvedArgs.dataset).toEqual(step1Output.items);
    });
  });
});
