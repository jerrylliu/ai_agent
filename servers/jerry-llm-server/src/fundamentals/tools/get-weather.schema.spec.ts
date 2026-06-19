/**
 * fundamentals/tools/get-weather.schema.spec.ts
 *
 * get_weather 工具的 zod schema → OpenAI Function Schema 转换测试
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 隔离 config，避免 get-weather.ts 顶层访问 qweatherApiKey 时触发真实校验
jest.mock('../config', () => ({
  config: {
    qweatherApiKey: 'TEST_KEY',
    qweatherApiBase: 'https://devapi.qweather.com',
  },
}));

import { getWeatherSchema, getWeatherParamsSchema } from './get-weather';

describe('getWeatherSchema 结构', () => {
  it('应是 OpenAI Function Calling 格式', () => {
    expect(getWeatherSchema.type).toBe('function');
    expect(getWeatherSchema.function.name).toBe('get_weather');
    expect(getWeatherSchema.function.description).toContain('天气');
  });

  it('city 必填，type enum 含 now/daily/hourly 且默认 now', () => {
    const params = getWeatherSchema.function.parameters as any;
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['city']);
    expect(params.properties.type.enum).toEqual(['now', 'daily', 'hourly']);
    expect(params.properties.type.default).toBe('now');
  });

  it('字段应保留中文 description', () => {
    const params = getWeatherSchema.function.parameters as any;
    expect(params.properties.city.description).toContain('城市');
    expect(params.properties.type.description).toContain('查询类型');
  });
});

describe('getWeatherParamsSchema 校验', () => {
  it('合法参数应通过', () => {
    const r = getWeatherParamsSchema.safeParse({ city: '北京' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe('now');
    }
  });

  it('city 为空应被拦截', () => {
    const r = getWeatherParamsSchema.safeParse({ city: '' });
    expect(r.success).toBe(false);
  });

  it('type 越界应被拦截', () => {
    const r = getWeatherParamsSchema.safeParse({ city: '北京', type: 'monthly' });
    expect(r.success).toBe(false);
  });

  it('合法 type=daily 应通过', () => {
    const r = getWeatherParamsSchema.safeParse({ city: '北京', type: 'daily' });
    expect(r.success).toBe(true);
  });
});
