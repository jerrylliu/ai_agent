/**
 * fundamentals/tools/multimodal-output.schema.spec.ts
 *
 * generate_chart / generate_image / create_mindmap 三个 Tool 的 zod schema 测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
} from './multimodal-output';

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
    const r = generateImageParamsSchema.safeParse({ prompt: 'x', model: 'sd-xl' });
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
