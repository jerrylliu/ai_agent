/**
 * fundamentals/tools/mcp-proxy.schema.spec.ts
 *
 * mcp_proxy 工具的入口兜底 zod schema 测试
 * 注意：FC schema 仍由 buildMcpProxySchema() 动态生成，本 spec 仅校验入口形状 schema
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    notify: { mcpServers: '' },
  },
}));

import { mcpProxyParamsSchema } from './mcp-proxy';

describe('mcpProxyParamsSchema 入口兜底', () => {
  it('合法输入应通过', () => {
    const r = mcpProxyParamsSchema.safeParse({
      server: 'github',
      tool: 'list_issues',
      arguments: { owner: 'a', repo: 'b' },
    });
    expect(r.success).toBe(true);
  });

  it('不带 arguments 也应通过', () => {
    const r = mcpProxyParamsSchema.safeParse({
      server: 'github',
      tool: 'list_issues',
    });
    expect(r.success).toBe(true);
  });

  it('arguments 内字段值可为任意类型（z.unknown）', () => {
    const r = mcpProxyParamsSchema.safeParse({
      server: 's',
      tool: 't',
      arguments: { num: 1, str: 'x', bool: true, arr: [1, 2], nested: { a: 1 } },
    });
    expect(r.success).toBe(true);
  });

  it('缺 server 应被拦截', () => {
    const r = mcpProxyParamsSchema.safeParse({ tool: 't' });
    expect(r.success).toBe(false);
  });

  it('缺 tool 应被拦截', () => {
    const r = mcpProxyParamsSchema.safeParse({ server: 's' });
    expect(r.success).toBe(false);
  });

  it('空字符串 server 应被拦截', () => {
    const r = mcpProxyParamsSchema.safeParse({ server: '', tool: 't' });
    expect(r.success).toBe(false);
  });

  it('arguments 为非对象（数组）应被拦截', () => {
    const r = mcpProxyParamsSchema.safeParse({
      server: 's',
      tool: 't',
      arguments: [1, 2, 3] as any,
    });
    expect(r.success).toBe(false);
  });

  it('arguments 为字符串应被拦截', () => {
    const r = mcpProxyParamsSchema.safeParse({
      server: 's',
      tool: 't',
      arguments: 'x' as any,
    });
    expect(r.success).toBe(false);
  });
});
