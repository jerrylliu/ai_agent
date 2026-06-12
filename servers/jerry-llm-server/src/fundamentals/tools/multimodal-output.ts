/**
 * 多模态输出工具
 *
 * - generate_chart: 根据 ECharts option JSON 生成图表
 * - generate_image: 调用万相文生图模型生成图片（wan2.7-image-pro / wan2.7-image）
 * - create_mindmap: 生成 Mermaid 思维导图
 *
 * 图表和思维导图由前端渲染，工具只返回渲染指令和配置数据。
 * 文生图通过 DashScope API 调用万相模型。
 */

import { logger } from '../logger';
import { config } from '../config';

// ==================== generate_chart ====================

export const generateChartSchema = {
  type: 'function' as const,
  function: {
    name: 'generate_chart',
    description: '根据数据生成图表。支持折线图、柱状图、饼图、散点图、雷达图等。返回 ECharts 配置 JSON，前端自动渲染。',
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

export async function executeGenerateChart(
  params: GenerateChartParams,
): Promise<GenerateChartResult> {
  const echartsOption = buildEChartsOption(params);

  logger.info('FC工具 [generate_chart] 生成图表配置', {
    module: 'Tool:MultiModal',
    chartType: params.chartType,
    title: params.title,
  });

  return {
    type: 'chart',
    chartType: params.chartType,
    echartsOption,
    message: `图表"${params.title || '未命名'}"配置已生成，前端将自动渲染。`,
  };
}

// ==================== generate_image ====================

/**
 * 将像素尺寸转换为 DashScope 的分辨率规格
 * wan2.7-image-pro 支持: 1K(1024×1024), 2K(2048×2048), 4K(4096×4096) 或 width*height
 * wan2.7-image 支持: 1K, 2K 或 width*height
 */
function convertToDashScopeSize(size: string, model: string): string {
  // 如果已经是 DashScope 规格格式（1K/2K/4K），直接返回
  if (/^[1234]K$/.test(size)) {
    return size;
  }

  // 解析 width*height 格式
  const match = size.match(/^(\d+)\*(\d+)$/);
  if (!match) {
    return '2K'; // 默认 2K
  }

  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  const totalPixels = width * height;

  // 根据总像素数选择最合适的分辨率规格
  if (totalPixels <= 1024 * 1024) {
    return '1K';
  } else if (totalPixels <= 2048 * 2048) {
    return '2K';
  } else if (model === 'wan2.7-image-pro' && totalPixels <= 4096 * 4096) {
    return '4K';
  }

  // 超出范围或模型不支持，降级到 2K
  return '2K';
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
          description: '图片尺寸，默认 1024*1024',
          enum: ['512*512', '768*768', '1024*1024', '1024*1536', '1536*1024'],
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

    // 将像素尺寸转换为 DashScope 的分辨率规格
    // wan2.7-image-pro 支持: 1K, 2K, 4K 或 width*height 格式
    // wan2.7-image 支持: 1K, 2K 或 width*height 格式
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
    description: '生成思维导图。返回 Mermaid 语法的思维导图定义，前端自动渲染。适用于整理知识结构、梳理逻辑关系等场景。',
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
  message: string;
}

export async function executeCreateMindmap(
  params: CreateMindmapParams,
): Promise<CreateMindmapResult> {
  let mermaidCode = params.content.trim();

  // 如果内容不以 mindmap 开头，自动包装
  if (!mermaidCode.startsWith('mindmap')) {
    mermaidCode = `mindmap\n  root((${params.title}))\n${mermaidCode.split('\n').map(line => '    ' + line).join('\n')}`;
  }

  logger.info('FC工具 [create_mindmap] 生成思维导图', {
    module: 'Tool:MultiModal',
    title: params.title,
    contentLength: params.content.length,
  });

  return {
    type: 'mindmap',
    title: params.title,
    mermaidCode,
    message: `思维导图"${params.title}"已生成，前端将自动渲染。`,
  };
}
