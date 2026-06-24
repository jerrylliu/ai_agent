/**
 * 多模态输出工具
 *
 * - generate_chart: 根据 ECharts option JSON 生成图表，前端渲染交互式图表，邮件附件由 puppeteer 本地渲染 PNG
 * - generate_image: 调用万相文生图模型生成图片（wan2.7-image-pro / wan2.7-image）
 * - create_mindmap: 生成 Mermaid 思维导图，前端渲染交互式图表，邮件附件由 puppeteer 本地渲染 PNG
 *
 * 图表/思维导图均由前端 echarts.js / mermaid.js 渲染（交互式）。
 * 工具还返回 imageUrl 字段（内部协议 fc://chart/{key} 或 fc://mindmap/{key}），
 * send_notification.attachments 收到后用 puppeteer 本地渲染 PNG 内嵌邮件。
 * 文生图通过 DashScope API 调用万相模型。
 */

import { z } from 'zod';
import { logger } from '../logger';
import { config } from '../config';
import { launchBrowser } from '../web-crawler';
import type { Browser } from 'puppeteer';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';
import { parseToolResultJson } from '../llm-json-parser';
import { MultiLevelCache } from '../multi-level-cache';
import { metrics } from '../metrics';

// ==================== 图表/思维导图 缓存（L1 内存 + L2 Redis）====================
//
// 为什么换成 MultiLevelCache：
//   chart/mindmap 用内部协议 fc://chart/{key} 把"option JSON"短地址化，发邮件/飞书时
//   再用 key 反查原始 option。最初只放在进程内存 Map 里：
//   - 开发期 start:dev 频繁重启 → key 全丢，跨重启发送必报"缓存已过期"
//   - 默认 30 分钟过期 → 用户隔天回来发也报错
//   - 多实例水平扩容时，A 实例生成的 key 在 B 实例查不到
//
// 改造方案：复用项目自有的 MultiLevelCache（L1 LRU 内存 + L2 Redis）
//   - L1 内存：< 0.1ms 命中，同一进程内"刚生成→立即发飞书"零网络开销
//   - L2 Redis：跨进程/跨实例/跨重启共享，重启后从 Redis 自动恢复
//   - Redis 不可用：自动降级回 L1 单机模式（业务无感知）
//   - TTL 抖动 ±10%：防止大量 key 同一秒过期引发雪崩

// ==================== 文生图 API 响应 schema ====================
//
// 兼容两套格式：
//   - DashScope 原生：output.choices[].message.content[].image
//   - OpenAI 兼容：data[].url / data[].b64_json
// 用 looseObject + 全 optional：边界容错性最大化，业务层负责真实解析
const ImageGenerationResponseSchema = z.looseObject({
  output: z
    .looseObject({
      choices: z
        .array(
          z.looseObject({
            message: z
              .looseObject({
                content: z.array(z.looseObject({})).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  data: z.union([z.array(z.looseObject({})), z.looseObject({})]).optional(),
});

// ==================== generate_chart ====================

/**
 * 图表缓存：key → ECharts option（多级缓存：L1 LRU + L2 Redis）
 *
 * - namespace 'chart-option' → Redis key 形如 jerry:chart-option:{key}
 * - ttlSec 1800 = 30 分钟，与历史行为一致
 * - l1MaxSize 500 = 内存最多 500 张图表的 option，超过 LRU 淘汰
 */
const chartCache = new MultiLevelCache<Record<string, any>>({
  namespace: 'chart-option',
  ttlSec: 30 * 60,
  l1MaxSize: 500,
  ttlJitterRatio: 0.1,
});
// 注册到 Prometheus，scrape 时自动读取命中率
metrics.registerCacheInstance('chart-option', chartCache);

/** 缓存 ECharts option 并返回短 key（写入异步：L1 同步落地、L2 异步写 Redis 不阻塞） */
async function cacheChartOption(option: Record<string, any>): Promise<string> {
  const key = Math.random().toString(36).substring(2, 10);
  await chartCache.set(key, option);
  return key;
}

/** 从缓存读取 ECharts option（L1 → L2 → null） */
export async function getCachedChartOption(key: string): Promise<Record<string, any> | null> {
  return chartCache.get(key);
}

// ==================== Zod Schema: generate_chart ====================

export const generateChartParamsSchema = z.object({
  title: z.string().optional().describe('图表标题'),
  chartType: z
    .enum(['line', 'bar', 'pie', 'scatter', 'radar', 'heatmap', 'funnel'])
    .describe('图表类型'),
  // 自由结构对象：ECharts option 字段过多，无法用 z.object 精确建模，passthrough 以保留所有字段
  echartsOption: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('ECharts 完整配置 JSON（如果提供此参数，将忽略 title 和 chartType）'),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      '图表数据，格式取决于图表类型。line/bar: { labels: string[], series: Array<{name: string, values: number[]}> }；pie: { items: Array<{name: string, value: number}> }',
    ),
});

export type GenerateChartParams = z.infer<typeof generateChartParamsSchema>;

export const generateChartSchema = buildToolJsonSchema(
  'generate_chart',
  '根据数据生成图表。支持折线图、柱状图、饼图、散点图、雷达图等。返回 ECharts 配置 JSON（前端渲染交互式图表）和 imageUrl 字段（图表静态 PNG 引用，可传给 send_notification.attachments 发邮件）。',
  generateChartParamsSchema,
);

// ==================== Result Schema: generate_chart ====================

export const generateChartResultSchema = z.looseObject({
  type: z.literal('chart'),
  chartType: z.string(),
  echartsOption: z.record(z.string(), z.unknown()),
  /** 图表静态 PNG 图片引用，可直接传给 send_notification.attachments 发邮件 */
  imageUrl: z.string(),
  message: z.string(),
});

export type GenerateChartResult = z.infer<typeof generateChartResultSchema>;

/**
 * 根据简化的数据和图表类型构建 ECharts option
 */
function buildEChartsOption(params: GenerateChartParams): Record<string, any> {
  // 如果直接提供了完整的 ECharts option，直接返回
  if (params.echartsOption) {
    return params.echartsOption;
  }

  const title = params.title || '';
  const chartType = params.chartType;
  // data 字段在 zod schema 中为自由结构（z.record(z.string(), z.unknown())），
  // 业务侧按图表类型读取 data.labels / data.series / data.items 等具体字段，
  // 这里统一断言为 any，保留历史逻辑形态
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = params.data as any;

  // 基础配置
  const option: Record<string, any> = {
    title: { text: title, left: 'center' },
    tooltip: { trigger: chartType === 'pie' ? 'item' : 'axis' },
    toolbox: {
      feature: { saveAsImage: {} },
      right: 10,
    },
  };

  if (!data) {
    option.xAxis = { type: 'category', data: [] };
    option.yAxis = { type: 'value' };
    option.series = [];
    return option;
  }

  // 根据图表类型构建配置
  switch (chartType) {
    case 'line':
    case 'bar': {
      const labels = data.labels || [];
      const series = data.series || [];
      option.xAxis = { type: 'category', data: labels };
      option.yAxis = { type: 'value' };
      option.legend = { top: 30 };
      option.series = series.map((s: any) => ({
        name: s.name,
        type: chartType,
        data: s.values,
      }));
      break;
    }
    case 'pie': {
      const items = data.items || [];
      option.series = [{
        type: 'pie',
        radius: '50%',
        data: items.map((item: any) => ({
          name: item.name,
          value: item.value,
        })),
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
          },
        },
      }];
      break;
    }
    case 'scatter': {
      const scatterData = data.values || [];
      option.xAxis = { type: 'value' };
      option.yAxis = { type: 'value' };
      option.series = [{
        type: 'scatter',
        data: scatterData,
      }];
      break;
    }
    case 'radar': {
      const indicators = data.indicators || [];
      const radarValues = data.values || [];
      option.radar = { indicator: indicators };
      option.series = [{
        type: 'radar',
        data: radarValues,
      }];
      break;
    }
    default: {
      option.xAxis = { type: 'category', data: data.labels || [] };
      option.yAxis = { type: 'value' };
      option.series = [{ type: chartType, data: data.values || [] }];
    }
  }

  return option;
}

/** 内部协议：图表 imageUrl，send_notification 收到后从缓存取出 ECharts option，puppeteer 渲染 PNG */
const CHART_URL_PREFIX = 'fc://chart/';

/** 生成图表的内部 imageUrl（短地址，供 send_notification 用） */
export async function chartImageUrl(echartsOption: Record<string, any>): Promise<string> {
  const key = await cacheChartOption(echartsOption);
  return `${CHART_URL_PREFIX}${key}`;
}

/** 判断 URL 是否为图表内部协议 */
export function isChartImageUrl(url: string): boolean {
  return url.startsWith(CHART_URL_PREFIX);
}

/** 从内部图表 URL 取回 ECharts option */
export async function parseChartImageUrl(url: string): Promise<Record<string, any> | null> {
  if (!isChartImageUrl(url)) return null;
  const key = url.slice(CHART_URL_PREFIX.length);
  return getCachedChartOption(key);
}

/** 复用的浏览器实例 —— 首次启动后保留，避免每次渲染都重新启动 */
let cachedBrowser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (cachedBrowser) return cachedBrowser;

  // 并发场景下避免重复 launch
  if (browserPromise) return browserPromise;

  browserPromise = launchBrowser().then((b) => {
    cachedBrowser = b;
    b.on('disconnected', () => {
      cachedBrowser = null;
      browserPromise = null;
    });
    return b;
  }).catch((err) => {
    browserPromise = null;
    throw err;
  });

  return browserPromise;
}

// 进程退出时关闭浏览器
const closeBrowserOnExit = async () => {
  if (cachedBrowser) {
    try { await cachedBrowser.close(); } catch { /* ignore */ }
    cachedBrowser = null;
  }
};
process.once('SIGTERM', closeBrowserOnExit);
process.once('SIGINT', closeBrowserOnExit);

/**
 * 用 puppeteer + ECharts 在本地渲染图表为 PNG，返回 base64 data URI
 * 加载 ECharts CDN（首次较慢，后续从浏览器缓存命中，极快）
 * 内置 2 次重试：首次可能因 CDN 超时失败，重试利用缓存直接成功
 */
export async function chartPngDataUri(
  echartsOption: Record<string, any>,
  width = 800,
  height = 400,
): Promise<string | null> {
  let lastError: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await chartPngDataUriOnce(echartsOption, width, height, attempt);
    if (result !== null) return result;
    lastError = new Error('chartPngDataUri attempt failed');
  }
  logger.warn('图表 PNG 渲染：2 次尝试均失败', { module: 'Tool:MultiModal', error: String(lastError) });
  return null;
}

/** chartPngDataUri 的单次尝试实现 */
async function chartPngDataUriOnce(
  echartsOption: Record<string, any>,
  width: number,
  height: number,
  attempt: number,
): Promise<string | null> {
  let page: import('puppeteer').Page | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <style>
    html, body { margin: 0; padding: 0; background: #fff; }
    #chart { width: ${width}px; height: ${height}px; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <script>
    window.__renderDone = false;
    window.__renderError = null;
    try {
      const option = ${JSON.stringify(echartsOption).replace(/<\//g, '<\\/')};
      const chart = echarts.init(document.getElementById('chart'), null, { renderer: 'canvas' });
      chart.setOption(option);
      chart.on('finished', () => { window.__renderDone = true; });
      // 兜底：若未触发 finished，给 800ms 让动画完成
      setTimeout(() => { window.__renderDone = true; }, 800);
    } catch (e) {
      window.__renderError = String(e && e.message || e);
      window.__renderDone = true;
    }
  </script>
</body>
</html>`;

    // domcontentloaded：HTML 解析完成即可；CDN 加载较慢（尤其国内访问 jsdelivr），
    // 由 waitForFunction 兜底等待 ECharts 渲染完成（含 CDN 加载 + setOption + finished）
    // 超时 30s：覆盖 CDN 首次加载（国内网络下 jsdelivr 可能需 10-20s）+ 渲染时间
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 等待 ECharts 渲染完成（包含 CDN 加载 + setOption + finished 事件）
    await page.waitForFunction('window.__renderDone === true', { timeout: 25000 });

    const renderError = await page.evaluate('window.__renderError').catch(() => null);
    if (renderError) {
      logger.warn('图表 PNG 渲染：浏览器内 ECharts 报错', {
        module: 'Tool:MultiModal',
        error: String(renderError),
      });
      return null;
    }

    const screenshot = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
      omitBackground: false,
      encoding: 'binary',
    });

    // puppeteer screenshot 返回 Uint8Array，Buffer.from 直接处理
    const base64 = Buffer.from(screenshot as Uint8Array).toString('base64');
    return `data:image/png;base64,${base64}`;
  } catch (e: any) {
    if (attempt === 0) {
      logger.info('图表 PNG 渲染：首次尝试失败（可能 CDN 未缓存），将重试', { module: 'Tool:MultiModal', error: e.message });
    } else {
      logger.warn('图表 PNG 渲染失败（puppeteer，2 次均失败）', { module: 'Tool:MultiModal', error: e.message });
    }
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

export async function executeGenerateChart(
  rawParams: unknown,
): Promise<GenerateChartResult> {
  const parsed = safeParseToolParams(generateChartParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [generate_chart] 参数校验失败', {
      module: 'Tool:MultiModal',
      error: parsed.error,
    });
    return {
      type: 'chart',
      chartType: (rawParams as { chartType?: string })?.chartType || 'line',
      echartsOption: {},
      imageUrl: '',
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data as GenerateChartParams;

  const echartsOption = buildEChartsOption(params);
  // 内部协议 URL：send_notification 收到后用 puppeteer 渲染 PNG 嵌入邮件
  const imageUrl = await chartImageUrl(echartsOption);

  logger.info('FC工具 [generate_chart] 生成图表配置', {
    module: 'Tool:MultiModal',
    chartType: params.chartType,
    title: params.title,
    imageUrl,
  });

  return {
    type: 'chart',
    chartType: params.chartType,
    echartsOption,
    imageUrl,
    message: `图表"${params.title || '未命名'}"配置已生成，前端将自动渲染。`,
  };
}

// ==================== generate_image ====================

/**
 * DashScope wan2.7 系列原生支持 width*height 格式和 1K/2K/4K 格式
 * 直接透传用户输入的尺寸，不做降级转换，保留宽高比
 */
function convertToDashScopeSize(size: string, _model: string): string {
  // 1K/2K/4K 或 width*height 格式，直接透传
  if (/^[1234]K$/.test(size)) return size;
  if (/^\d+\*\d+$/.test(size)) return size;
  return '2K'; // 默认
}

// ==================== Zod Schema: generate_image ====================

export const generateImageParamsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('图片描述（中文或英文），越详细效果越好'),
  model: z
    .enum(['wan2.7-image-pro', 'wan2.7-image'])
    .default('wan2.7-image')
    .describe(
      '文生图模型选择：wan2.7-image-pro（高质量，细节丰富）或 wan2.7-image（快速生成）',
    ),
  size: z
    .string()
    .default('1024*1024')
    .describe(
      '图片尺寸，如 1024*1024、1920*1080 等，服务端会自动匹配最佳分辨率（1K/2K/4K）',
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe('生成图片数量，默认1，最多4'),
});

export type GenerateImageParams = z.infer<typeof generateImageParamsSchema>;

export const generateImageSchema = buildToolJsonSchema(
  'generate_image',
  '根据文本描述生成图片。使用万相文生图模型，支持 wan2.7-image-pro（高质量）和 wan2.7-image（快速）两种模型。',
  generateImageParamsSchema,
);

// ==================== Result Schema: generate_image ====================

export const generateImageResultSchema = z.looseObject({
  type: z.literal('image'),
  images: z.array(
    z.looseObject({
      url: z.string(),
      revisedPrompt: z.string().optional(),
    }),
  ),
  model: z.string(),
  message: z.string(),
});

export type GenerateImageResult = z.infer<typeof generateImageResultSchema>;

export async function executeGenerateImage(
  rawParams: unknown,
): Promise<GenerateImageResult> {
  const parsed = safeParseToolParams(generateImageParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [generate_image] 参数校验失败', {
      module: 'Tool:MultiModal',
      error: parsed.error,
    });
    return {
      type: 'image',
      images: [],
      model: 'wan2.7-image',
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  const model = params.model;
  const size = params.size;
  const n = params.n;

  const apiKey = config.dashscopeApiKey;
  if (!apiKey) {
    return {
      type: 'image',
      images: [],
      model,
      message: '文生图功能未配置：DASHSCOPE_API_KEY 未设置。请在 .env 文件中配置 DASHSCOPE_API_KEY。',
    };
  }

  logger.info('FC工具 [generate_image] 开始生成图片', {
    module: 'Tool:MultiModal',
    prompt: params.prompt.substring(0, 100),
    model,
    size,
    n,
  });

  try {
    // 调用 DashScope 原生文生图 API（wan2.7 系列模型使用 multimodal-generation 端点）
    const baseUrl = config.dashscopeBaseUrl || 'https://dashscope.aliyuncs.com';
    const apiUrl = `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;

    // DashScope wan2.7 系列原生支持 width*height 和 1K/2K/4K 格式，透传用户尺寸
    const dashscopeSize = convertToDashScopeSize(size, model);

    const requestBody: Record<string, any> = {
      model,
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { text: params.prompt },
            ],
          },
        ],
      },
      parameters: {
        n,
        size: dashscopeSize,
      },
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.error('FC工具 [generate_image] API 返回错误', {
        module: 'Tool:MultiModal',
        statusCode: response.status,
        errorBody: errorText.substring(0, 500),
      });
      return {
        type: 'image',
        images: [],
        model,
        message: `文生图 API 返回错误 (HTTP ${response.status}): ${response.statusText}`,
      };
    }

    const responseText = await response.text();
    const parsed = parseToolResultJson(responseText, ImageGenerationResponseSchema, {
      module: 'Tool:MultiModal',
      api: 'image-generation',
      model,
    });
    if (!parsed.success) {
      logger.error('FC工具 [generate_image] 响应结构异常', {
        module: 'Tool:MultiModal',
        reason: parsed.reason,
      });
      return {
        type: 'image',
        images: [],
        model,
        message: `文生图 API 响应结构异常: ${parsed.reason}`,
      };
    }
    const responseData = parsed.data;

    // 解析返回的图片 URL
    // DashScope 原生格式：output.choices[].message.content[].image
    const images: Array<{ url: string; revisedPrompt?: string }> = [];

    const choices = responseData.output?.choices || [];
    for (const choice of choices) {
      const contents = (choice.message as any)?.content || [];
      for (const item of contents as any[]) {
        if (item.image) {
          images.push({ url: item.image });
        } else if (item.type === 'image' && (item.image || item.url)) {
          images.push({ url: item.image || item.url });
        }
      }
    }

    // 兼容 OpenAI 格式的响应：data 数组
    if (images.length === 0) {
      const dataList = responseData.data || [];
      const items = Array.isArray(dataList) ? dataList : [dataList];
      for (const item of items as any[]) {
        if (item.url) {
          images.push({
            url: item.url,
            revisedPrompt: item.revised_prompt,
          });
        } else if (item.b64_json) {
          images.push({
            url: `data:image/png;base64,${item.b64_json}`,
            revisedPrompt: item.revised_prompt,
          });
        }
      }
    }

    logger.info('FC工具 [generate_image] 图片生成完成', {
      module: 'Tool:MultiModal',
      imageCount: images.length,
      model,
    });

    return {
      type: 'image',
      images,
      model,
      message: images.length > 0
        ? `已使用 ${model} 生成 ${images.length} 张图片`
        : '图片生成完成但未返回有效图片URL',
    };
  } catch (error: any) {
    logger.error('FC工具 [generate_image] 生成图片异常', {
      module: 'Tool:MultiModal',
      error: error.message,
    });
    return {
      type: 'image',
      images: [],
      model,
      message: `图片生成失败: ${error.message}`,
    };
  }
}

// ==================== create_mindmap ====================

// ==================== Zod Schema: create_mindmap ====================

export const createMindmapParamsSchema = z.object({
  title: z.string().min(1).describe('思维导图的中心主题'),
  content: z
    .string()
    .min(1)
    .describe(
      '思维导图内容，使用 Mermaid mindmap 语法。格式示例：\nroot((中心主题))\n  分支1\n    子分支1-1\n    子分支1-2\n  分支2\n    子分支2-1',
    ),
});

export type CreateMindmapParams = z.infer<typeof createMindmapParamsSchema>;

export const createMindmapSchema = buildToolJsonSchema(
  'create_mindmap',
  '生成思维导图。返回 Mermaid 语法的思维导图定义（前端渲染交互式图表）和 imageUrl 字段（思维导图静态 PNG 引用，可传给 send_notification.attachments 发邮件）。适用于整理知识结构、梳理逻辑关系等场景。',
  createMindmapParamsSchema,
);

// ==================== Result Schema: create_mindmap ====================

export const createMindmapResultSchema = z.looseObject({
  type: z.literal('mindmap'),
  title: z.string(),
  mermaidCode: z.string(),
  /** 思维导图静态 PNG 图片引用，可直接传给 send_notification.attachments 发邮件 */
  imageUrl: z.string(),
  message: z.string(),
});

export type CreateMindmapResult = z.infer<typeof createMindmapResultSchema>;

/** 将 Mermaid 代码转为内部协议 imageUrl，send_notification 收到后用 puppeteer 渲染 PNG */
const MINDMAP_URL_PREFIX = 'fc://mindmap/';

/**
 * 思维导图缓存：key → Mermaid 源码（与图表缓存同款 L1 + L2 设计）
 */
const mindmapCache = new MultiLevelCache<string>({
  namespace: 'mindmap-code',
  ttlSec: 30 * 60,
  l1MaxSize: 500,
  ttlJitterRatio: 0.1,
});
metrics.registerCacheInstance('mindmap-code', mindmapCache);

async function cacheMindmapCode(code: string): Promise<string> {
  const key = Math.random().toString(36).substring(2, 10);
  await mindmapCache.set(key, code);
  return key;
}

export async function getCachedMindmapCode(key: string): Promise<string | null> {
  return mindmapCache.get(key);
}

export async function mindmapImageUrl(mermaidCode: string): Promise<string> {
  const key = await cacheMindmapCode(mermaidCode);
  return `${MINDMAP_URL_PREFIX}${key}`;
}

export function isMindmapImageUrl(url: string): boolean {
  return url.startsWith(MINDMAP_URL_PREFIX);
}

export async function parseMindmapImageUrl(url: string): Promise<string | null> {
  if (!isMindmapImageUrl(url)) return null;
  const key = url.slice(MINDMAP_URL_PREFIX.length);
  return getCachedMindmapCode(key);
}

/**
 * 用 puppeteer + Mermaid 在本地渲染思维导图为 PNG，返回 base64 data URI
 */
/**
 * 用 puppeteer + Mermaid 在本地渲染思维导图为 PNG，返回 base64 data URI
 * 内置 2 次重试：首次可能因 CDN 超时失败，重试利用浏览器缓存直接成功
 */
export async function mindmapPngDataUri(
  mermaidCode: string,
  width = 1200,
  height = 800,
): Promise<string | null> {
  let lastError: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await mindmapPngDataUriOnce(mermaidCode, width, height, attempt);
    if (result !== null) return result;
    lastError = new Error('mindmapPngDataUri attempt failed');
  }
  logger.warn('思维导图 PNG 渲染：2 次尝试均失败', { module: 'Tool:MultiModal', error: String(lastError) });
  return null;
}

/** mindmapPngDataUri 的单次尝试实现 */
async function mindmapPngDataUriOnce(
  mermaidCode: string,
  width: number,
  height: number,
  attempt: number,
): Promise<string | null> {
  let page: import('puppeteer').Page | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });

    // mermaid 代码用 JSON.stringify 安全注入（转义 </ 防 HTML 解析器提前关闭 script 标签）
    const codeLiteral = JSON.stringify(mermaidCode).replace(/<\//g, '<\\/');
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    html, body { margin: 0; padding: 0; background: #fff; }
    #chart { width: ${width}px; min-height: ${height}px; padding: 20px; box-sizing: border-box; }
    #chart svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <script>
    window.__renderDone = false;
    window.__renderError = null;
    (async () => {
      try {
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
        const { svg } = await mermaid.render('mindmap-svg', ${codeLiteral});
        document.getElementById('chart').innerHTML = svg;
        window.__renderDone = true;
      } catch (e) {
        window.__renderError = String(e && e.message || e);
        window.__renderDone = true;
      }
    })();
  </script>
</body>
</html>`;

    // setContent 超时 30s + waitForFunction 超时 25s，覆盖 CDN 首次加载 + mermaid 渲染
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction('window.__renderDone === true', { timeout: 25000 });

    const renderError = await page.evaluate('window.__renderError').catch(() => null);
    if (renderError) {
      logger.warn('思维导图 PNG 渲染：浏览器内 Mermaid 报错', {
        module: 'Tool:MultiModal',
        error: String(renderError),
      });
      return null;
    }

    // 截图整个 #chart 元素，自适应高度
    const element = await page.$('#chart');
    if (!element) return null;
    const screenshot = await element.screenshot({
      type: 'png',
      omitBackground: false,
      encoding: 'binary',
    });

    const base64 = Buffer.from(screenshot as Uint8Array).toString('base64');
    return `data:image/png;base64,${base64}`;
  } catch (e: any) {
    if (attempt === 0) {
      logger.info('思维导图 PNG 渲染：首次尝试失败（可能 CDN 未缓存），将重试', { module: 'Tool:MultiModal', error: e.message });
    } else {
      logger.warn('思维导图 PNG 渲染失败（puppeteer，2 次均失败）', { module: 'Tool:MultiModal', error: e.message });
    }
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

/** @deprecated 保留旧 API，内部已切换到 mindmapImageUrl + puppeteer 渲染 */
export async function mindmapToImageUrl(mermaidCode: string): Promise<string> {
  return mindmapImageUrl(mermaidCode);
}

export async function executeCreateMindmap(
  rawParams: unknown,
): Promise<CreateMindmapResult> {
  const parsed = safeParseToolParams(createMindmapParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('FC工具 [create_mindmap] 参数校验失败', {
      module: 'Tool:MultiModal',
      error: parsed.error,
    });
    return {
      type: 'mindmap',
      title: (rawParams as { title?: string })?.title || '',
      mermaidCode: '',
      imageUrl: '',
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  let mermaidCode = params.content.trim();

  // 如果内容不以 mindmap 开头，自动包装
  if (!mermaidCode.startsWith('mindmap')) {
    mermaidCode = `mindmap\n  root((${params.title}))\n${mermaidCode.split('\n').map(line => '    ' + line).join('\n')}`;
  }

  const imageUrl = await mindmapToImageUrl(mermaidCode);

  logger.info('FC工具 [create_mindmap] 生成思维导图', {
    module: 'Tool:MultiModal',
    title: params.title,
    contentLength: params.content.length,
    imageUrl: imageUrl.substring(0, 100),
  });

  return {
    type: 'mindmap',
    title: params.title,
    mermaidCode,
    imageUrl,
    message: `思维导图"${params.title}"已生成，前端将自动渲染。`,
  };
}
