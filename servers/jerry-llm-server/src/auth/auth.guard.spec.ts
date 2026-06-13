/**
 * auth/auth.guard.spec.ts
 *
 * AuthGuard 单元测试
 * - 无 Authorization 头时拒绝
 * - 格式错误拒绝
 * - Token 无效/过期拒绝
 * - tokenVersion 不匹配拒绝
 * - 验证成功放行并附加 req.user
 */

// Mock config + typeorm 防止 import 触发 JWT_SECRET 检查
jest.mock('../fundamentals/config', () => ({
  config: { jwtSecret: 'test-jwt-secret' },
}));
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => {},
  getRepositoryToken: () => 'mockRepo',
}));

import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { UnauthorizedException } from '@nestjs/common';

/* =====================================================================
 * 测试辅助：模拟 ExecutionContext
 * ==================================================================*/
function mockContext(authHeader?: string) {
  const request = {
    headers: {} as Record<string, string>,
    user: null as any,
  };
  if (authHeader) {
    request.headers['authorization'] = authHeader;
  }

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as any;
}

function mockAuthService(overrides: Partial<{
  verifyToken: jest.Mock;
  getUserById: jest.Mock;
}> = {}): Partial<AuthService> {
  return {
    verifyToken: overrides.verifyToken || jest.fn(),
    getUserById: overrides.getUserById || jest.fn(),
  };
}

describe('AuthGuard', () => {
  /* ====================================================================
   * 缺少 Authorization 头
   * ==================================================================*/
  describe('缺少 Authorization 头', () => {
    it('无 authorization header 时应抛出 UnauthorizedException', async () => {
      const authService = mockAuthService() as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext(undefined);

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(ctx)).rejects.toThrow('未提供认证令牌');
    });
  });

  /* ====================================================================
   * Token 格式错误
   * ==================================================================*/
  describe('Token 格式错误', () => {
    it('非 Bearer 格式应拒绝', async () => {
      const authService = mockAuthService() as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Basic dXNlcjpwYXNz');

      await expect(guard.canActivate(ctx)).rejects.toThrow('认证令牌格式错误');
    });

    it('只有 "Bearer" 无 token 应拒绝', async () => {
      const authService = mockAuthService() as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Bearer ');

      await expect(guard.canActivate(ctx)).rejects.toThrow('认证令牌格式错误');
    });
  });

  /* ====================================================================
   * Token 验证失败
   * ==================================================================*/
  describe('Token 验证失败', () => {
    it('Token 无效时应拒绝', async () => {
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(null),
      }) as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Bearer invalid.token.here');

      await expect(guard.canActivate(ctx)).rejects.toThrow('认证令牌无效或已过期');
    });

    it('Token 过期（verify 返回 null）时应拒绝', async () => {
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(null),
      }) as AuthService;
      const guard = new AuthGuard(authService);

      await expect(
        guard.canActivate(mockContext('Bearer expired.token')),
      ).rejects.toThrow('认证令牌无效或已过期');
    });
  });

  /* ====================================================================
   * tokenVersion 不匹配
   * ==================================================================*/
  describe('tokenVersion 不匹配', () => {
    it('tokenVersion 不匹配时应拒绝（密码修改后旧 token）', async () => {
      const decoded = { sub: 1, tokenVersion: 2 };
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(decoded),
        getUserById: jest
          .fn()
          .mockResolvedValue({ id: 1, tokenVersion: 5 }), // 当前版本更高
      }) as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Bearer old.version.token');

      await expect(guard.canActivate(ctx)).rejects.toThrow('认证令牌已失效，请重新登录');
    });

    it('tokenVersion 匹配时应通过', async () => {
      const decoded = { sub: 1, tokenVersion: 3 };
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(decoded),
        getUserById: jest.fn().mockResolvedValue({ id: 1, tokenVersion: 3 }),
      }) as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Bearer valid.token');

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      const request = ctx.switchToHttp().getRequest();
      expect(request.user).toEqual(decoded);
    });

    it('tokenVersion 为 undefined 时应按 0 处理并放行', async () => {
      const decoded = { sub: 1 }; // 无 tokenVersion
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(decoded),
        getUserById: jest.fn().mockResolvedValue({ id: 1 }), // 无 tokenVersion
      }) as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Bearer minimal.token');

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  /* ====================================================================
   * 验证成功
   * ==================================================================*/
  describe('验证成功', () => {
    it('成功时应将 decoded 设置到 request.user', async () => {
      const decoded = { sub: 42, tokenVersion: 0 };
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(decoded),
        getUserById: jest.fn().mockResolvedValue({ id: 42, tokenVersion: 0 }),
      }) as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Bearer good.token.abc');

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);

      const request = ctx.switchToHttp().getRequest();
      expect(request.user).toBe(decoded);
    });

    it('成功时应返回 true', async () => {
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue({ sub: 1 }),
        getUserById: jest.fn().mockResolvedValue({ id: 1, tokenVersion: 0 }),
      }) as AuthService;
      const guard = new AuthGuard(authService);

      const result = await guard.canActivate(mockContext('Bearer token'));
      expect(result).toBe(true);
    });

    it('getUserById 返回 null 时不校验 tokenVersion 并放行', async () => {
      const decoded = { sub: 1, tokenVersion: 0 };
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(decoded),
        getUserById: jest.fn().mockResolvedValue(null), // 用户不存在
      }) as AuthService;
      const guard = new AuthGuard(authService);
      const ctx = mockContext('Bearer token.for.deleted.user');

      // getUserById 返回 null 时会跳过 tokenVersion 检查
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(ctx.switchToHttp().getRequest().user).toEqual(decoded);
    });
  });
});
