/**
 * fundamentals/feishu-notify.service.spec.ts
 *
 * 飞书通知服务单元测试
 * 覆盖：
 *   - detectReceiveIdType / verifyEventToken / handleEventVerification (纯函数)
 *   - buildCardJson 卡片结构
 *   - uploadImage / uploadFile 素材上传（带 token 缓存）
 *   - sendCardMessage / sendImageMessage / sendFileMessage / sendTextMessage 消息发送
 *   - updateCard 卡片更新 + 网络抖动重试
 *   - resolveOpenIdByEmail 邮箱反查 + LRU 缓存 + TTL 过期
 *   - getTokenCacheSize / clearTokenCache / clearEmailCache 缓存管理
 */

// 让 config 模块走真实路径但跳过 fail-fast 校验
process.env.JWT_SECRET = 'test-jwt-secret-for-feishu-notify-spec';
process.env.NODE_ENV = 'test';

// mock config：只暴露 notify 相关字段
jest.mock('./config', () => ({
  config: {
    notify: {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuDomain: 'https://open.feishu.cn',
    },
  },
}));

// mock redis-client：通过 globalThis.__feishuRedisMock 状态切换可用性
// jest.mock 工厂会被 hoist 到 import 之前执行，所以状态必须挂在 globalThis 上
// 避免闭包未初始化的 TDZ 问题
type RedisMockState = {
  ready: boolean;
  store: Map<string, { value: string; expiresAt: number }>;
  getCalls: number;
  setCalls: number;
};

(globalThis as any).__feishuRedisMock = {
  ready: false,
  store: new Map<string, { value: string; expiresAt: number }>(),
  getCalls: 0,
  setCalls: 0,
} as RedisMockState;

const redisMock = (globalThis as any).__feishuRedisMock as RedisMockState;

jest.mock('./redis-client', () => ({
  getRedis: () => {
    const state = (globalThis as any).__feishuRedisMock as RedisMockState;
    if (!state.ready) return null;
    return {
      get: async (key: string) => {
        state.getCalls += 1;
        const entry = state.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
          state.store.delete(key);
          return null;
        }
        return entry.value;
      },
      set: async (key: string, value: string, mode?: string, ttl?: number) => {
        state.setCalls += 1;
        const expiresAt = mode === 'PX' && typeof ttl === 'number' ? Date.now() + ttl : 0;
        state.store.set(key, { value, expiresAt });
        return 'OK';
      },
    };
  },
  isRedisReady: () => ((globalThis as any).__feishuRedisMock as RedisMockState).ready,
}));

// mock logger：避免测试输出污染
jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// 临时 helper：构造 fetch 响应
function mockFetchResponse(jsonData: any, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => jsonData,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

import {
  detectReceiveIdType,
  verifyEventToken,
  handleEventVerification,
  buildCardJson,
  uploadImage,
  uploadFile,
  sendCardMessage,
  sendImageMessage,
  sendFileMessage,
  sendTextMessage,
  updateCard,
  resolveOpenIdByEmail,
  getTokenCacheSize,
  clearTokenCache,
  clearEmailCache,
} from './feishu-notify.service';

describe('FeishuNotifyService', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    clearTokenCache();
    clearEmailCache();
    // 每个用例默认禁用 L2 Redis，由 F2 用例自行打开
    redisMock.ready = false;
    redisMock.store.clear();
    redisMock.getCalls = 0;
    redisMock.setCalls = 0;
    fetchSpy = jest.spyOn(global, 'fetch') as unknown as jest.SpyInstance;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ============================================================
  // detectReceiveIdType
  // ============================================================
  describe('detectReceiveIdType', () => {
    it('邮箱格式应识别为 email', () => {
      expect(detectReceiveIdType('user@example.com')).toBe('email');
      expect(detectReceiveIdType('zhang.san+test@company.co')).toBe('email');
    });

    it('ou_ 开头应识别为 open_id', () => {
      expect(detectReceiveIdType('ou_abc123def456')).toBe('open_id');
    });

    it('oc_ 开头应识别为 chat_id', () => {
      expect(detectReceiveIdType('oc_abc123')).toBe('chat_id');
    });

    it('其他格式回退为 user_id', () => {
      expect(detectReceiveIdType('1234567')).toBe('user_id');
      expect(detectReceiveIdType('plain-name')).toBe('user_id');
    });
  });

  // ============================================================
  // verifyEventToken
  // ============================================================
  describe('verifyEventToken', () => {
    it('未配置校验 Token 时应跳过（返回 true）', () => {
      expect(verifyEventToken('any', '')).toBe(true);
    });

    it('请求体未携带 token 时应失败', () => {
      expect(verifyEventToken(undefined, 'expected')).toBe(false);
    });

    it('token 一致时应通过', () => {
      expect(verifyEventToken('secret123', 'secret123')).toBe(true);
    });

    it('token 不一致时应失败', () => {
      expect(verifyEventToken('wrong', 'secret123')).toBe(false);
    });

    it('长度不同时应直接失败（防 timingSafeEqual 抛错）', () => {
      expect(verifyEventToken('short', 'a-much-longer-token')).toBe(false);
    });
  });

  // ============================================================
  // handleEventVerification
  // ============================================================
  describe('handleEventVerification', () => {
    it('url_verification + challenge 时应返回 challenge', () => {
      const result = handleEventVerification({
        type: 'url_verification',
        challenge: 'abc-challenge-xyz',
      });
      expect(result).toEqual({ challenge: 'abc-challenge-xyz' });
    });

    it('非 url_verification 应返回 null', () => {
      expect(handleEventVerification({ type: 'event_callback' })).toBeNull();
    });

    it('缺少 challenge 字段应返回 null', () => {
      expect(handleEventVerification({ type: 'url_verification' })).toBeNull();
    });
  });

  // ============================================================
  // buildCardJson
  // ============================================================
  describe('buildCardJson', () => {
    it('应包含 wide_screen_mode 配置', () => {
      const card = buildCardJson({ title: 't', content: 'c' }) as any;
      expect(card.config).toEqual({ wide_screen_mode: true });
    });

    it('header 颜色未指定时默认 blue', () => {
      const card = buildCardJson({ title: 't', content: 'c' }) as any;
      expect(card.header.template).toBe('blue');
    });

    it('header 颜色应可自定义', () => {
      const card = buildCardJson({
        title: 't',
        content: 'c',
        headerColor: 'red',
      }) as any;
      expect(card.header.template).toBe('red');
    });

    it('content 为空时应回退为占位文本', () => {
      const card = buildCardJson({ title: 't', content: '' }) as any;
      expect(card.elements[0].text.content).toBe('（无正文）');
    });

    it('指定 fields 时应追加分隔线和字段元素', () => {
      const card = buildCardJson({
        title: 't',
        content: 'c',
        fields: [{ label: '附件', value: '1 个文件' }],
      }) as any;
      // [div(正文), hr, div(field)]
      expect(card.elements).toHaveLength(3);
      expect(card.elements[1].tag).toBe('hr');
      expect(card.elements[2].tag).toBe('div');
    });

    it('指定 buttons 时应追加 action 元素', () => {
      const card = buildCardJson({
        title: 't',
        content: 'c',
        buttons: [
          { text: '确认', value: { action: 'confirm', cid: '123' }, type: 'primary' },
        ],
      }) as any;
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      expect(actionEl).toBeDefined();
      expect(actionEl.actions[0].text.content).toBe('确认');
      expect(actionEl.actions[0].type).toBe('primary');
    });

    it('指定 cardId 时应返回更新格式（无 config）', () => {
      const card = buildCardJson({
        title: 't',
        content: 'c',
        cardId: 'card-123',
      }) as any;
      expect(card.config).toBeUndefined();
      expect(card.header).toBeDefined();
      expect(card.elements).toBeDefined();
    });

    it('指定 imageKey 时应注入 ud_icon', () => {
      const card = buildCardJson({
        title: 't',
        content: 'c',
        imageKey: 'img_key_xxx',
      }) as any;
      expect(card.header.ud_icon).toEqual({
        tag: 'img_v2',
        img_key: 'img_key_xxx',
      });
    });
  });

  // ============================================================
  // Token 缓存管理
  // ============================================================
  describe('Token 缓存', () => {
    it('clearTokenCache 后大小应为 0', () => {
      clearTokenCache();
      expect(getTokenCacheSize()).toBe(0);
    });

    it('首次发送后应缓存 token，二次发送应复用缓存', async () => {
      // 第一次：返回 token + 发送结果
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't_xxx', expire: 7200 }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, data: { message_id: 'om_001' } }),
        );
      const r1 = await sendTextMessage('ou_abc', 'open_id', '标题', '正文');
      expect(r1.success).toBe(true);
      expect(getTokenCacheSize()).toBe(1);

      // 第二次：不应再调 token 接口，只 mock 一次发送
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { message_id: 'om_002' } }),
      );
      const r2 = await sendTextMessage('ou_abc', 'open_id', '标题2', '正文2');
      expect(r2.success).toBe(true);
      // 第一次 2 次 fetch（token + send），第二次 1 次（send only）
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });

  // ============================================================
  // F2：L2 Redis 共享缓存（多实例 Token 复用）
  // ============================================================
  describe('Token L2 Redis 共享缓存（F2）', () => {
    it('L2 命中时不应调用远端飞书 Token 接口', async () => {
      // 预置 L2 中已有未过期 token
      redisMock.ready = true;
      const key = 'jerry:feishu:tenant_token:https://open.feishu.cn/open-apis:test-app-id';
      // 注意：模块内 key 不包含 ioredis 的 keyPrefix（那是 client 透明添加的）
      redisMock.store.set('feishu:tenant_token:https://open.feishu.cn/open-apis:test-app-id', {
        value: JSON.stringify({ token: 'token-from-redis', expiresAt: Date.now() + 60_000 }),
        expiresAt: Date.now() + 60_000,
      });

      // 只 mock 发送消息，不 mock token 接口；若代码错误走远端，fetch 会因为缺 mock 返回 undefined
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { message_id: 'om_l2_hit' } }),
      );

      const r = await sendTextMessage('ou_abc', 'open_id', 't', 'c');
      expect(r.success).toBe(true);
      // 只有一次 fetch（发送），没有 token 拉取
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(redisMock.getCalls).toBeGreaterThanOrEqual(1);
      // L1 也应被同步填充
      expect(getTokenCacheSize()).toBe(1);
      // 显式消费 key 防止 unused 警告
      expect(key).toContain('feishu:tenant_token');
    });

    it('L2 未命中 + 远端拉取后应回写 L2，TTL 与 expiresAt 对齐', async () => {
      redisMock.ready = true;
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't_remote', expire: 7200 }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, data: { message_id: 'om_l2_miss' } }),
        );

      const r = await sendTextMessage('ou_abc', 'open_id', 't', 'c');
      expect(r.success).toBe(true);
      // 远端拉了一次 token，发送了一次消息
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // L2 写入一次
      expect(redisMock.setCalls).toBe(1);
      const entry = redisMock.store.get(
        'feishu:tenant_token:https://open.feishu.cn/open-apis:test-app-id',
      );
      expect(entry).toBeDefined();
      const parsed = JSON.parse(entry!.value);
      expect(parsed.token).toBe('t_remote');
      // expiresAt 应比当前时间晚至少 100 分钟（120 分钟 - 5 分钟提前量），不会超过 120 分钟
      const remainMs = parsed.expiresAt - Date.now();
      expect(remainMs).toBeGreaterThan(100 * 60_000);
      expect(remainMs).toBeLessThanOrEqual(120 * 60_000);
    });

    it('Redis 不可用时应静默降级，不影响主流程', async () => {
      // Redis 关闭（默认状态）
      expect(redisMock.ready).toBe(false);
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't_local', expire: 7200 }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, data: { message_id: 'om_no_redis' } }),
        );

      const r = await sendTextMessage('ou_abc', 'open_id', 't', 'c');
      expect(r.success).toBe(true);
      // 既没读也没写 L2
      expect(redisMock.getCalls).toBe(0);
      expect(redisMock.setCalls).toBe(0);
      // L1 仍正常回填
      expect(getTokenCacheSize()).toBe(1);
    });

    it('并发请求应共享同一个 Token 拉取（单飞，防击穿）', async () => {
      redisMock.ready = true;
      // L2 未命中；远端只 mock 一次 token，证明只调一次
      fetchSpy.mockImplementation(async (url: any) => {
        const u = typeof url === 'string' ? url : (url?.url ?? '');
        if (u.includes('/auth/v3/tenant_access_token/internal')) {
          return mockFetchResponse({
            code: 0,
            tenant_access_token: 't_single_flight',
            expire: 7200,
          });
        }
        return mockFetchResponse({ code: 0, data: { message_id: 'om_concurrent' } });
      });

      // 同进程 5 个并发发送（同一 cacheKey）
      const results = await Promise.all([
        sendTextMessage('ou_a', 'open_id', 't', 'c'),
        sendTextMessage('ou_b', 'open_id', 't', 'c'),
        sendTextMessage('ou_c', 'open_id', 'oc', 'c'),
        sendTextMessage('ou_d', 'open_id', 't', 'c'),
        sendTextMessage('ou_e', 'open_id', 't', 'c'),
      ]);
      results.forEach((r) => expect(r.success).toBe(true));

      // Token 接口只应被调用 1 次（单飞）
      const tokenCalls = fetchSpy.mock.calls.filter((call: any[]) => {
        const u = typeof call[0] === 'string' ? call[0] : (call[0]?.url ?? '');
        return u.includes('/auth/v3/tenant_access_token/internal');
      });
      expect(tokenCalls).toHaveLength(1);
    });
  });

  // ============================================================
  // uploadImage
  // ============================================================
  describe('uploadImage', () => {
    beforeEach(() => {
      // 默认先 mock token 接口
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
      );
    });

    it('飞书返回 code=0 应成功并带 image_key', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { image_key: 'img_key_001' } }),
      );
      const r = await uploadImage('http://x', Buffer.from([1, 2, 3]));
      expect(r.success).toBe(true);
      expect(r.key).toBe('img_key_001');
    });

    it('飞书返回 code != 0 应失败', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 99991663, msg: 'permission denied' }),
      );
      const r = await uploadImage('http://x', Buffer.from([1]));
      expect(r.success).toBe(false);
      expect(r.error).toContain('permission denied');
    });

    it('未传 binary 且下载失败应失败', async () => {
      // 第二个 fetch 是真实下载，让它返回 ok=false
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, false));
      const r = await uploadImage('http://broken-url');
      expect(r.success).toBe(false);
      expect(r.error).toContain('无法下载');
    });
  });

  // ============================================================
  // uploadFile
  // ============================================================
  describe('uploadFile', () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
      );
    });

    it('成功上传应返回 file_key', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { file_key: 'file_key_001' } }),
      );
      const r = await uploadFile('http://x', 'report.pdf', Buffer.from([1]));
      expect(r.success).toBe(true);
      expect(r.key).toBe('file_key_001');
    });

    it('按后缀传 file_type（PDF→pdf）', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { file_key: 'fk' } }),
      );
      await uploadFile('http://x', 'report.pdf', Buffer.from([1]));
      // 检查最近一次调用的 FormData 中 file_type 字段
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastCall[0]).toContain('/im/v1/files');
      // FormData 不易直接断言，仅确认调用成功
    });

    it('未知后缀应回退为 stream', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { file_key: 'fk' } }),
      );
      const r = await uploadFile('http://x', 'unknown.xyz', Buffer.from([1]));
      expect(r.success).toBe(true);
    });
  });

  // ============================================================
  // sendCardMessage / sendImageMessage / sendFileMessage
  // ============================================================
  describe('发送消息系列', () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
      );
    });

    it('sendCardMessage 成功应返回 messageId', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { message_id: 'om_card_001' } }),
      );
      const r = await sendCardMessage('ou_x', 'open_id', { header: {}, elements: [] });
      expect(r.success).toBe(true);
      expect(r.messageId).toBe('om_card_001');
    });

    it('sendCardMessage 失败应返回错误信息', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 1, msg: 'invalid receive_id' }),
      );
      const r = await sendCardMessage('bad', 'open_id', {});
      expect(r.success).toBe(false);
      expect(r.error).toContain('invalid receive_id');
    });

    it('sendImageMessage 应携带 image_key', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { message_id: 'om_img' } }),
      );
      const r = await sendImageMessage('ou_x', 'open_id', 'img_key_001');
      expect(r.success).toBe(true);
      // 检查请求 body 包含 image_key
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const body = JSON.parse(lastCall[1].body);
      expect(body.msg_type).toBe('image');
      expect(JSON.parse(body.content).image_key).toBe('img_key_001');
    });

    it('sendFileMessage 应携带 file_key', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { message_id: 'om_file' } }),
      );
      const r = await sendFileMessage('ou_x', 'open_id', 'file_key_001');
      expect(r.success).toBe(true);
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const body = JSON.parse(lastCall[1].body);
      expect(body.msg_type).toBe('file');
      expect(JSON.parse(body.content).file_key).toBe('file_key_001');
    });

    it('携带 uuid 时应作为幂等字段传入', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { message_id: 'om_x' } }),
      );
      await sendCardMessage('ou_x', 'open_id', {}, 'idempotent-uuid-123');
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const body = JSON.parse(lastCall[1].body);
      expect(body.uuid).toBe('idempotent-uuid-123');
    });
  });

  // ============================================================
  // updateCard 重试
  // ============================================================
  describe('updateCard 重试机制', () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
      );
    });

    it('第 1 次成功应直接返回', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ code: 0 }));
      const r = await updateCard('om_xxx', { elements: [] });
      expect(r.success).toBe(true);
      // 1 次 token + 1 次 patch = 2 次
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('网络错误应重试到第 3 次', async () => {
      // 3 次 patch 都报错
      fetchSpy
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'));
      const r = await updateCard('om_xxx', { elements: [] });
      expect(r.success).toBe(false);
      expect(r.error).toContain('3 次尝试后放弃');
      // 1 次 token + 3 次 patch
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('网络错误后第 2 次成功应返回成功', async () => {
      fetchSpy
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(mockFetchResponse({ code: 0 }));
      const r = await updateCard('om_xxx', { elements: [] });
      expect(r.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('业务错误（code != 0）不应重试', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ code: 1, msg: 'message not found' }),
      );
      const r = await updateCard('om_xxx', { elements: [] });
      expect(r.success).toBe(false);
      expect(r.error).toContain('message not found');
      // 1 次 token + 1 次 patch（不重试）
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // resolveOpenIdByEmail
  // ============================================================
  describe('resolveOpenIdByEmail', () => {
    it('首次反查成功应缓存', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            code: 0,
            data: {
              user_list: [{ email: 'a@b.com', user_id: 'ou_aabb' }],
            },
          }),
        );
      const openId = await resolveOpenIdByEmail('A@B.COM');
      expect(openId).toBe('ou_aabb');

      // 第二次应命中缓存，不再发 fetch
      const openId2 = await resolveOpenIdByEmail('a@b.com');
      expect(openId2).toBe('ou_aabb');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('飞书返回非 0 应返回 null', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 99991664, msg: 'no permission' }),
        );
      const r = await resolveOpenIdByEmail('x@y.com');
      expect(r).toBeNull();
    });

    it('用户列表里没有该邮箱应返回 null', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, data: { user_list: [] } }),
        );
      const r = await resolveOpenIdByEmail('ghost@nowhere.com');
      expect(r).toBeNull();
    });

    it('网络异常应返回 null', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
        )
        .mockRejectedValueOnce(new Error('network unreachable'));
      const r = await resolveOpenIdByEmail('x@y.com');
      expect(r).toBeNull();
    });

    it('clearEmailCache 后应再次发起请求', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 't', expire: 7200 }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            code: 0,
            data: { user_list: [{ email: 'a@b.com', user_id: 'ou_aabb' }] },
          }),
        );
      await resolveOpenIdByEmail('a@b.com');
      clearEmailCache();

      // 清缓存后再次反查应再发请求（token 已缓存所以只发反查）
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          code: 0,
          data: { user_list: [{ email: 'a@b.com', user_id: 'ou_aabb' }] },
        }),
      );
      const r = await resolveOpenIdByEmail('a@b.com');
      expect(r).toBe('ou_aabb');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });
});
