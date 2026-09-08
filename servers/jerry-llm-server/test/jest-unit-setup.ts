/**
 * Jest 单元测试全局环境准备（package.json 中 jest.setupFiles，在所有测试模块加载前执行）
 *
 * 为什么需要：src/fundamentals/config.ts 在模块加载时就用 zod 校验环境变量并 fail-fast，
 * 其中 JWT_SECRET 是唯一没有默认值的必填项。单元测试并不关心真实密钥，
 * 但任何间接 import config.ts 的测试文件（如 document-parser → rag-service → store-state）
 * 都会因缺少该变量而整个套件崩溃。这里注入最小可用的测试值兜底。
 *
 * 注意：仅在变量不存在时赋默认值，CI / 本地可通过真实环境变量覆盖。
 */
const TEST_ENV_DEFAULTS: Record<string, string> = {
  JWT_SECRET: 'unit-test-jwt-secret-not-for-production',
};

for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
