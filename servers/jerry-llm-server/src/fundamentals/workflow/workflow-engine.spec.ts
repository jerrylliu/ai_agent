/**
 * Workflow Engine 单元测试（P1）
 *
 * 验证：
 * 1. 顺序执行 + 步骤间数据绑定（$stepN.output.xxx）
 * 2. 上下文模板替换（${context.xxx}）
 * 3. 错误处理：onError=abort vs continue
 * 4. validateWorkflow 校验
 * 5. SSE 事件推送（mock Response）
 * 6. 嵌套对象/数组参数解析
 */

// Mock logger
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock sse-writer，捕获 SSE 事件
const mockSendWorkflowEvent = jest.fn();
const mockSendToolStatus = jest.fn();
jest.mock('../sse-writer', () => ({
  sendWorkflowEvent: (...args: any[]) => mockSendWorkflowEvent(...args),
  sendToolStatus: (...args: any[]) => mockSendToolStatus(...args),
}));

import {
  executeWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
  type ToolExecutor,
} from './workflow-engine';

describe('Workflow Engine（P1）', () => {
  beforeEach(() => {
    mockSendWorkflowEvent.mockClear();
    mockSendToolStatus.mockClear();
  });

  describe('顺序执行 + 数据绑定', () => {
    it('应顺序执行多个步骤，并将前一步的输出传给下一步', async () => {
      const calls: Array<{ tool: string; params: any }> = [];
      const mockExecutor: ToolExecutor = jest.fn(async (tool, params) => {
        calls.push({ tool, params });
        if (tool === 'search') {
          return { results: ['a', 'b', 'c'] };
        }
        if (tool === 'chart') {
          return { chartUrl: 'https://chart/x' };
        }
        return null;
      });

      const wf: WorkflowDefinition = {
        id: 'test-wf',
        name: 'Test',
        description: '',
        steps: [
          {
            id: 'step1',
            description: '搜索',
            tool: 'search',
            params: { query: 'test' },
          },
          {
            id: 'step2',
            description: '生成图表',
            tool: 'chart',
            params: { data: '$step1.output.results' },
          },
        ],
      };

      const result = await executeWorkflow(wf, { userId: 'u1' }, mockExecutor);

      expect(result.status).toBe('completed');
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].status).toBe('success');
      expect(result.steps[1].status).toBe('success');

      // 验证第二步收到的 data 已是第一步的实际输出
      expect(calls[1].params.data).toEqual(['a', 'b', 'c']);
      expect(result.finalOutput).toEqual({ chartUrl: 'https://chart/x' });
    });

    it('整体引用 $stepN.output 应返回完整对象', async () => {
      const calls: any[] = [];
      const executor: ToolExecutor = jest.fn(async (_tool, params) => {
        calls.push(params);
        return { full: 'output', a: 1 };
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 'step1', description: '', tool: 't1', params: {} },
          { id: 'step2', description: '', tool: 't2', params: { all: '$step1.output' } },
        ],
      };

      await executeWorkflow(wf, {}, executor);
      expect(calls[1].all).toEqual({ full: 'output', a: 1 });
    });

    it('引用未完成的步骤应将参数解析为 undefined（不抛错）', async () => {
      const calls: any[] = [];
      const executor: ToolExecutor = jest.fn(async (_tool, params) => {
        calls.push(params);
        return null;
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 'step1', description: '', tool: 't1', params: { ref: '$step99.output' } },
        ],
      };

      const result = await executeWorkflow(wf, {}, executor);
      expect(result.status).toBe('completed');
      expect(calls[0].ref).toBeUndefined();
    });
  });

  describe('上下文模板替换', () => {
    it('"${context.userInput}" 整体引用应返回原始类型', async () => {
      const calls: any[] = [];
      const executor: ToolExecutor = jest.fn(async (_tool, params) => {
        calls.push(params);
        return null;
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 't1', params: { q: '${context.userInput}' } },
        ],
      };

      await executeWorkflow(wf, { userInput: 'hello' }, executor);
      expect(calls[0].q).toBe('hello');
    });

    it('字符串中夹杂模板应进行字符串拼接', async () => {
      const calls: any[] = [];
      const executor: ToolExecutor = jest.fn(async (_tool, params) => {
        calls.push(params);
        return null;
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          {
            id: 's1', description: '', tool: 't1',
            params: { title: '关于${context.userInput}的分析' },
          },
        ],
      };

      await executeWorkflow(wf, { userInput: 'AI' }, executor);
      expect(calls[0].title).toBe('关于AI的分析');
    });

    it('未定义的 context 路径应替换为空字符串', async () => {
      const calls: any[] = [];
      const executor: ToolExecutor = jest.fn(async (_tool, params) => {
        calls.push(params);
        return null;
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 't1', params: { q: '前缀${context.missing}后缀' } },
        ],
      };

      await executeWorkflow(wf, {}, executor);
      expect(calls[0].q).toBe('前缀后缀');
    });
  });

  describe('错误处理', () => {
    it('onError=abort（默认）：失败步骤后续步骤应被跳过', async () => {
      const executor: ToolExecutor = jest.fn(async (tool) => {
        if (tool === 'fail_tool') throw new Error('boom');
        return 'ok';
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 'fail_tool', params: {} },
          { id: 's2', description: '', tool: 'ok_tool', params: {} },
        ],
      };

      const result = await executeWorkflow(wf, {}, executor);
      expect(result.status).toBe('failed');
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps[0].error).toContain('boom');
      expect(result.steps[1].status).toBe('skipped');
      expect(executor).toHaveBeenCalledTimes(1); // s2 被跳过
    });

    it('onError=continue：失败后应继续执行下一步', async () => {
      const executor: ToolExecutor = jest.fn(async (tool) => {
        if (tool === 'fail_tool') throw new Error('boom');
        return 'ok';
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 'fail_tool', params: {}, onError: 'continue' },
          { id: 's2', description: '', tool: 'ok_tool', params: {} },
        ],
      };

      const result = await executeWorkflow(wf, {}, executor);
      expect(result.status).toBe('partial');
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps[1].status).toBe('success');
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it('全部失败时整体状态应为 failed', async () => {
      const executor: ToolExecutor = jest.fn(async () => {
        throw new Error('die');
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 't1', params: {}, onError: 'continue' },
          { id: 's2', description: '', tool: 't2', params: {}, onError: 'continue' },
        ],
      };

      const result = await executeWorkflow(wf, {}, executor);
      expect(result.status).toBe('failed');
    });

    it('全部成功时整体状态应为 completed', async () => {
      const executor: ToolExecutor = jest.fn(async () => 'ok');
      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 't1', params: {} },
          { id: 's2', description: '', tool: 't2', params: {} },
        ],
      };
      const result = await executeWorkflow(wf, {}, executor);
      expect(result.status).toBe('completed');
    });
  });

  describe('SSE 事件推送', () => {
    it('应推送 workflow_start / step_start / step_done / workflow_complete', async () => {
      const executor: ToolExecutor = jest.fn(async () => 'ok');
      const fakeRes: any = { writableEnded: false, write: jest.fn() };

      const wf: WorkflowDefinition = {
        id: 'wf-sse', name: 'n', description: '',
        steps: [
          { id: 's1', description: '步骤1', tool: 'tool1', params: {} },
        ],
      };

      await executeWorkflow(wf, {}, executor, fakeRes);

      const eventTypes = mockSendWorkflowEvent.mock.calls.map(c => c[1]);
      expect(eventTypes).toContain('workflow_start');
      expect(eventTypes).toContain('workflow_step_start');
      expect(eventTypes).toContain('workflow_step_done');
      expect(eventTypes).toContain('workflow_complete');

      // 验证 tool_status 也被推送
      const toolStatusCalls = mockSendToolStatus.mock.calls;
      expect(toolStatusCalls.length).toBeGreaterThanOrEqual(2); // executing + done
    });

    it('无 res 时不应调用 SSE 函数', async () => {
      const executor: ToolExecutor = jest.fn(async () => 'ok');
      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [{ id: 's1', description: '', tool: 't1', params: {} }],
      };

      await executeWorkflow(wf, {}, executor); // 不传 res

      expect(mockSendWorkflowEvent).not.toHaveBeenCalled();
      expect(mockSendToolStatus).not.toHaveBeenCalled();
    });

    it('失败步骤的 step_done 事件应携带 error 字段', async () => {
      const executor: ToolExecutor = jest.fn(async () => {
        throw new Error('fail-msg');
      });
      const fakeRes: any = { writableEnded: false, write: jest.fn() };

      const wf: WorkflowDefinition = {
        id: 'wf-err', name: 'n', description: '',
        steps: [{ id: 's1', description: '', tool: 't1', params: {} }],
      };

      await executeWorkflow(wf, {}, executor, fakeRes);

      const stepDoneCalls = mockSendWorkflowEvent.mock.calls.filter(c => c[1] === 'workflow_step_done');
      expect(stepDoneCalls).toHaveLength(1);
      expect(stepDoneCalls[0][2].status).toBe('failed');
      expect(stepDoneCalls[0][2].error).toContain('fail-msg');
    });
  });

  describe('嵌套对象/数组参数', () => {
    it('应递归解析嵌套对象中的引用', async () => {
      const calls: any[] = [];
      const executor: ToolExecutor = jest.fn(async (_tool, params) => {
        calls.push(params);
        return { value: 99 };
      });

      const wf: WorkflowDefinition = {
        id: 'wf', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 't1', params: {} },
          {
            id: 's2', description: '', tool: 't2',
            params: {
              outer: {
                inner: '$step1.output.value',
                literal: 'unchanged',
              },
            },
          },
        ],
      };

      await executeWorkflow(wf, {}, executor);
      expect(calls[1].outer.inner).toBe(99);
      expect(calls[1].outer.literal).toBe('unchanged');
    });
  });

  describe('validateWorkflow 校验', () => {
    it('合法的 workflow 应通过校验', () => {
      const wf: WorkflowDefinition = {
        id: 'ok', name: 'n', description: '',
        steps: [
          { id: 's1', description: '', tool: 't1', params: {} },
          { id: 's2', description: '', tool: 't2', params: { x: '$step1.output' } },
        ],
      };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('缺少 id 应报错', () => {
      const wf: any = { id: '', name: '', description: '', steps: [] };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('id'))).toBe(true);
    });

    it('空步骤列表应报错', () => {
      const wf: WorkflowDefinition = { id: 'x', name: '', description: '', steps: [] };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
    });

    it('重复 stepId 应报错', () => {
      const wf: WorkflowDefinition = {
        id: 'x', name: '', description: '',
        steps: [
          { id: 'dup', description: '', tool: 't', params: {} },
          { id: 'dup', description: '', tool: 't', params: {} },
        ],
      };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('重复'))).toBe(true);
    });

    it('引用后定义的步骤序号应报错', () => {
      const wf: WorkflowDefinition = {
        id: 'x', name: '', description: '',
        steps: [
          { id: 's1', description: '', tool: 't', params: { x: '$step2.output' } },
          { id: 's2', description: '', tool: 't', params: {} },
        ],
      };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('步骤序号') || e.includes('$step2'))).toBe(true);
    });

    it('缺少 tool 应报错', () => {
      const wf: any = {
        id: 'x', name: '', description: '',
        steps: [{ id: 's1', description: '', params: {} }],
      };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('tool'))).toBe(true);
    });
  });
});
