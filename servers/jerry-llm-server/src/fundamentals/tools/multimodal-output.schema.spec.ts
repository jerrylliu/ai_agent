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
} from './multimodal-output';
import { safeParseToolParams } from './_helpers';

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
