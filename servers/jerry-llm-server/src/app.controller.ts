import { Controller, Get, Post, Body } from '@nestjs/common';
import { AppService } from './app.service.js';
import { getCacheStats, getCacheConfig, updateCacheConfig, clearCache } from './fundamentals/cache.js';
import { getRateLimiterStatus, getRateLimiterConfig, updateRateLimiterConfig } from './fundamentals/llm-rate-limiter.js';
import { HealthService } from './services/health.service.js';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // ==================== 健康检查 ====================

  /**
   * GET /api/health
   * 健康检查端点（供 Docker HEALTHCHECK / 负载均衡探活使用）
   * 返回进程存活、MySQL / Redis 连通性状态
   */
  @Get('api/health')
  async getHealth() {
    return this.healthService.getHealthStatus();
  }

  // ==================== 缓存管理接口 ====================

  /**
   * GET /cache/stats
   * 获取缓存统计信息（命中次数、命中率、内存占用等）
   */
  @Get('cache/stats')
  getCacheStats() {
    return getCacheStats();
  }

  /**
   * GET /cache/config
   * 获取缓存当前配置
   */
  @Get('cache/config')
  getCacheConfig() {
    return getCacheConfig();
  }

  /**
   * POST /cache/config
   * 更新缓存配置（最大条目数、单条大小上限KB、默认TTL分钟）
   */
  @Post('cache/config')
  updateCacheConfig(
    @Body() body: { maxEntries?: number; maxItemSizeKB?: number; defaultTTLMinutes?: number },
  ) {
    updateCacheConfig(body);
    return { success: true, message: '缓存配置已更新' };
  }

  /**
   * POST /cache/clear
   * 手动清空缓存
   */
  @Post('cache/clear')
  clearCache() {
    clearCache('API 手动清空');
    return { success: true, message: '缓存已清空' };
  }

  // ==================== 限流管理接口 ====================

  /**
   * GET /rate-limiter/status
   * 获取限流器状态（各池并发数、队列长度、令牌桶余量）
   */
  @Get('rate-limiter/status')
  getRateLimiterStatus() {
    return getRateLimiterStatus();
  }

  /**
   * GET /rate-limiter/config
   * 获取限流器当前配置
   */
  @Get('rate-limiter/config')
  getRateLimiterConfig() {
    return getRateLimiterConfig();
  }

  /**
   * POST /rate-limiter/config
   * 更新限流器配置（快速池/流式池并发数、超时时间）
   */
  @Post('rate-limiter/config')
  updateRateLimiterConfig(
    @Body() body: { fastPoolMax?: number; streamingPoolMax?: number; tokenWaitTimeout?: number },
  ) {
    updateRateLimiterConfig(body);
    return { success: true, message: '限流器配置已更新' };
  }
}
