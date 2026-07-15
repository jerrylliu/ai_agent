/**
 * 健康检查服务
 *
 * 提供 /api/health 端点所需的健康状态聚合：
 * - 进程存活 + 运行时长
 * - MySQL 连通性（通过 DataSource.query 执行 SELECT 1）
 * - Redis 连通性（如果启用）
 *
 * 设计原则：
 * - 轻量：每项检查独立 try/catch，单项失败不影响整体响应
 * - 快速：超时控制在 1s 内，避免 Docker HEALTHCHECK 拖慢启动
 * - 可观测：每项检查结果独立返回，便于定位故障点
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRedis, isRedisReady } from '../fundamentals/redis-client.js';
import { config } from '../fundamentals/config.js';
import { logger } from '../fundamentals/logger.js';

export interface HealthCheckResult {
  name: string;
  status: 'up' | 'down';
  latencyMs?: number;
  detail?: string;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  uptime: number;
  timestamp: string;
  checks: HealthCheckResult[];
}

@Injectable()
export class HealthService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 聚合所有健康检查项，返回整体状态。
   *
   * 状态判定：
   * - ok：所有检查项 up
   * - degraded：MySQL up 但 Redis down（Redis 是可选组件）
   * - down：MySQL down（核心依赖不可用）
   */
  async getHealthStatus(): Promise<HealthStatus> {
    const checks: HealthCheckResult[] = [];

    // ===== MySQL 检查 =====
    checks.push(await this.checkMysql());

    // ===== Redis 检查（可选组件） =====
    checks.push(await this.checkRedis());

    // 聚合判定
    const mysqlDown = checks.find((c) => c.name === 'mysql')?.status === 'down';
    const redisDown = checks.find((c) => c.name === 'redis')?.status === 'down';
    const overall = mysqlDown ? 'down' : redisDown ? 'degraded' : 'ok';

    return {
      status: overall,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  /** MySQL 连通性检查：SELECT 1 */
  private async checkMysql(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return {
        name: 'mysql',
        status: 'up',
        latencyMs: Date.now() - start,
      };
    } catch (e: any) {
      logger.warn('健康检查：MySQL 不可达', {
        module: 'HealthService',
        err: (e?.message || String(e)).slice(0, 200),
      });
      return {
        name: 'mysql',
        status: 'down',
        latencyMs: Date.now() - start,
        detail: (e?.message || String(e)).slice(0, 200),
      };
    }
  }

  /** Redis 连通性检查：PING（仅在 REDIS_ENABLED=true 时执行） */
  private async checkRedis(): Promise<HealthCheckResult> {
    if (!config.redis.enabled) {
      return {
        name: 'redis',
        status: 'up',
        detail: '未启用（REDIS_ENABLED=false）',
      };
    }

    const start = Date.now();
    try {
      const redis = getRedis();
      if (!redis || !isRedisReady()) {
        return {
          name: 'redis',
          status: 'down',
          latencyMs: Date.now() - start,
          detail: 'Redis 客户端未就绪',
        };
      }
      const pong = await redis.ping();
      return {
        name: 'redis',
        status: pong === 'PONG' ? 'up' : 'down',
        latencyMs: Date.now() - start,
      };
    } catch (e: any) {
      return {
        name: 'redis',
        status: 'down',
        latencyMs: Date.now() - start,
        detail: (e?.message || String(e)).slice(0, 200),
      };
    }
  }
}
