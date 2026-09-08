/**
 * 运行时配置持久化模块
 *
 * 将缓存、限流和嵌入模型的运行时配置保存到 JSON 文件，
 * 服务重启后自动加载，用户在前端修改的配置不会丢失。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { logger } from './logger.js';
import { config } from './config.js';

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

// 嵌入生效模式：本地 Ollama / 云端 OpenAI 兼容端点
// 注意：这是「运行时解析出的生效模式」，不再作为持久化配置项。
// 持久化的只有 localEnabled 总开关（见 RuntimeConfigEmbeddingSchema）。
export const EmbeddingModeSchema = z.enum(['ollama', 'cloud']);
export type EmbeddingMode = z.infer<typeof EmbeddingModeSchema>;

// 云端嵌入供应商：硅基流动 / 自定义 OpenAI 兼容端点
export const CloudEmbeddingProviderSchema = z.enum(['siliconflow', 'custom']);
export type CloudEmbeddingProvider = z.infer<
  typeof CloudEmbeddingProviderSchema
>;

const RuntimeConfigEmbeddingOllamaSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().optional(),
});

const RuntimeConfigEmbeddingCloudSchema = z.object({
  provider: CloudEmbeddingProviderSchema.optional(),
  baseUrl: z.string().optional(),
  // API Key 使用 crypto.ts 加密后存储（iv:authTag:ciphertext hex 格式）
  apiKeyEncrypted: z.string().optional(),
  model: z.string().optional(),
});

const RuntimeConfigEmbeddingSchema = z
  .object({
    /**
     * 本地嵌入总开关
     * - true：优先使用本地 Ollama；探测到本地不可用时自动降级到云端
     * - false：只使用云端嵌入
     */
    localEnabled: z.boolean().optional(),
    ollama: RuntimeConfigEmbeddingOllamaSchema.optional(),
    cloud: RuntimeConfigEmbeddingCloudSchema.optional(),
  })
  // loose：历史版本写入的 mode 等废弃字段必须被忽略而不是让整个配置校验失败，
  // 否则 loadRuntimeConfig 会整体回退默认值，导致已保存的云端 API Key 密文丢失
  .loose();

const RuntimeConfigPartialSchema = z
  .object({
    cache: RuntimeConfigCacheSchema.optional(),
    rateLimiter: RuntimeConfigRateLimiterSchema.optional(),
    embedding: RuntimeConfigEmbeddingSchema.optional(),
  })
  // 文件中可能含未来扩展字段，loose 模式静默忽略
  .loose();

export interface EmbeddingRuntimeConfig {
  /**
   * 本地嵌入总开关（唯一持久化的模式相关配置）
   *
   * 开启时优先本地 Ollama，本地不可用自动降级云端；关闭时只用云端。
   */
  localEnabled: boolean;
  /** 本地 Ollama 嵌入配置 */
  ollama: {
    baseUrl: string;
    model: string;
  };
  /** 云端嵌入配置（apiKey 为加密密文） */
  cloud: {
    provider: CloudEmbeddingProvider;
    baseUrl: string;
    apiKeyEncrypted: string;
    model: string;
  };
}

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
  embedding: EmbeddingRuntimeConfig;
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
  embedding: {
    // 默认开启本地嵌入：装了 Ollama 的用户零配置可用；
    // 没装 / 没启动的用户会被自动探测到并降级云端，不会直接不可用
    localEnabled: true,
    ollama: {
      // 默认复用环境变量 OLLAMA_BASE_URL
      baseUrl: config.ollamaBaseUrl,
      // bge-m3：1024 维、8192 token 上下文、100+ 语言，
      // 与云端 BAAI/bge-m3 同权重同向量空间，本地/云端切换共用同一集合
      model: 'bge-m3',
    },
    cloud: {
      provider: 'siliconflow',
      // baseUrl / model 留空时由 embedding-provider 按供应商预设填充
      baseUrl: '',
      apiKeyEncrypted: '',
      model: '',
    },
  },
};

// ==================== 持久化 ====================

const CONFIG_FILE = join(process.cwd(), 'runtime-config.json');

/**
 * 日志脱敏：把 API Key 密文替换为占位符。
 * 虽然是密文，但日志可能被 Loki 等系统采集，不应携带任何可还原的密钥材料。
 */
function sanitizeConfigForLog(cfg: RuntimeConfig): RuntimeConfig {
  return {
    ...cfg,
    embedding: {
      ...cfg.embedding,
      cloud: {
        ...cfg.embedding.cloud,
        apiKeyEncrypted: cfg.embedding.cloud.apiKeyEncrypted ? '<encrypted>' : '',
      },
    },
  };
}

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
      embedding: {
        localEnabled:
          saved.embedding?.localEnabled ?? DEFAULT_RUNTIME_CONFIG.embedding.localEnabled,
        ollama: {
          ...DEFAULT_RUNTIME_CONFIG.embedding.ollama,
          ...saved.embedding?.ollama,
        },
        cloud: {
          ...DEFAULT_RUNTIME_CONFIG.embedding.cloud,
          ...saved.embedding?.cloud,
        },
      },
    };

    logger.info('运行时配置已从文件加载', {
      module: 'RuntimeConfig',
      config: sanitizeConfigForLog(config),
    });
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
    logger.info('运行时配置已保存到文件', {
      module: 'RuntimeConfig',
      config: sanitizeConfigForLog(config),
    });
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
 * 浅合并且忽略 patch 中值为 undefined 的键。
 * 部分更新场景下，未提供的字段必须以"不覆盖"语义处理；
 * 直接展开会把显式 undefined 写进已保存配置（如只传 apiKey 时清空 provider）。
 */
function mergeDefined<T extends Record<string, unknown>>(
  base: T,
  patch?: Partial<T>,
): T {
  if (!patch) return { ...base };
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}

/**
 * 更新运行时配置（部分更新，自动合并 + 持久化）
 */
export function updateRuntimeConfig(partial: {
  cache?: Partial<RuntimeConfig['cache']>;
  rateLimiter?: Partial<RuntimeConfig['rateLimiter']>;
  embedding?: {
    localEnabled?: boolean;
    ollama?: Partial<EmbeddingRuntimeConfig['ollama']>;
    cloud?: Partial<EmbeddingRuntimeConfig['cloud']>;
  };
}): RuntimeConfig {
  if (partial.cache) {
    currentConfig.cache = mergeDefined(currentConfig.cache, partial.cache);
  }
  if (partial.rateLimiter) {
    currentConfig.rateLimiter = mergeDefined(currentConfig.rateLimiter, partial.rateLimiter);
  }
  if (partial.embedding) {
    currentConfig.embedding = {
      localEnabled:
        partial.embedding.localEnabled ?? currentConfig.embedding.localEnabled,
      ollama: mergeDefined(currentConfig.embedding.ollama, partial.embedding.ollama),
      cloud: mergeDefined(currentConfig.embedding.cloud, partial.embedding.cloud),
    };
  }
  saveRuntimeConfig(currentConfig);
  return currentConfig;
}
