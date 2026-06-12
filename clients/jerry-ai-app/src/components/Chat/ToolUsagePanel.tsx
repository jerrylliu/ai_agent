import React, { useState, useEffect, useMemo } from 'react';
import { X, Wrench, CheckCircle, XCircle, Clock, RefreshCw } from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import { Button } from '../ui/button';
import { getToolUsageStats, type ToolUsageStats } from '../../lib/api';

interface ToolUsagePanelProps {
  open: boolean;
  onClose: () => void;
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  search_knowledge_base: '知识库搜索',
  search_web: '联网搜索',
  get_weather: '天气查询',
  calculate: '数学计算',
  manage_session: '会话管理',
  create_plan: '创建计划',
  update_plan_step: '更新计划',
  get_plan: '查看计划',
  crawl_webpage: '网页抓取',
  create_document: '创建文档',
  update_document: '更新文档',
  summarize_document: '生成摘要',
  compare_documents: '对比文档',
  generate_chart: '生成图表',
  generate_image: '文生图',
  create_mindmap: '思维导图',
};

const ToolUsagePanel: React.FC<ToolUsagePanelProps> = ({ open, onClose }) => {
  const [stats, setStats] = useState<ToolUsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(7);

  useEffect(() => {
    if (open) {
      fetchStats();
    }
  }, [open, days]);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const data = await getToolUsageStats(days);
      setStats(data);
    } catch (err) {
      console.error('获取工具调用统计失败:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

  // 工具调用分布饼图
  const pieOption = useMemo(() => {
    if (!stats) return {};
    const toolEntries = Object.entries(stats.byTool).sort((a, b) => b[1].calls - a[1].calls);
    return {
      tooltip: {
        trigger: 'item',
        formatter: '{b}: {c}次 ({d}%)',
      },
      legend: {
        orient: 'vertical',
        right: 10,
        top: 'center',
        textStyle: { fontSize: 11 },
        formatter: (name: string) => TOOL_DISPLAY_NAMES[name] || name,
      },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 4,
          borderColor: '#fff',
          borderWidth: 2,
        },
        label: { show: false },
        emphasis: {
          label: { show: true, fontSize: 12, fontWeight: 'bold' },
        },
        data: toolEntries.map(([name, data]) => ({
          name,
          value: data.calls,
        })),
      }],
    };
  }, [stats]);

  // 每日趋势折线图
  const lineOption = useMemo(() => {
    if (!stats || Object.keys(stats.dailyStats).length === 0) return {};
    const sortedDays = Object.entries(stats.dailyStats).sort(([a], [b]) => a.localeCompare(b));
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
      },
      legend: {
        data: ['总调用', '成功'],
        top: 0,
        textStyle: { fontSize: 11 },
      },
      grid: {
        left: 40,
        right: 20,
        bottom: 30,
        top: 35,
      },
      xAxis: {
        type: 'category',
        data: sortedDays.map(([d]) => d.slice(5)),
        axisLabel: { fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          name: '总调用',
          type: 'bar',
          data: sortedDays.map(([, d]) => d.calls),
          itemStyle: { borderRadius: [3, 3, 0, 0] },
        },
        {
          name: '成功',
          type: 'line',
          data: sortedDays.map(([, d]) => d.successCalls),
          smooth: true,
          lineStyle: { width: 2 },
          symbolSize: 4,
        },
      ],
    };
  }, [stats]);

  // 各工具成功率柱状图
  const successRateOption = useMemo(() => {
    if (!stats) return {};
    const toolEntries = Object.entries(stats.byTool).sort((a, b) => b[1].calls - a[1].calls);
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = params[0];
          const name = TOOL_DISPLAY_NAMES[p.name] || p.name;
          return `${name}<br/>成功率: ${(p.value * 100).toFixed(0)}%`;
        },
      },
      grid: {
        left: 80,
        right: 30,
        bottom: 30,
        top: 15,
      },
      xAxis: {
        type: 'value',
        max: 1,
        axisLabel: {
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
          fontSize: 10,
        },
      },
      yAxis: {
        type: 'category',
        data: toolEntries.map(([name]) => TOOL_DISPLAY_NAMES[name] || name),
        axisLabel: { fontSize: 10 },
      },
      series: [{
        type: 'bar',
        data: toolEntries.map(([, data]) => data.successRate),
        itemStyle: {
          borderRadius: [0, 3, 3, 0],
          color: (params: any) => {
            const rate = params.value;
            if (rate >= 0.9) return '#22c55e';
            if (rate >= 0.7) return '#eab308';
            return '#ef4444';
          },
        },
        barWidth: 14,
      }],
    };
  }, [stats]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[640px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            工具调用统计
          </h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={fetchStats} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* 时间范围选择 */}
        <div className="px-6 py-3 border-b border-border flex items-center gap-2">
          {[
            { label: '近7天', value: 7 },
            { label: '近30天', value: 30 },
            { label: '近90天', value: 90 },
          ].map(({ label, value }) => (
            <Button
              key={value}
              variant={days === value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDays(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {loading && !stats ? (
            <div className="text-center py-10 text-muted-foreground">加载中...</div>
          ) : stats ? (
            <>
              {/* 概览卡片 */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Wrench className="h-3.5 w-3.5" />总调用
                  </div>
                  <div className="text-xl font-bold text-foreground">{stats.totalCalls}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle className="h-3.5 w-3.5 text-green-500" />成功
                  </div>
                  <div className="text-xl font-bold text-green-600">{stats.successCalls}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <XCircle className="h-3.5 w-3.5 text-red-500" />失败
                  </div>
                  <div className="text-xl font-bold text-red-600">{stats.failedCalls}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />平均耗时
                  </div>
                  <div className="text-xl font-bold text-foreground">{formatMs(stats.avgDurationMs)}</div>
                </div>
              </div>

              {/* 成功率进度条 */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">总体成功率</span>
                  <span className="font-medium text-foreground">{(stats.successRate * 100).toFixed(1)}%</span>
                </div>
                <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${stats.successRate * 100}%`,
                      backgroundColor: stats.successRate >= 0.9 ? '#22c55e' : stats.successRate >= 0.7 ? '#eab308' : '#ef4444',
                    }}
                  />
                </div>
              </div>

              {/* 工具调用分布饼图 */}
              {Object.keys(stats.byTool).length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">工具调用分布</h3>
                  <div className="bg-muted/30 rounded-lg p-2">
                    <ReactECharts
                      option={pieOption}
                      style={{ height: 220 }}
                      opts={{ renderer: 'svg' }}
                    />
                  </div>
                </div>
              )}

              {/* 每日趋势 */}
              {Object.keys(stats.dailyStats).length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">每日趋势</h3>
                  <div className="bg-muted/30 rounded-lg p-2">
                    <ReactECharts
                      option={lineOption}
                      style={{ height: 200 }}
                      opts={{ renderer: 'svg' }}
                    />
                  </div>
                </div>
              )}

              {/* 各工具成功率 */}
              {Object.keys(stats.byTool).length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">各工具成功率</h3>
                  <div className="bg-muted/30 rounded-lg p-2">
                    <ReactECharts
                      option={successRateOption}
                      style={{ height: Math.max(120, Object.keys(stats.byTool).length * 28 + 40) }}
                      opts={{ renderer: 'svg' }}
                    />
                  </div>
                </div>
              )}

              {/* 各工具详情表格 */}
              {Object.keys(stats.byTool).length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">工具详情</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 px-2 text-muted-foreground font-medium">工具</th>
                          <th className="text-right py-2 px-2 text-muted-foreground font-medium">调用次数</th>
                          <th className="text-right py-2 px-2 text-muted-foreground font-medium">成功率</th>
                          <th className="text-right py-2 px-2 text-muted-foreground font-medium">平均耗时</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(stats.byTool)
                          .sort((a, b) => b[1].calls - a[1].calls)
                          .map(([name, data]) => (
                            <tr key={name} className="border-b border-border/50">
                              <td className="py-2 px-2 text-foreground">
                                {TOOL_DISPLAY_NAMES[name] || name}
                              </td>
                              <td className="py-2 px-2 text-right text-foreground">{data.calls}</td>
                              <td className="py-2 px-2 text-right">
                                <span className={
                                  data.successRate >= 0.9 ? 'text-green-600' :
                                  data.successRate >= 0.7 ? 'text-yellow-600' :
                                  'text-red-600'
                                }>
                                  {(data.successRate * 100).toFixed(0)}%
                                </span>
                              </td>
                              <td className="py-2 px-2 text-right text-foreground">{formatMs(data.avgDurationMs)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 最近调用记录 */}
              {stats.recentRecords.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">最近调用</h3>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {stats.recentRecords.slice(0, 15).map((r) => (
                      <div key={r.id} className="bg-muted/30 rounded-lg p-2.5 text-xs space-y-1">
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2">
                            <span className={
                              r.success
                                ? 'inline-block w-2 h-2 bg-green-500 rounded-full'
                                : 'inline-block w-2 h-2 bg-red-500 rounded-full'
                            } />
                            <span className="text-foreground font-medium">
                              {TOOL_DISPLAY_NAMES[r.toolName] || r.toolName}
                            </span>
                          </div>
                          <span className="text-muted-foreground">
                            {new Date(r.createdAt).toLocaleString('zh-CN')}
                          </span>
                        </div>
                        <div className="flex gap-3 text-muted-foreground">
                          <span>耗时: {formatMs(r.durationMs)}</span>
                          {r.errorMessage && (
                            <span className="text-red-500 truncate max-w-[200px]" title={r.errorMessage}>
                              错误: {r.errorMessage}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {stats.totalCalls === 0 && (
                <div className="text-center py-10 text-muted-foreground">
                  暂无工具调用数据
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-10 text-muted-foreground">暂无数据</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ToolUsagePanel;
