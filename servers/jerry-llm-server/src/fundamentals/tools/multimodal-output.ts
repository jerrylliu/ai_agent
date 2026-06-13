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

import { logger } from '../logger';
import { config } from '../config';
import { launchBrowser } from '../web-crawler';
import type { Browser } from 'puppeteer';

// ==================== generate_chart ====================

/**
 * 图表缓存：key → { option, expiresAt }
 * imageUrl 使用内部协议 fc://chart/{key}，send_notification 收到后通过 key 取回 option，
 * 用 puppeteer 本地渲染 PNG 嵌入邮件。
 */
const chartCache = new Map<string, { option: Record<string, any>; expiresAt: number }>();
const CHART_CACHE_TTL = 30 * 60 * 1000; // 30 分钟（覆盖用户从生成到发邮件的间隔）

/** 缓存 ECharts option 并返回短 key */
function cacheChartOption(option: Record<string, any>): string {
  const key = Math.random().toString(36).substring(2, 10);
  chartCache.set(key, { option, expiresAt: Date.now() + CHART_CACHE_TTL });
  // 清理过期条目
  for (const [k, v] of chartCache) {
    if (v.expiresAt < Date.now()) chartCache.delete(k);
  }
  return key;
}

/** 从缓存读取（不删除，允许多次访问） */
export function getCachedChartOption(key: string): Record<string, any> | null {
  const entry = chartCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    chartCache.delete(key);
    return null;
  }
  return entry.option;
}

export const generateChartSchema = {
  type: 'function' as const,
  function: {
    name: 'generate_chart',
    description: '根据数据生成图表。支持折线图、柱状图、饼图、散点图、雷达图等。返回 ECharts 配置 JSON（前端渲染交互式图表）和 imageUrl 字段（图表静态 PNG 引用，可传给 send_notification.attachments 发邮件）。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '图表标题',
        },
        chartType: {
          type: 'string',
          description: '图表类型',
          enum: ['line', 'bar', 'pie', 'scatter', 'radar', 'heatmap', 'funnel'],
        },
        echartsOption: {
          type: 'object',
          description: 'ECharts 完整配置 JSON（如果提供此参数，将忽略 title 和 chartType）',
        },
        data: {
          type: 'object',
          description: '图表数据，格式取决于图表类型。line/bar: { labels: string[], series: Array<{name: string, values: number[]}> }；pie: { items: Array<{name: string, value: number}> }',
        },
      },
      required: ['chartType'],
    },
  },
};

export interface GenerateChartParams {
  title?: string;
  chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'radar' | 'heatmap' | 'funnel';
  echartsOption?: Record<string, any>;
  data?: Record<string, any>;
}

export interface GenerateChartResult {
  type: 'chart';
  chartType: string;
  echartsOption: Record<string, any>;
  /** 图表静态 PNG 图片引用（内部协议 fc://chart/{key}），可直接传给 send_notification.attachments 发邮件 */
  imageUrl: string;
  message: string;
}

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
  const data = params.data;

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
export function chartImageUrl(echartsOption: Record<string, any>): string {
  const key = cacheChartOption(echartsOption);
  return `${CHART_URL_PREFIX}${key}`;
}

/** 判断 URL 是否为图表内部协议 */
export function isChartImageUrl(url: string): boolean {
  return url.startsWith(CHART_URL_PREFIX);
}

/** 从内部图表 URL 取回 ECharts option */
export function parseChartImageUrl(url: string): Record<string, any> | null {
  if (!isChartImageUrl(url)) return null;
  const key = url.slice(CHART_URL_PREFIX.length);
  return getCachedChartOption(key);
}

/** 复用的浏览器实例 —— 首次启动后保留，避免每次渲染都重新启动 */
let cachedBrowser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
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
  params: GenerateChartParams,
): Promise<GenerateChartResult> {
  const echartsOption = buildEChartsOption(params);
  // 内部协议 URL：send_notification 收到后用 puppeteer 渲染 PNG 嵌入邮件
  const imageUrl = chartImageUrl(echartsOption);

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

export const generateImageSchema = {
  type: 'function' as const,
  function: {
    name: 'generate_image',
    description: '根据文本描述生成图片。使用万相文生图模型，支持 wan2.7-image-pro（高质量）和 wan2.7-image（快速）两种模型。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '图片描述（中文或英文），越详细效果越好',
        },
        model: {
          type: 'string',
          description: '文生图模型选择：wan2.7-image-pro（高质量，细节丰富）或 wan2.7-image（快速生成）',
          enum: ['wan2.7-image-pro', 'wan2.7-image'],
          default: 'wan2.7-image',
        },
        size: {
          type: 'string',
          description: '图片尺寸，如 1024*1024、1920*1080 等，服务端会自动匹配最佳分辨率（1K/2K/4K）',
          default: '1024*1024',
        },
        n: {
          type: 'number',
          description: '生成图片数量，默认1，最多4',
          default: 1,
          minimum: 1,
          maximum: 4,
        },
      },
      required: ['prompt'],
    },
  },
};

export interface GenerateImageParams {
  prompt: string;
  model?: 'wan2.7-image-pro' | 'wan2.7-image';
  size?: string;
  n?: number;
}

export interface GenerateImageResult {
  type: 'image';
  images: Array<{
    url: string;
    revisedPrompt?: string;
  }>;
  model: string;
  message: string;
}

export async function executeGenerateImage(
  params: GenerateImageParams,
): Promise<GenerateImageResult> {
  const model = params.model || 'wan2.7-image';
  const size = params.size || '1024*1024';
  const n = Math.min(Math.max(params.n || 1, 1), 4);

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

    const responseData = await response.json();

    // 解析返回的图片 URL
    // DashScope 原生格式：output.choices[].message.content[].image
    const images: Array<{ url: string; revisedPrompt?: string }> = [];

    const choices = responseData.output?.choices || [];
    for (const choice of choices) {
      const contents = choice.message?.content || [];
      for (const item of contents) {
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
      for (const item of items) {
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

export const createMindmapSchema = {
  type: 'function' as const,
  function: {
    name: 'create_mindmap',
    description: '生成思维导图。返回 Mermaid 语法的思维导图定义（前端渲染交互式图表）和 imageUrl 字段（思维导图静态 PNG 引用，可传给 send_notification.attachments 发邮件）。适用于整理知识结构、梳理逻辑关系等场景。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '思维导图的中心主题',
        },
        content: {
          type: 'string',
          description: '思维导图内容，使用 Mermaid mindmap 语法。格式示例：\nroot((中心主题))\n  分支1\n    子分支1-1\n    子分支1-2\n  分支2\n    子分支2-1',
        },
      },
      required: ['title', 'content'],
    },
  },
};

export interface CreateMindmapParams {
  title: string;
  content: string;
}

export interface CreateMindmapResult {
  type: 'mindmap';
  title: string;
  mermaidCode: string;
  /** 思维导图静态 PNG 图片引用（内部协议 fc://mindmap/{key}），可直接传给 send_notification.attachments 发邮件 */
  imageUrl: string;
  message: string;
}

/** 将 Mermaid 代码转为内部协议 imageUrl，send_notification 收到后用 puppeteer 渲染 PNG */
const MINDMAP_URL_PREFIX = 'fc://mindmap/';
const mindmapCache = new Map<string, { code: string; expiresAt: number }>();
const MINDMAP_CACHE_TTL = 30 * 60 * 1000;

function cacheMindmapCode(code: string): string {
  const key = Math.random().toString(36).substring(2, 10);
  mindmapCache.set(key, { code, expiresAt: Date.now() + MINDMAP_CACHE_TTL });
  for (const [k, v] of mindmapCache) {
    if (v.expiresAt < Date.now()) mindmapCache.delete(k);
  }
  return key;
}

export function getCachedMindmapCode(key: string): string | null {
  const entry = mindmapCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    mindmapCache.delete(key);
    return null;
  }
  return entry.code;
}

export function mindmapImageUrl(mermaidCode: string): string {
  const key = cacheMindmapCode(mermaidCode);
  return `${MINDMAP_URL_PREFIX}${key}`;
}

export function isMindmapImageUrl(url: string): boolean {
  return url.startsWith(MINDMAP_URL_PREFIX);
}

export function parseMindmapImageUrl(url: string): string | null {
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
export function mindmapToImageUrl(mermaidCode: string): string {
  return mindmapImageUrl(mermaidCode);
}

export async function executeCreateMindmap(
  params: CreateMindmapParams,
): Promise<CreateMindmapResult> {
  let mermaidCode = params.content.trim();

  // 如果内容不以 mindmap 开头，自动包装
  if (!mermaidCode.startsWith('mindmap')) {
    mermaidCode = `mindmap\n  root((${params.title}))\n${mermaidCode.split('\n').map(line => '    ' + line).join('\n')}`;
  }

  const imageUrl = mindmapToImageUrl(mermaidCode);

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
