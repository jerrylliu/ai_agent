/**
 * Agent Router 单元测试（P2）
 *
 * 验证：
 * 1. 关键词路由 - 各 Agent 命中规则
 * 2. 平局裁决 - AGENT_PRIORITY 顺序
 * 3. 兜底 - 无关键词命中时回落 general
 * 4. Pipeline 模板触发建议
 * 5. applyAgentToolPriority 工具优先级排序（白名单排前，不再硬过滤）
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
  hasPipelineTemplate: (id: string) =>
    [
      'search_kb_and_chart',
      'web_search_and_document',
      'search_kb_and_mindmap',
      'web_search_and_mindmap',
    ].includes(id),
  listPipelineTemplates: () => [],
}));

import {
  routeRequest,
  applyAgentToolPriority,
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
      expect(result.suggestedWorkflow?.templateId).toBe(
        'search_kb_and_mindmap',
      );
    });

    it('"联网搜索 + 整理为文档" 应建议 web_search_and_document', () => {
      const result = routeRequest('联网搜一下最新动态，整理为文档保存');
      expect(result.suggestedWorkflow?.templateId).toBe(
        'web_search_and_document',
      );
    });

    it('"联网搜索 + 思维导图" 应建议 web_search_and_mindmap', () => {
      const result = routeRequest('联网搜最新进展，做成思维导图');
      expect(result.suggestedWorkflow?.templateId).toBe(
        'web_search_and_mindmap',
      );
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
      const roles = agents.map((a) => a.role).sort();
      expect(roles).toEqual([
        'analysis',
        'creative',
        'document',
        'general',
        'search',
      ]);
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
      const expertAgents: Array<
        'search' | 'analysis' | 'creative' | 'document'
      > = ['search', 'analysis', 'creative', 'document'];
      for (const role of expertAgents) {
        const agent = getAgent(role);
        expect(agent.toolWhitelist).toContain('create_plan');
        expect(agent.toolWhitelist).toContain('execute_workflow');
      }
    });
  });

  describe('复合意图路由（跨域任务回落 general）', () => {
    it('跨域任务（查询天气 + 图表）应回落 general Agent', () => {
      // 生产案例 2026-10-12 15:35：复合任务被路由到单一专家后跨域工具不可见
      const r = routeRequest('查询重庆天气并生成天气图表');
      expect(r.agent.role).toBe('general');
    });

    it('跨域任务（搜索新闻 + 图表）应回落 general Agent', () => {
      const r = routeRequest('搜索最新的国外新闻并画成图表');
      expect(r.agent.role).toBe('general');
    });

    it('单一领域任务仍路由到对应专家', () => {
      expect(routeRequest('计算一下复利').agent.role).toBe('analysis');
      expect(routeRequest('帮我画一张山水画').agent.role).toBe('creative');
    });

    it('复合任务的 Pipeline 模板建议不受影响', () => {
      const r = routeRequest('搜索知识库资料并画成图表');
      expect(r.suggestedWorkflow?.templateId).toBe('search_kb_and_chart');
    });
  });

  describe('applyAgentToolPriority 工具优先级排序', () => {
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
    const names = (schemas: any[]) =>
      schemas.map((s) => s.function?.name).filter(Boolean);

    it('general Agent 无白名单，顺序原样返回', () => {
      const ordered = applyAgentToolPriority(allSchemas, getAgent('general'));
      expect(ordered).toEqual(allSchemas);
    });

    it('search Agent：白名单工具排前，非白名单工具保留不丢弃', () => {
      const ordered = applyAgentToolPriority(allSchemas, getAgent('search'));
      // 关键断言：总数不变（不再硬过滤）
      expect(ordered).toHaveLength(allSchemas.length);
      const n = names(ordered);
      expect(n).toContain('generate_image');
      expect(n).toContain('calculate');
      // 白名单工具应全部排在非白名单工具之前
      const firstNonWhitelistIdx = n.findIndex(
        (name) => !getAgent('search').toolWhitelist!.includes(name),
      );
      const lastWhitelistIdx = n.reduce(
        (last, name, idx) =>
          getAgent('search').toolWhitelist!.includes(name) ? idx : last,
        -1,
      );
      expect(lastWhitelistIdx).toBeLessThan(firstNonWhitelistIdx);
    });

    it('analysis Agent：calculate 排最前且 create_document 仍可见', () => {
      const ordered = applyAgentToolPriority(allSchemas, getAgent('analysis'));
      const n = names(ordered);
      expect(n[0]).toBe('calculate'); // analysis 白名单首位
      expect(n).toContain('calculate');
      expect(n).toContain('create_document'); // 不再被过滤掉
    });

    it('非白名单工具之间保持原相对顺序（稳定排序）', () => {
      const ordered = applyAgentToolPriority(allSchemas, getAgent('search'));
      const n = names(ordered);
      const tail = n.filter(
        (name) => !getAgent('search').toolWhitelist!.includes(name),
      );
      // allSchemas 中非白名单的顺序：generate_image, create_mindmap, calculate, create_document
      expect(tail).toEqual([
        'generate_image',
        'create_mindmap',
        'calculate',
        'create_document',
      ]);
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
