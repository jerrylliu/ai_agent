/**
 * fundamentals/output-review.spec.ts
 *
 * AI 输出自检模块单元测试
 * Mock config / logger / llm-json-parser / model-provider，
 * 重点验证：fail-open 契约（解析失败/超时/无 Key/开关关闭一律放行）
 * 与 prompt 构建的协议残留检测要点。
 *
 * 项目 spec 模式：jest.mock 工厂 + 用例内 jest.resetModules() + require() 取 fresh 模块
 * （与 tools/settings-ops.spec.ts 同一模式）。
 * 注意：resetModules 后 mock 模块也会重新实例化，因此 mock 引用必须与被测模块
 * 同批 require，不能使用文件顶部 import 的旧绑定。
 */

const createLLMMock = jest.fn();
const buildModelConfigMock = jest.fn();

jest.mock('./config', () => ({
  config: {
    outputReview: {
      enabled: true,
      model: 'deepseek:deepseek-v4-flash',
      timeoutMs: 15000,
    },
  },
}));

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./llm-json-parser', () => ({
  parseLlmJson: jest.fn(),
}));

jest.mock('./model-provider', () => ({
  buildModelConfig: (...args: unknown[]) => buildModelConfigMock(...args),
  createLLM: (...args: unknown[]) => createLLMMock(...args),
}));

/** 被测模块类型（仅用于类型标注，运行时用 require 取 fresh 实例） */
type OutputReviewModule = typeof import('./output-review');

/** 构造一个 invoke 可 mock 的假 LLM */
function makeFakeLLM(content: string) {
  return { invoke: jest.fn().mockResolvedValue({ content }) };
}

describe('output-review 模块', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * resetModules 后取 fresh 被测模块与同批 mock 引用。
   * config.outputReview 默认开启，用例内可通过 mocks.config 修改。
   */
  function setup(): {
    mod: OutputReviewModule;
    config: { outputReview: { enabled: boolean; model: string; timeoutMs: number } };
    logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
    parseLlmJson: jest.Mock;
  } {
    jest.resetModules();
    const mod = require('./output-review') as OutputReviewModule;
    const { config } = require('./config') as {
      config: { outputReview: { enabled: boolean; model: string; timeoutMs: number } };
    };
    const { logger } = require('./logger') as {
      logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
    };
    const { parseLlmJson } = require('./llm-json-parser') as {
      parseLlmJson: jest.Mock;
    };
    return { mod, config, logger, parseLlmJson };
  }

  /* ====================================================================
   * buildReviewPrompt
   * ==================================================================*/
  describe('buildReviewPrompt', () => {
    it('应包含协议残留检测要点（DSML/invoke/tool_call 标记）', () => {
      const { mod } = setup();
      const prompt = mod.buildReviewPrompt('问题', '回答');
      expect(prompt).toContain('<｜｜DSML｜｜');
      expect(prompt).toContain('<invoke');
      expect(prompt).toContain('<tool_call>');
    });

    it('应包含用户问题与待检回答', () => {
      const { mod } = setup();
      const prompt = mod.buildReviewPrompt('什么是光合作用？', '光合作用是……');
      expect(prompt).toContain('什么是光合作用？');
      expect(prompt).toContain('光合作用是……');
    });

    it('提供 contexts 时应附上下文，未提供时应声明跳过编造核查', () => {
      const { mod } = setup();
      const withCtx = mod.buildReviewPrompt('q', 'a', ['ctx-1', 'ctx-2']);
      expect(withCtx).toContain('ctx-1');
      expect(withCtx).toContain('ctx-2');

      const withoutCtx = mod.buildReviewPrompt('q', 'a');
      expect(withoutCtx).toContain('跳过');
    });
  });

  /* ====================================================================
   * truncateForReview
   * ==================================================================*/
  describe('truncateForReview', () => {
    it('未超长时原样返回', () => {
      const { mod } = setup();
      expect(mod.truncateForReview('short', 100)).toBe('short');
    });

    it('超长时保留 80% 头 + 20% 尾并带省略标记', () => {
      const { mod } = setup();
      const text = 'a'.repeat(50) + 'MIDDLE' + 'b'.repeat(50);
      const out = mod.truncateForReview(text, 20);
      expect(out.length).toBeLessThan(text.length);
      expect(out).toContain('省略');
      expect(out.startsWith('a'.repeat(16))).toBe(true);
      expect(out.endsWith('b'.repeat(4))).toBe(true);
    });
  });

  /* ====================================================================
   * reviewFinalAnswer：fail-open 契约
   * ==================================================================*/
  describe('reviewFinalAnswer', () => {
    it('审核 system prompt 应包含"拿不准就通过"的判定口径', async () => {
      const { mod, parseLlmJson } = setup();
      const fake = makeFakeLLM('{"pass": true, "reason": ""}');
      createLLMMock.mockReturnValue(fake);
      parseLlmJson.mockReturnValue({ success: true, data: { pass: true, reason: '' } });

      await mod.reviewFinalAnswer({ question: 'q', answer: 'a' });

      // 判定口径在 system prompt（invoke 消息数组的第 0 条），而非 user prompt
      const invokeArg = fake.invoke.mock.calls[0][0] as Array<{ content: string }>;
      expect(invokeArg[0].content).toContain('拿不准就通过');
    });

    it('审核通过时应返回 pass=true 且 reviewed=true', async () => {
      const { mod, parseLlmJson } = setup();
      const fake = makeFakeLLM('{"pass": true, "reason": ""}');
      createLLMMock.mockReturnValue(fake);
      parseLlmJson.mockReturnValue({ success: true, data: { pass: true, reason: '' } });

      const r = await mod.reviewFinalAnswer({ question: 'q', answer: 'a' });

      expect(r.pass).toBe(true);
      expect(r.reviewed).toBe(true);
      expect(r.model).toBe('deepseek:deepseek-v4-flash');
      expect(fake.invoke).toHaveBeenCalledTimes(1);
    });

    it('审核不通过时应返回 pass=false 与理由', async () => {
      const { mod, parseLlmJson } = setup();
      const fake = makeFakeLLM('{"pass": false, "reason": "残留 DSML 标记"}');
      createLLMMock.mockReturnValue(fake);
      parseLlmJson.mockReturnValue({
        success: true,
        data: { pass: false, reason: '残留 DSML 标记' },
      });

      const r = await mod.reviewFinalAnswer({ question: 'q', answer: 'a' });

      expect(r.pass).toBe(false);
      expect(r.reason).toBe('残留 DSML 标记');
      expect(r.reviewed).toBe(true);
    });

    it('JSON 解析失败时应 fail-open 放行并告警', async () => {
      const { mod, logger, parseLlmJson } = setup();
      const fake = makeFakeLLM('not-json');
      createLLMMock.mockReturnValue(fake);
      parseLlmJson.mockReturnValue({ success: false, reason: 'no json' });

      const r = await mod.reviewFinalAnswer({ question: 'q', answer: 'a' });

      expect(r.pass).toBe(true);
      expect(r.reviewed).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('模型调用超时应 fail-open 放行', async () => {
      const { mod, logger } = setup();
      const fake = {
        invoke: jest.fn().mockRejectedValue(new Error('TimeoutError')),
      };
      createLLMMock.mockReturnValue(fake);

      const r = await mod.reviewFinalAnswer({ question: 'q', answer: 'a' });

      expect(r.pass).toBe(true);
      expect(r.reviewed).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('enabled=false 时不应调用模型', async () => {
      const { mod, config } = setup();
      config.outputReview.enabled = false;
      createLLMMock.mockImplementation(() => {
        throw new Error('不应该被调用');
      });

      const r = await mod.reviewFinalAnswer({ question: 'q', answer: 'a' });

      expect(r).toEqual({ pass: true, reason: '', reviewed: false });
      expect(createLLMMock).not.toHaveBeenCalled();
    });

    it('模型构建抛错（如无 Key）时应 fail-open 放行', async () => {
      const { mod, logger } = setup();
      createLLMMock.mockImplementation(() => {
        throw new Error('DeepSeek 模型需要 API Key');
      });

      const r = await mod.reviewFinalAnswer({ question: 'q', answer: 'a' });

      expect(r.pass).toBe(true);
      expect(r.reviewed).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('超长 answer 应截断（user prompt 中带省略标记、中段被丢弃）', async () => {
      const { mod, parseLlmJson } = setup();
      const fake = makeFakeLLM('{"pass": true, "reason": ""}');
      createLLMMock.mockReturnValue(fake);
      parseLlmJson.mockReturnValue({ success: true, data: { pass: true, reason: '' } });

      // 20013 字符（远超 ANSWER_MAX_CHARS=6000），中段独特标记落在被丢弃的
      // [4800, 18813) 区间内（head=80%*6000=4800，tail=最后 1200 字符）
      const longAnswer = 'a'.repeat(10000) + 'MIDDLE_MARKER' + 'b'.repeat(10000);
      await mod.reviewFinalAnswer({ question: 'q', answer: longAnswer });

      const invokeArg = fake.invoke.mock.calls[0][0] as Array<{ content: string }>;
      const userText = invokeArg[1].content;
      expect(userText).toContain('省略');
      expect(userText).not.toContain('MIDDLE_MARKER');
    });

    it('contexts 超过 12 条时应只取前 12 条', async () => {
      const { mod, parseLlmJson } = setup();
      const fake = makeFakeLLM('{"pass": true, "reason": ""}');
      createLLMMock.mockReturnValue(fake);
      parseLlmJson.mockReturnValue({ success: true, data: { pass: true, reason: '' } });

      const contexts = Array.from({ length: 15 }, (_, i) => `ctx-${i}`);
      await mod.reviewFinalAnswer({ question: 'q', answer: 'a', contexts });

      const invokeArg = fake.invoke.mock.calls[0][0] as Array<{ content: string }>;
      const userText = invokeArg[1].content;
      expect(userText).toContain('ctx-11');
      expect(userText).not.toContain('ctx-12');
    });
  });

  /* ====================================================================
   * buildRewriteInstruction
   * ==================================================================*/
  describe('buildRewriteInstruction', () => {
    it('应包含审核理由并禁止协议格式文本', () => {
      const { mod } = setup();
      const instruction = mod.buildRewriteInstruction('残留 DSML 标记');
      expect(instruction).toContain('残留 DSML 标记');
      expect(instruction).toContain('<invoke');
      expect(instruction).toContain('完整修正后的回答正文');
    });
  });
});
