import { logger } from '../logger';

const QWEATHER_API_KEY = process.env.QWEATHER_API_KEY || '';
const _rawApiBase = process.env.QWEATHER_API_BASE || 'https://devapi.qweather.com';
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

export const getWeatherSchema = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: '查询指定城市的实时天气、天气预报信息。当用户询问天气、气温、温度、湿度、风力、下雨、晴天、阴天、空气质量等任何与天气相关的问题时，必须使用此工具，不要使用 search_web。支持实时天气、7天预报、24小时逐小时预报。',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '城市名称，如"北京"、"上海"、"广州"，或城市ID（如"101010100"）',
        },
        type: {
          type: 'string',
          description: '查询类型：now（实时天气，默认）、daily（未来7天预报）、hourly（未来24小时逐小时预报）',
          enum: ['now', 'daily', 'hourly'],
          default: 'now',
        },
      },
      required: ['city'],
    },
  },
};

export interface GetWeatherParams {
  city: string;
  type?: 'now' | 'daily' | 'hourly';
}

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

    const data = JSON.parse(responseText);

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

    const data = JSON.parse(responseText);

    if (data.code !== '200') {
      throw new Error(`和风天气API返回错误码: ${data.code}，响应: ${JSON.stringify(data).substring(0, 300)}`);
    }

    const now = data.now;
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
      cloud: now.cloud,
      dew: now.dew,
      updateTime: data.updateTime,
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
    const data = await response.json();

    if (data.code !== '200') {
      throw new Error(`和风天气API返回错误码: ${data.code}`);
    }

    return {
      city: cityName,
      forecasts: data.daily.map((d: any) => ({
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
      updateTime: data.updateTime,
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
    const data = await response.json();

    if (data.code !== '200') {
      throw new Error(`和风天气API返回错误码: ${data.code}`);
    }

    return {
      city: cityName,
      forecasts: data.hourly.map((h: any) => ({
        fxTime: h.fxTime,
        temp: h.temp,
        text: h.text,
        windDir: h.windDir,
        windScale: h.windScale,
        humidity: h.humidity,
        precip: h.precip,
      })),
      updateTime: data.updateTime,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function executeGetWeather(
  params: GetWeatherParams,
): Promise<GetWeatherResult> {
  const startTime = Date.now();

  if (!weatherAvailable) {
    logger.warn('FC工具 [get_weather] 工具未配置，无法执行查询', {
      module: 'Tool:GetWeather',
    });
    return {
      type: 'error',
      error: '天气查询功能未配置，请检查 QWEATHER_API_KEY 环境变量',
      city: params.city || '',
    };
  }

  if (!params.city || !params.city.trim()) {
    logger.warn('FC工具 [get_weather] 参数校验失败：city 为空', {
      module: 'Tool:GetWeather',
    });
    return {
      type: 'error',
      error: '城市名称不能为空',
      city: '',
    };
  }

  const queryType = params.type || 'now';

  logger.info('FC工具 [get_weather] 开始执行', {
    module: 'Tool:GetWeather',
    city: params.city,
    type: queryType,
  });

  try {
    const cityId = await lookupCityId(params.city.trim());
    if (!cityId) {
      return {
        type: 'error',
        error: `未找到城市"${params.city}"，请检查城市名称是否正确`,
        city: params.city,
      };
    }

    let result: GetWeatherResult;

    switch (queryType) {
      case 'daily':
        const dailyData = await fetchWeatherDaily(cityId, params.city);
        result = { type: 'daily', data: dailyData };
        break;
      case 'hourly':
        const hourlyData = await fetchWeatherHourly(cityId, params.city);
        result = { type: 'hourly', data: hourlyData };
        break;
      default:
        const nowData = await fetchWeatherNow(cityId, params.city);
        result = { type: 'now', data: nowData };
    }

    const duration = Date.now() - startTime;
    logger.info('FC工具 [get_weather] 执行完成', {
      module: 'Tool:GetWeather',
      city: params.city,
      type: queryType,
      duration,
    });

    return formatWeatherResult(result);
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error('FC工具 [get_weather] 执行失败', {
      module: 'Tool:GetWeather',
      city: params.city,
      type: queryType,
      duration,
      error: error.message,
    });

    return {
      type: 'error',
      error: `天气查询失败: ${error.message}`,
      city: params.city,
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
