import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Network, RefreshCw, Play } from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import { Button } from '../ui/button';
import {
  getKgGraph,
  getKgDocumentGraph,
  getKgStats,
  getDocuments,
  triggerKgExtractAll,
  triggerKgExtractDocument,
  type KgGraphResponse,
  type KgDocGraphResponse,
  type KgStatsResponse,
  type DocumentItem,
} from '../../lib/api';

interface KgGraphPanelProps {
  open: boolean;
  onClose: () => void;
}

/** 后台抽取进度的轮询间隔（毫秒）：抽取是 LLM 长任务，秒级刷新没有意义 */
const PROGRESS_POLL_MS = 3000;

/** 实体类型 → 中文展示名与图例色（与后端抽取 schema 的类型枚举对应） */
const TYPE_META: Record<string, { label: string; color: string }> = {
  person: { label: '人物', color: '#3b82f6' },
  team: { label: '团队', color: '#8b5cf6' },
  organization: { label: '组织', color: '#a855f7' },
  product: { label: '产品', color: '#22c55e' },
  model: { label: '模型', color: '#f59e0b' },
  technology: { label: '技术', color: '#06b6d4' },
  concept: { label: '概念', color: '#64748b' },
  event: { label: '事件', color: '#ec4899' },
  document: { label: '文档', color: '#84cc16' },
  unknown: { label: '未知', color: '#9ca3af' },
};

/** 图例/配色兜底：后端新增类型时不至于无色 */
const FALLBACK_COLOR = '#94a3b8';

/** 统一节点形态（全局聚合图与单文档子图共用渲染逻辑） */
interface NormalizedNode {
  key: string;
  label: string;
  type: string;
  aliases: string[];
  docCount: number;
}

interface NormalizedEdge {
  source: string;
  target: string;
  relation: string;
  count: number;
}

const KgGraphPanel: React.FC<KgGraphPanelProps> = ({ open, onClose }) => {
  const [stats, setStats] = useState<KgStatsResponse | null>(null);
  const [graph, setGraph] = useState<KgGraphResponse | null>(null);
  const [docGraph, setDocGraph] = useState<KgDocGraphResponse | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [docId, setDocId] = useState<number | null>(null); // null = 全局聚合图
  const [loading, setLoading] = useState(false);
  // 人工触发提取：triggering 标记按钮 loading，notice 展示受理结果 / 失败原因
  const [triggering, setTriggering] = useState<'all' | 'doc' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // 后台抽取进行中：轮询队列计数展示进度，清空后自动刷新图谱
  const [polling, setPolling] = useState(false);

  const fetchAll = useCallback(async (selectedDocId: number | null) => {
    setLoading(true);
    try {
      const [statsData, docsData] = await Promise.all([getKgStats(), getDocuments()]);
      setStats(statsData);
      setDocuments(docsData);
      if (selectedDocId === null) {
        setDocGraph(null);
        setGraph(await getKgGraph());
      } else {
        setGraph(null);
        setDocGraph(await getKgDocumentGraph(selectedDocId));
      }
    } catch (err) {
      console.error('获取知识图谱数据失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchAll(docId);
    }
    // docId 变化走 onDocChange 单独触发，避免重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onDocChange = (value: string) => {
    const next = value === '' ? null : Number(value);
    setDocId(next);
    fetchAll(next);
  };

  // 后台抽取进度轮询：触发接口立即返回（单篇抽取上限 180s，不能同步等），
  // 进度只能靠 GET /api/kg/stats 的队列计数观察；队列清空后刷新当前视图。
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const s = await getKgStats();
        if (cancelled) return;
        setStats(s);
        if (s.ops.pending + s.ops.processing === 0) {
          setPolling(false);
          setNotice({
            ok: s.ops.failed === 0,
            text: `提取结束：成功 ${s.ops.completed} 篇${s.ops.failed > 0 ? ` · 失败 ${s.ops.failed} 篇（可再次点击提取重试）` : ''}`,
          });
          await fetchAll(docId);
        }
      } catch {
        // 单次轮询失败不终止观察，下一轮继续（服务重启期间可能短暂 502）
      }
    }, PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling, docId, fetchAll]);

  /** 人工触发提取：scope=all 全量入队，scope=doc 只入队当前选中文档 */
  const handleTrigger = useCallback(
    async (scope: 'all' | 'doc') => {
      if (scope === 'doc' && docId === null) return;
      setTriggering(scope);
      setNotice(null);
      try {
        const result =
          scope === 'all'
            ? await triggerKgExtractAll()
            : await triggerKgExtractDocument(docId as number);
        if (!result.accepted) {
          setNotice({ ok: false, text: result.reason || '本次提取请求未被受理' });
          return;
        }
        setNotice({
          ok: true,
          text:
            result.reason ||
            (scope === 'all'
              ? `已受理：${result.enqueued} 篇文档进入提取队列，后台执行中`
              : '已受理：该文档已进入提取队列，后台执行中'),
        });
        if (result.running) {
          setPolling(true);
        } else {
          await fetchAll(docId);
        }
      } catch (err) {
        setNotice({
          ok: false,
          text: err instanceof Error ? err.message : '触发提取失败',
        });
      } finally {
        setTriggering(null);
      }
    },
    [docId, fetchAll],
  );

  // 当前视图的统一节点/边（两种数据源归一化后共用渲染）
  const { nodes, edges, truncated } = useMemo(() => {
    if (docId === null) {
      if (!graph) return { nodes: [] as NormalizedNode[], edges: [] as NormalizedEdge[], truncated: false };
      return {
        nodes: graph.nodes.map((n) => ({
          key: n.key,
          label: n.label,
          type: n.type,
          aliases: n.aliases,
          docCount: n.docCount,
        })),
        edges: graph.edges.map((e) => ({ ...e })),
        truncated: graph.truncated,
      };
    }
    if (!docGraph) return { nodes: [] as NormalizedNode[], edges: [] as NormalizedEdge[], truncated: false };
    return {
      nodes: docGraph.nodes.map((n) => ({
        key: n.key,
        label: n.label,
        type: n.type,
        aliases: n.aliases,
        docCount: 1,
      })),
      edges: docGraph.edges.map((e) => ({ ...e, count: 1 })),
      truncated: false,
    };
  }, [docId, graph, docGraph]);

  // 按节点类型生成 categories（图例顺序稳定）
  const categories = useMemo(() => {
    const types = Array.from(new Set(nodes.map((n) => n.type))).sort();
    return types.map((t) => ({
      name: TYPE_META[t]?.label || t,
      itemStyle: { color: TYPE_META[t]?.color || FALLBACK_COLOR },
    }));
  }, [nodes]);

  // echarts force 布局 graph option
  const graphOption = useMemo(() => {
    if (nodes.length === 0) return {};
    const typeIndex = new Map(categories.map((c, i) => [c.name, i]));
    const isGlobal = docId === null;
    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: { data?: { label?: string; type?: string; aliases?: string[]; docCount?: number } }) => {
          const d = params.data;
          if (!d || !d.label) return '';
          const meta = TYPE_META[d.type || 'unknown'];
          const lines = [`<b>${d.label}</b>（${meta?.label || d.type}）`];
          if (d.aliases && d.aliases.length > 0) {
            lines.push(`别名: ${d.aliases.join('、')}`);
          }
          if (isGlobal && (d.docCount || 0) > 0) {
            lines.push(`出现文档数: ${d.docCount}`);
          }
          return lines.join('<br/>');
        },
      },
      legend: [
        {
          data: categories.map((c) => c.name),
          top: 0,
          textStyle: { fontSize: 11 },
        },
      ],
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          draggable: true,
          categories,
          data: nodes.map((n) => {
            const catName = TYPE_META[n.type]?.label || n.type;
            return {
              id: n.key,
              name: n.label,
              label: n.label,
              type: n.type,
              aliases: n.aliases,
              docCount: n.docCount,
              category: typeIndex.get(catName) ?? 0,
              // 全局图按跨文档次数放大 hub 节点；单文档子图统一尺寸
              symbolSize: isGlobal ? Math.min(14 + n.docCount * 6, 40) : 18,
            };
          }),
          edges: edges.map((e) => ({
            source: e.source,
            target: e.target,
            relation: e.relation,
            count: e.count,
            label: {
              show: nodes.length <= 60,
              formatter: isGlobal && e.count > 1 ? `${e.relation}×${e.count}` : e.relation,
              fontSize: 9,
              color: '#94a3b8',
            },
            lineStyle: {
              color: '#cbd5e1',
              width: isGlobal ? Math.min(1 + e.count, 4) : 1.5,
              curveness: 0.1,
            },
          })),
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
          },
          force: {
            repulsion: 220,
            edgeLength: 90,
            gravity: 0.08,
          },
          emphasis: {
            focus: 'adjacency',
            lineStyle: { width: 3 },
          },
        },
      ],
    };
  }, [nodes, edges, categories, docId]);

  // KG 关闭 / 队列执行中 / 数据加载中时禁用触发按钮（原因在视图行提示）
  const extractDisabled =
    loading || polling || triggering !== null || stats?.enabled === false;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[860px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Network className="h-5 w-5" />
            知识图谱
          </h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleTrigger('all')}
              disabled={extractDisabled}
              title="把所有「当前生效版本尚未成功抽取」的文档入队提取（历史失败项会一并重试），后台执行"
            >
              <Play className="h-3.5 w-3.5" />
              全量提取
            </Button>
            <Button variant="ghost" size="icon" onClick={() => fetchAll(docId)} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* 视图切换：全局聚合图 / 单文档子图 */}
        <div className="px-6 py-3 border-b border-border flex items-center gap-3">
          <span className="text-sm text-muted-foreground shrink-0">视图</span>
          <select
            className="bg-background border border-border rounded-md px-2 py-1.5 text-sm text-foreground min-w-0 flex-1"
            value={docId === null ? '' : String(docId)}
            onChange={(e) => onDocChange(e.target.value)}
            disabled={loading}
          >
            <option value="">全局聚合图（跨文档合并）</option>
            {documents.map((d) => (
              <option key={d.id} value={String(d.id)}>
                {d.title}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void handleTrigger('doc')}
            disabled={extractDisabled || docId === null}
            title="按该文档当前生效版本提取知识图谱（后台执行）"
          >
            <Play className="h-3.5 w-3.5" />
            提取本文档
          </Button>
          {stats && !stats.enabled && (
            <span className="text-xs text-yellow-600 dark:text-yellow-400 shrink-0">
              KG 在线链路未启用（数据仍可浏览，无法提取）
            </span>
          )}
        </div>

        {/* 触发结果 / 后台抽取进度（抽取已改为人工触发，此处是唯一的进度出口） */}
        {(notice || polling) && (
          <div className="px-6 py-2 border-b border-border flex items-center gap-3 text-xs">
            {polling && stats && (
              <span className="text-muted-foreground shrink-0 flex items-center gap-1.5">
                <RefreshCw className="h-3 w-3 animate-spin" />
                提取进行中：待处理 {stats.ops.pending} · 进行中 {stats.ops.processing}
              </span>
            )}
            {notice && (
              <span
                className={
                  notice.ok
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }
              >
                {notice.text}
              </span>
            )}
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading && !graph && !docGraph ? (
            <div className="text-center py-10 text-muted-foreground">加载中...</div>
          ) : (
            <>
              {/* 统计卡片 */}
              {stats && (
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">实体（去重）</div>
                    <div className="text-xl font-bold text-foreground">{stats.entities.distinctKeys}</div>
                    <div className="text-[10px] text-muted-foreground">
                      共 {stats.entities.rows} 行 / {stats.entities.documents} 篇文档
                    </div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">三元组</div>
                    <div className="text-xl font-bold text-foreground">{stats.triples.rows}</div>
                    {stats.triples.topRelations[0] && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        top: {stats.triples.topRelations[0].relation} ×{stats.triples.topRelations[0].count}
                      </div>
                    )}
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">嵌入覆盖</div>
                    <div className="text-xl font-bold text-foreground">
                      {stats.entities.rows > 0
                        ? `${((stats.entities.withEmbedding / stats.entities.rows) * 100).toFixed(0)}%`
                        : '-'}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {stats.entities.withEmbedding}/{stats.entities.rows} 条
                    </div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">抽取队列</div>
                    <div className="text-xl font-bold text-foreground">
                      <span className="text-green-600">{stats.ops.completed}</span>
                      <span className="text-muted-foreground text-sm"> / </span>
                      <span className="text-red-600">{stats.ops.failed}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      待处理 {stats.ops.pending} · 进行中 {stats.ops.processing} · 索引
                      {stats.index.ready ? '已就绪' : '未就绪'}
                    </div>
                  </div>
                </div>
              )}

              {/* 图谱 */}
              {nodes.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-foreground">
                      {docId === null ? '全局实体关系图' : '文档实体关系图'}
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {nodes.length} 节点 / {edges.length} 边
                      {truncated && '（已按 hub 优先截断）'}
                    </span>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-2">
                    <ReactECharts
                      option={graphOption}
                      style={{ height: 460 }}
                      opts={{ renderer: 'svg' }}
                      notMerge
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    滚轮缩放 · 拖拽平移/移动节点 · 悬停高亮邻接
                  </p>
                </div>
              ) : (
                <div className="text-center py-10 text-muted-foreground">
                  {docId === null
                    ? '暂无图谱数据（点击右上角「全量提取」手动触发文档抽取）'
                    : '该文档暂无图谱数据（点击上方「提取本文档」手动触发抽取）'}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default KgGraphPanel;
