/**
 * feishu-chat-session 单测
 *
 * 覆盖：
 *   - p2p / group sessionKey 拼接
 *   - 本地 fallback：首次创建 / 二次复用 / TTL 续期
 *   - clearChatSession 清理
 *
 * Redis 路径走"未就绪"分支，集中验证降级到本地 Map 的行为。
 */
jest.mock('../redis-client', () => ({
  getRedis: () => null,
  isRedisReady: () => false,
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  buildSessionKey,
  parseSessionKey,
  getOrCreateChatSession,
  clearChatSession,
  deleteFeishuChatSessionBySessionId,
  initFeishuChatSessionRepository,
  __resetLocalChatSessionCacheForTest,
} from './feishu-chat-session';

describe('feishu-chat-session', () => {
  beforeEach(() => {
    __resetLocalChatSessionCacheForTest();
  });

  describe('buildSessionKey / parseSessionKey', () => {
    it('p2p 场景：key 只含 sender open_id', () => {
      const key = buildSessionKey({
        chatType: 'p2p',
        chatId: 'oc_xxx',
        senderOpenId: 'ou_alice',
      });
      expect(key).toBe('p2p:ou_alice');
    });

    it('group 场景：key 包含 chatId + senderOpenId（隔离群成员）', () => {
      const key = buildSessionKey({
        chatType: 'group',
        chatId: 'oc_team_42',
        senderOpenId: 'ou_alice',
      });
      expect(key).toBe('group:oc_team_42:ou_alice');
    });

    it('同群两个不同成员 → 不同 sessionKey（各自独立上下文）', () => {
      const k1 = buildSessionKey({
        chatType: 'group',
        chatId: 'oc_team',
        senderOpenId: 'ou_alice',
      });
      const k2 = buildSessionKey({
        chatType: 'group',
        chatId: 'oc_team',
        senderOpenId: 'ou_bob',
      });
      expect(k1).not.toBe(k2);
    });

    it('同一个飞书聊天切换项目用户 → 不同 sessionKey（避免 session.owner 串号）', () => {
      const k1 = buildSessionKey({
        chatType: 'p2p',
        chatId: 'oc_xxx',
        senderOpenId: 'ou_alice',
        ownerUserId: 'default',
      });
      const k2 = buildSessionKey({
        chatType: 'p2p',
        chatId: 'oc_xxx',
        senderOpenId: 'ou_alice',
        ownerUserId: '15',
      });
      expect(k1).toBe('owner:default:p2p:ou_alice');
      expect(k2).toBe('owner:15:p2p:ou_alice');
      expect(k1).not.toBe(k2);
    });

    it('能从 sessionKey 解析出 DB 唯一键', () => {
      expect(parseSessionKey('owner:15:group:oc_team:ou_alice')).toEqual({
        ownerUserId: '15',
        chatType: 'group',
        chatId: 'oc_team',
        senderOpenId: 'ou_alice',
      });
      expect(parseSessionKey('p2p:ou_alice')).toEqual({
        ownerUserId: 'default',
        chatType: 'p2p',
        chatId: 'p2p:ou_alice',
        senderOpenId: 'ou_alice',
      });
    });
  });

  describe('getOrCreateChatSession（DB 为 source of truth）', () => {
    function createRepoMock(initial: any[] = []) {
      const rows = [...initial];
      return {
        findOne: jest.fn(async ({ where }) => rows.find((row) => {
          if (where.sessionId) return row.sessionId === where.sessionId;
          return row.ownerUserId === where.ownerUserId &&
            row.chatType === where.chatType &&
            row.chatId === where.chatId &&
            row.senderOpenId === where.senderOpenId;
        }) ?? null),
        create: jest.fn((data) => ({ id: rows.length + 1, ...data })),
        save: jest.fn(async (entity) => {
          const idx = rows.findIndex((row) => row.id === entity.id);
          if (idx >= 0) rows[idx] = entity;
          else rows.push(entity);
          return entity;
        }),
        delete: jest.fn(async (where) => {
          const idx = rows.findIndex((row) => {
            if (typeof where.id === 'number') return row.id === where.id;
            return row.ownerUserId === where.ownerUserId &&
              row.chatType === where.chatType &&
              row.chatId === where.chatId &&
              row.senderOpenId === where.senderOpenId;
          });
          if (idx >= 0) rows.splice(idx, 1);
          return { affected: idx >= 0 ? 1 : 0 };
        }),
        rows,
      } as any;
    }

    it('同一个 p2p DB 记录多次返回同一个 sessionId', async () => {
      const repo = createRepoMock();
      initFeishuChatSessionRepository(repo);
      const key = buildSessionKey({
        chatType: 'p2p',
        chatId: 'oc_ignored',
        senderOpenId: 'ou_alice',
        ownerUserId: '15',
      });

      const id1 = await getOrCreateChatSession(key);
      __resetLocalChatSessionCacheForTest();
      initFeishuChatSessionRepository(repo);
      const id2 = await getOrCreateChatSession(key);

      expect(id2).toBe(id1);
      expect(repo.rows).toHaveLength(1);
    });

    it('同一个飞书用户切换 ownerUserId 会得到不同 sessionId', async () => {
      const repo = createRepoMock();
      initFeishuChatSessionRepository(repo);

      const id1 = await getOrCreateChatSession('owner:default:p2p:ou_alice');
      const id2 = await getOrCreateChatSession('owner:15:p2p:ou_alice');

      expect(id1).not.toBe(id2);
      expect(repo.rows).toHaveLength(2);
    });

    it('群聊同群不同人各自隔离', async () => {
      const repo = createRepoMock();
      initFeishuChatSessionRepository(repo);

      const id1 = await getOrCreateChatSession('owner:15:group:oc_team:ou_alice');
      const id2 = await getOrCreateChatSession('owner:15:group:oc_team:ou_bob');

      expect(id1).not.toBe(id2);
      expect(repo.rows).toHaveLength(2);
    });

    it('clearChatSession 会删除 DB 映射，再次创建新 sessionId', async () => {
      const repo = createRepoMock();
      initFeishuChatSessionRepository(repo);
      const key = 'owner:15:p2p:ou_clear_db';

      const id1 = await getOrCreateChatSession(key);
      await clearChatSession(key);
      const id2 = await getOrCreateChatSession(key);

      expect(id2).not.toBe(id1);
      expect(repo.rows).toHaveLength(1);
    });

    it('deleteFeishuChatSessionBySessionId 会按 owner 删除指定映射', async () => {
      const repo = createRepoMock();
      initFeishuChatSessionRepository(repo);
      const sessionId = await getOrCreateChatSession('owner:15:p2p:ou_delete_by_session');

      await deleteFeishuChatSessionBySessionId(sessionId, '15');

      expect(repo.rows).toHaveLength(0);
    });

    it('deleteFeishuChatSessionBySessionId 会删除群聊中当前发送人的映射，不影响同群其他人', async () => {
      const repo = createRepoMock();
      initFeishuChatSessionRepository(repo);
      const aliceSessionId = await getOrCreateChatSession('owner:15:group:oc_team:ou_alice');
      await getOrCreateChatSession('owner:15:group:oc_team:ou_bob');

      await deleteFeishuChatSessionBySessionId(aliceSessionId, '15');

      expect(repo.rows).toHaveLength(1);
      expect(repo.rows[0].senderOpenId).toBe('ou_bob');
    });

    it('deleteFeishuChatSessionBySessionId owner 不匹配时不删除映射', async () => {
      const repo = createRepoMock();
      initFeishuChatSessionRepository(repo);
      const sessionId = await getOrCreateChatSession('owner:15:p2p:ou_keep_by_owner');

      await deleteFeishuChatSessionBySessionId(sessionId, '16');

      expect(repo.rows).toHaveLength(1);
    });
  });

  describe('getOrCreateChatSession（DB 未注入，降级到本地 Map）', () => {
    it('首次调用创建 uuid 形式的 sessionId', async () => {
      const id = await getOrCreateChatSession('p2p:ou_test1');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('同 sessionKey 二次调用返回同一个 sessionId', async () => {
      const id1 = await getOrCreateChatSession('p2p:ou_test2');
      const id2 = await getOrCreateChatSession('p2p:ou_test2');
      expect(id1).toBe(id2);
    });

    it('不同 sessionKey 返回不同 sessionId', async () => {
      const id1 = await getOrCreateChatSession('p2p:ou_a');
      const id2 = await getOrCreateChatSession('p2p:ou_b');
      expect(id1).not.toBe(id2);
    });

    it('clearChatSession 后再调用会得到新 sessionId', async () => {
      const id1 = await getOrCreateChatSession('p2p:ou_clear');
      await clearChatSession('p2p:ou_clear');
      const id2 = await getOrCreateChatSession('p2p:ou_clear');
      expect(id2).not.toBe(id1);
    });
  });
});
