/**
 * auth/auth.service.spec.ts
 *
 * AuthService 单元测试
 * - 注册校验（邮箱、手机号、用户名格式，密码长度）
 * - 登录流程（账号查找、密码验证、禁用检查）
 * - Token 生成与验证
 * - 用户信息脱敏
 * - 密码修改（旧密码校验、tokenVersion 递增）
 * - 密码重置
 * - 更新资料（用户名唯一性、头像 URL 格式）
 */

import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

/* =====================================================================
 * Mock 外部依赖
 * ==================================================================*/

jest.mock('../fundamentals/config', () => ({
  config: {
    jwtSecret: 'test-jwt-secret-key-for-unit-tests',
    port: 3000,
    db: { host: 'localhost', port: 3306, username: 'root', password: '', database: 'test' },
    ollamaBaseUrl: 'http://localhost:11434',
    chromaUrl: 'http://localhost:8000',
    chromaHost: 'localhost',
    chromaPort: 8000,
    serverBaseUrl: 'http://localhost:3000',
    deepseekBaseUrl: 'https://api.deepseek.com',
    zhipuBaseUrl: '',
    dashscopeBaseUrl: '',
    dashscopeApiKey: '',
    logLevel: 'info',
    searchApiUrl: '',
    searchApiKey: '',
    qweatherApiKey: '',
    qweatherApiBase: '',
    lokiHost: '',
    corsOrigins: ['http://localhost:5173'],
  },
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(),
  verify: jest.fn(),
}));

/* =====================================================================
 * 测试辅助：使用真实 User entity，mock Repository
 * ==================================================================*/
function mockRepo() {
  return {
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  const u = new User();
  u.id = 1;
  u.email = null;
  u.phone = null;
  u.username = null;
  u.password = 'hashed_password';
  u.avatar = null;
  u.isActive = true;
  u.tokenVersion = 0;
  u.createdAt = new Date();
  u.updatedAt = new Date();
  return Object.assign(u, overrides);
}

describe('AuthService', () => {
  let service: AuthService;
  let userRepo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockRepo() },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepo = module.get(getRepositoryToken(User));
  });

  /* ====================================================================
   * register
   * ==================================================================*/
  describe('register', () => {
    beforeEach(() => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_pwd');
      (jwt.sign as jest.Mock).mockReturnValue('mock-jwt-token');
    });

    it('应拒绝全空邮箱和手机号的注册', async () => {
      await expect(
        service.register({ email: '', phone: '', password: '123456' }),
      ).rejects.toThrow('邮箱或手机号至少填写一项');
    });

    it('应拒绝无效邮箱格式', async () => {
      await expect(
        service.register({ email: 'not-an-email', password: '123456' }),
      ).rejects.toThrow('邮箱格式不正确');
    });

    it('应拒绝无效手机号格式', async () => {
      await expect(
        service.register({ phone: '12345', password: '123456' }),
      ).rejects.toThrow('手机号格式不正确');
    });

    it('应拒绝过短密码 (< 6)', async () => {
      await expect(
        service.register({ email: 'a@b.com', password: '12345' }),
      ).rejects.toThrow('密码长度至少6位');
    });

    it('应拒绝过长密码 (> 128)', async () => {
      await expect(
        service.register({ email: 'a@b.com', password: 'a'.repeat(129) }),
      ).rejects.toThrow('密码长度不能超过128位');
    });

    it('应拒绝无效用户名', async () => {
      await expect(
        service.register({ email: 'a@b.com', password: '123456', username: 'x' }),
      ).rejects.toThrow('用户名长度应在2-20位之间');
    });

    it('邮箱已注册时应拒绝', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ email: 'a@b.com' }));
      await expect(
        service.register({ email: 'a@b.com', password: '123456' }),
      ).rejects.toThrow('该邮箱已注册');
    });

    it('手机号已注册时应拒绝', async () => {
      // register({ phone: '...' }) 中 email 为空跳过 email check，只调一次 findOne 用于 phone check
      userRepo.findOne.mockResolvedValueOnce(makeUser({ phone: '13800138000' }));
      await expect(
        service.register({ phone: '13800138000', password: '12345678' }),
      ).rejects.toThrow('该手机号已注册');
    });

    it('用户名被占用时应拒绝', async () => {
      // register 依次检查 email（不存在）→ phone（跳过）→ username（冲突）
      userRepo.findOne
        .mockResolvedValueOnce(null)  // email 不存在
        .mockResolvedValueOnce(makeUser({ username: 'taken' })); // username 冲突
      await expect(
        service.register({ email: 'new@test.com', password: '12345678', username: 'taken' }),
      ).rejects.toThrow('该用户名已被使用');
    });

    it('成功注册应返回 user 和 token', async () => {
      userRepo.findOne.mockResolvedValue(null);
      const saved = makeUser({ id: 1, email: 'new@test.com', username: 'newbie' });
      userRepo.save.mockResolvedValue(saved);

      const result = await service.register({
        email: 'new@test.com', password: '12345678', username: 'newbie',
      });

      expect(result.success).toBe(true);
      expect(result.token).toBe('mock-jwt-token');
      expect((result.user as any).password).toBeUndefined();
      expect(userRepo.save).toHaveBeenCalled();
    });

    it('纯手机号注册应成功', async () => {
      userRepo.findOne.mockResolvedValue(null);
      const saved = makeUser({ id: 2, phone: '13912345678' });
      userRepo.save.mockResolvedValue(saved);

      const result = await service.register({ phone: '13912345678', password: 'abcdef' });
      expect(result.success).toBe(true);
    });
  });

  /* ====================================================================
   * login
   * ==================================================================*/
  describe('login', () => {
    beforeEach(() => {
      (jwt.sign as jest.Mock).mockReturnValue('login-jwt-token');
    });

    it('空白账号或密码应拒绝', async () => {
      await expect(
        service.login({ account: '', password: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('账号不存在时拒绝', async () => {
      const qb = { where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) };
      userRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.login({ account: 'nobody@t.com', password: '123456' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('密码错误时拒绝', async () => {
      const qb = { where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(makeUser({ email: 'u@t.com' })) };
      userRepo.createQueryBuilder.mockReturnValue(qb);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ account: 'u@t.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('账号被禁用时拒绝', async () => {
      const qb = { where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(makeUser({ email: 'b@t.com', isActive: false })) };
      userRepo.createQueryBuilder.mockReturnValue(qb);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.login({ account: 'b@t.com', password: 'x' }),
      ).rejects.toThrow('账号已被禁用');
    });

    it('登录成功应返回 user 和 token', async () => {
      const u = makeUser({ id: 10, email: 'ok@t.com', tokenVersion: 3 });
      const qb = { where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(u) };
      userRepo.createQueryBuilder.mockReturnValue(qb);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login({ account: 'ok@t.com', password: 'right' });
      expect(result.success).toBe(true);
      expect(result.token).toBe('login-jwt-token');
      expect((result.user as any).password).toBeUndefined();
    });

    it('超长密码直接拒绝（防暴力）', async () => {
      await expect(
        service.login({ account: 'u@t.com', password: 'a'.repeat(129) }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  /* ====================================================================
   * Token 管理
   * ==================================================================*/
  describe('Token 管理', () => {
    it('generateToken 应使用 JWT_SECRET 签名', () => {
      (jwt.sign as jest.Mock).mockReturnValue('signed');
      const token = service.generateToken(makeUser({ id: 5, tokenVersion: 1 }) as any);
      expect(token).toBe('signed');
      expect(jwt.sign).toHaveBeenCalledWith(
        { sub: 5, tokenVersion: 1 },
        'test-jwt-secret-key-for-unit-tests',
        { expiresIn: '7d' },
      );
    });

    it('verifyToken 有效时返回 payload', () => {
      (jwt.verify as jest.Mock).mockReturnValue({ sub: 1 });
      expect(service.verifyToken('good')).toEqual({ sub: 1 });
    });

    it('verifyToken 无效时返回 null', () => {
      (jwt.verify as jest.Mock).mockImplementation(() => { throw new Error('bad'); });
      expect(service.verifyToken('bad')).toBeNull();
    });
  });

  /* ====================================================================
   * sanitizeUser
   * ==================================================================*/
  describe('sanitizeUser', () => {
    it('应移除 password 字段', () => {
      const safe = service.sanitizeUser(makeUser({ password: 'secret' }) as any);
      expect((safe as any).password).toBeUndefined();
    });

    it('应保留其他字段', () => {
      const safe = service.sanitizeUser(makeUser({ id: 8, email: 'e@t.com' }) as any);
      expect(safe.id).toBe(8);
      expect(safe.email).toBe('e@t.com');
    });
  });

  /* ====================================================================
   * changePassword
   * ==================================================================*/
  describe('changePassword', () => {
    beforeEach(() => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('new_hash');
    });

    it('原密码错误时应拒绝', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.changePassword(1, 'wrongOld', 'newPass')).rejects.toThrow('原密码错误');
    });

    it('新密码过短时应拒绝', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      await expect(service.changePassword(1, 'oldPwd', '12345')).rejects.toThrow('新密码长度至少6位');
    });

    it('修改成功应递增 tokenVersion', async () => {
      const u = makeUser({ id: 1, tokenVersion: 5 });
      userRepo.findOne.mockResolvedValue(u);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      userRepo.save.mockResolvedValue(u);

      const result = await service.changePassword(1, 'oldPwd', 'newPassword');
      expect(result.success).toBe(true);
      expect(u.tokenVersion).toBe(6);
    });

    it('用户不存在时应拒绝', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.changePassword(999, 'old', 'newPass')).rejects.toThrow('用户不存在');
    });
  });

  /* ====================================================================
   * resetPassword
   * ==================================================================*/
  describe('resetPassword', () => {
    it('账号不存在时应拒绝', async () => {
      const qb = { where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) };
      userRepo.createQueryBuilder.mockReturnValue(qb);
      await expect(service.resetPassword('ghost', 'newPass123')).rejects.toThrow('该账号不存在');
    });

    it('重置成功应递增 tokenVersion', async () => {
      const u = makeUser({ id: 2, tokenVersion: 2 });
      const qb = { where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(u) };
      userRepo.createQueryBuilder.mockReturnValue(qb);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');
      userRepo.save.mockResolvedValue(u);

      const result = await service.resetPassword('test@mail.com', 'newPwd123');
      expect(result.success).toBe(true);
      expect(u.tokenVersion).toBe(3);
    });
  });

  /* ====================================================================
   * updateProfile
   * ==================================================================*/
  describe('updateProfile', () => {
    it('用户不存在时应拒绝', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.updateProfile(999, { username: 'x' })).rejects.toThrow('用户不存在');
    });

    it('用户名被占用时应拒绝', async () => {
      userRepo.findOne
        .mockResolvedValueOnce(makeUser({ id: 1 }))
        .mockResolvedValueOnce(makeUser({ id: 99, username: 'taken' }));
      await expect(service.updateProfile(1, { username: 'taken' })).rejects.toThrow('该用户名已被使用');
    });

    it('头像 URL 需以 http 开头', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      await expect(service.updateProfile(1, { avatar: 'javascript:alert(1)' })).rejects.toThrow('头像 URL 必须以 http:// 或 https:// 开头');
    });

    it('更新成功应返回脱敏用户', async () => {
      userRepo.findOne.mockResolvedValueOnce(makeUser({ id: 1 }));
      userRepo.findOne.mockResolvedValueOnce(null);
      userRepo.save.mockResolvedValue(makeUser({ id: 1 }));
      const result = await service.updateProfile(1, { username: 'newname' });
      expect(result.success).toBe(true);
      expect((result.user as any).password).toBeUndefined();
    });
  });

  /* ====================================================================
   * getUserById
   * ==================================================================*/
  describe('getUserById', () => {
    it('应返回脱敏用户', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1, password: 'secret' }));
      const safe = await service.getUserById(1);
      expect((safe as any).password).toBeUndefined();
    });

    it('用户不存在时应抛出', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.getUserById(999)).rejects.toThrow('用户不存在');
    });
  });
});
