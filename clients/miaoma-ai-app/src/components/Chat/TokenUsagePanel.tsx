import React, { useState, useEffect } from 'react';
import { X, BarChart3, Clock, Database, Zap, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { getLlmUsageStats, type LlmUsageStats } from '../../lib/api';

interface TokenUsagePanelProps {
  open: boolean;
  onClose: () => void;
}

const TokenUsagePanel: React.FC<TokenUsagePanelProps> = ({ open, onClose }) => {
  const [stats, setStats] = useState<LlmUsageStats | null>(null);
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
      const data = await getLlmUsageStats(days);
      setStats(data);
    } catch (err) {
      console.error('获取用量统计失败:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  const formatNumber = (n: number) => n.toLocaleString();
  const formatMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden cyberpunk-ms-dialog-card">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground cyberpunk-ms-title flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Token 用量统计
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
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Zap className="h-3.5 w-3.5" />总调用次数
                  </div>
                  <div className="text-xl font-bold text-foreground">{formatNumber(stats.totalCalls)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <BarChart3 className="h-3.5 w-3.5" />总 Token 消耗
                  </div>
                  <div className="text-xl font-bold text-foreground">{formatNumber(stats.totalTokens)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />平均响应时间
                  </div>
                  <div className="text-xl font-bold text-foreground">{formatMs(stats.avgResponseTimeMs)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Database className="h-3.5 w-3.5" />知识库命中率
                  </div>
                  <div className="text-xl font-bold text-foreground">{(stats.knowledgeBaseHitRate * 100).toFixed(0)}%</div>
                </div>
              </div>

              {/* Token 明细 */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">Token 明细</h3>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">输入 Token</span>
                    <span className="text-foreground font-medium">{formatNumber(stats.totalInputTokens)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">输出 Token</span>
                    <span className="text-foreground font-medium">{formatNumber(stats.totalOutputTokens)}</span>
                  </div>
                  {stats.totalTokens > 0 && (
                    <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden flex">
                      <div
                        className="bg-blue-500 h-full"
                        style={{ width: `${(stats.totalInputTokens / stats.totalTokens) * 100}%` }}
                      />
                      <div
                        className="bg-green-500 h-full"
                        style={{ width: `${(stats.totalOutputTokens / stats.totalTokens) * 100}%` }}
                      />
                    </div>
                  )}
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-blue-500 rounded-full" />输入</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-green-500 rounded-full" />输出</span>
                  </div>
                </div>
              </div>

              {/* 每日趋势 */}
              {Object.keys(stats.dailyStats).length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">每日趋势</h3>
                  <div className="space-y-1.5">
                    {Object.entries(stats.dailyStats)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([day, data]) => (
                        <div key={day} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground w-20">{day.slice(5)}</span>
                          <div className="flex-1 mx-3 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="bg-primary h-full rounded-full"
                              style={{
                                width: `${stats.totalCalls > 0 ? (data.calls / Math.max(...Object.values(stats.dailyStats).map(d => d.calls))) * 100 : 0}%`,
                              }}
                            />
                          </div>
                          <span className="text-foreground font-medium w-16 text-right">{data.calls} 次</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* 最近调用记录 */}
              {stats.recentRecords.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">最近调用</h3>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {stats.recentRecords.slice(0, 10).map((r) => (
                      <div key={r.id} className="bg-muted/30 rounded-lg p-2.5 text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{r.modelId}</span>
                          <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString('zh-CN')}</span>
                        </div>
                        <div className="flex gap-3 text-foreground">
                          <span>输入: {formatNumber(r.inputTokens)}</span>
                          <span>输出: {formatNumber(r.outputTokens)}</span>
                          <span>耗时: {formatMs(r.responseTimeMs || 0)}</span>
                          {r.usedKnowledgeBase && <span className="text-blue-500">知识库</span>}
                        </div>
                      </div>
                    ))}
                  </div>
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

export default TokenUsagePanel;
