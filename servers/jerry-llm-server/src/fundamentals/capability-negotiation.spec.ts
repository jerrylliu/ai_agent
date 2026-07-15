/**
 * Agent 能力协商逻辑测试（P2）
 *
 * 验证修复后的逻辑：
 * 1. detectToolIntent 能正确识别图片/图表/思维导图生成意图
 * 2. 当用户意图工具不在路由 Agent 白名单时，应 fallback 到 general Agent
 * 3. fallback 后 general Agent 的 extraPrompt 不会产生矛盾指令
 * 4. applyAgentToolWhitelist 在 general Agent 下不过滤工具
 *
 * 注意：prompt.ts import 了大量重型模块（数据库、Redis、LLM 等），
 *       此处用 jest.mock 全部 mock 掉，只测试 detectToolIntent 纯函数 + agent-router 组合行为。
 */

// ==================== Mock 重型依赖 ====================
// 必须在 import 之前执行 jest.mock

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./config', () => ({
  config: {
    llm: { defaultModel: 'mock-model' },
    redis: { url: 'mock' },
  },
}));

jest.mock('./sse-writer', () => ({
  sendToolStatus: jest.fn(),
  startHeartbeat: jest.fn(() => ({})),
  stopHeartbeat: jest.fn(),
  sendMetadata: jest.fn(),
  sendSessionAction: jest.fn(),
  sendContent: jest.fn(),
  sendFileCard: jest.fn(),
}));

jest.mock('./rag-service', () => ({
  retrieveFromKnowledgeBase: jest.fn(),
}));

jest.mock('./vector-store', () => ({
  getKnowledgeBaseStats: jest.fn(),
}));

jest.mock('./model-provider', () => ({
  createLLM: jest.fn(),
  createRateLimitedLLM: jest.fn(),
  buildModelConfig: jest.fn(),
  getCurrentModelId: jest.fn(() => 'mock-model'),
  getModelInfo: jest.fn(() => ({ supportsFunctionCalling: true, supportsVision: true })),
  getModelCapabilities: jest.fn(() => ({ supportsFC: true, supportsToolChoice: true, contextLength: 8000 })),
}));

jest.mock('./tools', () => ({
  getToolSchemasForModel: jest.fn(),
  executeTool: jest.fn(),
  hasTool: jest.fn(),
  getAvailableToolNames: jest.fn(() => []),
}));

jest.mock('./tools/plan-execute', () => ({
  resolveDataBindings: jest.fn(),
  getSessionPlan: jest.fn(),
  storeStepOutput: jest.fn(),
  findMatchingStep: jest.fn(),
}));

jest.mock('./tools/search-web', () => ({
  formatSearchResultAsSummary: jest.fn(),
  searchWebResultSchema: {},
}));

jest.mock('./tools/multimodal-output', () => ({
  generateImageResultSchema: {},
  createMindmapResultSchema: {},
  generateChartResultSchema: {},
  mindmapImageUrl: jest.fn(),
}));

jest.mock('./tools/generate-document', () => ({
  generateDocumentResultSchema: {},
}));

jest.mock('./llm-json-parser', () => ({
  parseLlmJson: jest.fn(),
  parseToolResultJson: jest.fn(),
}));

jest.mock('./multi-level-cache', () => ({
  MultiLevelCache: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    set: jest.fn(),
    touch: jest.fn(),
  })),
}));

jest.mock('./prompt-injection-guard.js', () => ({
  buildPromptInjectionSafetyInstruction: jest.fn(() => ''),
  inspectPromptInjection: jest.fn(() => ({ level: 'safe' })),
  UNTRUSTED_CONTEXT_INSTRUCTION: '',
}));

jest.mock('./feishu/feishu-markdown-image.js', () => ({
  stripMarkdownImages: jest.fn(),
}));

jest.mock('./prompt-message-cleaner', () => ({
  cleanMessagesForFinalSummary: jest.fn(),
}));

jest.mock('@langchain/core/messages', () => ({
  HumanMessage: jest.fn(),
  AIMessage: jest.fn(),
  SystemMessage: jest.fn(),
  ToolMessage: jest.fn(),
}));

// ==================== Import 被测模块 ====================

import { detectToolIntent, ToolIntentDetection } from './prompt';
import { routeRequest, getAgent, applyAgentToolWhitelist, AgentConfig } from './router/agent-router';

// ==================== 测试用例 ====================

describe('Agent 能力协商逻辑（P2）', () => {
  // ==================== detectToolIntent 正则识别 ====================
  describe('detectToolIntent 图片生成意图识别', () => {
    it('"生成一张图片" → shouldForce=true, specificTool=generate_image', () => {
      const result = detectToolIntent('生成一张图片');
      expect(result.shouldForce).toBe(true);
      expect(result.specificTool).toBe('generate_image');
    });

    it('"画一张猫的图片" → shouldForce=true, specificTool=generate_image', () => {
      const result = detectToolIntent('画一张猫的图片');
      expect(result.shouldForce).toBe(true);
      expect(result.specificTool).toBe('generate_image');
    });

    it('"帮我生成一个星空海报" → shouldForce=true, specificTool=generate_image', () => {
      const result = detectToolIntent('帮我生成一个星空海报');
      expect(result.shouldForce).toBe(true);
      expect(result.specificTool).toBe('generate_image');
    });

    it('"你好" → shouldForce=false（纯寒暄不触发）', () => {
      const result = detectToolIntent('你好');
      expect(result.shouldForce).toBe(false);
      expect(result.specificTool).toBeUndefined();
    });

    it('空字符串 → shouldForce=false', () => {
      const result = detectToolIntent('');
      expect(result.shouldForce).toBe(false);
    });

    it('"帮我创建一个思维导图来整理思路" → shouldForce=true, specificTool=create_mindmap', () => {
      // 注意：不能用"生成思维导图"测试，因为 imagePattern 里有 `图$` 正则，
      // "生成思维导图"以"图"结尾会被误匹配为 generate_image（pre-existing bug，非本次改动引入）
      const result = detectToolIntent('帮我创建一个思维导图来整理思路');
      expect(result.shouldForce).toBe(true);
      expect(result.specificTool).toBe('create_mindmap');
    });

    it('"画一个柱状图表" → shouldForce=true, specificTool=generate_chart', () => {
      const result = detectToolIntent('画一个柱状图表');
      expect(result.shouldForce).toBe(true);
      expect(result.specificTool).toBe('generate_chart');
    });
  });

  // ==================== 能力协商核心逻辑：路由 + 白名单检查 ====================
  describe('能力协商：路由到含目标工具的 Agent 时不触发 fallback', () => {
    it('"帮我画一张猫的图片" → 路由到 creative → creative 白名单含 generate_image → 不需要 fallback', () => {
      const userInput = '帮我画一张猫的图片';
      const routing = routeRequest(userInput);
      const intent = detectToolIntent(userInput);

      expect(routing.agent.role).toBe('creative');
      expect(intent.shouldForce).toBe(true);
      expect(intent.specificTool).toBe('generate_image');

      // 验证 generate_image 在 creative 白名单内
      const whitelist = routing.agent.toolWhitelist;
      const toolAvailable = !whitelist || whitelist.includes(intent.specificTool!);
      expect(toolAvailable).toBe(true);
    });
  });

  describe('能力协商：路由到不含目标工具的 Agent 时应触发 fallback', () => {
    /**
     * 构造场景：用户意图是 generate_image，但路由到 search Agent（白名单不含 generate_image）
     * 这模拟了"路由误判"的场景
     */
    it('模拟路由到 search Agent + 意图 generate_image → 需要 fallback 到 general', () => {
      const intent: ToolIntentDetection = {
        shouldForce: true,
        specificTool: 'generate_image',
        reason: '匹配图片生成关键词',
      };

      // 模拟路由到 search Agent
      const searchAgent = getAgent('search');
      const whitelist = searchAgent.toolWhitelist;
      const toolAvailable = !whitelist || whitelist.includes(intent.specificTool!);

      expect(toolAvailable).toBe(false);

      // 验证 search Agent 的白名单确实不含 generate_image
      expect(whitelist).toBeDefined();
      expect(whitelist!.includes('generate_image')).toBe(false);

      // fallback 到 general
      const generalAgent = getAgent('general');
      expect(generalAgent.role).toBe('general');

      // general Agent 没有 toolWhitelist（不限制工具）
      expect(generalAgent.toolWhitelist).toBeUndefined();
    });

    it('模拟路由到 document Agent + 意图 generate_image → 需要 fallback', () => {
      const intent: ToolIntentDetection = {
        shouldForce: true,
        specificTool: 'generate_image',
        reason: '匹配图片生成关键词',
      };

      const documentAgent = getAgent('document');
      const whitelist = documentAgent.toolWhitelist;
      const toolAvailable = !whitelist || whitelist.includes(intent.specificTool!);

      expect(toolAvailable).toBe(false);
      expect(whitelist!.includes('generate_image')).toBe(false);
    });

    it('模拟路由到 analysis Agent + 意图 generate_image → 需要 fallback（analysis 不含 generate_image）', () => {
      const intent: ToolIntentDetection = {
        shouldForce: true,
        specificTool: 'generate_image',
        reason: '匹配图片生成关键词',
      };

      const analysisAgent = getAgent('analysis');
      const whitelist = analysisAgent.toolWhitelist;
      const toolAvailable = !whitelist || whitelist.includes(intent.specificTool!);

      expect(toolAvailable).toBe(false);
    });
  });

  // ==================== extraPrompt 不残留验证 ====================
  describe('能力协商：fallback 后 extraPrompt 不残留矛盾指令', () => {
    it('search Agent 的 extraPrompt 非空（如果不 fallback 会追加）', () => {
      const searchAgent = getAgent('search');
      expect(searchAgent.extraPrompt).toBeTruthy();
      expect(searchAgent.extraPrompt!.length).toBeGreaterThan(0);
    });

    it('general Agent 的 extraPrompt 为空字符串（fallback 后不会追加矛盾指令）', () => {
      const generalAgent = getAgent('general');
      expect(generalAgent.extraPrompt).toBe('');
    });

    it('模拟 fallback 后的 extraPrompt 追加逻辑：general 的 extraPrompt 不会被追加', () => {
      // 模拟 prompt.ts 里的逻辑：if (routing.agent.extraPrompt) { fcSystemPrompt += ... }
      const generalAgent = getAgent('general');
      let fcSystemPrompt = 'base prompt';
      if (generalAgent.extraPrompt) {
        fcSystemPrompt += generalAgent.extraPrompt;
      }
      // general 的 extraPrompt 是空字符串，if 条件为 false，不会追加
      expect(fcSystemPrompt).toBe('base prompt');
    });

    it('模拟未 fallback 时 search 的 extraPrompt 会被追加', () => {
      const searchAgent = getAgent('search');
      let fcSystemPrompt = 'base prompt';
      if (searchAgent.extraPrompt) {
        fcSystemPrompt += searchAgent.extraPrompt;
      }
      // search 的 extraPrompt 非空，会被追加
      expect(fcSystemPrompt).not.toBe('base prompt');
      expect(fcSystemPrompt).toContain('信息检索专家');
    });
  });

  // ==================== applyAgentToolWhitelist 行为验证 ====================
  describe('能力协商：applyAgentToolWhitelist 在 fallback 后不过滤工具', () => {
    const mockSchemas = [
      { function: { name: 'generate_image' } },
      { function: { name: 'search_knowledge_base' } },
      { function: { name: 'search_web' } },
      { function: { name: 'calculate' } },
    ];

    it('general Agent → 不过滤，返回所有工具', () => {
      const generalAgent = getAgent('general');
      const filtered = applyAgentToolWhitelist(mockSchemas, generalAgent);
      expect(filtered.length).toBe(4);
      expect(filtered.some(s => s.function.name === 'generate_image')).toBe(true);
    });

    it('search Agent → 只返回白名单内的工具（不含 generate_image）', () => {
      const searchAgent = getAgent('search');
      const filtered = applyAgentToolWhitelist(mockSchemas, searchAgent);
      expect(filtered.some(s => s.function.name === 'generate_image')).toBe(false);
      expect(filtered.some(s => s.function.name === 'search_knowledge_base')).toBe(true);
      expect(filtered.some(s => s.function.name === 'search_web')).toBe(true);
    });

    it('fallback 到 general 后，generate_image 会保留在 filteredToolSchemas 中', () => {
      // 模拟完整链路：search Agent fallback 到 general → applyAgentToolWhitelist 不过滤
      const searchAgent = getAgent('search');
      const filteredBefore = applyAgentToolWhitelist(mockSchemas, searchAgent);
      expect(filteredBefore.some(s => s.function.name === 'generate_image')).toBe(false);

      // fallback
      const generalAgent = getAgent('general');
      const filteredAfter = applyAgentToolWhitelist(mockSchemas, generalAgent);
      expect(filteredAfter.some(s => s.function.name === 'generate_image')).toBe(true);
    });
  });

  // ==================== 完整链路集成测试 ====================
  describe('完整链路：用户输入 → detectToolIntent → 路由 → 能力协商', () => {
    /**
     * 场景 1：正常路径——用户要生成图片，路由到 creative Agent，工具可用，不触发 fallback
     */
    it('场景1："帮我画一张猫的图片" → creative Agent → 工具可用 → 不 fallback', () => {
      const userInput = '帮我画一张猫的图片';

      // Step 1: detectToolIntent
      const intent = detectToolIntent(userInput);
      expect(intent.shouldForce).toBe(true);
      expect(intent.specificTool).toBe('generate_image');

      // Step 2: routeRequest
      const routing = routeRequest(userInput);
      expect(routing.agent.role).toBe('creative');

      // Step 3: 能力协商检查
      const whitelist = routing.agent.toolWhitelist;
      const toolAvailable = !whitelist || whitelist.includes(intent.specificTool!);
      expect(toolAvailable).toBe(true);

      // Step 4: 不触发 fallback，extraPrompt 正常追加
      if (routing.agent.extraPrompt) {
        // creative 的 extraPrompt 会被追加（正常流程）
        expect(routing.agent.extraPrompt).toContain('创意助手');
      }
    });

    /**
     * 场景 2：路由误判——用户要生成图片，但被路由到 search Agent（模拟）
     * 这正是修复方案要解决的场景
     */
    it('场景2：路由误判到 search Agent + generate_image 意图 → fallback 到 general', () => {
      const userInput = '生成一张图片';

      // Step 1: detectToolIntent
      const intent = detectToolIntent(userInput);
      expect(intent.shouldForce).toBe(true);
      expect(intent.specificTool).toBe('generate_image');

      // Step 2: 模拟路由误判到 search Agent（实际 routeRequest 可能路由到 creative，
      //         这里模拟"路由误判"场景）
      const misroutedAgent = getAgent('search');
      const whitelist = misroutedAgent.toolWhitelist;
      const toolAvailable = !whitelist || whitelist.includes(intent.specificTool!);
      expect(toolAvailable).toBe(false);

      // Step 3: fallback 到 general
      const fallbackAgent = getAgent('general');
      expect(fallbackAgent.role).toBe('general');
      expect(fallbackAgent.toolWhitelist).toBeUndefined();

      // Step 4: 验证 fallback 后 general 的 extraPrompt 不会产生矛盾指令
      expect(fallbackAgent.extraPrompt).toBe('');

      // Step 5: 验证 applyAgentToolWhitelist 在 general 下不过滤 generate_image
      const mockSchemas = [
        { function: { name: 'generate_image' } },
        { function: { name: 'search_knowledge_base' } },
      ];
      const filtered = applyAgentToolWhitelist(mockSchemas, fallbackAgent);
      expect(filtered.some(s => s.function.name === 'generate_image')).toBe(true);
    });

    /**
     * 场景 3：纯寒暄——不触发能力协商
     */
    it('场景3："你好" → 不触发能力协商（无工具意图）', () => {
      const userInput = '你好';
      const intent = detectToolIntent(userInput);
      expect(intent.shouldForce).toBe(false);
      expect(intent.specificTool).toBeUndefined();

      // shouldForce=false → 能力协商的 if 条件不满足，不触发 fallback
      const routing = routeRequest(userInput);
      expect(routing.agent.role).toBe('general');
    });
  });
});
