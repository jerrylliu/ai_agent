/**
 * Redis 客户端单例（lazy init + 自动降级）
 *
 * 设计目标：
 *   1. **零侵入**：业务代码通过 `getRedis()` 获取实例，未配置 / 连接失败统一返回 null
 *   2. **不阻塞主流程**：Redis 抖动时单条命令最多等 300ms（commandTimeout）
 *   3. **可观测**：连接 / 错误 / 关闭事件均有 logger 记录，便于线上排查
 *   4. **优雅关闭**：进程退出前主动 quit，让 Redis Server 清理客户端连接
 *
 * 为什么不用 NestJS 的 RedisModule？
 *   - 项目里 Redis 仅用于"缓存 + 限流 + 锁"等基础设施场景，不需要依赖注入容器
 *   - 工具函数（如 prompt.ts 里的 sessionAssetCache）不在 Nest DI 链路上，
 *     注入 Module 反而要把 logger / config 全部改造成 Service，破坏现有结构
 *   - 单例 + lazy init 已经满足需求，且更易于在测试中 mock
 *
 * 与 enableOfflineQueue=false 的取舍：
 *   ioredis 默认会把"连接未就绪"时下发的命令排队，连上后再发。这在主业务场景下
 *   会导致诡异的"超时一段时间后突然全部成功"现象。我们关掉队列，要求每条命令
 *   要么立即失败、要么立即成功，配合上层的 try/catch 降级才能可控。
 */

import Redis, { type RedisOptions } from 'ioredis';
import { config } from './config';
import { logger } from './logger';

/** ioredis 单例。null 表示未启用或初始化失败 */
let client: Redis | null = null;

/** 连接是否就绪（用于 isRedisReady 快速判断，避免每次都触发 ping） */
let ready = false;

/** 是否已尝试初始化（避免重复打印"未启用"日志） */
let initAttempted = false;

/**
 * 懒加载获取 Redis 客户端。
 *
 * 调用方应当：
 *   const redis = getRedis();
 *   if (!redis) { ...降级路径... }
 *   try { await redis.get(key); } catch { ...降级路径... }
 *
 * 注意：返回 null 或抛异常都应触发降级，二者等价。
 */
export function getRedis(): Redis | null {
  // 总开关关闭：永远返回 null（开发机零依赖体验）
  if (!config.redis.enabled) {
    if (!initAttempted) {
      initAttempted = true;
      logger.info('Redis 未启用（REDIS_ENABLED=false），所有 Redis 能力将走内存降级', {
        module: 'RedisClient',
      });
    }
    return null;
  }

  // 已初始化过：直接复用单例
  if (client) return client;

  initAttempted = true;

  const options: RedisOptions = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    keyPrefix: config.redis.keyPrefix,

    // ====== 关键容错参数 ======
    /** 单条命令超时：防止 Redis 抖动拖累 LLM 推理链路 */
    commandTimeout: config.redis.commandTimeoutMs,
    /** 最大重试次数（每条命令）：超过即抛错，触发上层降级 */
    maxRetriesPerRequest: 1,
    /**
     * 连接未就绪时是否排队命令：
     *   true（默认）—— 队列堆积，连上后批量执行（行为不可控）
     *   false（我们的选择）—— 立即报错，由 try/catch 降级
     */
    enableOfflineQueue: false,
    /** 连接重试策略：最多 5 次，间隔指数退避，封顶 3 秒 */
    retryStrategy: (times) => {
      if (times > 5) return null; // 放弃重连
      return Math.min(times * 200, 3000);
    },
    /** 进程退出时不要尝试重连 */
    reconnectOnError: (err) => {
      // READONLY 错误（主从切换）才触发重连，其他错误不重连
      return err.message.includes('READONLY');
    },
  };

  try {
    client = new Redis(options);
  } catch (e: any) {
    logger.error('Redis 客户端初始化失败', { module: 'RedisClient', err: e.message });
    return null;
  }

  // ====== 事件监听 ======
  client.on('connect', () => {
    logger.info('Redis 正在建立连接', {
      module: 'RedisClient',
      host: config.redis.host,
      port: config.redis.port,
      db: config.redis.db,
    });
  });
  client.on('ready', () => {
    ready = true;
    logger.info('Redis 连接就绪，可处理命令', { module: 'RedisClient' });
  });
  client.on('error', (err) => {
    // 注意：ioredis 会把每次重连失败都触发 error，日志可能刷屏
    // 这里降级为 warn，并截断错误信息
    ready = false;
    logger.warn('Redis 错误（将降级到内存）', {
      module: 'RedisClient',
      err: (err.message || String(err)).slice(0, 200),
    });
  });
  client.on('close', () => {
    ready = false;
    logger.warn('Redis 连接已关闭', { module: 'RedisClient' });
  });
  client.on('reconnecting', (delayMs: number) => {
    logger.info('Redis 重连中', { module: 'RedisClient', delayMs });
  });
  client.on('end', () => {
    ready = false;
    logger.warn('Redis 连接终止（不再重连）', { module: 'RedisClient' });
  });

  return client;
}

/**
 * 快速判断 Redis 是否可用（无网络开销）。
 * 业务代码用这个来决定走 Redis 还是降级路径，比 try/catch 更轻量。
 */
export function isRedisReady(): boolean {
  return ready;
}

/**
 * 优雅关闭：在进程退出 / NestJS onApplicationShutdown 钩子里调用。
 * 让 Redis Server 立刻回收 socket，避免 TCP TIME_WAIT 堆积。
 */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    // quit() 会等待"未完成命令"返回后再断开，比 disconnect() 更优雅
    await client.quit();
    logger.info('Redis 已优雅关闭', { module: 'RedisClient' });
  } catch (e: any) {
    logger.warn('Redis 关闭失败，强制断开', { module: 'RedisClient', err: e.message });
    client.disconnect();
  } finally {
    client = null;
    ready = false;
  }
}

/**
 * 仅供测试使用：重置内部单例（不要在生产代码中调用）
 * @internal
 */
export function __resetRedisClientForTest(): void {
  client = null;
  ready = false;
  initAttempted = false;
}
