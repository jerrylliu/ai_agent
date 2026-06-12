/**
 * auth/auth.controller.spec.ts
 *
 * AuthController 单元测试
 * 使用 NestJS TestingModule + mock AuthService + AuthGuard
 */

import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BadRequestException } from '@nestjs/common';

// Mock AuthGuard — 必须 export 一个可构造类，而非普通对象
jest.mock('./auth.guard', () => {
  class MockAuthGuard {
    canActivate(ctx: any) {
      const req = ctx.switchToHttp().getRequest();
      req.user = { sub: 'u1', username: 'test' };
      return true;
    }
  }
  return { AuthGuard: MockAuthGuard };
});

// Mock @nestjs/typeorm — 防止加载 typeorm native 模块
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (target: any, key: string, index: number) => {},
  getRepositoryToken: () => 'mockRepo',
}));

jest.mock('../fundamentals/config', () => ({
  config: {
    jwtSecret: 'test-secret',
    serverBaseUrl: 'http://localhost:3000',
    db: { host: 'localhost', port: 3306, username: 'r', password: '', database: 't' },
    ollamaBaseUrl: 'http://localhost:11434',
    chromaUrl: 'http://localhost:8000',
    chromaHost: 'localhost',
    chromaPort: 8000,
    corsOrigins: [],
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock('path', () => {
  const pathMod: any = {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '/',
    extname: (name: string) => {
      const i = name.lastIndexOf('.');
      return i >= 0 ? name.slice(i) : '';
    },
    resolve: (...args: string[]) => args.join('/'),
  };
  return pathMod;
});

// Mock typeorm 以防止加载 typeorm native 模块
jest.mock('typeorm', () => ({
  Repository: class {},
  DataSource: class {},
  In: () => () => {},
  Entity: () => () => {},
  Column: () => () => {},
  PrimaryGeneratedColumn: () => () => {},
  CreateDateColumn: () => () => {},
  UpdateDateColumn: () => () => {},
  Index: () => () => {},
  BeforeInsert: () => () => {},
  BeforeUpdate: () => () => {},
  EntityRepository: () => () => {},
}));

describe('AuthController', () => {
  let controller: AuthController;
  let authService: any;

  beforeEach(async () => {
    authService = {
      register: jest.fn(),
      login: jest.fn(),
      getUserById: jest.fn(),
      updateProfile: jest.fn(),
      changePassword: jest.fn(),
      resetPassword: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  /* ====================================================================
   * register
   * ==================================================================*/
  describe('register', () => {
    it('应委托 AuthService.register', async () => {
      authService.register.mockResolvedValue({ success: true });
      const body = { phone: '13800138000', password: '12345678' };
      const r = await controller.register(body as any);
      expect(authService.register).toHaveBeenCalledWith(body);
      expect(r).toEqual({ success: true });
    });
  });

  /* ====================================================================
   * login
   * ==================================================================*/
  describe('login', () => {
    it('应委托 AuthService.login', async () => {
      authService.login.mockResolvedValue({ token: 'jwt' });
      const body = { account: 'test', password: '123' };
      const r = await controller.login(body as any);
      expect(authService.login).toHaveBeenCalledWith(body);
      expect(r.token).toBe('jwt');
    });
  });

  /* ====================================================================
   * getProfile
   * ==================================================================*/
  describe('getProfile', () => {
    it('应委托 AuthService.getUserById(req.user.sub)', async () => {
      authService.getUserById.mockResolvedValue({ id: 'u1', username: 'test' });
      const req = { user: { sub: 'u1' } };
      const r = await controller.getProfile(req);
      expect(authService.getUserById).toHaveBeenCalledWith('u1');
      expect(r).toEqual({ id: 'u1', username: 'test' });
    });
  });

  /* ====================================================================
   * updateProfile
   * ==================================================================*/
  describe('updateProfile', () => {
    it('应委托 AuthService.updateProfile', async () => {
      authService.updateProfile.mockResolvedValue({ id: 'u1', avatar: 'x.jpg' });
      const req = { user: { sub: 'u1' } };
      const body = { avatar: 'x.jpg' };
      const r = await controller.updateProfile(req, body);
      expect(authService.updateProfile).toHaveBeenCalledWith('u1', body);
      expect(r).toEqual({ id: 'u1', avatar: 'x.jpg' });
    });
  });

  /* ====================================================================
   * changePassword
   * ==================================================================*/
  describe('changePassword', () => {
    it('应委托 AuthService.changePassword', async () => {
      authService.changePassword.mockResolvedValue({ success: true });
      const req = { user: { sub: 'u1' } };
      const body = { oldPassword: 'old', newPassword: 'new' };
      const r = await controller.changePassword(req, body as any);
      expect(authService.changePassword).toHaveBeenCalledWith('u1', 'old', 'new');
      expect(r).toEqual({ success: true });
    });
  });

  /* ====================================================================
   * resetPassword
   * ==================================================================*/
  describe('resetPassword', () => {
    it('应委托 AuthService.resetPassword', async () => {
      authService.resetPassword.mockResolvedValue({ success: true });
      const body = { account: 'u1', newPassword: 'np' };
      const r = await controller.resetPassword(body as any);
      expect(authService.resetPassword).toHaveBeenCalledWith('u1', 'np');
      expect(r).toEqual({ success: true });
    });
  });

  /* ====================================================================
   * verifyToken
   * ==================================================================*/
  describe('verifyToken', () => {
    it('应返回有效令牌验证结果', async () => {
      authService.getUserById.mockResolvedValue({ id: 'u1' });
      const req = { user: { sub: 'u1' } };
      const r = await controller.verifyToken(req);
      expect(r).toEqual({ success: true, valid: true, user: { id: 'u1' } });
    });
  });

  /* ====================================================================
   * uploadAvatar — 各种验证路径
   * ==================================================================*/
  describe('uploadAvatar', () => {
    it('缺少文件时应抛出 BadRequest', async () => {
      const req = { user: { sub: 'u1' } };
      await expect(controller.uploadAvatar(req, undefined)).rejects.toThrow(BadRequestException);
      await expect(controller.uploadAvatar(req, null)).rejects.toThrow(BadRequestException);
    });

    it('不支持的文件类型应抛出 BadRequest', async () => {
      const req = { user: { sub: 'u1' } };
      const file = { mimetype: 'text/plain', size: 1000, originalname: 'doc.txt', buffer: Buffer.from('') };
      await expect(controller.uploadAvatar(req, file)).rejects.toThrow(BadRequestException);
    });

    it('文件过大应抛出 BadRequest', async () => {
      const req = { user: { sub: 'u1' } };
      const file = { mimetype: 'image/png', size: 30 * 1024 * 1024, originalname: 'big.png', buffer: Buffer.from('') };
      await expect(controller.uploadAvatar(req, file)).rejects.toThrow(BadRequestException);
    });

    it('有效头像应更新用户资料', async () => {
      authService.updateProfile.mockResolvedValue({ avatar: 'http://localhost:3000/files/avatars/1_a.png' });
      const req = { user: { sub: 'u1' } };
      const buffer = Buffer.from('fake');
      const file = {
        mimetype: 'image/png',
        size: 1000,
        originalname: 'avatar.png',
        buffer,
      };
      const r = await controller.uploadAvatar(req, file);
      expect(authService.updateProfile).toHaveBeenCalled();
      const arg = authService.updateProfile.mock.calls[0][1];
      expect(arg.avatar).toContain('http://localhost:3000/files/avatars/');
    });
  });
});
