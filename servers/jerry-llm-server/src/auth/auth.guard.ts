import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';

/** 从 Authorization header 提取 Bearer Token */
function extractBearerToken(authHeader: string): string | null {
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException('未提供认证令牌');
    }

    const token = extractBearerToken(authHeader);
    if (!token) {
      throw new UnauthorizedException('认证令牌格式错误');
    }

    const decoded = this.authService.verifyToken(token);

    if (!decoded) {
      throw new UnauthorizedException('认证令牌无效或已过期');
    }

    // 检查 tokenVersion，确保密码修改后旧 Token 失效
    const user = await this.authService.getUserById(decoded.sub);
    if (user) {
      const currentVersion = user.tokenVersion ?? 0;
      const tokenVersion = decoded.tokenVersion ?? 0;
      if (tokenVersion !== currentVersion) {
        throw new UnauthorizedException('认证令牌已失效，请重新登录');
      }
    }

    request.user = decoded;
    return true;
  }
}
