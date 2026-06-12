/**
 * Agent Router 单元测试（P2）
 *
 * 验证：
 * 1. 关键词路由 - 各 Agent 命中规则
 * 2. 平局裁决 - AGENT_PRIORITY 顺序
 * 3. 兜底 - 无关键词命中时回落 general
 * 4. Pipeline 模板触发建议
 * 5. applyAgentToolWhitelist 工具过滤
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

// Mock pipeline-templates，使用受控的模板列表
jest.mock('../workflow/pipeline-templates', () => ({
  hasPipelineTemplate: (id: string) => [
    'search_kb_and_chart',
    'web_search_and_document',
    'search_kb_and_mindmap',
    'web_search_and_mindmap',
  ].includes(id),
  listPipelineTemplates: () => [],
}));

import {
  routeRequest,
  applyAgentToolWhitelist,
  getAgent,
  listAgents,
} from './agent-router';

describe('Agent Router（P2）', () => {
  describe('关键词路由', () => {
    it('"搜索 XX 资料" → search Agent', () => {
      const result = routeRequest('帮我搜索一下 React 资料');
      expect(result.agent.role).toBe('search');
      expect(result.matchedBy).toBe('rule');
      expect(result.score).toBeGreaterThan(0);
    });

    it('"计算 XX" → analysis Agent', () => {
      const result = routeRequest('请帮我计算一下 1+1 等于多少');
      expect(result.agent.role).toBe('analysis');
    });

    it('"画图" → creative Agent', () => {
      const result = routeRequest('帮我画一张猫的图片');
      expect(result.agent.role).toBe('creative');
    });

    it('"思维导图" → creative Agent', () => {
      const result = routeRequest('生成思维导图');
      expect(result.agent.role).toBe('creative');
    });

    it('"创建文档" → document Agent', () => {
      const result = routeRequest('帮我创建文档：项目计划');
      expect(result.agent.role).toBe('document');
    });

    it('"摘要" → document Agent', () => {
      const result = routeRequest('给这个文档生成摘要');
      expect(result.agent.role).toBe('document');
    });
  });

  describe('兜底逻辑', () => {
    it('无关键词命中时应回落到 general Agent', () => {
      const result = routeRequest('你好');
      expect(result.agent.role).toBe('general');
      expect(result.matchedBy).toBe('fallback');
    });

    it('空字符串应回落到 general', () => {
      const result = routeRequest('');
      expect(result.agent.role).toBe('general');
      expect(result.matchedBy).toBe('fallback');
    });

    it('undefined 输入应回落到 general', () => {
      const result = routeRequest(undefined);
      expect(result.agent.role).toBe('general');
      expect(result.matchedBy).toBe('fallback');
    });

    it('纯空白字符串应回落到 general', () => {
      const result = routeRequest('   ');
      expect(result.agent.role).toBe('general');
      expect(result.matchedBy).toBe('fallback');
    });
  });

  describe('Pipeline 模板触发建议', () => {
    it('"搜索知识库 + 画图表" 应建议 search_kb_and_chart', () => {
      const result = routeRequest('搜索知识库里的销售数据，生成柱状图表');
      expect(result.suggestedWorkflow?.templateId).toBe('search_kb_and_chart');
    });

    it('"搜索知识库 + 思维导图" 应建议 search_kb_and_mindmap', () => {
      const result = routeRequest('搜索知识库里的 React 资料，生成思维导图');
      expect(result.suggestedWorkflow?.templateId).toBe('search_kb_and_mindmap');
    });

    it('"联网搜索 + 整理为文档" 应建议 web_search_and_document', () => {
      const result = routeRequest('联网搜一下最新动态，整理为文档保存');
      expect(result.suggestedWorkflow?.templateId).toBe('web_search_and_document');
    });

    it('"联网搜索 + 思维导图" 应建议 web_search_and_mindmap', () => {
      const result = routeRequest('联网搜最新进展，做成思维导图');
      expect(result.suggestedWorkflow?.templateId).toBe('web_search_and_mindmap');
    });

    it('单一关键词不应触发 Pipeline 建议', () => {
      const result = routeRequest('画一张图');
      // 画图但没有搜索关键词
      expect(result.suggestedWorkflow).toBeUndefined();
    });

    it('普通问候不应触发任何 Pipeline 建议', () => {
      const result = routeRequest('你好啊');
      expect(result.suggestedWorkflow).toBeUndefined();
    });
  });

  describe('Agent 配置正确性', () => {
    it('listAgents 应返回 5 个 Agent', () => {
      const agents = listAgents();
      const roles = agents.map(a => a.role).sort();
      expect(roles).toEqual(['analysis', 'creative', 'document', 'general', 'search']);
    });

    it('general Agent 不应有 toolWhitelist（兜底允许全工具）', () => {
      const general = getAgent('general');
      expect(general.toolWhitelist).toBeUndefined();
    });

    it('search Agent 应包含搜索类工具', () => {
      const search = getAgent('search');
      expect(search.toolWhitelist).toBeDefined();
      expect(search.toolWhitelist).toContain('search_knowledge_base');
      expect(search.toolWhitelist).toContain('search_web');
    });

    it('creative Agent 应包含图片/思维导图工具', () => {
      const creative = getAgent('creative');
      expect(creative.toolWhitelist).toContain('generate_image');
      expect(creative.toolWhitelist).toContain('create_mindmap');
    });

    it('每个 Agent 都应包含规划类工具（便于触发 plan-execute）', () => {
      const expertAgents: Array<'search' | 'analysis' | 'creative' | 'document'> = [
        'search', 'analysis', 'creative', 'document',
      ];
      for (const role of expertAgents) {
        const agent = getAgent(role);
        expect(agent.toolWhitelist).toContain('create_plan');
        expect(agent.toolWhitelist).toContain('execute_workflow');
      }
    });
  });

  describe('applyAgentToolWhitelist 工具过滤', () => {
    const allSchemas = [
      { type: 'function', function: { name: 'search_knowledge_base' } },
      { type: 'function', function: { name: 'search_web' } },
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'create_mindmap' } },
      { type: 'function', function: { name: 'calculate' } },
      { type: 'function', function: { name: 'create_document' } },
      { type: 'function', function: { name: 'create_plan' } },
      { type: 'function', function: { name: 'execute_workflow' } },
    ];

    it('general Agent 不过滤任何工具', () => {
      const filtered = applyAgentToolWhitelist(allSchemas, getAgent('general'));
      expect(filtered).toHaveLength(allSchemas.length);
    });

    it('search Agent 应只保留搜索相关工具', () => {
      const filtered = applyAgentToolWhitelist(allSchemas, getAgent('search'));
      const names = filtered.map(s => s.function.name);
      expect(names).toContain('search_knowledge_base');
      expect(names).toContain('search_web');
      expect(names).not.toContain('generate_image');
      expect(names).not.toContain('calculate');
    });

    it('creative Agent 应只保留创意类工具', () => {
      const filtered = applyAgentToolWhitelist(allSchemas, getAgent('creative'));
      const names = filtered.map(s => s.function.name);
      expect(names).toContain('generate_image');
      expect(names).toContain('create_mindmap');
      expect(names).not.toContain('search_web');
      expect(names).not.toContain('create_document');
    });

    it('analysis Agent 应包含 calculate 但不含 create_document', () => {
      const filtered = applyAgentToolWhitelist(allSchemas, getAgent('analysis'));
      const names = filtered.map(s => s.function.name);
      expect(names).toContain('calculate');
      expect(names).not.toContain('create_document');
    });

    it('应保留 create_plan / execute_workflow（专家 Agent 共享）', () => {
      for (const role of ['search', 'analysis', 'creative', 'document'] as const) {
        const filtered = applyAgentToolWhitelist(allSchemas, getAgent(role));
        const names = filtered.map(s => s.function.name);
        expect(names).toContain('create_plan');
        expect(names).toContain('execute_workflow');
      }
    });
  });

  describe('路由分数和优先级', () => {
    it('多关键词命中应得高分', () => {
      const r1 = routeRequest('搜');
      const r2 = routeRequest('搜索 查找 知识库 资料');
      expect(r2.score!).toBeGreaterThan(r1.score!);
    });

    it('记录 matchedBy 应区分 rule vs fallback', () => {
      expect(routeRequest('计算').matchedBy).toBe('rule');
      expect(routeRequest('hello world').matchedBy).toBe('fallback');
    });
  });
});
