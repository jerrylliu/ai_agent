import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { logger } from '../fundamentals/logger';

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

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const decoded = this.authService.verifyToken(token);
      if (decoded) {
        // 登录用户：使用 user.id 转字符串作为 userId
        request.userId = String(decoded.sub);
        logger.debug('已登录用户', { module: 'OptionalAuthGuard', userId: request.userId, sub: decoded.sub });
        return true;
      } else {
        logger.warn('token 验证失败', { module: 'OptionalAuthGuard', tokenPrefix: token.substring(0, 20) });
      }
    } else {
      logger.debug('无 Authorization header', { module: 'OptionalAuthGuard', path: request.url });
    }

    // 未登录：使用默认 userId
    request.userId = 'default';
    return true;
  }
}
