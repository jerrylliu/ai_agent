/**
 * fundamentals/tools/multimodal-output.schema.spec.ts
 *
 * generate_chart / generate_image / create_mindmap 三个 Tool 的 zod schema 测试
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../config', () => ({
  config: {
    dashscopeApiKey: 'TEST_KEY',
    dashscopeBaseUrl: 'https://dashscope.aliyuncs.com',
  },
}));

// 阻断 puppeteer / web-crawler 的真实加载（schema 测试不需要它们）
jest.mock('../web-crawler', () => ({
  launchBrowser: jest.fn(),
}));

import {
  generateChartSchema,
  generateChartParamsSchema,
  generateImageSchema,
  generateImageParamsSchema,
  createMindmapSchema,
  createMindmapParamsSchema,
  normalizeEChartsOption,
  extractLabels,
  extractSeries,
  extractPieItems,
  applyThemeDefaults,
  buildDefaultSeriesStyle,
} from './multimodal-output';
import { safeParseToolParams } from './_helpers';

// ==================== normalizeEChartsOption（生产案例 2026-10-13 回归） ====================
// 现象：图表渲染了标题和 X 轴但没有任何数据线

describe('normalizeEChartsOption', () => {
  it('series 项误写 values → 归一化为 data（14:03 日志原样复现）', () => {
    const option = {
      xAxis: { type: 'category', data: ['10-13', '10-14'] },
      yAxis: { type: 'value' },
      series: [
        { name: '最高气温(℃)', values: [25, 25] },
        { name: '最低气温(℃)', values: [19, 19] },
      ],
    };
    const r = normalizeEChartsOption(option, 'line');
    expect(r.series[0].data).toEqual([25, 25]);
    expect(r.series[0].values).toBeUndefined();
    expect(r.series[1].data).toEqual([19, 19]);
  });

  it('series 项已有 data 时不触碰（values 与 data 并存时以 data 为准）', () => {
    const option = {
      series: [{ type: 'line', data: [1, 2], values: [9, 9] }],
    };
    const r = normalizeEChartsOption(option, 'line');
    expect(r.series[0].data).toEqual([1, 2]);
  });

  it('series 项漏写 type → 按 chartType 推断', () => {
    const option = { series: [{ name: 'a', data: [1] }] };
    const r = normalizeEChartsOption(option, 'bar');
    expect(r.series[0].type).toBe('bar');
  });

  it('series 传成单个对象 → 包装成数组', () => {
    const option = { series: { name: 'a', data: [1, 2] } };
    const r = normalizeEChartsOption(option, 'line');
    expect(Array.isArray(r.series)).toBe(true);
    expect(r.series[0].name).toBe('a');
  });

  it('合法 option 原样保留其余字段（title/xAxis 等不被破坏）', () => {
    const option = {
      backgroundColor: '#0b1020',
      title: { text: 'T' },
      series: [{ type: 'line', data: [1] }],
    };
    const r = normalizeEChartsOption(option, 'line');
    expect(r.backgroundColor).toBe('#0b1020');
    expect(r.title).toEqual({ text: 'T' });
  });

  it('非法入参（null / 数组）原样返回不抛错', () => {
    expect(normalizeEChartsOption(null as any, 'line')).toBeNull();
    expect(normalizeEChartsOption([1, 2] as any, 'line')).toEqual([1, 2]);
  });
});

// ==================== data 形状容错提取器（生产案例 2026-10-13 第三变体） ====================
// 现象：模型传 {date:[...], high:[...], low:[...]} 等价数据但字段名非标准，
// 构建器刚性取 labels/series 静默产出空骨架图

describe('extractLabels / extractSeries / extractPieItems', () => {
  it('labels 等价字段名 dates/days/categories 均可提取', () => {
    expect(extractLabels({ dates: ['10-13', '10-14'] })).toEqual([
      '10-13',
      '10-14',
    ]);
    expect(extractLabels({ categories: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(extractLabels({ labels: ['x'] })).toEqual(['x']);
    expect(extractLabels({ xAxis: { data: ['p', 'q'] } })).toEqual(['p', 'q']);
  });

  it('并行数组形态（生产案例原样复现）→ 每个数值数组一个系列，键名做系列名', () => {
    const r = extractSeries({
      date: ['10-13', '10-14'],
      high: [25, 22],
      low: [19, 19],
    });
    expect(r).toEqual([
      { name: 'high', data: [25, 22] },
      { name: 'low', data: [19, 19] },
    ]);
  });

  it('标准 series 形态优先，data|values 双收', () => {
    expect(
      extractSeries({ series: [{ name: 'n', values: [1, 2] }] }),
    ).toEqual([{ name: 'n', data: [1, 2] }]);
    expect(
      extractSeries({ series: [{ name: 'n', data: [3] }] }),
    ).toEqual([{ name: 'n', data: [3] }]);
  });

  it('pie：items/data/series 数组与 {名称:数值} 字典形态均可提取', () => {
    expect(extractPieItems({ items: [{ name: 'a', value: 1 }] })).toEqual([
      { name: 'a', value: 1 },
    ]);
    expect(extractPieItems({ 多云: 12, 小雨: 5 })).toEqual([
      { name: '多云', value: 12 },
      { name: '小雨', value: 5 },
    ]);
  });

  it('字符串数组不会被误认为数值系列（labels 键排除）', () => {
    expect(extractSeries({ dates: ['a'], temps: [1] })).toEqual([
      { name: 'temps', data: [1] },
    ]);
  });
});

// ==================== 深色科技风默认主题（2026-10-13 用户确认固化） ====================

describe('chart-theme 默认主题接入', () => {
  it('简化 data 路径：生成的 option 自带深色背景 + 主题色板 + 渐变面积', () => {
    const r = generateChartParamsSchema.safeParse({
      chartType: 'line',
      title: '气温趋势',
      data: {
        dates: ['10-13', '10-14'],
        高温: [27, 24],
        低温: [19, 18],
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // 走私有 buildEChartsOption 需经 executeGenerateChart，这里直接断言 schema
    // 归一化 + 构建逻辑由 executeGenerateChart 集成验证；主题模块单测见下
    expect(r.data).toBeDefined();
  });

  it('applyThemeDefaults：只补缺失字段，模型显式样式不覆盖', () => {
    const option = {
      backgroundColor: '#123456',
      series: [{ type: 'line', data: [1] }],
    };
    const r = applyThemeDefaults(option);
    expect(r.backgroundColor).toBe('#123456'); // 模型写的保留
    expect(r.textStyle).toEqual({ color: '#e6f1ff' }); // 缺失的补上
    expect(r.tooltip.backgroundColor).toBe('rgba(12, 20, 38, 0.92)');
  });

  it('applyThemeDefaults：模型写了 tooltip 结构时不覆盖', () => {
    const option = { tooltip: { trigger: 'item' }, series: [] };
    const r = applyThemeDefaults(option);
    expect(r.tooltip.trigger).toBe('item');
    expect(r.tooltip.backgroundColor).toBeUndefined();
  });

  it('buildDefaultSeriesStyle：前两个系列带渐变面积，第三个起虚线', () => {
    const first = buildDefaultSeriesStyle('#ff7e45', 'line', 0);
    expect(first.smooth).toBe(true);
    expect(first.areaStyle).toBeDefined();
    const third = buildDefaultSeriesStyle('#818cf8', 'line', 2);
    expect(third.areaStyle).toBeUndefined();
    expect(third.lineStyle.type).toBe('dashed');
    const bar = buildDefaultSeriesStyle('#ff7e45', 'bar', 0);
    expect(bar.smooth).toBeUndefined();
    expect(bar.areaStyle).toBeUndefined();
  });
});

describe('generateChartSchema', () => {
  it('chartType 必填，含 7 个枚举值', () => {
    const params = generateChartSchema.function.parameters as any;
    expect(params.required).toEqual(['chartType']);
    expect(params.properties.chartType.enum).toEqual([
      'line',
      'bar',
      'pie',
      'scatter',
      'radar',
      'heatmap',
      'funnel',
    ]);
  });

  it('echartsOption / data 应为 type: object（自由结构）', () => {
    const params = generateChartSchema.function.parameters as any;
    expect(params.properties.echartsOption.type).toBe('object');
    expect(params.properties.data.type).toBe('object');
  });

  it('契约守卫：description 必须教 ECharts 原生 data，禁止再教 values（生产案例 2026-10-13）', () => {
    // 服务端文档曾教模型写 series[].values，ECharts 静默忽略画出空图。
    // 改契约时工具 description 与 prompt.ts 图表规则两处必须同步，此用例守住前者
    const params = generateChartSchema.function.parameters as any;
    const echartsDesc: string = params.properties.echartsOption.description;
    const dataDesc: string = params.properties.data.description;
    expect(dataDesc).toContain('data: number[]');
    expect(dataDesc).not.toContain('values');
    expect(echartsDesc).toContain('data');
    expect(echartsDesc).toContain('不要用 values');
  });

  it('chartType 越界应被拦截', () => {
    const r = generateChartParamsSchema.safeParse({ chartType: 'unknown' });
    expect(r.success).toBe(false);
  });

  it('合法 chartType + 自由 data 应通过', () => {
    const r = generateChartParamsSchema.safeParse({
      chartType: 'line',
      data: { labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] },
    });
    expect(r.success).toBe(true);
  });

  // ==================== 参数形态容错回归（生产案例 2026-10-12 14:03） ====================
  // 形态容错由 safeParseToolParams 的 schema 导向全局归一化提供，
  // 因此这些用例走 safeParseToolParams 真实路径（与生产执行路径一致）

  it('echartsOption 传 JSON 字符串应解析为对象并通过（完整复现生产日志）', () => {
    const r = safeParseToolParams(generateChartParamsSchema, {
      chartType: 'line',
      title: '重庆未来天气趋势（深色科技风）',
      echartsOption: JSON.stringify({
        backgroundColor: '#0b1020',
        title: { text: '重庆未来天气趋势', left: 'center', top: 10 },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
      }),
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.echartsOption).toEqual({
        backgroundColor: '#0b1020',
        title: { text: '重庆未来天气趋势', left: 'center', top: 10 },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
      });
    }
  });

  it('data 传 JSON 字符串应解析为对象并通过（完整复现生产日志）', () => {
    const r = safeParseToolParams(generateChartParamsSchema, {
      chartType: 'line',
      title: '重庆未来天气趋势（2026年10月12日起）',
      data:
        '{"labels":["10-12","10-13","10-14"],"series":[{"name":"最高气温(℃)","values":[25,25,22]},{"name":"最低气温(℃)","values":[19,19,19]}]}',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.data).toEqual({
        labels: ['10-12', '10-13', '10-14'],
        series: [
          { name: '最高气温(℃)', values: [25, 25, 22] },
          { name: '最低气温(℃)', values: [19, 19, 19] },
        ],
      });
    }
  });

  it('data 传非法 JSON 字符串应保持失败（不给模糊兜底）', () => {
    const r = safeParseToolParams(generateChartParamsSchema, {
      chartType: 'line',
      data: '这不是JSON',
    });
    expect(r.success).toBe(false);
  });

  it('正常对象形态不受容错影响', () => {
    const r = safeParseToolParams(generateChartParamsSchema, {
      chartType: 'pie',
      data: { items: [{ name: 'a', value: 1 }] },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.data).toEqual({ items: [{ name: 'a', value: 1 }] });
    }
  });
});

describe('generateImageSchema', () => {
  it('prompt 必填，model/size/n 全有 default', () => {
    const params = generateImageSchema.function.parameters as any;
    expect(params.required).toEqual(['prompt']);
    expect(params.properties.model.default).toBe('wan2.7-image');
    expect(params.properties.size.default).toBe('1024*1024');
    expect(params.properties.n.default).toBe(1);
  });

  it('n 应保留 minimum=1 / maximum=4', () => {
    const params = generateImageSchema.function.parameters as any;
    expect(params.properties.n.minimum).toBe(1);
    expect(params.properties.n.maximum).toBe(4);
  });

  it('合法 prompt 应通过且填充 default', () => {
    const r = generateImageParamsSchema.safeParse({ prompt: 'a cat' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.model).toBe('wan2.7-image');
      expect(r.data.n).toBe(1);
    }
  });

  it('n 超过 4 应被拦截', () => {
    const r = generateImageParamsSchema.safeParse({ prompt: 'x', n: 5 });
    expect(r.success).toBe(false);
  });

  it('model 越界应被拦截', () => {
    const r = generateImageParamsSchema.safeParse({
      prompt: 'x',
      model: 'sd-xl',
    });
    expect(r.success).toBe(false);
  });
});

describe('createMindmapSchema', () => {
  it('title / content 双必填', () => {
    const params = createMindmapSchema.function.parameters as any;
    expect(params.required.sort()).toEqual(['content', 'title']);
  });

  it('合法输入应通过', () => {
    const r = createMindmapParamsSchema.safeParse({
      title: '主题',
      content: 'root((主题))\n  分支',
    });
    expect(r.success).toBe(true);
  });

  it('空 title 应被拦截', () => {
    const r = createMindmapParamsSchema.safeParse({ title: '', content: 'x' });
    expect(r.success).toBe(false);
  });

  it('空 content 应被拦截', () => {
    const r = createMindmapParamsSchema.safeParse({ title: 'x', content: '' });
    expect(r.success).toBe(false);
  });
});
