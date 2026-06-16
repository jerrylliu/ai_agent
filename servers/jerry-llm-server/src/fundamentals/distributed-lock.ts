/**
 * 分布式锁（基于 Redis SET NX EX）
 *
 * ============================================================================
 * 适用场景：
 *   1. **会话级互斥**：同一个 sessionId 不能并发执行多个 LLM 请求
 *      （前端用户连点 send，第二次请求应被锁挡掉，避免乱序回复 / Token 浪费）
 *   2. **定时任务防重**：多实例部署时，cron 任务只让一个实例执行
 *   3. **资源独占操作**：例如"清空知识库"这种全局动作
 *
 * ============================================================================
 * 核心原理：
 *   SET key uniqueValue NX EX 30
 *     - NX：仅当 key 不存在时设置（互斥）
 *     - EX 30：30 秒后自动过期（防死锁，进程崩溃时锁会自释放）
 *     - uniqueValue：锁持有者的唯一标识（释放时校验，防止误删别人的锁）
 *
 * ============================================================================
 * 三大要素（参考 Redlock 论文）：
 *   1. **互斥**（Mutual Exclusion）：任何时刻只有一个客户端持有锁 ← SET NX
 *   2. **防死锁**（Deadlock Free）：持有者崩溃后锁自动释放 ← EX
 *   3. **容错**（Fault Tolerance）：Redis 主节点故障时降级 ← 业务侧降级
 *
 * ============================================================================
 * 释放锁为什么要用 Lua 脚本？
 *
 *   错误做法：
 *     if (redis.get(key) === myValue) redis.del(key);  // 非原子！
 *
 *   竞态场景：
 *     T1: GET 拿到 myValue，准备 DEL
 *     T2: 锁在 GET 和 DEL 之间过期，被 T3 重新获取，新值 = otherValue
 *     T1: DEL 删掉了 T3 的锁 ← Bug！
 *
 *   正确做法：用 Lua 脚本把 GET + DEL 包成原子操作。
 *
 * ============================================================================
 * 局限与适用边界：
 *   - 单 Redis 节点：主从切换瞬间可能丢锁 → 严格场景需用 Redlock 算法（多节点投票）
 *   - 业务超过 TTL：例如锁了 30s，业务跑了 35s，第 30s 锁被自动释放 → 第 31s 别人拿到锁，
 *     此时 T1 还在执行，会造成"双重持锁" → 进阶方案是 watchdog 自动续期（如 Redisson）
 *   - 当前项目：单 Redis 节点 + 业务执行时间可控（LLM 流式响应一般 < 30s），
 *     SET NX EX 已经够用，不需要 Redlock 的复杂度。
 *
 * ============================================================================
 * 使用示例：
 *   const lock = await acquireLock(`session:${sessionId}`, 30);
 *   if (!lock) throw new Error('该会话正在处理中，请稍后再试');
 *   try {
 *     // 业务逻辑（必须在 ttlSec 内完成，否则锁会自动释放）
 *   } finally {
 *     await lock.release();
 *   }
 */

import { logger } from './logger';
import { getRedis, isRedisReady } from './redis-client';
import { randomBytes } from 'crypto';

/** 锁释放结果 */
export interface DistributedLock {
  /** 锁 key（含 namespace） */
  key: string;
  /** 锁持有者唯一标识 */
  token: string;
  /** 锁 TTL（秒），用于上层判断业务是否需要主动续期 */
  ttlSec: number;
  /**
   * 释放锁。返回 true 表示成功释放，false 表示锁已经被别人持有（不会误删）。
   * 推荐放在 finally 里，保证异常时锁也能释放。
   */
  release: () => Promise<boolean>;
}

/**
 * 释放锁的 Lua 脚本：原子地"校验持有者 + 删除 key"
 * KEYS[1] = 锁 key
 * ARGV[1] = 期望的 token 值
 *
 * 返回 1 = 成功删除（锁是自己的）
 * 返回 0 = 没删（锁不是自己的或已过期）
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/**
 * 续期锁的 Lua 脚本：仅当锁仍属于自己时才续期
 * KEYS[1] = 锁 key
 * ARGV[1] = 期望的 token 值
 * ARGV[2] = 新 TTL（秒）
 *
 * 返回 1 = 续期成功
 * 返回 0 = 锁不是自己的或已过期
 */
const RENEW_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * 尝试获取分布式锁。
 *
 * @param namespace 锁的命名空间，建议用业务语义命名，如 'session:{id}' / 'cron:summary'
 * @param ttlSec    锁的最大持有时间（秒），到期自动释放。建议设为业务最长执行时间的 1.5 ~ 2 倍
 * @returns 成功返回 DistributedLock，失败（锁已被持有 / Redis 不可用）返回 null
 *
 * 设计取舍：
 *   - 不阻塞等待：单次获取，失败立刻返回 null。需要重试请由调用方决定（避免封装过多策略）
 *   - 不抛异常：用 null 表达"获取失败"，业务用 if 判断更直观
 *   - Redis 不可用 → 返回 null：默认 fail-close（更安全，避免重复执行关键操作）
 *     如果业务希望降级（如非关键定时任务），可以在 catch null 后选择继续执行
 */
export async function acquireLock(
  namespace: string,
  ttlSec: number = 30,
): Promise<DistributedLock | null> {
  const redis = getRedis();
  if (!redis || !isRedisReady()) {
    logger.warn('DistributedLock: Redis 不可用，无法获取锁', {
      module: 'DistributedLock',
      namespace,
    });
    return null;
  }

  // 锁的唯一持有者标识：随机 16 字节 hex（32 字符）
  // 用 randomBytes 而不是 Math.random，避免高并发场景下的碰撞
  const token = randomBytes(16).toString('hex');
  const key = `lock:${namespace}`;

  try {
    // SET key value NX EX ttl：原子性地"互斥获取 + 设置过期时间"
    // 不能拆成 SETNX + EXPIRE 两步，否则进程在两步之间崩溃会导致死锁
    const result = await redis.set(key, token, 'EX', ttlSec, 'NX');
    if (result !== 'OK') {
      // 锁已被别人持有
      logger.debug('DistributedLock: 锁被占用', {
        module: 'DistributedLock',
        namespace,
      });
      return null;
    }

    logger.debug('DistributedLock: 获取锁成功', {
      module: 'DistributedLock',
      namespace,
      ttlSec,
    });

    return {
      key,
      token,
      ttlSec,
      release: async () => releaseLock(key, token),
    };
  } catch (e: any) {
    logger.warn('DistributedLock: 获取锁异常', {
      module: 'DistributedLock',
      namespace,
      err: (e.message || String(e)).slice(0, 200),
    });
    return null;
  }
}

/**
 * 释放锁（内部函数，调用方应使用 lock.release()）
 *
 * 安全释放：用 Lua 脚本原子地"校验 token + 删除 key"，防止误删别人的锁。
 */
async function releaseLock(key: string, token: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis || !isRedisReady()) {
    logger.warn('DistributedLock: Redis 不可用，无法释放锁（将随 TTL 自动过期）', {
      module: 'DistributedLock',
      key,
    });
    return false;
  }

  try {
    // ioredis 的 eval：(script, numKeys, ...keysAndArgs)
    const result = (await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token)) as number;
    if (result === 1) {
      logger.debug('DistributedLock: 释放锁成功', { module: 'DistributedLock', key });
      return true;
    }
    // 0 = 锁不是自己的（已过期 / 被别人覆盖）；不算错误，但要记录便于排查超时问题
    logger.warn('DistributedLock: 释放锁失败（锁不属于当前持有者，可能已过期）', {
      module: 'DistributedLock',
      key,
    });
    return false;
  } catch (e: any) {
    logger.warn('DistributedLock: 释放锁异常', {
      module: 'DistributedLock',
      key,
      err: (e.message || String(e)).slice(0, 200),
    });
    return false;
  }
}

/**
 * 续期锁：业务执行时间不确定时，定期调用本函数延长锁。
 *
 * 推荐方案（Redisson watchdog）：
 *   - acquireLock 后启动定时器，每 ttlSec/3 秒续期一次
 *   - release 时停止定时器
 *
 * 当前实现没自动启 watchdog，由业务侧决定是否调用，避免增加心智负担。
 */
export async function renewLock(lock: DistributedLock, newTtlSec?: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis || !isRedisReady()) return false;
  const ttl = newTtlSec ?? lock.ttlSec;
  try {
    const result = (await redis.eval(RENEW_LOCK_SCRIPT, 1, lock.key, lock.token, ttl)) as number;
    return result === 1;
  } catch (e: any) {
    logger.warn('DistributedLock: 续期锁异常', {
      module: 'DistributedLock',
      key: lock.key,
      err: (e.message || String(e)).slice(0, 200),
    });
    return false;
  }
}

/**
 * 高阶 API：用锁包裹一段异步逻辑。
 * 自动 acquire + try/finally release，避免业务方忘记释放。
 *
 * @returns 业务函数返回值；获取锁失败抛出 LockBusyError
 */
export class LockBusyError extends Error {
  constructor(namespace: string) {
    super(`Lock busy: ${namespace}`);
    this.name = 'LockBusyError';
  }
}

export async function withLock<T>(
  namespace: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(namespace, ttlSec);
  if (!lock) throw new LockBusyError(namespace);
  try {
    return await fn();
  } finally {
    // 即使业务抛异常，也要释放锁
    await lock.release();
  }
}
