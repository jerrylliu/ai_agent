/**
 * 临时验证脚本：确认 config.ts 的 zod fail-fast 行为
 *
 * 通过 jest.isolateModules 让 config.ts 在不同 process.env 下重新加载，
 * 避免一次性导入污染其他用例。
 */

describe('config fail-fast', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // 还原环境变量，防止串扰
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    jest.resetModules();
  });

  it('缺失 JWT_SECRET 时应抛错并提示字段路径', () => {
    delete process.env.JWT_SECRET;

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./config');
      });
    }).toThrow(/jwtSecret/);
  });

  it('非法 PORT（负数）应抛错', () => {
    process.env.JWT_SECRET = 'test-secret-1234567890';
    process.env.PORT = '-1';

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./config');
      });
    }).toThrow(/port/);
  });

  it('合法环境变量下应正常加载并保留 getter 行为', () => {
    process.env.JWT_SECRET = 'test-secret-1234567890';
    process.env.PORT = '3001';
    process.env.CHROMA_URL = 'http://chromahost:9001';
    process.env.CORS_ORIGINS = 'http://a.com, http://b.com , ';
    process.env.NOTIFY_DB_ALLOWED_TABLES = 'users, orders';

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { config } = require('./config');
      expect(config.port).toBe(3001);
      expect(config.chromaHost).toBe('chromahost');
      expect(config.chromaPort).toBe(9001);
      expect(config.corsOrigins).toEqual(['http://a.com', 'http://b.com']);
      expect(config.queryDb.allowedTables).toEqual(['users', 'orders']);
    });
  });

  // ==================== SEMANTIC_CACHE_ENABLED（ERB 评测开关，方案 §5.2 坑 4） ====================

  it('SEMANTIC_CACHE_ENABLED 未设置时默认 true（生产行为不变）', () => {
    process.env.JWT_SECRET = 'test-secret-1234567890';
    delete process.env.SEMANTIC_CACHE_ENABLED;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { config } = require('./config');
      expect(config.semanticCacheEnabled).toBe(true);
    });
  });

  it.each([
    ['false', false],
    ['true', true],
    ['TRUE', true],
  ])('SEMANTIC_CACHE_ENABLED=%s 应解析为 %s', (raw, expected) => {
    process.env.JWT_SECRET = 'test-secret-1234567890';
    process.env.SEMANTIC_CACHE_ENABLED = raw;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { config } = require('./config');
      expect(config.semanticCacheEnabled).toBe(expected);
    });
  });
});
