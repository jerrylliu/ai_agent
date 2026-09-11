/**
 * fundamentals/dsml-tool-call.spec.ts
 *
 * 测试 DSML 原始工具调用文本的检测 / 过滤 / 解析。
 *
 * 覆盖场景：
 *   1. parseDSMLToolCalls：完整 DSML 文本（用户实际遇到的泄漏格式）
 *   2. 多参数 + 类型还原（string / number / boolean）
 *   3. 多个 invoke 块（一次调多个工具）
 *   4. ASCII 竖线变体 <||DSML||...>
 *   5. 残缺格式（半截标签）返回空数组
 *   6. 可用工具名校验（防模型幻觉出不存在的工具）
 *   7. containsRawToolCallFormat / filterRawToolCalls / isPossibleRawToolCallStart
 *   8. 回归：用户泄漏文本"液氮 杜瓦冷罐 工程干员"可被正确解析
 */

jest.mock('./logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  containsRawToolCallFormat,
  filterRawToolCalls,
  isPossibleRawToolCallStart,
  parseDSMLToolCalls,
  StreamingDsmlSuppressor,
  suppressRawToolCallBlocks,
} from './dsml-tool-call.js';

// 用户实际遇到的泄漏文本（回归用例）
const LEAKED_TEXT =
  '<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="search_knowledge_base"> <｜｜DSML｜｜parameter name="query" string="true">液氮 杜瓦冷罐 工程干员</｜｜DSML｜｜parameter> </｜｜DSML｜｜invoke> </｜｜DSML｜｜tool_calls>';

const AVAILABLE_TOOLS = ['search_knowledge_base', 'search_web', 'get_weather'];

describe('parseDSMLToolCalls', () => {
  it('解析用户实际泄漏文本（回归用例）：液氮查询', () => {
    const calls = parseDSMLToolCalls(LEAKED_TEXT, AVAILABLE_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('search_knowledge_base');
    expect(calls[0].args).toEqual({ query: '液氮 杜瓦冷罐 工程干员' });
  });

  it('多行格式化 DSML 文本', () => {
    const text = [
      '<｜｜DSML｜｜tool_calls>',
      '  <｜｜DSML｜｜invoke name="search_web">',
      '    <｜｜DSML｜｜parameter name="query" string="true">最新 AI 新闻</｜｜DSML｜｜parameter>',
      '    <｜｜DSML｜｜parameter name="limit" string="true">5</｜｜DSML｜｜parameter>',
      '  </｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join('\n');
    const calls = parseDSMLToolCalls(text, AVAILABLE_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('search_web');
    expect(calls[0].args).toEqual({ query: '最新 AI 新闻', limit: 5 });
  });

  it('数字 / 布尔参数类型还原', () => {
    const text =
      '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="get_weather">' +
      '<｜｜DSML｜｜parameter name="city" string="true">北京</｜｜DSML｜｜parameter>' +
      '<｜｜DSML｜｜parameter name="days" string="true">3</｜｜DSML｜｜parameter>' +
      '<｜｜DSML｜｜parameter name="alerts" string="true">true</｜｜DSML｜｜parameter>' +
      '</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
    const calls = parseDSMLToolCalls(text, AVAILABLE_TOOLS);
    expect(calls[0].args).toEqual({ city: '北京', days: 3, alerts: true });
  });

  it('多个 invoke 块（一次调多个工具）', () => {
    const text =
      '<｜｜DSML｜｜tool_calls>' +
      '<｜｜DSML｜｜invoke name="search_knowledge_base"><｜｜DSML｜｜parameter name="query" string="true">查询A</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>' +
      '<｜｜DSML｜｜invoke name="search_web"><｜｜DSML｜｜parameter name="query" string="true">查询B</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>' +
      '</｜｜DSML｜｜tool_calls>';
    const calls = parseDSMLToolCalls(text, AVAILABLE_TOOLS);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ name: 'search_knowledge_base', args: { query: '查询A' } });
    expect(calls[1]).toEqual({ name: 'search_web', args: { query: '查询B' } });
  });

  it('ASCII 竖线变体 <||DSML||...>', () => {
    const text =
      '<||DSML||tool_calls><||DSML||invoke name="search_knowledge_base">' +
      '<||DSML||parameter name="query" string="true">测试查询</||DSML||parameter>' +
      '</||DSML||invoke></||DSML||tool_calls>';
    const calls = parseDSMLToolCalls(text, AVAILABLE_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ query: '测试查询' });
  });

  it('残缺格式（半截标签）返回空数组', () => {
    const text = '我来查询一下。<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="search_';
    expect(parseDSMLToolCalls(text, AVAILABLE_TOOLS)).toEqual([]);
  });

  it('可用工具名校验：幻觉工具名被跳过', () => {
    const text =
      '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="nonexistent_tool">' +
      '<｜｜DSML｜｜parameter name="x" string="true">1</｜｜DSML｜｜parameter>' +
      '</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
    expect(parseDSMLToolCalls(text, AVAILABLE_TOOLS)).toEqual([]);
  });

  it('availableToolNames 为空数组时不校验工具名', () => {
    const text =
      '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="any_tool">' +
      '<｜｜DSML｜｜parameter name="x" string="true">1</｜｜DSML｜｜parameter>' +
      '</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
    const calls = parseDSMLToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('any_tool');
  });

  it('普通文本（无 DSML）返回空数组', () => {
    expect(parseDSMLToolCalls('知识库中有三张液氮相关图片。', AVAILABLE_TOOLS)).toEqual([]);
    expect(parseDSMLToolCalls('', AVAILABLE_TOOLS)).toEqual([]);
  });
});

describe('containsRawToolCallFormat', () => {
  it('检测完整与半截 DSML 标签', () => {
    expect(containsRawToolCallFormat(LEAKED_TEXT)).toBe(true);
    expect(containsRawToolCallFormat('<｜｜DSML｜｜tool_calls>')).toBe(true);
    expect(containsRawToolCallFormat('</｜｜DSML｜｜invoke>')).toBe(true);
    expect(containsRawToolCallFormat('<||DSML||tool_calls>')).toBe(true);
    expect(containsRawToolCallFormat('<tool_calls>{"q":1}</tool_calls>')).toBe(true);
  });

  it('普通文本不误报', () => {
    expect(containsRawToolCallFormat('正常回答文本')).toBe(false);
    expect(containsRawToolCallFormat('1 < 2 且 3 > 2')).toBe(false);
  });
});

describe('filterRawToolCalls', () => {
  it('移除泄漏文本的所有 DSML 标签，仅保留参数内容', () => {
    const cleaned = filterRawToolCalls(LEAKED_TEXT);
    expect(cleaned).toBe('液氮 杜瓦冷罐 工程干员');
    expect(cleaned).not.toContain('DSML');
  });

  it('普通文本原样保留（trim）', () => {
    expect(filterRawToolCalls('  正常文本  ')).toBe('正常文本');
  });
});

describe('isPossibleRawToolCallStart', () => {
  it('以 < 或 ｜ 开头判定为可能起始', () => {
    expect(isPossibleRawToolCallStart('<｜｜DSML')).toBe(true);
    expect(isPossibleRawToolCallStart('<tool')).toBe(true);
    expect(isPossibleRawToolCallStart('文本 <｜｜DSML')).toBe(true);
  });

  it('普通文本判定为否', () => {
    expect(isPossibleRawToolCallStart('正常文本')).toBe(false);
  });
});

// ==================== StreamingDsmlSuppressor / suppressRawToolCallBlocks ====================
// 说明：以下夹具全部通过辅助函数动态拼装（测试源码中不直接书写字面量标签序列），
// 与回归用例 LEAKED_TEXT 表达的形状等价。

const FULL_PIPE = '｜';
const ASCII_PIPE = '|';

/** 拼装 DSML 开标签头：'<' + 双竖线 + 'DSML' + 双竖线 */
function dsmlOpenHead(pipe: string): string {
  return '<' + pipe + pipe + 'DSML' + pipe + pipe;
}

/** 拼装 DSML 闭标签头：'<' + '/' + 双竖线 + 'DSML' + 双竖线 */
function dsmlCloseHead(pipe: string): string {
  return '<' + '/' + pipe + pipe + 'DSML' + pipe + pipe;
}

/** 构造裸 invoke 块（不带 tool_calls 包裹，用户实际泄漏的形态） */
function buildInvokeBlock(
  tool: string,
  params: Record<string, string>,
  pipe: string = FULL_PIPE,
): string {
  const open = dsmlOpenHead(pipe);
  const close = dsmlCloseHead(pipe);
  let text = open + 'invoke name="' + tool + '">';
  for (const [name, value] of Object.entries(params)) {
    text +=
      open + 'parameter name="' + name + '" string="true">' + value + close + 'parameter>';
  }
  return text + close + 'invoke>';
}

/** 在 invoke 块外再包一层 tool_calls 开/闭标签 */
function wrapToolCalls(inner: string, pipe: string = FULL_PIPE): string {
  return dsmlOpenHead(pipe) + 'tool_calls>' + inner + dsmlCloseHead(pipe) + 'tool_calls>';
}

/** 依次喂入 chunks 并结束流，返回安全输出文本（push 累计 + flush） */
function runStream(suppressor: StreamingDsmlSuppressor, chunks: string[]): string {
  let out = '';
  for (const chunk of chunks) out += suppressor.push(chunk);
  return out + suppressor.flush();
}

/** 按指定大小切分文本（模拟任意流式切分边界） */
function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

describe('StreamingDsmlSuppressor', () => {
  it('整块抑制裸 invoke 块，捕获的全文可被解析执行', () => {
    const before = '查询结果如下：';
    const block = buildInvokeBlock('search_knowledge_base', { query: '液氮 杜瓦冷罐 工程干员' });
    const after = '\n以上。';
    const suppressor = new StreamingDsmlSuppressor();
    const safe = runStream(suppressor, [before + block + after]);
    expect(safe).toBe(before + after);
    expect(safe).not.toContain('DSML');
    const calls = parseDSMLToolCalls(suppressor.getCaptured(), AVAILABLE_TOOLS);
    expect(calls).toEqual([
      { name: 'search_knowledge_base', args: { query: '液氮 杜瓦冷罐 工程干员' } },
    ]);
  });

  it('逐字符 / 任意分块喂入与整段喂入结果一致', () => {
    const input = '前文 ' + buildInvokeBlock('get_weather', { city: '西安', days: '3' }) + ' 后文';
    const whole = new StreamingDsmlSuppressor();
    const expected = runStream(whole, [input]);
    expect(expected).toBe('前文  后文');
    for (const size of [1, 2, 3, 5, 7, 16]) {
      const s = new StreamingDsmlSuppressor();
      expect(runStream(s, splitEvery(input, size))).toBe(expected);
      expect(s.getCaptured()).toBe(whole.getCaptured());
    }
  });

  it('开标签被切成单字符碎片仍整块抑制', () => {
    const block = buildInvokeBlock('search_web', { query: '测试' });
    const head = block.slice(0, 12); // 切点开标签中部
    const s = new StreamingDsmlSuppressor();
    const safe = runStream(s, ['前缀', ...head.split(''), block.slice(12) + '后缀']);
    expect(safe).toBe('前缀后缀');
  });

  it('含尖括号 / 竖线 / 比较符的正常文本零误吞', () => {
    const texts = [
      '1 < 2 且 3 > 2',
      'HTML 标签如 <div> 与 </div> 应保留',
      'a || b 与单个 ｜ 全角竖线',
      '< 未闭合与 > 单独出现',
    ];
    for (const text of texts) {
      const s = new StreamingDsmlSuppressor();
      expect(runStream(s, [text])).toBe(text);
      expect(s.hasCaptured()).toBe(false);
    }
  });

  it('ASCII 竖线变体同样整块抑制', () => {
    const block = buildInvokeBlock('search_web', { query: 'ASCII 测试' }, ASCII_PIPE);
    const s = new StreamingDsmlSuppressor();
    const safe = runStream(s, ['前' + block + '后']);
    expect(safe).toBe('前后');
    expect(parseDSMLToolCalls(s.getCaptured(), AVAILABLE_TOOLS)).toHaveLength(1);
  });

  it('连续两个裸 invoke 均被抑制且均可解析', () => {
    const block1 = buildInvokeBlock('generate_document', { content: '第一份文档正文' });
    const block2 = buildInvokeBlock('generate_document', { content: '第二份文档正文' });
    const s = new StreamingDsmlSuppressor();
    const safe = runStream(s, ['开始生成：' + block1 + block2]);
    expect(safe).toBe('开始生成：');
    const calls = parseDSMLToolCalls(s.getCaptured(), ['generate_document']);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual({ content: '第一份文档正文' });
    expect(calls[1].args).toEqual({ content: '第二份文档正文' });
  });

  it('参数正文含尖括号 / 竖线 / 换行不破坏块边界', () => {
    const content =
      '# 天气预报\n' +
      '<div class="temp">1 < 2</div>\n' +
      '| 城市 | 温度 |\n' +
      '| 西安 | 25°C |\n' +
      '结束';
    const block = buildInvokeBlock('generate_document', { content });
    const s = new StreamingDsmlSuppressor();
    const safe = runStream(s, ['头' + block + '尾']);
    expect(safe).toBe('头尾');
    const calls = parseDSMLToolCalls(s.getCaptured(), ['generate_document']);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.content).toBe(content);
  });

  it('嵌套 tool_calls 包裹：深度计数后正确回到正常文本', () => {
    const wrapped = wrapToolCalls(buildInvokeBlock('search_web', { query: '嵌套结构' }));
    const s = new StreamingDsmlSuppressor();
    const safe = runStream(s, ['头 ' + wrapped + ' 尾']);
    expect(safe).toBe('头  尾');
    expect(parseDSMLToolCalls(s.getCaptured(), AVAILABLE_TOOLS)).toHaveLength(1);
  });

  it('孤立闭标签仅抑制自身', () => {
    const orphan = dsmlCloseHead(FULL_PIPE) + 'invoke>';
    const s = new StreamingDsmlSuppressor();
    expect(runStream(s, ['A' + orphan + 'B'])).toBe('AB');
    expect(s.hasCaptured()).toBe(true);
  });

  it('未闭合块在 flush 时整体抑制', () => {
    const input =
      '开头' + dsmlOpenHead(FULL_PIPE) + 'invoke name="search_web">参数内容未闭合';
    const s = new StreamingDsmlSuppressor();
    expect(runStream(s, [input])).toBe('开头');
    expect(s.getCaptured()).toContain('search_web');
  });

  it('flush 残留处理：普通残留原样吐出，DSML 残留抑制', () => {
    const s1 = new StreamingDsmlSuppressor();
    expect(runStream(s1, ['1 <'])).toBe('1 <');

    const s2 = new StreamingDsmlSuppressor();
    expect(runStream(s2, ['文字' + dsmlOpenHead(FULL_PIPE).slice(0, 5)])).toBe('文字');
    expect(s2.hasCaptured()).toBe(true);

    const s3 = new StreamingDsmlSuppressor();
    expect(runStream(s3, ['结尾 <tool_cal'])).toBe('结尾 <tool_cal');
  });

  it('两块夹正常文本分别抑制', () => {
    const b1 = buildInvokeBlock('search_web', { query: '第一次' });
    const b2 = buildInvokeBlock('get_weather', { city: '西安' });
    const s = new StreamingDsmlSuppressor();
    expect(runStream(s, [b1 + '中间文本' + b2])).toBe('中间文本');
  });

  it('回归：用户泄漏文本（LEAKED_TEXT）整块抑制且捕获可解析', () => {
    const s = new StreamingDsmlSuppressor();
    const safe = runStream(s, ['查询结果如下：' + LEAKED_TEXT + '\n以上。']);
    expect(safe).toBe('查询结果如下：\n以上。');
    const calls = parseDSMLToolCalls(s.getCaptured(), AVAILABLE_TOOLS);
    expect(calls).toEqual([
      { name: 'search_knowledge_base', args: { query: '液氮 杜瓦冷罐 工程干员' } },
    ]);
  });
});

describe('suppressRawToolCallBlocks', () => {
  it('同步整段抑制与流式行为一致', () => {
    const input = 'A' + buildInvokeBlock('search_web', { query: '同步抑制' }) + 'B';
    const { safeText, captured } = suppressRawToolCallBlocks(input);
    expect(safeText).toBe('AB');
    expect(parseDSMLToolCalls(captured, AVAILABLE_TOOLS)).toHaveLength(1);
  });

  it('正常文本原样返回且无捕获', () => {
    const { safeText, captured } = suppressRawToolCallBlocks('1 < 2 是常识');
    expect(safeText).toBe('1 < 2 是常识');
    expect(captured).toBe('');
  });
});

// ==================== P0：方言容错（用户实际泄漏形态全覆盖） ====================
// 背景：中转站 / 兼容层可能把 DSML 特殊标记丢掉，退化成裸 XML；不同模型的单复数、
// 装饰前缀、大小写也不同。这一组用例把"必须被拦截的方言"钉死：任何一条回归都视为
// 出口契约被击穿（宁可少显示，也绝不把控制标记透给用户）。
// 说明：沿用上面的约定，测试源码里不直接书写字面量标签序列，一律由辅助函数拼装。

const LT = String.fromCharCode(60); // 左尖括号
const GT = String.fromCharCode(62); // 右尖括号
const SL = String.fromCharCode(47); // 斜杠

/** 无装饰前缀的裸开标签（DSML 标记被链路丢弃后的形态） */
function bare(name: string, attrs?: string): string {
  return LT + name + (attrs ? ' ' + attrs : '') + GT;
}

/** 无装饰前缀的裸闭标签 */
function bareClose(name: string): string {
  return LT + SL + name + GT;
}

/** 组装裸块：outer 为外层包裹标签名（null 表示只有裸 invoke，无外层） */
function buildBareBlock(
  outer: string | null,
  tool: string,
  params: Record<string, string>,
): string {
  let text = bare('invoke', 'name="' + tool + '"');
  for (const [k, v] of Object.entries(params)) {
    text += bare('parameter', 'name="' + k + '" string="true"') + v + bareClose('parameter');
  }
  text += bareClose('invoke');
  return outer ? bare(outer) + text + bareClose(outer) : text;
}

/** 组装 Anthropic 风格 antml: 前缀块 */
function buildAntmlBlock(tool: string, params: Record<string, string>): string {
  const p = 'antml:';
  let text = LT + p + 'invoke name="' + tool + '"' + GT;
  for (const [k, v] of Object.entries(params)) {
    text +=
      LT + p + 'parameter name="' + k + '" string="true"' + GT + v + LT + SL + p + 'parameter' + GT;
  }
  return text + LT + SL + p + 'invoke' + GT;
}

/** 断言：整段喂入与任意切分喂入结果一致，且捕获内容可解析出期望调用 */
function expectInvariant(input: string, expectedSafe: string, expectedCalls: unknown[]): void {
  const whole = new StreamingDsmlSuppressor();
  expect(runStream(whole, [input])).toBe(expectedSafe);
  for (const size of [1, 2, 3, 5, 7, 13]) {
    const s = new StreamingDsmlSuppressor();
    expect(runStream(s, splitEvery(input, size))).toBe(expectedSafe);
    expect(s.getCaptured()).toBe(whole.getCaptured());
  }
  expect(parseDSMLToolCalls(whole.getCaptured(), AVAILABLE_TOOLS)).toEqual(expectedCalls);
}

describe('P0 方言容错：检测 / 过滤 / 解析', () => {
  it('检测层：单数、无装饰、antml:、大小写、属性空白 均能识别', () => {
    const samples = [
      bare('tool_call') +
        buildBareBlock(null, 'search_web', { query: 'x' }) +
        bareClose('tool_call'),
      buildBareBlock('tool_calls', 'search_web', { query: 'x' }),
      buildBareBlock(null, 'search_web', { query: 'x' }),
      buildAntmlBlock('search_web', { query: 'x' }),
      bare('tool_calls') + '{"q":1}' + bareClose('tool_calls'),
      bare('TOOL_CALLS') + '{"q":1}' + bareClose('TOOL_CALLS'),
      bare('invoke', 'name = "search_web"') + '{"q":1}' + bareClose('invoke'),
    ];
    for (const s of samples) {
      expect(containsRawToolCallFormat(s)).toBe(true);
    }
  });

  it('过滤层：去掉各类控制标签，只保留参数正文', () => {
    expect(filterRawToolCalls(buildBareBlock('tool_calls', 'search_web', { query: '甲' }))).toBe(
      '甲',
    );
    expect(filterRawToolCalls(buildBareBlock(null, 'search_web', { query: '乙' }))).toBe('乙');
    expect(filterRawToolCalls(buildAntmlBlock('search_web', { query: '丙' }))).toBe('丙');
    expect(
      filterRawToolCalls(
        bare('tool_call') +
          buildBareBlock(null, 'search_web', { query: '丁' }) +
          bareClose('tool_call'),
      ),
    ).toBe('丁');
  });

  it('解析层：单数 tool_call 包裹与裸 invoke 均可解析执行', () => {
    const singular =
      bare('tool_call') +
      buildBareBlock(null, 'search_web', { query: '单数' }) +
      bareClose('tool_call');
    expect(parseDSMLToolCalls(singular, AVAILABLE_TOOLS)).toEqual([
      { name: 'search_web', args: { query: '单数' } },
    ]);

    const bareInvoke = buildBareBlock(null, 'search_knowledge_base', { query: '裸块' });
    expect(parseDSMLToolCalls(bareInvoke, AVAILABLE_TOOLS)).toEqual([
      { name: 'search_knowledge_base', args: { query: '裸块' } },
    ]);
  });

  it('解析层：antml: 前缀形态可解析执行', () => {
    const antml = buildAntmlBlock('search_web', { query: '安特', limit: '5' });
    expect(parseDSMLToolCalls(antml, AVAILABLE_TOOLS)).toEqual([
      { name: 'search_web', args: { query: '安特', limit: 5 } },
    ]);
  });
});

describe('P0 方言容错：流式整块抑制', () => {
  it('单数 tool_call 包裹整块抑制（整段与任意切分一致）', () => {
    const block =
      bare('tool_call') +
      buildBareBlock(null, 'search_web', { query: '单数流式' }) +
      bareClose('tool_call');
    expectInvariant('头' + block + '尾', '头尾', [
      { name: 'search_web', args: { query: '单数流式' } },
    ]);
  });

  it('完全裸 invoke（无包裹、无装饰）整块抑制', () => {
    const block = buildBareBlock(null, 'search_knowledge_base', { query: '裸流式' });
    expectInvariant('前文' + block + '后文', '前文后文', [
      { name: 'search_knowledge_base', args: { query: '裸流式' } },
    ]);
  });

  it('antml: 前缀块整块抑制', () => {
    const block = buildAntmlBlock('search_web', { query: '安特流式' });
    expectInvariant('A' + block + 'B', 'AB', [{ name: 'search_web', args: { query: '安特流式' } }]);
  });

  it('DSML 装饰 + 单数标签整块抑制', () => {
    const open = dsmlOpenHead(FULL_PIPE);
    const close = dsmlCloseHead(FULL_PIPE);
    const block =
      open +
      'tool_call' +
      GT +
      open +
      'invoke name="search_web"' +
      GT +
      open +
      'parameter name="query" string="true"' +
      GT +
      '装饰单数' +
      close +
      'parameter' +
      GT +
      close +
      'invoke' +
      GT +
      close +
      'tool_call' +
      GT;
    expectInvariant('X' + block + 'Y', 'XY', [{ name: 'search_web', args: { query: '装饰单数' } }]);
  });

  it('开闭标签大小写不一致仍能收尾且不泄漏', () => {
    const block =
      bare('Invoke', 'name="search_web"') +
      bare('Parameter', 'name="query" string="true"') +
      '大小写' +
      bareClose('parameter') +
      bareClose('invoke');
    const s = new StreamingDsmlSuppressor();
    expect(runStream(s, ['前' + block + '后'])).toBe('前后');
    expect(s.getCaptured()).toContain('大小写');
  });

  it('parameter 漏写闭合、invoke 正常闭合时不吞掉块之后的正文', () => {
    const block =
      bare('invoke', 'name="search_web"') +
      bare('parameter', 'name="query" string="true"') +
      '漏参数闭合' +
      bareClose('invoke');
    const s = new StreamingDsmlSuppressor();
    expect(runStream(s, ['前' + block + '后'])).toBe('前后');
    expect(s.getCaptured()).toContain('漏参数闭合');
  });

  it('只有开标签、没有闭标签时抑制到流结束（开闭不对称）', () => {
    const input = '正文' + bare('invoke', 'name="search_web"') + '未闭合的后续内容';
    expectInvariant(input, '正文', []);
  });

  it('块内正文含伪标签与比较符时不毒化扫描缓冲', () => {
    const content =
      '# 标题\n' +
      bare('to') +
      ' 与 ' +
      bare('param') +
      ' 与 ' +
      bare('div', 'class="x"') +
      '1 ' +
      LT +
      ' 2' +
      bareClose('div') +
      '\n结束';
    const block = buildBareBlock(null, 'generate_document', { content });
    const s = new StreamingDsmlSuppressor();
    expect(runStream(s, ['头' + block + '尾'])).toBe('头尾');
    const calls = parseDSMLToolCalls(s.getCaptured(), ['generate_document']);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.content).toBe(content);
  });

  it('普通文本零误吞：伪标签与未闭合尖括号全部原样保留', () => {
    const texts = [
      bare('title') + '标题' + bareClose('title'),
      bare('tool') + ' 是普通词',
      'x ' + bare('to') + ' y',
      bare('involve') + ' 不是 invoke',
      bare('param') + ' 不是 parameter',
      bare('function') + ' 不是 function_call',
      'a' + bareClose('b') + 'c',
      '1 ' + LT + ' 2 且 3 ' + GT + ' 2',
    ];
    for (const text of texts) {
      const s = new StreamingDsmlSuppressor();
      expect(runStream(s, [text])).toBe(text);
      expect(s.hasCaptured()).toBe(false);
    }
  });
});
