/**
 * fundamentals/metrics.spec.ts
 *
 * Prometheus 指标注册中心单元测试
 * 覆盖：
 *   1. metricsRegistry 暴露 3 类核心指标
 *   2. feishuMessageSent 计数器累加
 *   3. hitlResolved 计数器累加
 *   4. registerCacheInstance + refreshCacheGauges 联动
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

import { metrics, metricsRegistry } from './metrics';

describe('metrics', () => {
  beforeEach(() => {
    // 重置所有计数器（prom-client 计数器无法回退，但可以重置所有指标）
    // 通过 reset 各个指标实现
    metrics.feishuMessageSent.reset();
    metrics.hitlResolved.reset();
    metrics.__resetForTest();
  });

  describe('注册的指标', () => {
    it('应包含 feishu/HITL/multilevel-cache 三类指标', async () => {
      const all = await metricsRegistry.metrics();
      expect(all).toContain('jerry_feishu_message_sent_total');
      expect(all).toContain('jerry_hitl_resolved_total');
      expect(all).toContain('jerry_multilevel_cache_l1_hits');
      expect(all).toContain('jerry_multilevel_cache_overall_hit_rate');
      expect(all).toContain('jerry_multilevel_cache_l1_size');
      expect(all).toContain('jerry_multilevel_cache_l1_max_size');
      expect(all).toContain('jerry_multilevel_cache_get_duration_seconds');
    });

    it('应包含 Node.js 默认指标（CPU/内存）', async () => {
      const all = await metricsRegistry.metrics();
      expect(all).toContain('jerry_process_cpu_user_seconds_total');
      expect(all).toContain('jerry_nodejs_eventloop_lag_seconds');
    });
  });

  describe('feishuMessageSent', () => {
    it('应支持按 channel 和 status 累加', async () => {
      metrics.feishuMessageSent.inc({ channel: 'card', status: 'success' });
      metrics.feishuMessageSent.inc({ channel: 'card', status: 'success' });
      metrics.feishuMessageSent.inc({ channel: 'image', status: 'failure' });

      const text = await metricsRegistry.metrics();
      expect(text).toMatch(/jerry_feishu_message_sent_total\{channel="card",status="success"\} 2/);
      expect(text).toMatch(/jerry_feishu_message_sent_total\{channel="image",status="failure"\} 1/);
    });
  });

  describe('hitlResolved', () => {
    it('应区分 web/feishu 两种来源', async () => {
      metrics.hitlResolved.inc({ action: 'confirm', source: 'web' });
      metrics.hitlResolved.inc({ action: 'confirm', source: 'feishu' });
      metrics.hitlResolved.inc({ action: 'timeout', source: 'web' });

      const text = await metricsRegistry.metrics();
      expect(text).toMatch(/jerry_hitl_resolved_total\{action="confirm",source="web"\} 1/);
      expect(text).toMatch(/jerry_hitl_resolved_total\{action="confirm",source="feishu"\} 1/);
      expect(text).toMatch(/jerry_hitl_resolved_total\{action="timeout",source="web"\} 1/);
    });
  });

  describe('registerCacheInstance + refreshCacheGauges', () => {
    it('refresh 后 Gauge 应反映 getStats 结果', async () => {
      const fakeCache = {
        getStats: () => ({
          namespace: 'test-cache',
          l1Hits: 10,
          l2Hits: 3,
          misses: 2,
          l2Errors: 1,
          total: 15,
          l1HitRate: 0.6667,
          overallHitRate: 0.8667,
          l1Size: 100,
          l1MaxSize: 500,
        }),
      };
      metrics.registerCacheInstance('test-cache', fakeCache);
      metrics.refreshCacheGauges();

      const text = await metricsRegistry.metrics();
      expect(text).toMatch(/jerry_multilevel_cache_l1_hits\{namespace="test-cache"\} 10/);
      expect(text).toMatch(/jerry_multilevel_cache_l2_hits\{namespace="test-cache"\} 3/);
      expect(text).toMatch(/jerry_multilevel_cache_misses\{namespace="test-cache"\} 2/);
      expect(text).toMatch(/jerry_multilevel_cache_l2_errors\{namespace="test-cache"\} 1/);
      expect(text).toMatch(/jerry_multilevel_cache_overall_hit_rate\{namespace="test-cache"\} 0.8667/);
      expect(text).toMatch(/jerry_multilevel_cache_l1_size\{namespace="test-cache"\} 100/);
      expect(text).toMatch(/jerry_multilevel_cache_l1_max_size\{namespace="test-cache"\} 500/);
    });

    it('多个 namespace 应独立统计', async () => {
      metrics.registerCacheInstance('a', {
        getStats: () => ({
          namespace: 'a',
          l1Hits: 1,
          l2Hits: 0,
          misses: 0,
          l2Errors: 0,
          total: 1,
          l1HitRate: 1,
          overallHitRate: 1,
          l1Size: 1,
          l1MaxSize: 100,
        }),
      });
      metrics.registerCacheInstance('b', {
        getStats: () => ({
          namespace: 'b',
          l1Hits: 5,
          l2Hits: 0,
          misses: 0,
          l2Errors: 0,
          total: 5,
          l1HitRate: 1,
          overallHitRate: 1,
          l1Size: 1,
          l1MaxSize: 100,
        }),
      });
      metrics.refreshCacheGauges();

      const text = await metricsRegistry.metrics();
      expect(text).toMatch(/jerry_multilevel_cache_l1_hits\{namespace="a"\} 1/);
      expect(text).toMatch(/jerry_multilevel_cache_l1_hits\{namespace="b"\} 5/);
    });

    it('相同 namespace 重复注册应覆盖（幂等）', async () => {
      metrics.registerCacheInstance('same', {
        getStats: () => ({
          namespace: 'same',
          l1Hits: 100,
          l2Hits: 0,
          misses: 0,
          l2Errors: 0,
          total: 100,
          l1HitRate: 1,
          overallHitRate: 1,
          l1Size: 1,
          l1MaxSize: 100,
        }),
      });
      metrics.registerCacheInstance('same', {
        getStats: () => ({
          namespace: 'same',
          l1Hits: 999,
          l2Hits: 0,
          misses: 0,
          l2Errors: 0,
          total: 999,
          l1HitRate: 1,
          overallHitRate: 1,
          l1Size: 1,
          l1MaxSize: 100,
        }),
      });
      metrics.refreshCacheGauges();
      const text = await metricsRegistry.metrics();
      expect(text).toMatch(/jerry_multilevel_cache_l1_hits\{namespace="same"\} 999/);
    });
  });
});
