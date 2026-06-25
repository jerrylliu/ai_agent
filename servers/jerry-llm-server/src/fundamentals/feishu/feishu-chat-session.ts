/**
 * 飞书会话映射（D1/D2）
 *
 * 作用：把飞书侧的 (ownerUserId, chat_type, chat_id, sender.open_id) 稳定映射到平台内部的 sessionId。
 *
 * 设计：
 *   - DB 是 source of truth，保证跨天、服务重启、Redis 清空后仍复用同一个 sessionId
 *   - Redis / 本地 Map 只做加速缓存，不再决定会话生命周期
 *   - group 默认按 chatId + senderOpenId 隔离，避免同群多人串上下文
 */
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { FeishuChatSession } from '../../entities/feishu-chat-session.entity';
import { logger } from '../logger';
import { getRedis, isRedisReady } from '../redis-client';

/** Redis key 前缀（拼在 redis-client 的 keyPrefix 之后） */
const REDIS_KEY_PREFIX = 'feishu:chat-session:';
/** Redis 加速缓存 TTL：90 天；DB 记录不过期 */
const SESSION_CACHE_TTL_SEC = 90 * 24 * 3600;

let chatSessionRepository: Repository<FeishuChatSession> | null = null;

/** 进程内降级缓存（Redis/DB 不可用时使用） */
interface LocalEntry {
  sessionId: string;
  expiresAt: number;
}
const localFallback = new Map<string, LocalEntry>();

export function initFeishuChatSessionRepository(
  repository: Repository<FeishuChatSession>,
): void {
  chatSessionRepository = repository;
}

/**
 * 根据平台内部 sessionId 查询飞书会话映射。
 * Web 端继续在飞书会话内对话时，用它定位要同步回哪个飞书聊天。
 */
export async function findFeishuChatSessionBySessionId(
  sessionId: string,
): Promise<FeishuChatSession | null> {
  if (!chatSessionRepository) return null;
  return chatSessionRepository.findOne({ where: { sessionId } });
}

/**
 * 根据平台 sessionId 删除飞书映射。
 * Web 端删除会话时调用，避免下次飞书消息把已删除会话复活。
 */
export async function deleteFeishuChatSessionBySessionId(
  sessionId: string,
  ownerUserId?: string,
): Promise<void> {
  if (!chatSessionRepository) return;
  const mapping = await chatSessionRepository.findOne({ where: { sessionId } });
  if (!mapping) return;
  // ownerUserId 存的是字符串，调用方传入可能是数字，统一转字符串比较，避免越权判断误判
  if (ownerUserId !== undefined && String(mapping.ownerUserId) !== String(ownerUserId)) return;

  localFallback.delete(buildSessionKey(mapping));
  await chatSessionRepository.delete({ id: mapping.id });

  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      await redis.del(`${REDIS_KEY_PREFIX}${buildSessionKey(mapping)}`);
    } catch {
      /* 映射删除以 DB 为准，Redis 删除失败不阻塞 */
    }
  }
}

export function parseSessionKey(sessionKey: string): {
  ownerUserId: string;
  chatType: 'p2p' | 'group';
  chatId: string;
  senderOpenId: string;
} | null {
  const parts = sessionKey.split(':');
  let ownerUserId = 'default';
  let cursor = 0;

  if (parts[0] === 'owner') {
    ownerUserId = parts[1] || 'default';
    cursor = 2;
  }

  const chatType = parts[cursor];
  if (chatType === 'p2p') {
    const senderOpenId = parts[cursor + 1];
    if (!senderOpenId) return null;
    return {
      ownerUserId,
      chatType,
      chatId: `p2p:${senderOpenId}`,
      senderOpenId,
    };
  }

  if (chatType === 'group') {
    const chatId = parts[cursor + 1];
    const senderOpenId = parts[cursor + 2];
    if (!chatId || !senderOpenId) return null;
    return { ownerUserId, chatType, chatId, senderOpenId };
  }

  return null;
}

/** 拼接 sessionKey */
export function buildSessionKey(params: {
  chatType: 'p2p' | 'group';
  chatId: string;
  senderOpenId: string;
  ownerUserId?: string;
}): string {
  const ownerPrefix = params.ownerUserId ? `owner:${params.ownerUserId}:` : '';
  if (params.chatType === 'p2p') {
    return `${ownerPrefix}p2p:${params.senderOpenId}`;
  }
  return `${ownerPrefix}group:${params.chatId}:${params.senderOpenId}`;
}

/**
 * 取或创建飞书 chat 到 sessionId 的映射
 *
 * @returns 平台内部 sessionId（uuid v4）
 */
export async function getOrCreateChatSession(
  sessionKey: string,
): Promise<string> {
  const redis = getRedis();
  const redisKey = `${REDIS_KEY_PREFIX}${sessionKey}`;
  const identity = parseSessionKey(sessionKey);

  // 1) DB 是 source of truth；Redis 只在 DB 未注入时作为兼容缓存使用
  if (!chatSessionRepository && redis && isRedisReady()) {
    try {
      const cached = await redis.get(redisKey);
      if (cached) {
        await redis.expire(redisKey, SESSION_CACHE_TTL_SEC).catch(() => {});
        return cached;
      }
    } catch (e: any) {
      logger.warn('飞书会话：Redis 读取失败，继续查 DB', {
        module: 'FeishuChatSession',
        sessionKey,
        err: (e?.message || String(e)).slice(0, 200),
      });
    }
  }

  if (chatSessionRepository && identity) {
    try {
      const existing = await chatSessionRepository.findOne({ where: identity });
      if (existing) {
        existing.lastActiveAt = new Date();
        await chatSessionRepository.save(existing);
        await cacheSessionMapping(sessionKey, existing.sessionId);
        return existing.sessionId;
      }

      const sessionId = randomUUID();
      const entity = chatSessionRepository.create({
        ...identity,
        sessionId,
        lastActiveAt: new Date(),
      });
      try {
        await chatSessionRepository.save(entity);
      } catch (saveError) {
        const raced = await chatSessionRepository.findOne({ where: identity });
        if (raced) {
          await cacheSessionMapping(sessionKey, raced.sessionId);
          return raced.sessionId;
        }
        throw saveError;
      }
      await cacheSessionMapping(sessionKey, sessionId);
      logger.info('飞书会话：DB 创建新映射', {
        module: 'FeishuChatSession',
        sessionKey,
        sessionId,
      });
      return sessionId;
    } catch (e: any) {
      logger.warn('飞书会话：DB 操作失败，降级到本地 Map', {
        module: 'FeishuChatSession',
        sessionKey,
        err: (e?.message || String(e)).slice(0, 200),
      });
    }
  }

  // 2) 进程内 fallback：仅在 DB 未注入/异常时使用
  const now = Date.now();
  const local = localFallback.get(sessionKey);
  if (local && local.expiresAt > now) {
    local.expiresAt = now + SESSION_CACHE_TTL_SEC * 1000;
    return local.sessionId;
  }
  const sessionId = randomUUID();
  localFallback.set(sessionKey, {
    sessionId,
    expiresAt: now + SESSION_CACHE_TTL_SEC * 1000,
  });
  logger.info('飞书会话：本地 Map 创建新映射', {
    module: 'FeishuChatSession',
    sessionKey,
    sessionId,
  });
  return sessionId;
}

async function cacheSessionMapping(sessionKey: string, sessionId: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisReady()) return;
  try {
    await redis.set(
      `${REDIS_KEY_PREFIX}${sessionKey}`,
      sessionId,
      'EX',
      SESSION_CACHE_TTL_SEC,
    );
  } catch {
    // 缓存失败不影响 DB 映射
  }
}

/**
 * 主动清除某个 chat 的会话映射（用户主动发送 /reset 等指令时调用）
 */
export async function clearChatSession(sessionKey: string): Promise<void> {
  localFallback.delete(sessionKey);
  const identity = parseSessionKey(sessionKey);
  if (chatSessionRepository && identity) {
    await chatSessionRepository.delete(identity).catch(() => {});
  }

  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      await redis.del(`${REDIS_KEY_PREFIX}${sessionKey}`);
    } catch {
      /* 静默降级，本地已清 */
    }
  }
}

/** 仅测试用：重置本地 fallback */
export function __resetLocalChatSessionCacheForTest(): void {
  localFallback.clear();
  chatSessionRepository = null;
}
