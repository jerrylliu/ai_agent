/**
 * Winston 结构化日志配置
 *
 * 功能：
 * - 统一日志格式：JSON 结构化输出，包含时间戳、级别、模块名、消息、额外字段
 * - 多 Transport：Console（开发环境，带颜色）+ File（生产环境，按级别分文件）
 * - 默认 Meta：附加 service 字段，方便多服务时区分来源
 *
 * 使用方式：
 * - NestJS 注入方式：@Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger
 * - 独立模块导入：import { logger } from './logger'; logger.info('消息', { module: 'xxx' });
 */

import { WinstonModule } from 'nest-winston';
import LokiTransport from 'winston-loki';
import { config } from './config';
import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

// 日志文件输出目录
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 自定义日志格式：JSON 结构化 + 时间戳 + 级别着色
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }), // 错误时自动附加 stack
  winston.format.json(), // JSON 结构化输出
);

// Console 专用格式：带颜色和可读性
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(), // 级别着色
  winston.format.printf(({ timestamp, level, message, module, ...meta }) => {
    const moduleStr = module ? `[${module}]` : '';
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${moduleStr} ${message}${metaStr}`;
  }),
);

// Winston 模块配置（供 AppModule 注册使用）
export const winstonConfig = {
  transports: [
    // Console 输出：开发环境友好，带颜色
    new winston.transports.Console({
      format: consoleFormat,
      level: config.logLevel, // 通过 config 统一管理
    }),

    // 所有日志写入 combined.log
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: logFormat,
      level: 'info',
      maxsize: 10 * 1024 * 1024, // 10MB 轮转
      maxFiles: 5, // 最多保留 5 个文件
    }),

    // 错误日志单独写入 error.log
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      format: logFormat,
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),

    // Loki 输出：将所有日志写入 Loki 数据库
    // 注意：需要 Loki 数据库已启动并监听在 http://localhost:3100
    // 开发环境下可通过环境变量 LOKI_HOST 配置，未设置则跳过 Loki Transport
    ...(config.lokiHost
      ? [
          new LokiTransport({
            host: config.lokiHost,
            labels: { service: 'jerry-llm-server' },
            json: true,
            format: winston.format.json(),
            replaceTimestamp: true,
            onConnectionError: (err) => console.error('Loki connection error:', err),
          }),
        ]
      : []),
  ],

  // 默认附加的元数据
  defaultMeta: {
    service: 'jerry-llm-server',
  },
};

// 创建 WinstonModule 的配置（供 AppModule.forRoot 使用）
export const WinstonLoggerModule = WinstonModule.forRoot(winstonConfig);

// 创建独立 logger 实例（供非 NestJS 注入的模块使用，如 prompt.ts、vector-store.ts 等）
const standaloneLogger = winston.createLogger({
  ...winstonConfig,
  defaultMeta: { service: 'jerry-llm-server' },
});

/**
 * 独立日志器（供非 NestJS 管理的模块使用）
 *
 * 使用示例：
 *   import { logger } from './logger';
 *   logger.info('消息', { module: 'PromptService', sessionId: 'xxx' });
 *   logger.error('错误', { module: 'VectorStore', error: err.message });
 *   logger.warn('警告', { module: 'RAGService' });
 *   logger.debug('调试', { module: 'ModelProvider', modelId: 'xxx' });
 */
export const logger = {
  info: (message: string, meta?: Record<string, any>) => standaloneLogger.info(message, meta),
  warn: (message: string, meta?: Record<string, any>) => standaloneLogger.warn(message, meta),
  error: (message: string, meta?: Record<string, any>) => standaloneLogger.error(message, meta),
  debug: (message: string, meta?: Record<string, any>) => standaloneLogger.debug(message, meta),
};
