/**
 * fundamentals/tools/query-database.schema.spec.ts
 *
 * query_database 工具的 zod schema → OpenAI Function Schema 转换测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    queryDb: {
      host: '',
      user: '',
      password: '',
      database: '',
      allowedTables: [],
    },
  },
}));

import {
  queryDatabaseSchema,
  queryDatabaseParamsSchema,
} from './query-database';

describe('queryDatabaseSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(queryDatabaseSchema.type).toBe('function');
    expect(queryDatabaseSchema.function.name).toBe('query_database');
  });

  it('sql 必填，purpose 可选', () => {
    const params = queryDatabaseSchema.function.parameters as any;
    expect(params.required).toEqual(['sql']);
    expect(params.required).not.toContain('purpose');
  });

  it('字段应保留中文 description', () => {
    const params = queryDatabaseSchema.function.parameters as any;
    expect(params.properties.sql.description).toContain('SELECT');
    expect(params.properties.purpose.description).toContain('查询的业务目的');
  });
});

describe('queryDatabaseParamsSchema 校验', () => {
  it('合法 SQL + purpose 应通过', () => {
    const r = queryDatabaseParamsSchema.safeParse({
      sql: 'SELECT 1',
      purpose: '探活',
    });
    expect(r.success).toBe(true);
  });

  it('仅有 sql 也应通过', () => {
    const r = queryDatabaseParamsSchema.safeParse({ sql: 'SELECT 1' });
    expect(r.success).toBe(true);
  });

  it('空 sql 应被拦截', () => {
    const r = queryDatabaseParamsSchema.safeParse({ sql: '' });
    expect(r.success).toBe(false);
  });

  it('缺少 sql 应被拦截', () => {
    const r = queryDatabaseParamsSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('purpose 类型错误应被拦截', () => {
    const r = queryDatabaseParamsSchema.safeParse({
      sql: 'SELECT 1',
      purpose: 123 as any,
    });
    expect(r.success).toBe(false);
  });
});
