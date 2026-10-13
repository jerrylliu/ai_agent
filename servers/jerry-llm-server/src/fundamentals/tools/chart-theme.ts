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
      top: 40,
      textStyle: { color: '#e6f1ff' },
      // 滚动图例：系列名过长或系列过多时不溢出画布
      type: 'scroll',
    },
    // containLabel: true 让坐标轴文字参与布局计算——固定 left/right 遇到
    // 大数值（如 1,000,000 的 y 轴标签）会被裁切，这是固定边距的隐性风险
    grid: { left: 16, right: 16, top: 84, bottom: 16, containLabel: true },
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
 * 检测模型是否已对配色表达过"意见"（写过任何文字/图形颜色）。
 * 有意见 = 模型心里有自己假定的背景基调（很可能按白底配了深灰文字），
 * 此时注入深色背景会产出"深底深字"的不可读图表——整体放手不注入。
 */
function hasColorOpinion(o: Record<string, any>): boolean {
  if (o.textStyle?.color) return true;
  if (o.legend?.textStyle?.color) return true;
  const axes = [
    ...(Array.isArray(o.xAxis) ? o.xAxis : [o.xAxis]),
    ...(Array.isArray(o.yAxis) ? o.yAxis : [o.yAxis]),
  ].filter(Boolean);
  if (axes.some((a) => a.axisLabel?.color || a.axisLine?.lineStyle?.color)) {
    return true;
  }
  if (
    Array.isArray(o.series) &&
    o.series.some((s) => s?.label?.color || s?.itemStyle?.color)
  ) {
    return true;
  }
  return false;
}

/**
 * echartsOption 路径的主题补全：模型没表达任何配色意见时，才注入深色主题
 * 缺失字段；模型写过任何颜色则整体放手（防止"模型按白底配深灰文字 + 我们
 * 注入深色背景"组合出不可读图表）。注入时浅合并，不破坏模型已有的同名字段
 */
export function applyThemeDefaults(option: Record<string, any>): Record<string, any> {
  if (hasColorOpinion(option)) {
    return option;
  }
  if (option.backgroundColor === undefined) {
    option.backgroundColor = '#0b1020';
  }
  if (option.textStyle?.color === undefined) {
    option.textStyle = { ...(option.textStyle ?? {}), color: '#e6f1ff' };
  }
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
