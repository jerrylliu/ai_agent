/**
 * 运行时配置持久化模块
 *
 * 将缓存和限流的运行时配置保存到 JSON 文件，
 * 服务重启后自动加载，用户在前端修改的配置不会丢失。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { logger } from './logger.js';

// ==================== 配置结构 ====================

// 运行时配置的 zod schema：所有字段可选（partial），加载时与默认值深合并
const RuntimeConfigCacheSchema = z.object({
  maxEntries: z.number().int().nonnegative().optional(),
  maxItemSizeKB: z.number().int().nonnegative().optional(),
  defaultTTLMinutes: z.number().int().nonnegative().optional(),
});

const RuntimeConfigRateLimiterSchema = z.object({
  fastPoolMax: z.number().int().nonnegative().optional(),
  streamingPoolMax: z.number().int().nonnegative().optional(),
  tokenWaitTimeout: z.number().int().nonnegative().optional(),
});

const RuntimeConfigPartialSchema = z
  .object({
    cache: RuntimeConfigCacheSchema.optional(),
    rateLimiter: RuntimeConfigRateLimiterSchema.optional(),
  })
  // 文件中可能含未来扩展字段，loose 模式静默忽略
  .loose();

export interface RuntimeConfig {
  cache: {
    maxEntries: number;
    maxItemSizeKB: number;
    defaultTTLMinutes: number;
  };
  rateLimiter: {
    fastPoolMax: number;
    streamingPoolMax: number;
    tokenWaitTimeout: number;
  };
}

// ==================== 默认配置 ====================

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  cache: {
    maxEntries: 200,
    maxItemSizeKB: 50,
    defaultTTLMinutes: 5,
  },
  rateLimiter: {
    fastPoolMax: 10,
    streamingPoolMax: 5,
    tokenWaitTimeout: 10000,
  },
};

// ==================== 持久化 ====================

const CONFIG_FILE = join(process.cwd(), 'runtime-config.json');

/**
 * 从文件加载运行时配置
 * 文件不存在或解析失败时返回默认配置
 */
export function loadRuntimeConfig(): RuntimeConfig {
  try {
    if (!existsSync(CONFIG_FILE)) {
      logger.info('运行时配置文件不存在，使用默认配置', { module: 'RuntimeConfig' });
      return { ...DEFAULT_RUNTIME_CONFIG };
    }

    const raw = readFileSync(CONFIG_FILE, 'utf-8');

    let savedRaw: unknown;
    try {
      savedRaw = JSON.parse(raw);
    } catch (e) {
      logger.warn('运行时配置文件 JSON 解析失败，使用默认配置', {
        module: 'RuntimeConfig',
        error: (e as Error).message,
      });
      return { ...DEFAULT_RUNTIME_CONFIG };
    }

    const validated = RuntimeConfigPartialSchema.safeParse(savedRaw);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      logger.warn('运行时配置文件结构不符合预期，使用默认配置', {
        module: 'RuntimeConfig',
        issues,
      });
      return { ...DEFAULT_RUNTIME_CONFIG };
    }
    const saved = validated.data;

    // 深度合并：默认值 + 文件中的值
    const config: RuntimeConfig = {
      cache: { ...DEFAULT_RUNTIME_CONFIG.cache, ...saved.cache },
      rateLimiter: { ...DEFAULT_RUNTIME_CONFIG.rateLimiter, ...saved.rateLimiter },
    };

    logger.info('运行时配置已从文件加载', { module: 'RuntimeConfig', config });
    return config;
  } catch (error: any) {
    logger.warn('运行时配置加载失败，使用默认配置', {
      module: 'RuntimeConfig',
      error: error.message,
    });
    return { ...DEFAULT_RUNTIME_CONFIG };
  }
}

/**
 * 保存运行时配置到文件
 */
export function saveRuntimeConfig(config: RuntimeConfig): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    logger.info('运行时配置已保存到文件', { module: 'RuntimeConfig', config });
  } catch (error: any) {
    logger.error('运行时配置保存失败', {
      module: 'RuntimeConfig',
      error: error.message,
    });
  }
}

// ==================== 内存中的当前配置 ====================

let currentConfig: RuntimeConfig = loadRuntimeConfig();

/**
 * 获取当前运行时配置
 */
export function getRuntimeConfig(): RuntimeConfig {
  return currentConfig;
}

/**
 * 更新运行时配置（部分更新，自动合并 + 持久化）
 */
export function updateRuntimeConfig(partial: { cache?: Partial<RuntimeConfig['cache']>; rateLimiter?: Partial<RuntimeConfig['rateLimiter']> }): RuntimeConfig {
  if (partial.cache) {
    currentConfig.cache = { ...currentConfig.cache, ...partial.cache };
  }
  if (partial.rateLimiter) {
    currentConfig.rateLimiter = { ...currentConfig.rateLimiter, ...partial.rateLimiter };
  }
  saveRuntimeConfig(currentConfig);
  return currentConfig;
}
