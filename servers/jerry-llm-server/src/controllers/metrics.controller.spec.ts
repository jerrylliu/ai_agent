/**
 * controllers/metrics.controller.spec.ts
 *
 * 验证 /api/metrics 端点能返回 prom-client 格式文本，并主动触发 refreshCacheGauges
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../fundamentals/metrics.js', () => {
  return {
    metrics: {
      refreshCacheGauges: jest.fn(),
    },
    metricsRegistry: {
      metrics: jest.fn().mockResolvedValue(
        '# HELP jerry_test mock-only\n# TYPE jerry_test counter\njerry_test 0\n',
      ),
    },
  };
});

import { MetricsController } from './metrics.controller';
import { metrics, metricsRegistry } from '../fundamentals/metrics.js';

describe('MetricsController', () => {
  let controller: MetricsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new MetricsController();
  });

  it('应主动调用 refreshCacheGauges 然后返回 registry.metrics()', async () => {
    const text = await controller.getMetrics();
    expect(metrics.refreshCacheGauges).toHaveBeenCalledTimes(1);
    expect(metricsRegistry.metrics).toHaveBeenCalledTimes(1);
    expect(text).toContain('jerry_test');
  });
});
