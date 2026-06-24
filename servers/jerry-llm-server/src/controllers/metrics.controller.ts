/**
 * controllers/metrics.controller.ts
 *
 * 暴露 Prometheus 抓取端点 `GET /api/metrics`，返回 text/plain；version=0.0.4 格式。
 *
 * 注意：本端点不做鉴权（公司内网部署，Prometheus Server 是内部抓取器）。
 * 如果未来需要鉴权，可加 IP 白名单或 Bearer Token 校验。
 */
import { Controller, Get, Header } from '@nestjs/common';
import { metrics, metricsRegistry } from '../fundamentals/metrics.js';

@Controller('api')
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    // 主动刷新缓存 Gauge：每次 scrape 都从已注册的缓存实例读取最新统计
    metrics.refreshCacheGauges();
    return await metricsRegistry.metrics();
  }
}
