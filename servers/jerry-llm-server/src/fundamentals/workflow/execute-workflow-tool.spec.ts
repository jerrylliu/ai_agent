/**
 * fundamentals/workflow/execute-workflow-tool.spec.ts
 *
 * execute_workflow 工具单元测试
 * 覆盖：buildExecuteWorkflowSchema / executeExecuteWorkflow 参数校验分支
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('./workflow-engine', () => ({
  executeWorkflow: jest.fn().mockResolvedValue({
    workflowId: 'test_wf',
    status: 'completed',
    totalDurationMs: 100,
    steps: [{ stepId: 's1', status: 'success', durationMs: 50 }],
  }),
}));

import {
  buildExecuteWorkflowSchema,
  executeExecuteWorkflow,
  setWorkflowToolExecutor,
} from './execute-workflow-tool';

describe('execute_workflow 工具', () => {
  describe('buildExecuteWorkflowSchema', () => {
    it('应返回正确的工具名', () => {
      const schema = buildExecuteWorkflowSchema();
      expect(schema.function.name).toBe('execute_workflow');
    });

    it('parameters 应包含 templateId 和 userInput 必填', () => {
      const schema = buildExecuteWorkflowSchema();
      expect(schema.function.parameters.required).toContain('templateId');
      expect(schema.function.parameters.required).toContain('userInput');
    });

    it('templateId 应有 enum 列表', () => {
      const schema = buildExecuteWorkflowSchema();
      const props = schema.function.parameters.properties as any;
      expect(props.templateId.enum).toBeDefined();
      expect(props.templateId.enum.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('executeExecuteWorkflow', () => {
    it('未设置 executor 时应返回失败', async () => {
      const r = await executeExecuteWorkflow({
        templateId: 'search_kb_and_chart',
        userInput: 'test',
      });
      expect(r.status).toBe('failed');
      expect(r.message).toContain('未注入');
    });

    it('不存在的模板应返回 not_found', async () => {
      const r = await executeExecuteWorkflow({
        templateId: 'nonexistent',
        userInput: 'test',
      });
      expect(r.status).toBe('not_found');
      expect(r.message).toContain('不存在');
    });

    it('设置 executor 后有效模板应调用 workflow', async () => {
      const mockExecutor = jest.fn().mockResolvedValue({ output: 'ok' });
      setWorkflowToolExecutor(mockExecutor as any);

      const r = await executeExecuteWorkflow(
        { templateId: 'search_kb_and_chart', userInput: 'search react' },
        { userId: 'u1', sessionId: 's1' },
      );

      const { executeWorkflow } = require('./workflow-engine');
      expect(executeWorkflow).toHaveBeenCalled();
      expect(r.status).toBe('completed');
      expect(r.message).toContain('成功');
    });
  });
});
