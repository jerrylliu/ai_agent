/**
 * 速率限制 Guard（基于 Redis 的滑动窗口算法）
 *
 * ============================================================================
 * 为什么要限流？
 * ----------------------------------------------------------------------------
 * AI 对话接口每次请求都会调用 LLM（DeepSeek/智谱/Ollama），有以下风险：
 *   1. **算力滥用**：恶意脚本刷接口，占用 GPU/CPU，导致正常用户排队
 *   2. **Token 成本**：DeepSeek/智谱按 Token 计费，恶意刷取直接烧钱
 *   3. **DDoS 防护**：单 IP / 单用户高频请求需要兜底拦截
 *
 * ============================================================================
 * 算法选型对比：
 *   1. **固定窗口（Fixed Window）**：每分钟计数清零
 *      ✗ 临界突刺：59 秒发 30 次 + 01 秒发 30 次 = 2 秒内发 60 次
 *
 *   2. **滑动窗口（Sliding Window，本实现采用）**：用 ZSET 记录每次请求的时间戳
 *      ✓ 平滑限流，无临界突刺
 *      ✓ Redis ZSET + ZREMRANGEBYSCORE 原子操作天然支持
 *      ✗ 内存占用比固定窗口大（每个请求一个 ZSET 成员）
 *
 *   3. **令牌桶（Token Bucket）**：按速率匀速放令牌，请求消费令牌
 *      ✓ 允许小幅突发，平均速率稳定
 *      ✗ Redis 实现需要 Lua 脚本保证原子性，复杂度高
 *
 *   4. **漏桶（Leaky Bucket）**：请求排队，按固定速率出队
 *      ✓ 强制平滑，下游压力恒定
 *      ✗ 不适合 LLM 场景（请求需要立即返回成功/失败，不能排队）
 *
 * 我们选滑动窗口：实现简单、无突刺、对 LLM 场景友好。
 *
 * ============================================================================
 * 核心实现（伪代码）：
 *   key = `rate-limit:chat:{userId}`
 *   now = Date.now()
 *   windowStart = now - 60000  // 1分钟窗口
 *
 *   // ① 删除窗口外的旧记录
 *   ZREMRANGEBYSCORE key -inf windowStart
 *   // ② 统计窗口内请求数
 *   count = ZCARD key
 *   if (count >= limit) reject
 *   // ③ 记录本次请求
 *   ZADD key now `${now}-${random}`
 *   // ④ 设置 key 过期，避免空 key 堆积
 *   EXPIRE key 60
 *
 * 用 MULTI 把 ①②③④ 包成事务，保证原子性。
 * （更进一步的优化：用 Lua 脚本，但事务已能满足，不引入额外复杂度）
 *
 * ============================================================================
 * 降级策略：
 *   - Redis 不可用时，按 config.rateLimit.failOpen 决策：
 *     - true（默认）：放行，避免限流组件故障导致全员被拒（用户体验优先）
 *     - false：拒绝，安全优先（金融等强合规场景适用）
 *
 * ============================================================================
 * 响应头：
 *   - X-RateLimit-Limit: 限流上限
 *   - X-RateLimit-Remaining: 剩余可用次数
 *   - X-RateLimit-Reset: 窗口重置时间（Unix 时间戳，秒）
 *   - Retry-After: 触发限流时返回，提示客户端多久后重试（秒）
 */

import { CanActivate, ExecutionContext, Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { config } from '../fundamentals/config';
import { logger } from '../fundamentals/logger';
import { getRedis, isRedisReady } from '../fundamentals/redis-client';

/** 限流窗口大小（毫秒）。1 分钟窗口对应 chatPerMin 配置项 */
const WINDOW_MS = 60_000;

@Injectable()
export class RateLimitGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // chatPerMin = 0 视为关闭限流（开发 / 内部环境可能需要）
    const limit = config.rateLimit.chatPerMin;
    if (limit <= 0) return true;

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // userId 由前置的 OptionalAuthGuard 注入；未登录用户用 IP 兜底
    // 注意：要让 RateLimitGuard 在 OptionalAuthGuard 之后执行，请在 Controller 上
    //       @UseGuards(OptionalAuthGuard, RateLimitGuard) 按顺序声明
    const userId = request.userId || 'anonymous';
    const clientIp = (request.ip || request.headers['x-forwarded-for'] || 'unknown').toString().split(',')[0].trim();
    // 已登录：按 userId 限流；未登录：按 IP 限流（防 default 用户互相影响）
    const subject = userId !== 'default' && userId !== 'anonymous' ? `u:${userId}` : `ip:${clientIp}`;

    const redis = getRedis();
    if (!redis || !isRedisReady()) {
      // Redis 不可用 —— 按降级策略决策
      if (config.rateLimit.failOpen) {
        logger.debug('RateLimit: Redis 不可用，fail-open 放行', {
          module: 'RateLimitGuard',
          subject,
        });
        return true;
      }
      throw new HttpException(
        { success: false, message: '限流服务暂不可用，请稍后再试' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    const redisKey = `rate-limit:chat:${subject}`;
    // ZSET 成员唯一性要求：用 时间戳-随机数 拼接，避免同一毫秒多个请求被去重
    const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      // ====== 用 multi 事务保证 4 个命令原子执行 ======
      const pipe = redis.multi();
      pipe.zremrangebyscore(redisKey, '-inf', windowStart); // ① 清除过期记录
      pipe.zcard(redisKey); // ② 统计当前窗口内的请求数（先于 ZADD，所以不计入本次）
      pipe.zadd(redisKey, now, member); // ③ 记录本次请求
      pipe.expire(redisKey, Math.ceil(WINDOW_MS / 1000) + 5); // ④ 兜底过期时间，多 5 秒余量

      const results = await pipe.exec();
      if (!results) {
        // 事务被打断（极少见，连接断开等场景）
        return this.handleRedisFailure(subject);
      }

      // results[1] 是 zcard 的返回值；ioredis 返回 [err, value][]
      const [zcardErr, currentCount] = results[1] as [Error | null, number];
      if (zcardErr) {
        return this.handleRedisFailure(subject);
      }

      const used = (currentCount as number) + 1; // +1 因为本次刚入队
      const remaining = Math.max(0, limit - used);
      // 设置标准响应头，便于前端展示与重试控制
      response.setHeader('X-RateLimit-Limit', String(limit));
      response.setHeader('X-RateLimit-Remaining', String(remaining));
      response.setHeader('X-RateLimit-Reset', String(Math.ceil((now + WINDOW_MS) / 1000)));

      if (used > limit) {
        // 超限：本次请求已经被 ZADD 进去了，但仍然要拒绝
        // 注意：不回滚 ZADD —— 即使本次被拒，恶意请求也算计数（更安全）
        const retryAfterSec = Math.ceil(WINDOW_MS / 1000);
        response.setHeader('Retry-After', String(retryAfterSec));

        logger.warn('RateLimit: 触发限流', {
          module: 'RateLimitGuard',
          subject,
          used,
          limit,
        });
        throw new HttpException(
          {
            success: false,
            message: `请求过于频繁，请 ${retryAfterSec} 秒后再试`,
            limit,
            used,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (e: any) {
      // HttpException（限流命中）原样抛出
      if (e instanceof HttpException) throw e;
      // 其他 Redis 异常：降级
      logger.warn('RateLimit: Redis 操作异常，触发降级', {
        module: 'RateLimitGuard',
        subject,
        err: (e.message || String(e)).slice(0, 200),
      });
      return this.handleRedisFailure(subject);
    }
  }

  private handleRedisFailure(subject: string): boolean {
    if (config.rateLimit.failOpen) {
      logger.debug('RateLimit: fail-open 放行', { module: 'RateLimitGuard', subject });
      return true;
    }
    throw new HttpException(
      { success: false, message: '限流服务暂不可用，请稍后再试' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
