/**
 * fundamentals/tools/manage-session.schema.spec.ts
 *
 * manage_session 工具的 zod schema → OpenAI Function Schema 转换测试
 * 重点验证：12 个 action enum 全部保留、可选字段不进 required
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  manageSessionSchema,
  manageSessionParamsSchema,
} from './manage-session';

describe('manageSessionSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(manageSessionSchema.type).toBe('function');
    expect(manageSessionSchema.function.name).toBe('manage_session');
    expect(manageSessionSchema.function.description).toContain('会话');
  });

  it('action 必填且含全部 12 个枚举值', () => {
    const params = manageSessionSchema.function.parameters as any;
    expect(params.required).toEqual(['action']);
    expect(params.properties.action.enum).toEqual([
      'list',
      'create',
      'delete',
      'rename',
      'pin',
      'unpin',
      'switch',
      'search',
      'add_tag',
      'remove_tag',
      'set_category',
      'list_tags',
    ]);
  });

  it('其余字段都应是 optional（不在 required 列表）', () => {
    const params = manageSessionSchema.function.parameters as any;
    const required: string[] = params.required;
    for (const key of ['session_id', 'title', 'keyword', 'tag', 'category']) {
      expect(required).not.toContain(key);
    }
  });

  it('字段应保留中文 description', () => {
    const params = manageSessionSchema.function.parameters as any;
    expect(params.properties.action.description).toContain('要执行的操作');
    expect(params.properties.session_id.description).toContain('会话ID');
  });
});

describe('manageSessionParamsSchema 校验', () => {
  it('action=list 应通过', () => {
    const r = manageSessionParamsSchema.safeParse({ action: 'list' });
    expect(r.success).toBe(true);
  });

  it('action 越界应被拦截', () => {
    const r = manageSessionParamsSchema.safeParse({ action: 'archive' });
    expect(r.success).toBe(false);
  });

  it('合法 action=add_tag + tag 应通过', () => {
    const r = manageSessionParamsSchema.safeParse({
      action: 'add_tag',
      session_id: 'sid-1',
      tag: '工作',
    });
    expect(r.success).toBe(true);
  });

  it('缺失 action 应被拦截', () => {
    const r = manageSessionParamsSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('额外字段应被静默剥离（zod 默认行为）', () => {
    const r = manageSessionParamsSchema.safeParse({
      action: 'list',
      unknown_field: 'x',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as any).unknown_field).toBeUndefined();
    }
  });
});
