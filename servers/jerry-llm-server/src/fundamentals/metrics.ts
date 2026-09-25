/**
 * fundamentals/metrics.ts
 *
 * Prometheus 指标注册中心
 *
 * 设计目标：
 *   把"飞书发送 / HITL 审批 / 多级缓存命中率"三类核心指标通过 prom-client
 *   暴露到 /api/metrics 端点，供 Prometheus 抓取、Grafana 可视化。
 *
 * 指标清单（3 类）：
 *   1. feishu_message_sent_total{channel, status}
 *      - channel: card / image / file / text
 *      - status:  success / failure
 *      - 用途：监控飞书消息成功率，定位是哪类消息出问题
 *
 *   2. hitl_resolved_total{action, source}
 *      - action: confirm / reject / timeout
 *      - source: web / feishu
 *      - 用途：观察 HITL 双通道使用占比、用户是否倾向手机审批
 *
 *   3. multilevel_cache (Gauge)
 *      - 命中：l1_hits / l2_hits / misses / l2_errors / overall_hit_rate
 *      - 容量：l1_size / l1_max_size / weighted_size_bytes / max_total_size_bytes
 *             / avg_entry_size_bytes / p95_entry_size_bytes
 *      - 写入拒绝：rejected{reason=oversize|budget}
 *      - 淘汰归因：evicted{reason=size|budget|ttl|config}
 *      - 击穿压力：coalesced_requests（被单飞合并掉的并发回源次数）
 *      - 每次 scrape 时主动调 getStats()，容量治理类指标为可选字段
 *        （MultiLevelCache 不提供，序列缺失而非写 0）
 *      - 用途：观察命中率、定位容量瓶颈（条数上限还是字节预算先触顶）、
 *             判断缓存是否正在被击穿
 *
 * 使用：
 *   - 业务侧：import { metrics } from './metrics'; metrics.feishuMessageSent.inc({ channel: 'card', status: 'success' });
 *   - 注册缓存实例：在缓存实例化处调 metrics.registerCacheInstance('chart-option', cacheInstance)
 *   - 暴露端点：详见 controllers/metrics.controller.ts
 *
 * 设计取舍：
 *   - 使用 prom-client 而非 @willsoto/nestjs-prometheus，前者更轻量、控制更精细
 *   - Registry 全局单例，避免 register.register() 冲突
 *   - 缓存指标用 Gauge + 回调（每次 scrape 主动算），而不是每次 set/get 累加
 *     原因：MultiLevelCache 已经内部维护命中计数，重复计数浪费
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * 缓存实例的最小接口（避免循环依赖直接 import MultiLevelCache 类型）
 */
interface CacheStatsProvider {
  getStats(): {
    namespace: string;
    l1Hits: number;
    l2Hits: number;
    misses: number;
    l2Errors: number;
    total: number;
    l1HitRate: number;
    overallHitRate: number;
    l1Size: number;
    l1MaxSize: number;

    // ==================== 容量治理扩展指标（可选） ====================
    // 为什么全部可选：registerCacheInstance 有两类调用方 ——
    // LRUCache（有字节预算、单飞、拒绝计数）与 MultiLevelCache（只有 L1 条数 + Redis）。
    // 强行要求会让 MultiLevelCache 和 metrics.spec.ts 里的 fake 全部编译失败。
    // refreshCacheGauges 对 undefined 直接跳过，不写 Gauge（Prometheus 侧表现为该序列缺失，
    // 而不是一个假的 0 —— 缺失才是「这个缓存没有这个概念」的正确表达）。

    /** 当前条目加权体积（字节），非真实 RSS */
    weightedSizeBytes?: number;
    /** 字节预算上限（字节） */
    maxTotalSizeBytes?: number;
    /** 平均条目大小（字节） */
    avgEntrySizeBytes?: number;
    /** 条目大小 95 分位（字节） */
    p95EntrySizeBytes?: number;
    /** 因超过单条上限被拒绝写入的次数 */
    rejectedOversize?: number;
    /** 因撑爆字节预算被拒绝写入的次数 */
    rejectedBudget?: number;
    /** 因条目数上限淘汰的次数 */
    evictedBySize?: number;
    /** 因字节预算淘汰的次数 */
    evictedByBudget?: number;
    /** 因 TTL 过期在读取时回收的次数 */
    evictedByTTL?: number;
    /** 因配置调小淘汰的次数 */
    evictedByConfig?: number;
    /** 被单飞合并掉的并发回源次数 */
    coalescedRequests?: number;
  };
}

/** 全局 Registry，单例 */
export const metricsRegistry = new Registry();

/** Node.js 默认指标（CPU/内存/事件循环等） */
collectDefaultMetrics({ register: metricsRegistry, prefix: 'jerry_' });

/** 飞书消息发送计数器 */
const feishuMessageSent = new Counter({
  name: 'jerry_feishu_message_sent_total',
  help: '飞书消息发送总次数（按通道和状态）',
  labelNames: ['channel', 'status'] as const,
  registers: [metricsRegistry],
});

/** HITL 审批结果计数器 */
const hitlResolved = new Counter({
  name: 'jerry_hitl_resolved_total',
  help: 'HITL 审批结果总次数（按 action 和触发来源）',
  labelNames: ['action', 'source'] as const,
  registers: [metricsRegistry],
});

/** 多级缓存指标（Gauge：每次 scrape 时主动读取） */
const cacheL1Hits = new Gauge({
  name: 'jerry_multilevel_cache_l1_hits',
  help: '多级缓存 L1 命中次数',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheL2Hits = new Gauge({
  name: 'jerry_multilevel_cache_l2_hits',
  help: '多级缓存 L2（Redis）命中次数',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheMisses = new Gauge({
  name: 'jerry_multilevel_cache_misses',
  help: '多级缓存未命中次数',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheL2Errors = new Gauge({
  name: 'jerry_multilevel_cache_l2_errors',
  help: '多级缓存 L2 调用错误次数（Redis 故障/超时）',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheOverallHitRate = new Gauge({
  name: 'jerry_multilevel_cache_overall_hit_rate',
  help: '多级缓存整体命中率（L1+L2）/ total',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheL1Size = new Gauge({
  name: 'jerry_multilevel_cache_l1_size',
  help: '多级缓存 L1 当前条目数',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheL1MaxSize = new Gauge({
  name: 'jerry_multilevel_cache_l1_max_size',
  help: '多级缓存 L1 最大容量',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});

// ==================== 容量治理 Gauge ====================

const cacheWeightedSizeBytes = new Gauge({
  name: 'jerry_multilevel_cache_weighted_size_bytes',
  help: '缓存条目加权体积（序列化字节数之和，非真实 RSS，实际占用约为其 1.5~3 倍）',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheMaxTotalSizeBytes = new Gauge({
  name: 'jerry_multilevel_cache_max_total_size_bytes',
  help: '缓存总字节预算上限',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheAvgEntrySizeBytes = new Gauge({
  name: 'jerry_multilevel_cache_avg_entry_size_bytes',
  help: '缓存条目平均大小',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheP95EntrySizeBytes = new Gauge({
  name: 'jerry_multilevel_cache_p95_entry_size_bytes',
  help: '缓存条目大小 95 分位（检索结果长尾分布，平均值会掩盖少数巨型条目吃掉大半预算的事实）',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});
const cacheRejected = new Gauge({
  name: 'jerry_multilevel_cache_rejected',
  help: '缓存写入被拒绝次数（reason: oversize=超单条上限 / budget=撑爆总字节预算）',
  labelNames: ['namespace', 'reason'] as const,
  registers: [metricsRegistry],
});
const cacheEvicted = new Gauge({
  name: 'jerry_multilevel_cache_evicted',
  help: '缓存淘汰次数（reason: size=条目数上限 / budget=字节预算 / ttl=过期回收 / config=配置调小）',
  labelNames: ['namespace', 'reason'] as const,
  registers: [metricsRegistry],
});
const cacheCoalescedRequests = new Gauge({
  name: 'jerry_multilevel_cache_coalesced_requests',
  help: '被单飞合并掉的并发回源次数，数值越高说明缓存击穿压力越大',
  labelNames: ['namespace'] as const,
  registers: [metricsRegistry],
});

/** 缓存读取耗时分布（Histogram：P50/P99 延迟） */
const cacheGetDuration = new Histogram({
  name: 'jerry_multilevel_cache_get_duration_seconds',
  help: '多级缓存读取耗时（秒）',
  labelNames: ['namespace', 'layer'] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [metricsRegistry],
});

/** 注册的缓存实例集合（用 Map<namespace, instance> 防止重复注册） */
const registeredCaches = new Map<string, CacheStatsProvider>();

/**
 * 注册一个缓存实例，供指标采集使用。
 * 调用此函数后，每次 scrape /api/metrics 时会自动读取 instance.getStats() 填到 Gauge。
 *
 * 幂等：同 namespace 重复注册会覆盖旧实例（用于热重载场景）。
 */
function registerCacheInstance(
  namespace: string,
  instance: CacheStatsProvider,
): void {
  registeredCaches.set(namespace, instance);
}

/**
 * 同步刷新所有缓存指标。
 * 在 MetricsController 的 GET 处理函数中调用一次，再返回 register.metrics()。
 */
function refreshCacheGauges(): void {
  for (const instance of registeredCaches.values()) {
    const stats = instance.getStats();
    const labels = { namespace: stats.namespace };
    cacheL1Hits.set(labels, stats.l1Hits);
    cacheL2Hits.set(labels, stats.l2Hits);
    cacheMisses.set(labels, stats.misses);
    cacheL2Errors.set(labels, stats.l2Errors);
    cacheOverallHitRate.set(labels, stats.overallHitRate);
    cacheL1Size.set(labels, stats.l1Size);
    cacheL1MaxSize.set(labels, stats.l1MaxSize);

    // 容量治理指标都是可选字段：MultiLevelCache 没有字节预算与单飞概念，
    // 缺失时保持「序列不存在」而不是写 0 —— 写 0 会在 Grafana 上变成
    // 「这个缓存有预算且占用为零」的假信号，比缺失更难排查。
    const setIfDefined = (
      gauge: Gauge<'namespace'>,
      value: number | undefined,
    ): void => {
      if (value !== undefined) gauge.set(labels, value);
    };
    const setReasonIfDefined = (
      gauge: Gauge<'namespace' | 'reason'>,
      reason: string,
      value: number | undefined,
    ): void => {
      if (value !== undefined) gauge.set({ ...labels, reason }, value);
    };

    setIfDefined(cacheWeightedSizeBytes, stats.weightedSizeBytes);
    setIfDefined(cacheMaxTotalSizeBytes, stats.maxTotalSizeBytes);
    setIfDefined(cacheAvgEntrySizeBytes, stats.avgEntrySizeBytes);
    setIfDefined(cacheP95EntrySizeBytes, stats.p95EntrySizeBytes);
    setIfDefined(cacheCoalescedRequests, stats.coalescedRequests);

    setReasonIfDefined(cacheRejected, 'oversize', stats.rejectedOversize);
    setReasonIfDefined(cacheRejected, 'budget', stats.rejectedBudget);
    setReasonIfDefined(cacheEvicted, 'size', stats.evictedBySize);
    setReasonIfDefined(cacheEvicted, 'budget', stats.evictedByBudget);
    setReasonIfDefined(cacheEvicted, 'ttl', stats.evictedByTTL);
    setReasonIfDefined(cacheEvicted, 'config', stats.evictedByConfig);
  }
}

export const metrics = {
  feishuMessageSent,
  hitlResolved,
  registerCacheInstance,
  refreshCacheGauges,
  /** 缓存读取耗时 Histogram（供 MultiLevelCache 在 get 方法中 observe） */
  cacheGetDuration,
  /** 仅测试用：清空注册的缓存引用 */
  __resetForTest(): void {
    registeredCaches.clear();
  },
};
