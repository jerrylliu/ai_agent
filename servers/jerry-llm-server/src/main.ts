import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { validateSearchWebConfig, validateWeatherConfig } from './fundamentals/tools';
import { config } from './fundamentals/config';
import { closeRedis, getRedis, waitForRedisReady } from './fundamentals/redis-client';
import { loadApiKeysFromStorage } from './fundamentals/model-provider';
import { cleanupStaleSessionLocks } from './fundamentals/distributed-lock';
import { createSpeechWsHandler } from './gateways/speech.gateway';
import { SpeechService } from './services/speech.service';
import { AuthService } from './auth/auth.service';
import { closeFeishuWsClient } from './fundamentals/feishu-ws-client.js';
import { stopDeadLetterCompensation } from './fundamentals/feishu-notify.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // 全局启用输入验证管道
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  validateSearchWebConfig();
  validateWeatherConfig();

  // 预热 Redis 连接（启动时即建立连接，避免首请求 cold start）
  // 如果 REDIS_ENABLED=false，getRedis() 返回 null，本调用不会有任何副作用
  getRedis();

  // 等待 Redis 连接就绪后再恢复 API Key 和模型设置
  // 不等待的话 isRedisReady() 返回 false，loadApiKeysFromStorage 会跳过加载
  await waitForRedisReady(5000);

  // 从 Redis 恢复已保存的 API Key 和当前模型（加密存储，重启后自动恢复）
  await loadApiKeysFromStorage();

  // 清理上一轮运行残留的会话锁（Ctrl+C 杀进程时 finally 不执行，锁会留在 Redis）
  await cleanupStaleSessionLocks();

  // 配置 bodyParser，支持大文件上传
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // 配置 CORS（跨域资源共享）
  const allowedOrigins = config.corsOrigins;
  app.enableCors({
    origin: (origin, callback) => {
      // 允许无 origin 的请求（如服务端请求、移动端）
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error('CORS 不允许的来源: ' + origin), false);
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // ============================================
  // 配置上传文件目录
  // 确保 uploads 目录存在，用于存储用户上传的文件
  // ============================================

  // 拼接上传目录的绝对路径
  // __dirname: 编译后的 JS 文件所在目录（dist/）
  // '..': 回到项目根目录（servers/jerry-llm-server/）
  // 'uploads': 上传文件存储的目录名
  const uploadDir = path.join(__dirname, '..', 'uploads');

  // 检查 uploads 目录是否存在
  if (!fs.existsSync(uploadDir)) {
    // 如果不存在，使用 recursive: true 创建目录
    // recursive: true 会自动创建所有必要的父级目录
    fs.mkdirSync(uploadDir, { recursive: true });
    // console.log('已自动创建 uploads 上传目录');
  }

  // ============================================
  // 配置静态文件服务
  // 将 uploads 目录暴露为静态资源目录
  // 使得通过 /files/路径可以访问上传的文件
  // ============================================

  // express.static() 是 Express.js 的静态文件中间件
  // 第一个参数 '/files': URL 前缀（访问 URL 会包含 /files/）
  // 第二个参数 uploadDir: 要暴露的目录路径
  // 例如：文件 uploads/logo.png 可以通过 http://localhost:3000/files/logo.png 访问
  app.use('/files', express.static(uploadDir));

  // ============================================
  // 配置音频文件目录（ASR 长音频转写临时存储）
  // ============================================
  const audioDir = path.join(__dirname, '..', 'tmp', 'audios');
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }
  app.use('/audios', express.static(audioDir));

  // ============================================
  // 启动 HTTP 服务器
  // ============================================
  await app.listen(config.port);

  // ============================================
  // 语音识别 WebSocket 服务器
  // 挂载到同一 HTTP 服务器，路径 /api/speech/stream
  // ============================================
  const httpServer = app.getHttpServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/api/speech/stream' });
  const speechService = app.get(SpeechService);
  const authService = app.get(AuthService);
  wss.on('connection', createSpeechWsHandler(speechService, authService));

  // ============================================
  // 优雅关闭：进程收到 SIGINT/SIGTERM 时回收 Redis 连接
  // 防止 Redis Server 端 TCP TIME_WAIT 堆积，并让未完成命令有机会返回结果
  // ============================================
  const gracefulShutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[main] 收到 ${signal}，开始优雅关闭...`);
    try {
      closeFeishuWsClient();
      await app.close();
      await closeRedis();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[main] 优雅关闭失败', e);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
}
bootstrap();
