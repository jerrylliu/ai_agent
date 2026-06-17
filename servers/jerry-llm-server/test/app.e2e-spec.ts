/**
 * 应用根接口 E2E 健康检查
 *
 * 这是一个最小可运行样例，用于：
 * 1. 验证 E2E 工具链（jest-e2e.json + supertest + Nest TestingModule）能正常装配 AppModule
 * 2. 作为后续业务 E2E 用例的模板
 *
 * 注意：
 * - 与 main.ts 保持一致地启用全局 ValidationPipe
 * - 显式关闭 Redis（避免污染本地 Redis）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';

// 必须放在 import AppModule 之前：让 fundamentals/redis-client 看到 REDIS_ENABLED=false
process.env.REDIS_ENABLED = 'false';

import { AppModule } from '../src/app.module.js';
import { closeRedis } from '../src/fundamentals/redis-client.js';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeRedis();
  });

  it('GET / 应当返回欢迎语字符串', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    // app.service.getHello() 默认返回 'Hello World!'，
    // 此处只断言为非空字符串，避免文案变更频繁打挂用例。
    expect(typeof res.text).toBe('string');
    expect(res.text.length).toBeGreaterThan(0);
  });
});
