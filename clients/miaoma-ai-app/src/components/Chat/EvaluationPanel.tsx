import React, { useState, useEffect } from 'react';
import { X, ThumbsUp, ThumbsDown, BarChart3, RefreshCw, Star } from 'lucide-react';
import { Button } from '../ui/button';
import { getEvaluationStats, type EvaluationStats } from '../../lib/api';

interface EvaluationPanelProps {
  open: boolean;
  onClose: () => void;
}

const EvaluationPanel: React.FC<EvaluationPanelProps> = ({ open, onClose }) => {
  const [stats, setStats] = useState<EvaluationStats | null>(null);
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
      const data = await getEvaluationStats(days);
      setStats(data);
    } catch (err) {
      console.error('获取评估统计失败:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden cyberpunk-ms-dialog-card">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground cyberpunk-ms-title flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            回答准确率评估
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
              {/* 人工评估概览 */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <ThumbsUp className="h-4 w-4" /> 人工评估
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">满意度</div>
                    <div className="text-xl font-bold text-green-500">
                      {(stats.humanEvaluation.satisfactionRate * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">反馈总数</div>
                    <div className="text-xl font-bold text-foreground">{stats.humanEvaluation.totalFeedbacks}</div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <ThumbsUp className="h-3 w-3 text-green-500" />点赞
                    </div>
                    <div className="text-lg font-bold text-green-500">{stats.humanEvaluation.positiveCount}</div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <ThumbsDown className="h-3 w-3 text-red-500" />点踩
                    </div>
                    <div className="text-lg font-bold text-red-500">{stats.humanEvaluation.negativeCount}</div>
                  </div>
                </div>
              </div>

              {/* 自动评估概览 */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <Star className="h-4 w-4" /> 自动评估
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">平均评分</div>
                    <div className="text-xl font-bold text-foreground">
                      {(stats.autoEvaluation.avgScore * 100).toFixed(0)}
                      <span className="text-sm font-normal text-muted-foreground">/100</span>
                    </div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">评估次数</div>
                    <div className="text-xl font-bold text-foreground">{stats.autoEvaluation.totalEvaluations}</div>
                  </div>
                </div>
                {/* 评分进度条 */}
                {stats.autoEvaluation.avgScore > 0 && (
                  <div className="mt-2">
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          stats.autoEvaluation.avgScore >= 0.7 ? 'bg-green-500' :
                          stats.autoEvaluation.avgScore >= 0.4 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${stats.autoEvaluation.avgScore * 100}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground mt-1">
                      <span>低</span>
                      <span>中</span>
                      <span>高</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 每日反馈趋势 */}
              {Object.keys(stats.dailyFeedback).length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">每日反馈趋势</h3>
                  <div className="space-y-1.5">
                    {Object.entries(stats.dailyFeedback)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([day, data]) => (
                        <div key={day} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground w-20">{day.slice(5)}</span>
                          <div className="flex-1 mx-3 flex gap-1">
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className="bg-green-500 h-full rounded-full"
                                style={{ width: `${data.positive > 0 ? (data.positive / (data.positive + data.negative)) * 100 : 0}%` }}
                              />
                            </div>
                          </div>
                          <div className="flex gap-2 w-20 text-right">
                            <span className="text-green-500">+{data.positive}</span>
                            <span className="text-red-500">-{data.negative}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* 最近自动评估记录 */}
              {stats.autoEvaluation.recentEvaluations.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">最近自动评估</h3>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {stats.autoEvaluation.recentEvaluations.slice(0, 10).map((e) => (
                      <div key={e.id} className="bg-muted/30 rounded-lg p-2.5 text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className={`font-medium ${e.score >= 0.7 ? 'text-green-500' : e.score >= 0.4 ? 'text-yellow-500' : 'text-red-500'}`}>
                            评分: {(e.score * 100).toFixed(0)}
                          </span>
                          <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString('zh-CN')}</span>
                        </div>
                        {e.reason && <div className="text-muted-foreground">{e.reason}</div>}
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

export default EvaluationPanel;
