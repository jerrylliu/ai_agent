/**
 * 服务端图表默认主题：深色科技风
 *
 * 生产背景（2026-10-13）：图表渲染链路修复后，模型自写 echartsOption 的审美
 * 第一次完整落地（深色背景 + 双轴 + 渐变面积），用户确认"就要这个样子"。
 * 但依赖模型每次自觉写样式不可靠——模型没写样式时，简化路径拼出的是 ECharts
 * 默认浅色模板，观感割裂。本模块把该风格固化为服务端默认主题：
 *   - echartsOption 路径：仅补缺失字段（backgroundColor 等），模型显式写的样式一律不碰
 *   - 简化 data 路径：全套套用
 *
 * 配色以重庆天气图（用户确认满意）为基准：
 *   背景 #0b1020 深蓝黑 / 主色 #ff7e45 橙（高温）/ #2dd4bf 青（低温）/
 *   #818cf8 靛（湿度）/ 文字 #e6f1ff / 次级文字 #7a8ba8 / 网格线 rgba(122,139,168,0.15)
 */

/** 系列配色板（按 series 顺序循环取色） */
export const CHART_THEME_COLORS = [
  '#ff7e45', // 橙
  '#2dd4bf', // 青
  '#818cf8', // 靛
  '#fbbf24', // 金
  '#f472b6', // 粉
  '#38bdf8', // 天蓝
];

interface ChartThemeInput {
  title?: string;
  chartType: string;
}

/**
 * 生成深色科技风基础 option（title/tooltip/toolbox/legend/grid/color）。
 * 只含"框架层"样式；series 专属样式（渐变面积等）由 applyThemeToSeries 处理
 */
export function buildThemeBaseOption(input: ChartThemeInput): Record<string, any> {
  const { title, chartType } = input;
  const option: Record<string, any> = {
    backgroundColor: '#0b1020',
    color: CHART_THEME_COLORS,
    textStyle: { color: '#e6f1ff' },
    title: {
      text: title || '',
      left: 'center',
      top: 10,
      textStyle: { color: '#e6f1ff', fontSize: 18, fontWeight: 'bold' },
    },
    tooltip: {
      trigger: chartType === 'pie' ? 'item' : 'axis',
      backgroundColor: 'rgba(12, 20, 38, 0.92)',
      borderColor: '#22d3ee',
      textStyle: { color: '#e6f1ff' },
    },
    toolbox: {
      feature: { saveAsImage: {} },
      right: 10,
      // toolbox 图标默认是灰色，深背景下不可见
      iconStyle: { borderColor: '#7a8ba8' },
    },
    legend: {
      top: 36,
      textStyle: { color: '#e6f1ff' },
      // 单系列不显示图例（图例文本=系列名，重复信息）
      ...(input.chartType && { type: 'scroll' }),
    },
    grid: { left: 56, right: 56, top: 80, bottom: 48, containLabel: false },
  };
  return option;
}

/**
 * 为 line/bar 系列生成默认的 smooth + 渐变面积样式。
 * 用户确认的重庆天气图风格：线条平滑、线下渐变面积（8% → 0 透明度）
 */
export function buildDefaultSeriesStyle(
  color: string,
  chartType: string,
  seriesIndex: number,
): Record<string, any> {
  if (chartType !== 'line') {
    // bar 不加面积，仅收个圆角
    return { itemStyle: { borderRadius: [4, 4, 0, 0] } };
  }
  void seriesIndex;
  return {
    smooth: true,
    lineStyle: { width: 2.5 },
    itemStyle: { borderWidth: 2 },
    // 前两个系列带渐变面积填充（高温/低温对比图的经典形态），
    // 第三条及以后（如湿度，通常配副轴）只画虚线不填充，避免多层面积互相遮挡
    ...(seriesIndex < 2
      ? {
          areaStyle: {
            opacity: 1,
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `${color}33` }, // 主色 20% 透明度
                { offset: 1, color: `${color}00` }, // 渐变到全透明
              ],
            },
          },
        }
      : { lineStyle: { width: 2.5, type: 'dashed' } }),
  };
}

/**
 * echartsOption 路径的主题补全：仅当模型没写对应字段时注入默认值，
 * 模型显式定义的任何样式一律保留（不覆盖、不合并、不"优化"）
 */
export function applyThemeDefaults(option: Record<string, any>): Record<string, any> {
  const defaults: Record<string, unknown> = {
    backgroundColor: '#0b1020',
    textStyle: { color: '#e6f1ff' },
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (option[key] === undefined) {
      option[key] = value;
    }
  }
  // 模型没写 tooltip 样式但写了 tooltip 结构，或完全没写时，补深色弹层
  if (!option.tooltip) {
    option.tooltip = {
      trigger: 'axis',
      backgroundColor: 'rgba(12, 20, 38, 0.92)',
      borderColor: '#22d3ee',
      textStyle: { color: '#e6f1ff' },
    };
  }
  return option;
}
