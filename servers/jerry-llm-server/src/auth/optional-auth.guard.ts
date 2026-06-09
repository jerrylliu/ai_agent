import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { logger } from '../fundamentals/logger';

/** 从 Authorization header 提取 Bearer Token */
function extractBearerToken(authHeader: string): string | null {
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
}

/**
 * 可选认证守卫
 *
 * 与 AuthGuard 的区别：
 * - AuthGuard：必须有 token，否则抛 401 异常
 * - OptionalAuthGuard：无 token 时放行，使用 'default' 作为 userId
 *
 * 用途：聊天、会话等接口需要支持未登录访问，
 * 登录用户使用真实 userId 隔离数据，未登录用户共享 'default' 数据
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (authHeader) {
      const token = extractBearerToken(authHeader);
      if (token) {
        const decoded = this.authService.verifyToken(token);
        if (decoded) {
          // 检查 tokenVersion，确保密码修改后旧 Token 失效
          try {
            const user = await this.authService.getUserById(decoded.sub);
            if (user) {
              const currentVersion = user.tokenVersion ?? 0;
              const tokenVersion = decoded.tokenVersion ?? 0;
              if (tokenVersion !== currentVersion) {
                logger.warn('token 已失效（tokenVersion 不匹配）', { module: 'OptionalAuthGuard', sub: decoded.sub });
                request.userId = 'default';
                return true;
              }
            }
          } catch {
            request.userId = 'default';
            return true;
          }

          request.userId = String(decoded.sub);
          logger.debug('已登录用户', { module: 'OptionalAuthGuard', userId: request.userId, sub: decoded.sub });
          return true;
        } else {
          logger.warn('token 验证失败', { module: 'OptionalAuthGuard' });
        }
      } else {
        logger.warn('Authorization header 格式错误', { module: 'OptionalAuthGuard' });
      }
    } else {
      logger.debug('无 Authorization header', { module: 'OptionalAuthGuard', path: request.url });
    }

    // 未登录：使用默认 userId
    request.userId = 'default';
    return true;
  }
}
