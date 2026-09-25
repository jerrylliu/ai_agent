import { Controller, Get, Post, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AppService } from './app.service.js';
import {
  getCacheStats,
  getCacheConfig,
  updateCacheConfig,
  clearCache,
} from './fundamentals/cache.js';
import {
  getRateLimiterStatus,
  getRateLimiterConfig,
  updateRateLimiterConfig,
} from './fundamentals/llm-rate-limiter.js';
import {
  CacheConfigUpdateSchema,
  RateLimiterConfigUpdateSchema,
} from './fundamentals/runtime-config.js';
import { ZodValidationPipe } from './fundamentals/zod-validation.pipe.js';
import { HealthService } from './services/health.service.js';

/**
 * 缓存 / 限流配置的入参类型（由 zod schema 推导，不另写 interface）
 */
type CacheConfigDto = z.infer<typeof CacheConfigUpdateSchema>;
type RateLimiterConfigDto = z.infer<typeof RateLimiterConfigUpdateSchema>;

/**
 * 管理类端点的限流阈值
 *
 * 全局 ThrottlerModule 是 10 次/60s，而设置面板一次打开就会并发 5 个 GET
 * （缓存统计/配置 + 限流状态/配置 + 健康检查），用户连点两次刷新就 429，
 * 且前端拿不到明确的错误提示，表现为「数据一直是旧的」。
 * 这里放宽到 120 次/60s：既解决面板误伤，又保留基础的防刷保护，
 * 不做 @SkipThrottle 全量豁免。
 */
const ADMIN_THROTTLE = { default: { ttl: 60000, limit: 120 } };

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
   * 获取缓存统计信息
   *
   * 除命中次数 / 命中率外，还包含容量治理指标：
   * 分层命中（hits / l2Hits）、加权体积与字节预算（weightedSizeKB / maxTotalSizeKB）、
   * 单条均值与 P95（avgEntrySizeKB / p95EntrySizeKB）、写入拒绝归因（rejectedOversize /
   * rejectedBudget）、淘汰归因（evictedBySize / ByBudget / ByTTL / ByConfig）、
   * 击穿压力（coalescedRequests）与 L2 健康度（l2Errors / l2Enabled）。
   */
  @Get('cache/stats')
  @Throttle(ADMIN_THROTTLE)
  getCacheStats() {
    return getCacheStats();
  }

  /**
   * GET /cache/config
   * 获取缓存当前配置
   */
  @Get('cache/config')
  @Throttle(ADMIN_THROTTLE)
  getCacheConfig() {
    return getCacheConfig();
  }

  /**
   * POST /cache/config
   * 更新缓存配置（最大条目数、单条大小上限KB、默认TTL分钟、总字节预算MB）
   *
   * 入参经 zod 严格校验：maxEntries / maxItemSizeKB / maxTotalSizeMB 必须为正整数，
   * 否则返回 400 并附带具体字段。拦住 0 是硬性要求——
   * `maxEntries: 0` 落盘后，下一次写缓存就会触发淘汰死循环使进程假死。
   *
   * maxTotalSizeMB 与 maxEntries 构成双约束：条数上限只约束「条数」，
   * 真实占用是条数 × 单条大小的乘积，单靠条数无法给内存上硬顶。
   */
  @Post('cache/config')
  @Throttle(ADMIN_THROTTLE)
  updateCacheConfig(
    @Body(
      new ZodValidationPipe(CacheConfigUpdateSchema, { label: 'CacheConfig' }),
    )
    body: CacheConfigDto,
  ) {
    updateCacheConfig(body);
    return { success: true, message: '缓存配置已更新' };
  }

  /**
   * POST /cache/clear
   * 手动清空缓存
   */
  @Post('cache/clear')
  @Throttle(ADMIN_THROTTLE)
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
  @Throttle(ADMIN_THROTTLE)
  getRateLimiterStatus() {
    return getRateLimiterStatus();
  }

  /**
   * GET /rate-limiter/config
   * 获取限流器当前配置
   */
  @Get('rate-limiter/config')
  @Throttle(ADMIN_THROTTLE)
  getRateLimiterConfig() {
    return getRateLimiterConfig();
  }

  /**
   * POST /rate-limiter/config
   * 更新限流器配置（快速池/流式池并发数、令牌等待超时、排队等待超时）
   *
   * 入参经 zod 严格校验：所有值必须为正整数，否则返回 400。
   * 池并发数为 0 会让所有 LLM 请求永久挂起，属于必须在入口拦住的故障。
   */
  @Post('rate-limiter/config')
  @Throttle(ADMIN_THROTTLE)
  updateRateLimiterConfig(
    @Body(
      new ZodValidationPipe(RateLimiterConfigUpdateSchema, {
        label: 'RateLimiterConfig',
      }),
    )
    body: RateLimiterConfigDto,
  ) {
    updateRateLimiterConfig(body);
    return { success: true, message: '限流器配置已更新' };
  }
}
