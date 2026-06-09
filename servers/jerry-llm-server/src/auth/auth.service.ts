import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity.js';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { config } from '../fundamentals/config.js';

const JWT_SECRET = config.jwtSecret;
const JWT_EXPIRES_IN = '7d';
const MAX_PASSWORD_LENGTH = 128;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^1[3-9]\d{9}$/;

export type SafeUser = Omit<User, 'password'>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async register(body: {
    email?: string;
    phone?: string;
    password: string;
    username?: string;
  }) {
    const email = (body.email || '').trim();
    const phone = (body.phone || '').trim();
    const username = (body.username || '').trim();
    const password = body.password;

    if (!email && !phone) {
      throw new BadRequestException('邮箱或手机号至少填写一项');
    }

    if (email && !EMAIL_REGEX.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }

    if (phone && !PHONE_REGEX.test(phone)) {
      throw new BadRequestException('手机号格式不正确');
    }

    if (!password || password.length < 6) {
      throw new BadRequestException('密码长度至少6位');
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new BadRequestException(`密码长度不能超过${MAX_PASSWORD_LENGTH}位`);
    }

    if (username && (username.length < 2 || username.length > 20)) {
      throw new BadRequestException('用户名长度应在2-20位之间');
    }

    if (email) {
      const existing = await this.userRepository.findOne({ where: { email } });
      if (existing) {
        throw new BadRequestException('该邮箱已注册');
      }
    }

    if (phone) {
      const existing = await this.userRepository.findOne({ where: { phone } });
      if (existing) {
        throw new BadRequestException('该手机号已注册');
      }
    }

    if (username) {
      const existing = await this.userRepository.findOne({ where: { username } });
      if (existing) {
        throw new BadRequestException('该用户名已被使用');
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User();
    user.email = email || null;
    user.phone = phone || null;
    user.username = username || null;
    user.password = hashedPassword;

    await this.userRepository.save(user);

    const token = this.generateToken(user);

    return {
      success: true,
      message: '注册成功',
      user: this.sanitizeUser(user),
      token,
    };
  }

  async login(body: { account: string; password: string }) {
    const account = (body.account || '').trim();
    const password = body.password;

    if (!account || !password) {
      throw new BadRequestException('请输入账号和密码');
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new BadRequestException('账号或密码错误');
    }

    const user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.email = :account OR user.phone = :account OR user.username = :account', { account })
      .getOne();

    if (!user) {
      throw new UnauthorizedException('账号或密码错误');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('账号或密码错误');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('账号已被禁用');
    }

    const token = this.generateToken(user);

    return {
      success: true,
      message: '登录成功',
      user: this.sanitizeUser(user),
      token,
    };
  }

  async updateProfile(userId: number, body: { username?: string; avatar?: string }) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('用户不存在');
    }

    if (body.username !== undefined) {
      const username = body.username.trim();
      if (username && username !== user.username) {
        if (username.length < 2 || username.length > 20) {
          throw new BadRequestException('用户名长度应在2-20位之间');
        }
        const existing = await this.userRepository.findOne({ where: { username } });
        if (existing) {
          throw new BadRequestException('该用户名已被使用');
        }
        user.username = username;
      }
    }

    if (body.avatar) {
      // 校验 avatar URL 协议，防止 javascript: 等恶意 URL
      const avatarUrl = body.avatar.trim();
      if (!/^https?:\/\//i.test(avatarUrl)) {
        throw new BadRequestException('头像 URL 必须以 http:// 或 https:// 开头');
      }
      user.avatar = avatarUrl;
    }

    await this.userRepository.save(user);

    return {
      success: true,
      message: '更新成功',
      user: this.sanitizeUser(user),
    };
  }

  async getUserById(userId: number): Promise<SafeUser> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('用户不存在');
    }
    return this.sanitizeUser(user);
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('用户不存在');
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('原密码错误');
    }

    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('新密码长度至少6位');
    }

    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      throw new BadRequestException(`新密码长度不能超过${MAX_PASSWORD_LENGTH}位`);
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await this.userRepository.save(user);

    return {
      success: true,
      message: '密码修改成功',
    };
  }

  async resetPassword(account: string, newPassword: string) {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.email = :account OR user.phone = :account OR user.username = :account', { account: account.trim() })
      .getOne();

    if (!user) {
      throw new BadRequestException('该账号不存在');
    }

    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('新密码长度至少6位');
    }

    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      throw new BadRequestException(`新密码长度不能超过${MAX_PASSWORD_LENGTH}位`);
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await this.userRepository.save(user);

    return {
      success: true,
      message: '密码重置成功',
    };
  }

  generateToken(user: User): string {
    const payload = {
      sub: user.id,
      tokenVersion: user.tokenVersion ?? 0,
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  verifyToken(token: string): any {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
  }

  sanitizeUser(user: User): SafeUser {
    const { password, ...result } = user;
    return result;
  }
}
