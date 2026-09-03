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
