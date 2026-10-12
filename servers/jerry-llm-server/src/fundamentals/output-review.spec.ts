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

    it('应告知模型可视化内容已由系统恢复、只需输出文字正文', () => {
      const { mod } = setup();
      const instruction = mod.buildRewriteInstruction('自相矛盾');
      expect(instruction).toContain('已由系统单独恢复');
      expect(instruction).toContain('```echarts');
      expect(instruction).toContain('```mermaid');
    });
  });

  /* ====================================================================
   * extractPreservedAssetBlocks
   * ==================================================================*/
  describe('extractPreservedAssetBlocks', () => {
    it('无资产时返回空字符串', () => {
      const { mod } = setup();
      expect(mod.extractPreservedAssetBlocks('纯文字回答，没有任何资产。')).toBe(
        '',
      );
    });

    it('应提取 echarts 围栏块并保留完整 JSON', () => {
      const { mod } = setup();
      const optionJson = '{"series":[{"data":[1,2,3]}]}';
      const answer = `前置文字\n\n\`\`\`echarts\n${optionJson}\n\`\`\`\n\n后置文字`;
      const out = mod.extractPreservedAssetBlocks(answer);
      expect(out).toContain('```echarts');
      expect(out).toContain(optionJson);
      expect(out).not.toContain('前置文字');
      expect(out).not.toContain('后置文字');
    });

    it('应提取 mermaid 围栏块', () => {
      const { mod } = setup();
      const answer = '文字\n\n```mermaid\ngraph TD; A-->B;\n```\n\n文字';
      expect(mod.extractPreservedAssetBlocks(answer)).toContain(
        'graph TD; A-->B;',
      );
    });

    it('应按原文顺序提取多个资产块（echarts 在前、图片在后）', () => {
      const { mod } = setup();
      const chart = '```echarts\n{"a":1}\n```';
      const img = '![图片](https://example.com/a.png)';
      const answer = `${chart}\n\n中间文字\n\n${img}\n\n结尾`;
      const out = mod.extractPreservedAssetBlocks(answer);
      const chartIdx = out.indexOf('```echarts');
      const imgIdx = out.indexOf('![');
      expect(chartIdx).toBeGreaterThanOrEqual(0);
      expect(imgIdx).toBeGreaterThan(chartIdx);
      expect(out).not.toContain('中间文字');
    });

    it('落在代码围栏内部的图片字样不重复提取（以围栏块整体为准）', () => {
      const { mod } = setup();
      // echarts JSON 字符串里恰好出现图片 Markdown 字样的极端情况
      const answer =
        '```echarts\n{"mark":"![x](https://inner.example.com/y.png)"}\n```\n\n正文';
      const out = mod.extractPreservedAssetBlocks(answer);
      expect(out).toContain('```echarts');
      // '![' 仅作为 JSON 字符串存在于围栏块内（出现 1 次），未再作为独立资产块重复提取
      expect(out.split('![').length - 1).toBe(1);
      expect(out).not.toContain('正文');
    });

    it('输出末尾带空行，便于与后续重写文字衔接', () => {
      const { mod } = setup();
      const out = mod.extractPreservedAssetBlocks(
        '```mermaid\ngraph TD; A-->B;\n```',
      );
      expect(out.endsWith('\n\n')).toBe(true);
    });

    it('容忍 \\r\\n 行尾的围栏块', () => {
      const { mod } = setup();
      const out = mod.extractPreservedAssetBlocks(
        '```echarts\r\n{"a":1}\r\n```\r\n正文',
      );
      expect(out).toContain('```echarts');
      expect(out).toContain('{"a":1}');
      expect(out).not.toContain('正文');
    });
  });

  /* ====================================================================
   * createVisualFenceSuppressor（重写流视觉围栏硬抑制）
   * ==================================================================*/
  describe('createVisualFenceSuppressor', () => {
    function makeSup() {
      const { mod } = setup();
      return { mod, sup: mod.createVisualFenceSuppressor() };
    }

    it('普通代码块（```python 等）原样放行', () => {
      const { sup } = makeSup();
      const text = '前置\n\n```python\nprint(1)\n```\n\n后置';
      expect(sup.push(text)).toBe(text);
      expect(sup.flush()).toBe('');
    });

    it('无语言名的普通围栏原样放行（收尾 ``` 暂扣至 flush 归还）', () => {
      const { sup } = makeSup();
      // 收尾的 ``` 被暂扣（后续可能续成 ```echarts 开头），但绝不丢失
      expect(sup.push('```\nplain\n```')).toBe('```\nplain\n');
      expect(sup.flush()).toBe('```');
    });

    it('echarts 围栏整块丢弃，前后文字保留', () => {
      const { sup } = makeSup();
      const out = sup.push('文字A\n\n```echarts\n{"a":1}\n```\n\n文字B');
      expect(out).toBe('文字A\n\n\n\n文字B');
      expect(sup.flush()).toBe('');
    });

    it('mermaid 围栏同样丢弃', () => {
      const { sup } = makeSup();
      const out = sup.push('A\n```mermaid\ngraph TD; A-->B;\n```\nB');
      expect(out).toBe('A\n\nB');
    });

    it('未闭合的视觉围栏到流尾：正文保留、块内残留丢弃', () => {
      const { sup } = makeSup();
      expect(sup.push('正文\n```mermaid\ngraph TD;')).toBe('正文\n');
      expect(sup.flush()).toBe('');
    });

    it('围栏标记被 chunk 切散时仍正确判定并丢弃', () => {
      const { sup } = makeSup();
      const o1 = sup.push('x\n``');
      const o2 = sup.push('`echarts\n{"a":1}\n``');
      const o3 = sup.push('`\n收尾');
      // chunk1 末尾 "``" 暂扣（可能是切散的围栏开头），flush 归还
      expect(o1).toBe('x\n');
      expect(o2).toBe('');
      expect(o3).toBe('\n收尾');
      expect(sup.flush()).toBe('');
    });

    it('非视觉围栏标记被切散时正常放行不丢字', () => {
      const { sup } = makeSup();
      // 暂扣的 "``" 与下一 chunk 的 "`python" 拼成完整围栏开头，正确放行
      const o1 = sup.push('a ``');
      const o2 = sup.push('`python\nhi\n```\nend');
      expect(o1).toBe('a ');
      expect(o2).toBe('```python\nhi\n```\nend');
      expect(sup.flush()).toBe('');
    });

    it('echarts 语言带参数（如空格后缀）也能识别', () => {
      const { sup } = makeSup();
      const out = sup.push('```echarts \n{"a":1}\n```');
      expect(out).toBe('');
    });

    it('flush 归还 normal 态暂扣的反引号（绝不丢字）', () => {
      const { sup } = makeSup();
      expect(sup.push('结尾一个反引号 `')).toBe('结尾一个反引号 ');
      expect(sup.flush()).toBe('`');
    });

    it('语言行超长（非合法围栏）按普通文本放行', () => {
      const { sup } = makeSup();
      const longLine = 'x'.repeat(40);
      const out = sup.push('```' + longLine + '\ncontent');
      expect(out).toBe('```' + longLine + '\ncontent');
    });
  });

  /* ====================================================================
   * isProtocolResidueReason（协议残留判定 → 触发资产补执行）
   * ==================================================================*/
  describe('isProtocolResidueReason', () => {
    it('线上两类协议残留 reason 均命中', () => {
      const { mod } = setup();
      expect(
        mod.isProtocolResidueReason(
          '回答中残留了工具调用的协议标签文本（<｜｜DSML｜｜ calls>、<｜｜DSML｜｜ invoke>、<｜｜DSML｜｜ parameter> 等），属于协议残留硬伤。',
        ),
      ).toBe(true);
      expect(
        mod.isProtocolResidueReason(
          '回答末尾残留工具调用协议原始文本（<｜｜DSML｜｜ calls>、<｜｜DSML｜｜ invoke>、parameter 等标记及裸露的调用参数体），命中协议残留硬伤。',
        ),
      ).toBe(true);
    });

    it('数据矛盾类 reason 不触发补执行', () => {
      const { mod } = setup();
      expect(
        mod.isProtocolResidueReason(
          '图表数据与文字总结自相矛盾：图中逐小时降水量合计约9.26mm，文字却称全天累计约3.3mm。',
        ),
      ).toBe(false);
      expect(mod.isProtocolResidueReason('回答未覆盖用户问题')).toBe(false);
    });

    it('宽松匹配：任意标记字样（invoke/parameter/tool_call）即命中，空值不命中', () => {
      const { mod } = setup();
      expect(mod.isProtocolResidueReason('裸露的 invoke 标记')).toBe(true);
      expect(mod.isProtocolResidueReason('参数体 parameter 泄漏')).toBe(true);
      expect(mod.isProtocolResidueReason('')).toBe(false);
      expect(mod.isProtocolResidueReason(undefined as unknown as string)).toBe(
        false,
      );
    });
  });

  /* ====================================================================
   * dedupeSalvagedAssetBlocks（补执行资产内容级去重）
   * ==================================================================*/
  describe('dedupeSalvagedAssetBlocks', () => {
    const CHART_A = '{"series":[{"data":[1,2,3]}],"title":{"text":"成都天气"}}';
    // 同数据不同缩进/键序的场景：JSON.parse 后归一化应视为相同
    const CHART_A_REINDENTED =
      '{\n  "title": {"text": "成都天气"},\n  "series": [{"data": [1, 2, 3]}]\n}';
    const CHART_B = '{"series":[{"data":[4,5,6]}],"title":{"text":"上海天气"}}';

    it('salvaged 为空返回空串；existing 为空时原样保留 salvaged', () => {
      const { mod } = setup();
      expect(mod.dedupeSalvagedAssetBlocks('', '')).toBe('');
      expect(
        mod.dedupeSalvagedAssetBlocks('', '```echarts\n' + CHART_A + '\n```\n\n'),
      ).toBe('```echarts\n' + CHART_A + '\n```\n\n');
    });

    it('echarts 同数据（缩进/键序不同）去重，不同数据保留', () => {
      const { mod } = setup();
      const existing = '前文\n\n```echarts\n' + CHART_A + '\n```\n\n后文';
      const salvaged =
        '```echarts\n' +
        CHART_A_REINDENTED +
        '\n```\n\n```echarts\n' +
        CHART_B +
        '\n```\n\n';
      const result = mod.dedupeSalvagedAssetBlocks(existing, salvaged);
      expect(result).toBe('```echarts\n' + CHART_B + '\n```\n\n');
      expect(result).not.toContain('成都天气');
    });

    it('mermaid 同内容去重（容忍首尾空白差异），不同内容保留', () => {
      const { mod } = setup();
      const existing = '```mermaid\ngraph TD; A-->B;\n```';
      const salvaged =
        '```mermaid\n\ngraph TD; A-->B;\n```\n\n```mermaid\ngraph TD; A-->C;\n```\n\n';
      const result = mod.dedupeSalvagedAssetBlocks(existing, salvaged);
      expect(result).toContain('A-->C');
      expect(result).not.toMatch(/graph TD; A-->B;/);
    });

    it('图片同 URL 去重（alt 不同不算新图），不同 URL 保留', () => {
      const { mod } = setup();
      const existing = '![生成的图片](https://cdn.example.com/a.png)';
      const salvaged =
        '![生成的图片 1](https://cdn.example.com/a.png)\n![新图](https://cdn.example.com/b.png)\n\n';
      const result = mod.dedupeSalvagedAssetBlocks(existing, salvaged);
      expect(result).toBe('![新图](https://cdn.example.com/b.png)\n\n');
    });

    it('全重复时返回空串；existing 无资产签名时保留 salvaged（统一尾空行）', () => {
      const { mod } = setup();
      const broken = '```echarts\n不是合法JSON\n```';
      expect(mod.dedupeSalvagedAssetBlocks(broken, broken + '\n\n')).toBe('');
      const salvaged = '```echarts\n' + CHART_A + '\n```';
      expect(mod.dedupeSalvagedAssetBlocks('无资产', salvaged)).toBe(
        salvaged + '\n\n',
      );
    });

    it('同批次内两份相同块只保留一份（签名随保留回写）', () => {
      const { mod } = setup();
      const chart = '```echarts\n' + CHART_A + '\n```';
      const salvaged = chart + '\n\n' + chart + '\n\n' + '```echarts\n' + CHART_B + '\n```\n\n';
      const result = mod.dedupeSalvagedAssetBlocks('', salvaged);
      expect(result.match(/成都天气/g)?.length ?? 0).toBe(1);
      expect(result).toContain('上海天气');
    });
  });
});
