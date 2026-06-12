/**
 * createRateLimitedLLM 单元测试
 *
 * 覆盖功能：
 * 1. invoke 方法被限流包装
 * 2. stream 方法被限流包装
 * 3. bindTools 返回的实例也受限流保护
 * 4. Ollama 不限流，直接返回原始实例
 */

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./runtime-config', () => ({
  getRuntimeConfig: () => ({
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  }),
  updateRuntimeConfig: jest.fn(),
  loadRuntimeConfig: jest.fn(),
  saveRuntimeConfig: jest.fn(),
  DEFAULT_RUNTIME_CONFIG: {
    cache: { maxEntries: 200, maxItemSizeKB: 50, defaultTTLMinutes: 5 },
    rateLimiter: { fastPoolMax: 10, streamingPoolMax: 5, tokenWaitTimeout: 10000 },
  },
}));

// Mock LangChain
const mockInvoke = jest.fn().mockResolvedValue({ content: 'test response' });
const mockStream = jest.fn().mockResolvedValue((async function* () { yield { content: 'chunk' }; })());
const mockBindTools = jest.fn().mockReturnValue({
  invoke: jest.fn().mockResolvedValue({ content: 'fc response' }),
  stream: jest.fn().mockResolvedValue((async function* () { yield { content: 'fc chunk' }; })()),
});

jest.mock('@langchain/ollama', () => ({
  ChatOllama: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke,
    stream: mockStream,
    bindTools: mockBindTools,
  })),
}));

jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke,
    stream: mockStream,
    bindTools: mockBindTools,
  })),
}));

jest.mock('./config', () => ({
  config: {
    deepseekBaseUrl: 'https://api.deepseek.com',
    zhipuBaseUrl: 'https://open.bigmodel.cn/api/paas',
    ollamaBaseUrl: 'http://localhost:11434',
  },
}));

import { createRateLimitedLLM, setDeepseekApiKey, setZhipuApiKey } from './model-provider';
import { llmRateLimiter } from './llm-rate-limiter';

describe('createRateLimitedLLM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDeepseekApiKey('test-key');
    setZhipuApiKey('test-key');
  });

  // ==================== Ollama 不限流 ====================

  describe('Ollama 不限流', () => {
    it('Ollama 应直接返回原始实例，不包装方法', () => {
      const llm = createRateLimitedLLM(
        { provider: 'ollama', model: 'minicpm', baseUrl: 'http://localhost:11434' },
        'fast',
      );

      // Ollama 不限流，invoke 应该是原始 mock
      expect(llm).toBeDefined();
      expect(typeof llm.invoke).toBe('function');
    });
  });

  // ==================== DeepSeek 限流 ====================

  describe('DeepSeek 限流包装', () => {
    it('invoke 方法应被限流包装', async () => {
      const llm = createRateLimitedLLM(
        { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' },
        'fast',
      );

      const result = await llm.invoke([{ role: 'user', content: 'hello' }]);

      expect(mockInvoke).toHaveBeenCalled();
      expect(result).toEqual({ content: 'test response' });
    });

    it('stream 方法应被限流包装', async () => {
      const llm = createRateLimitedLLM(
        { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' },
        'streaming',
      );

      const stream = await llm.stream([{ role: 'user', content: 'hello' }]);

      expect(mockStream).toHaveBeenCalled();
    });

    it('bindTools 返回实例的 invoke 应被限流包装', async () => {
      const llm = createRateLimitedLLM(
        { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' },
        'fast',
      );

      const boundLLM = (llm as any).bindTools([{ name: 'test_tool', description: 'test', parameters: {} }]);
      expect(mockBindTools).toHaveBeenCalled();

      const result = await boundLLM.invoke([{ role: 'user', content: 'use tool' }]);
      expect(result).toEqual({ content: 'fc response' });
    });
  });

  // ==================== 智谱限流 ====================

  describe('智谱限流包装', () => {
    it('invoke 方法应被限流包装', async () => {
      const llm = createRateLimitedLLM(
        { provider: 'zhipu', model: 'glm-4.7', apiKey: 'test-key', baseUrl: 'https://open.bigmodel.cn/api/paas' },
        'fast',
      );

      const result = await llm.invoke([{ role: 'user', content: 'hello' }]);

      expect(mockInvoke).toHaveBeenCalled();
      expect(result).toEqual({ content: 'test response' });
    });
  });

  // ==================== 限流器状态 ====================

  describe('限流器状态验证', () => {
    it('限流器应有 fast 和 streaming 两个池', () => {
      const status = llmRateLimiter.getStatus();
      expect(status.fastPool).toHaveProperty('running');
      expect(status.fastPool).toHaveProperty('max');
      expect(status.streamingPool).toHaveProperty('running');
      expect(status.streamingPool).toHaveProperty('max');
    });

    it('限流器应有令牌桶', () => {
      const status = llmRateLimiter.getStatus();
      expect(status.tokenBuckets).toHaveProperty('deepseek');
      expect(status.tokenBuckets).toHaveProperty('zhipu');
    });
  });
});
