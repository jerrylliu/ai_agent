import { z } from 'zod';
import { logger } from '../logger';
import { config } from '../config';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';
import { parseToolResultJson } from '../llm-json-parser';

// ==================== 和风天气 API 响应 schema ====================
//
// 仅做"边界兜底"——和风天气 API 字段完整性与正确性由其官方保证，
// 这里只校验业务关键字段（code/location/now），其余用 looseObject 透传。

const QWeatherCityLookupSchema = z.looseObject({
  code: z.string(),
  location: z
    .array(
      z.looseObject({
        id: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
});

const QWeatherNowSchema = z.looseObject({
  code: z.string(),
  updateTime: z.string().optional(),
  now: z
    .looseObject({
      temp: z.string(),
      feelsLike: z.string(),
      text: z.string(),
      windDir: z.string(),
      windScale: z.string(),
      humidity: z.string(),
      precip: z.string(),
      pressure: z.string(),
      vis: z.string(),
      cloud: z.string().optional(),
      dew: z.string().optional(),
    })
    .optional(),
});

const QWeather7dSchema = z.looseObject({
  code: z.string(),
  updateTime: z.string().optional(),
  daily: z
    .array(
      z.looseObject({
        fxDate: z.string(),
        tempMax: z.string(),
        tempMin: z.string(),
        textDay: z.string(),
        textNight: z.string(),
        windDirDay: z.string(),
        windScaleDay: z.string(),
        humidity: z.string(),
        precip: z.string(),
        uvIndex: z.string(),
      }),
    )
    .optional(),
});

const QWeatherHourlySchema = z.looseObject({
  code: z.string(),
  updateTime: z.string().optional(),
  hourly: z
    .array(
      z.looseObject({
        fxTime: z.string(),
        temp: z.string(),
        text: z.string(),
        windDir: z.string(),
        windScale: z.string(),
        humidity: z.string(),
        precip: z.string(),
      }),
    )
    .optional(),
});

const QWEATHER_API_KEY = config.qweatherApiKey;
const _rawApiBase = config.qweatherApiBase;
const QWEATHER_API_BASE = _rawApiBase.startsWith('http') ? _rawApiBase : `https://${_rawApiBase}`;
const WEATHER_API_TIMEOUT_MS = 10000;

let resolvedApiBase: string | null = null;

// 判断是否为自定义Host（非标准 devapi/api 域名）
const isCustomHost = !QWEATHER_API_BASE.includes('devapi.qweather.com') && !QWEATHER_API_BASE.includes('api.qweather.com');

let weatherAvailable = false;

export function validateWeatherConfig(): boolean {
  if (!QWEATHER_API_KEY || QWEATHER_API_KEY.startsWith('TODO')) {
    logger.warn('get_weather 工具未配置：QWEATHER_API_KEY 未设置或仍为占位符，天气查询功能不可用', {
      module: 'Tool:GetWeather',
    });
    weatherAvailable = false;
    return false;
  }
  weatherAvailable = true;
  logger.info('get_weather 工具配置校验通过，天气查询功能可用', {
    module: 'Tool:GetWeather',
  });
  return true;
}

export function isWeatherAvailable(): boolean {
  return weatherAvailable;
}

async function resolveApiBase(): Promise<string> {
  if (resolvedApiBase) return resolvedApiBase;

  // 自定义Host直接使用，不探测
  if (isCustomHost) {
    resolvedApiBase = QWEATHER_API_BASE;
    logger.info('FC工具 [get_weather] 使用自定义API Host', {
      module: 'Tool:GetWeather',
      apiBase: resolvedApiBase,
    });
    return resolvedApiBase;
  }

  // 标准域名：先尝试默认，403则切换备用
  const altBase = QWEATHER_API_BASE.includes('devapi')
    ? 'https://api.qweather.com'
    : 'https://devapi.qweather.com';

  for (const base of [QWEATHER_API_BASE, altBase]) {
    try {
      const testUrl = `${base}/v7/weather/now?location=101010100&key=${QWEATHER_API_KEY}`;
      const resp = await fetch(testUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.status !== 403) {
        resolvedApiBase = base;
        logger.info('FC工具 [get_weather] API域名探测成功', {
          module: 'Tool:GetWeather',
          apiBase: resolvedApiBase,
        });
        return resolvedApiBase;
      }
    } catch {}
  }

  resolvedApiBase = QWEATHER_API_BASE;
  logger.warn('FC工具 [get_weather] API域名探测均失败，使用默认域名', {
    module: 'Tool:GetWeather',
    apiBase: resolvedApiBase,
  });
  return resolvedApiBase;
}

// ==================== Zod Schema ====================

export const getWeatherParamsSchema = z.object({
  city: z
    .string()
    .min(1)
    .describe('城市名称，如"北京"、"上海"、"广州"，或城市ID（如"101010100"）'),
  type: z
    .enum(['now', 'daily', 'hourly'])
    .default('now')
    .describe(
      '查询类型：now（实时天气，默认）、daily（未来7天预报）、hourly（未来24小时逐小时预报）',
    ),
});

export type GetWeatherParams = z.infer<typeof getWeatherParamsSchema>;

// ==================== OpenAI Function Calling Schema ====================

export const getWeatherSchema = buildToolJsonSchema(
  'get_weather',
  '查询指定城市的实时天气、天气预报信息。当用户询问天气、气温、温度、湿度、风力、下雨、晴天、阴天、空气质量等任何与天气相关的问题时，必须使用此工具，不要使用 search_web。支持实时天气、7天预报、24小时逐小时预报。',
  getWeatherParamsSchema,
);

export interface WeatherNow {
  city: string;
  temp: string;
  feelsLike: string;
  text: string;
  windDir: string;
  windScale: string;
  humidity: string;
  precip: string;
  pressure: string;
  vis: string;
  cloud: string;
  dew: string;
  updateTime: string;
}

export interface WeatherDaily {
  city: string;
  forecasts: Array<{
    fxDate: string;
    tempMax: string;
    tempMin: string;
    textDay: string;
    textNight: string;
    windDirDay: string;
    windScaleDay: string;
    humidity: string;
    precip: string;
    uvIndex: string;
  }>;
  updateTime: string;
}

export interface WeatherHourly {
  city: string;
  forecasts: Array<{
    fxTime: string;
    temp: string;
    text: string;
    windDir: string;
    windScale: string;
    humidity: string;
    precip: string;
  }>;
  updateTime: string;
}

export type GetWeatherResult = {
  type: 'now';
  data: WeatherNow;
} | {
  type: 'daily';
  data: WeatherDaily;
} | {
  type: 'hourly';
  data: WeatherHourly;
} | {
  type: 'error';
  error: string;
  city: string;
};

async function lookupCityId(cityName: string): Promise<string> {
  if (/^\d+$/.test(cityName)) {
    return cityName;
  }

  const apiBase = await resolveApiBase();
  // 自定义Host使用 /geo/v2/city/lookup，标准域名使用 /v2/city/lookup
  const geoPath = isCustomHost ? '/geo/v2/city/lookup' : '/v2/city/lookup';
  const url = `${apiBase}${geoPath}?location=${encodeURIComponent(cityName)}`;

  logger.info('FC工具 [get_weather] 城市ID查询', {
    module: 'Tool:GetWeather',
    cityName,
    url,
  });

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), WEATHER_API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (isCustomHost) {
      headers['X-QW-Api-Key'] = QWEATHER_API_KEY;
    }

    const response = await fetch(url, { signal: abortController.signal, headers });
    const responseText = await response.text();

    logger.info('FC工具 [get_weather] 城市查询API原始响应', {
      module: 'Tool:GetWeather',
      cityName,
      statusCode: response.status,
      contentType: response.headers.get('content-type'),
      responseLength: responseText.length,
      responsePreview: responseText.substring(0, 500),
    });

    if (!responseText) {
      throw new Error(`API返回空响应，HTTP状态码: ${response.status}`);
    }

    const parsed = parseToolResultJson(responseText, QWeatherCityLookupSchema, {
      module: 'Tool:GetWeather',
      api: 'city-lookup',
      cityName,
    });
    if (!parsed.success) {
      // 边界兜底失败：和风返回了非预期结构，按"未找到"处理
      return '';
    }
    const data = parsed.data;

    if (data.code === '200' && data.location && data.location.length > 0) {
      const location = data.location[0];
      logger.info('FC工具 [get_weather] 城市ID查询成功', {
        module: 'Tool:GetWeather',
        cityName,
        matchedCity: location.name,
        cityId: location.id,
      });
      return location.id;
    }

    logger.warn('FC工具 [get_weather] 城市ID查询未找到匹配', {
      module: 'Tool:GetWeather',
      cityName,
      apiCode: data.code,
    });
    return '';
  } catch (error: any) {
    logger.error('FC工具 [get_weather] 城市ID查询失败', {
      module: 'Tool:GetWeather',
      cityName,
      error: error.message,
    });
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWeatherNow(cityId: string, cityName: string): Promise<WeatherNow> {
  const apiBase = await resolveApiBase();
  const url = isCustomHost
    ? `${apiBase}/v7/weather/now?location=${cityId}`
    : `${apiBase}/v7/weather/now?location=${cityId}&key=${QWEATHER_API_KEY}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), WEATHER_API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (isCustomHost) {
      headers['X-QW-Api-Key'] = QWEATHER_API_KEY;
    }
    const response = await fetch(url, { signal: abortController.signal, headers });
    const responseText = await response.text();

    logger.info('FC工具 [get_weather] API原始响应', {
      module: 'Tool:GetWeather',
      api: 'now',
      statusCode: response.status,
      responseLength: responseText.length,
      responsePreview: responseText.substring(0, 500),
    });

    if (!responseText) {
      throw new Error(`API返回空响应，HTTP状态码: ${response.status}`);
    }

    const parsed = parseToolResultJson(responseText, QWeatherNowSchema, {
      module: 'Tool:GetWeather',
      api: 'now',
      cityId,
    });
    if (!parsed.success) {
      throw new Error(`和风天气 /v7/weather/now 响应不符合预期结构: ${parsed.reason}`);
    }
    const data = parsed.data;

    if (data.code !== '200') {
      throw new Error(`和风天气API返回错误码: ${data.code}，响应: ${JSON.stringify(data).substring(0, 300)}`);
    }

    const now = data.now;
    if (!now) {
      throw new Error('和风天气 /v7/weather/now 缺少 now 字段');
    }
    return {
      city: cityName,
      temp: now.temp,
      feelsLike: now.feelsLike,
      text: now.text,
      windDir: now.windDir,
      windScale: now.windScale,
      humidity: now.humidity,
      precip: now.precip,
      pressure: now.pressure,
      vis: now.vis,
      cloud: now.cloud ?? '',
      dew: now.dew ?? '',
      updateTime: data.updateTime ?? '',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWeatherDaily(cityId: string, cityName: string): Promise<WeatherDaily> {
  const apiBase = await resolveApiBase();
  const url = isCustomHost
    ? `${apiBase}/v7/weather/7d?location=${cityId}`
    : `${apiBase}/v7/weather/7d?location=${cityId}&key=${QWEATHER_API_KEY}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), WEATHER_API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (isCustomHost) {
      headers['X-QW-Api-Key'] = QWEATHER_API_KEY;
    }
    const response = await fetch(url, { signal: abortController.signal, headers });
    const responseText = await response.text();

    const parsed = parseToolResultJson(responseText, QWeather7dSchema, {
      module: 'Tool:GetWeather',
      api: '7d',
      cityId,
    });
    if (!parsed.success) {
      throw new Error(`和风天气 /v7/weather/7d 响应不符合预期结构: ${parsed.reason}`);
    }
    const data = parsed.data;

    if (data.code !== '200') {
      throw new Error(`和风天气API返回错误码: ${data.code}`);
    }

    if (!data.daily) {
      throw new Error('和风天气 /v7/weather/7d 缺少 daily 字段');
    }

    return {
      city: cityName,
      forecasts: data.daily.map((d) => ({
        fxDate: d.fxDate,
        tempMax: d.tempMax,
        tempMin: d.tempMin,
        textDay: d.textDay,
        textNight: d.textNight,
        windDirDay: d.windDirDay,
        windScaleDay: d.windScaleDay,
        humidity: d.humidity,
        precip: d.precip,
        uvIndex: d.uvIndex,
      })),
      updateTime: data.updateTime ?? '',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWeatherHourly(cityId: string, cityName: string): Promise<WeatherHourly> {
  const apiBase = await resolveApiBase();
  const url = isCustomHost
    ? `${apiBase}/v7/weather/24h?location=${cityId}`
    : `${apiBase}/v7/weather/24h?location=${cityId}&key=${QWEATHER_API_KEY}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), WEATHER_API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (isCustomHost) {
      headers['X-QW-Api-Key'] = QWEATHER_API_KEY;
    }
    const response = await fetch(url, { signal: abortController.signal, headers });
    const responseText = await response.text();

    const parsed = parseToolResultJson(responseText, QWeatherHourlySchema, {
      module: 'Tool:GetWeather',
      api: '24h',
      cityId,
    });
    if (!parsed.success) {
      throw new Error(`和风天气 /v7/weather/24h 响应不符合预期结构: ${parsed.reason}`);
    }
    const data = parsed.data;

    if (data.code !== '200') {
      throw new Error(`和风天气API返回错误码: ${data.code}`);
    }

    if (!data.hourly) {
      throw new Error('和风天气 /v7/weather/24h 缺少 hourly 字段');
    }

    return {
      city: cityName,
      forecasts: data.hourly.map((h) => ({
        fxTime: h.fxTime,
        temp: h.temp,
        text: h.text,
        windDir: h.windDir,
        windScale: h.windScale,
        humidity: h.humidity,
        precip: h.precip,
      })),
      updateTime: data.updateTime ?? '',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function executeGetWeather(
  params: unknown,
): Promise<GetWeatherResult> {
  const startTime = Date.now();

  if (!weatherAvailable) {
    logger.warn('FC工具 [get_weather] 工具未配置，无法执行查询', {
      module: 'Tool:GetWeather',
    });
    return {
      type: 'error',
      error: '天气查询功能未配置，请检查 QWEATHER_API_KEY 环境变量',
      city: (params as { city?: string })?.city || '',
    };
  }

  // zod 校验：city 必填、type 限定枚举
  const parsed = safeParseToolParams(getWeatherParamsSchema, params);
  if (!parsed.success) {
    logger.warn('FC工具 [get_weather] 参数校验失败', {
      module: 'Tool:GetWeather',
      error: parsed.error,
    });
    return {
      type: 'error',
      error: `参数校验失败: ${parsed.error}`,
      city: (params as { city?: string })?.city || '',
    };
  }

  const city = parsed.data.city.trim();
  const queryType = parsed.data.type;

  logger.info('FC工具 [get_weather] 开始执行', {
    module: 'Tool:GetWeather',
    city,
    type: queryType,
  });

  try {
    const cityId = await lookupCityId(city);
    if (!cityId) {
      return {
        type: 'error',
        error: `未找到城市"${city}"，请检查城市名称是否正确`,
        city,
      };
    }

    let result: GetWeatherResult;

    switch (queryType) {
      case 'daily':
        const dailyData = await fetchWeatherDaily(cityId, city);
        result = { type: 'daily', data: dailyData };
        break;
      case 'hourly':
        const hourlyData = await fetchWeatherHourly(cityId, city);
        result = { type: 'hourly', data: hourlyData };
        break;
      default:
        const nowData = await fetchWeatherNow(cityId, city);
        result = { type: 'now', data: nowData };
    }

    const duration = Date.now() - startTime;
    logger.info('FC工具 [get_weather] 执行完成', {
      module: 'Tool:GetWeather',
      city,
      type: queryType,
      duration,
    });

    return formatWeatherResult(result);
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error('FC工具 [get_weather] 执行失败', {
      module: 'Tool:GetWeather',
      city,
      type: queryType,
      duration,
      error: error.message,
    });

    return {
      type: 'error',
      error: `天气查询失败: ${error.message}`,
      city,
    };
  }
}

function formatWeatherResult(result: GetWeatherResult): GetWeatherResult {
  if (result.type === 'error') return result;

  if (result.type === 'now') {
    const d = result.data;
    return {
      ...result,
      data: {
        ...d,
        summary: `${d.city}当前天气：${d.text}，气温${d.temp}°C（体感${d.feelsLike}°C），${d.windDir}${d.windScale}级，湿度${d.humidity}%，降水量${d.precip}mm，能见度${d.vis}km，气压${d.pressure}hPa。数据更新时间：${d.updateTime}`,
      },
    } as any;
  }

  if (result.type === 'daily') {
    const d = result.data;
    const forecastText = d.forecasts.map(f =>
      `${f.fxDate}：${f.textDay}转${f.textNight}，${f.tempMin}°C~${f.tempMax}°C，${f.windDirDay}${f.windScaleDay}级，湿度${f.humidity}%`
    ).join('\n');
    return {
      ...result,
      data: {
        ...d,
        summary: `${d.city}未来7天天气预报：\n${forecastText}\n数据更新时间：${d.updateTime}`,
      },
    } as any;
  }

  if (result.type === 'hourly') {
    const d = result.data;
    const forecastText = d.forecasts.map(f => {
      const time = f.fxTime.replace(/T/, ' ').replace(/\+.*$/, '');
      return `${time}：${f.text}，${f.temp}°C，${f.windDir}${f.windScale}级，湿度${f.humidity}%`;
    }).join('\n');
    return {
      ...result,
      data: {
        ...d,
        summary: `${d.city}未来24小时逐小时天气预报：\n${forecastText}\n数据更新时间：${d.updateTime}`,
      },
    } as any;
  }

  return result;
}
