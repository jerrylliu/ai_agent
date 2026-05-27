import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';

async function bootstrap() {
  // 创建 NestJS 应用实例（禁用默认 bodyParser，使用自定义配置）
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // 使用 Winston 替换 NestJS 默认 Logger
  // 这样 NestJS 框架自身的日志（启动信息、路由注册等）也会走 Winston
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  
  // 配置 bodyParser，支持大文件上传
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // 配置 CORS（跨域资源共享）
  // 允许所有来源的请求访问 API（开发环境使用，生产环境应限制具体域名）
  app.enableCors({
    origin: '*',                              // 允许所有来源（域名）
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // 允许的 HTTP 方法
    credentials: true,                         // 允许携带凭证（cookies）
  });

  // ============================================
  // 配置上传文件目录
  // 确保 uploads 目录存在，用于存储用户上传的文件
  // ============================================

  // 拼接上传目录的绝对路径
  // __dirname: 编译后的 JS 文件所在目录（dist/）
  // '..': 回到 src/ 目录
  // '..': 回到项目根目录（servers/miaoma-llm-server/）
  // 'uploads': 上传文件存储的目录名
  const uploadDir = path.join(__dirname, '..', '..', 'uploads');

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

  // 启动服务器，监听 3000 端口（或使用环境变量 PORT 指定的端口）
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
