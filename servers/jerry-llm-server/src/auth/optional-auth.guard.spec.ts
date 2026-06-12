/**
 * auth/optional-auth.guard.spec.ts
 *
 * OptionalAuthGuard 单元测试
 * 覆盖：无 header 放行 / 格式错误放行 / token 无效放行 / 有效 token / tokenVersion 不匹配
 */

import { OptionalAuthGuard } from './optional-auth.guard';

describe('OptionalAuthGuard', () => {
  function makeMockAuthService(overrides: { verifyToken?: any; getUserById?: any } = {}) {
    return {
      verifyToken: overrides.verifyToken ?? jest.fn(),
      getUserById: overrides.getUserById ?? jest.fn(),
    } as any;
  }

  /**
   * 创建 mock ExecutionContext
   * 关键：getRequest() 始终返回同一对象引用，使 guard 的修改能被测试读到
   */
  function makeContext(auth?: string): any {
    const request: any = { headers: auth ? { authorization: auth } : {} };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    };
  }

  /* ====================================================================
   * 无 token → 放行，userId = 'default'
   * ==================================================================*/
  it('无 Authorization header 时应放行，userId = default', async () => {
    const authService = makeMockAuthService();
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext();
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.userId).toBe('default');
  });

  /* ====================================================================
   * 有 header 但格式不对 → 放行，userId = default
   * ==================================================================*/
  it('Authorization 格式错误时应放行', async () => {
    const authService = makeMockAuthService();
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext('NotBearer token123');
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.userId).toBe('default');
  });

  it('Authorization 值为空字符串时应放行', async () => {
    const authService = makeMockAuthService();
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext('');
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.userId).toBe('default');
  });

  /* ====================================================================
   * Token 验证失败 → 放行，userId = default
   * ==================================================================*/
  it('verifyToken 返回 null 时应放行', async () => {
    const authService = makeMockAuthService({ verifyToken: jest.fn().mockReturnValue(null) });
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext('Bearer invalid');
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.userId).toBe('default');
  });

  /* ====================================================================
   * 有效 token + 有效 user → 设置 userId
   * ==================================================================*/
  it('token 有效且 tokenVersion 匹配时应设置 userId', async () => {
    const authService = makeMockAuthService({
      verifyToken: jest.fn().mockReturnValue({ sub: 'u1', tokenVersion: 1 }),
      getUserById: jest.fn().mockResolvedValue({ tokenVersion: 1 }),
    });
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext('Bearer valid-jwt');
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.userId).toBe('u1');
  });

  /* ====================================================================
   * tokenVersion 不匹配 → 放行，userId = default
   * ==================================================================*/
  it('tokenVersion 不匹配时应降级为 default', async () => {
    const authService = makeMockAuthService({
      verifyToken: jest.fn().mockReturnValue({ sub: 'u1', tokenVersion: 1 }),
      getUserById: jest.fn().mockResolvedValue({ tokenVersion: 2 }),
    });
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext('Bearer old-jwt');
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.userId).toBe('default');
  });

  /* ====================================================================
   * user 不存在 → 放行，但 userId 设为 decoded.sub（现有行为）
   * ==================================================================*/
  it('getUserById 返回 null 时 userId 设为 decoded.sub', async () => {
    const authService = makeMockAuthService({
      verifyToken: jest.fn().mockReturnValue({ sub: 'ghost', tokenVersion: 0 }),
      getUserById: jest.fn().mockResolvedValue(null),
    });
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext('Bearer ghost-jwt');
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    // 现有行为：user 为 null 时跳过 tokenVersion 检查，直接设为 decoded.sub
    expect(req.userId).toBe('ghost');
  });

  /* ====================================================================
   * 无 tokenVersion 字段 → 兼容
   * ==================================================================*/
  it('token 无 tokenVersion 字段且 user 无该字段时应放行', async () => {
    const authService = makeMockAuthService({
      verifyToken: jest.fn().mockReturnValue({ sub: 'u2' }),
      getUserById: jest.fn().mockResolvedValue({}),
    });
    const guard = new OptionalAuthGuard(authService);
    const ctx = makeContext('Bearer legacy-jwt');
    const req = ctx.switchToHttp().getRequest();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.userId).toBe('u2');
  });
});
