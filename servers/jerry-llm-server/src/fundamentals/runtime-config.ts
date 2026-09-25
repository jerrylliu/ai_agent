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

// 运行时配置的 zod schema：所有字段可选（partial），加载时与默认值深合并。
//
// 加载路径刻意保持宽松（nonnegative 而非 positive）：
// 历史脏文件不应让配置整体作废，真正拦住非法值的是「写入路径」的
// RuntimeConfigUpdateSchema（见下方「写入校验」区块）。
const RuntimeConfigCacheSchema = z.object({
  maxEntries: z.number().int().nonnegative().optional(),
  maxItemSizeKB: z.number().int().nonnegative().optional(),
  defaultTTLMinutes: z.number().int().nonnegative().optional(),
  maxTotalSizeMB: z.number().int().nonnegative().optional(),
});

const RuntimeConfigRateLimiterSchema = z.object({
  fastPoolMax: z.number().int().nonnegative().optional(),
  streamingPoolMax: z.number().int().nonnegative().optional(),
  tokenWaitTimeout: z.number().int().nonnegative().optional(),
  queueWaitTimeout: z.number().int().nonnegative().optional(),
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

/**
 * 逐区块校验：失败时记录告警并返回 undefined（调用方用默认值补齐）
 *
 * 为什么分区块而不是整份 safeParse：
 * 整份校验一旦失败就全量回退默认值，单个区块的脏数据（例如被外部工具
 * 写坏的 cache.maxEntries）会连坐 embedding.cloud.apiKeyEncrypted，
 * 用户被迫重新填写并验证云端嵌入 API Key。分区块后坏的那块单独回退。
 */
function parseSection<T extends z.ZodType>(
  schema: T,
  raw: unknown,
  section: string,
): z.infer<T> | undefined {
  if (raw === undefined) return undefined;
  const result = schema.safeParse(raw);
  if (result.success) return result.data as z.infer<T>;

  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || section}: ${i.message}`)
    .join('; ');
  logger.warn('运行时配置区块结构不符合预期，该区块回退默认值', {
    module: 'RuntimeConfig',
    section,
    issues,
  });
  return undefined;
}

// ==================== 写入校验 ====================

/**
 * 写入路径的严格 schema（与加载路径的宽松 schema 分工）
 *
 * 为什么必须严格：
 * - `cache.maxEntries: 0` 一旦落盘，缓存淘汰循环 `while (size >= maxEntries)`
 *   在空缓存上恒真且取不到可删条目，会立刻死循环阻塞事件循环（进程假死）；
 * - `rateLimiter.fastPoolMax: 0` 一旦落盘，信号量 `running < max` 永不成立，
 *   所有 LLM 请求永久挂起，HTTP 连接堆积直至服务不可用。
 * 而这两个值在前端只要「清空输入框再保存」就能产生（`Number('') === 0`），
 * 所以必须在写入前 fail-fast 抛错，绝不让脏值落盘。
 */
export const CacheConfigUpdateSchema = z.object({
  maxEntries: z.number().int().positive().max(100000).optional(),
  maxItemSizeKB: z.number().int().positive().max(10240).optional(),
  // TTL 允许 0，这是「永不过期」的既定语义，不能一并禁掉
  defaultTTLMinutes: z.number().int().min(0).max(1440).optional(),
  /**
   * 缓存总字节预算（MB）
   *
   * 为什么条目数上限还不够：`maxEntries` 只约束「条数」，真实内存占用是
   * 条数 × 单条大小的乘积。把 maxEntries 调到 1000、单条上限 50KB，
   * 理论峰值就是 50MB —— 而这个乘积在 UI 上完全看不出来。
   * 字节预算是一道与条数无关的硬顶，两个约束取先到者触发淘汰。
   */
  maxTotalSizeMB: z.number().int().positive().max(2048).optional(),
});

export const RateLimiterConfigUpdateSchema = z.object({
  fastPoolMax: z.number().int().positive().max(1000).optional(),
  streamingPoolMax: z.number().int().positive().max(1000).optional(),
  tokenWaitTimeout: z.number().int().positive().max(600000).optional(),
  queueWaitTimeout: z.number().int().positive().max(3600000).optional(),
});

export const RuntimeConfigUpdateSchema = z
  .object({
    cache: CacheConfigUpdateSchema.optional(),
    rateLimiter: RateLimiterConfigUpdateSchema.optional(),
    embedding: RuntimeConfigEmbeddingSchema.optional(),
  })
  .loose();

export interface ConfigIssue {
  /** 出错字段路径，如 `cache.maxEntries` */
  path: string;
  /** 中文可读的错误说明 */
  message: string;
}

/**
 * 运行时配置写入校验失败
 *
 * Controller 捕获后转成 400，前端据此提示用户具体哪个字段非法，
 * 而不是笼统的「保存失败」。
 */
export class RuntimeConfigValidationError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      `运行时配置校验失败: ${issues
        .map((i) => `${i.path} ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'RuntimeConfigValidationError';
    this.issues = issues;
  }
}

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
    /** 缓存总字节预算（MB），与 maxEntries 构成双约束淘汰 */
    maxTotalSizeMB: number;
  };
  rateLimiter: {
    fastPoolMax: number;
    streamingPoolMax: number;
    tokenWaitTimeout: number;
    /**
     * 并发池排队等待上限（毫秒）
     *
     * 与 tokenWaitTimeout 是两件不同的事：
     * - tokenWaitTimeout：等「provider RPM 令牌」的超时
     * - queueWaitTimeout：等「并发槽位」的超时
     * 没有后者时，池子被打满 + 上游长时间不释放会让请求永久挂起。
     */
    queueWaitTimeout: number;
  };
  embedding: EmbeddingRuntimeConfig;
}

// ==================== 默认配置 ====================

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  cache: {
    maxEntries: 200,
    maxItemSizeKB: 50,
    defaultTTLMinutes: 5,
    // 32MB：默认参数下（200 条 × 瘦身后约 18KB/条 ≈ 3.6MB）几乎不会触发，
    // 它的作用是给「用户把 maxEntries 调到上千」这类组合上一道硬顶
    maxTotalSizeMB: 32,
  },
  rateLimiter: {
    fastPoolMax: 10,
    streamingPoolMax: 5,
    tokenWaitTimeout: 10000,
    // 2 分钟：足够长以容忍一次完整的流式生成排队，
    // 又足够短以避免请求永久挂起拖垮连接池
    queueWaitTimeout: 120000,
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
        apiKeyEncrypted: cfg.embedding.cloud.apiKeyEncrypted
          ? '<encrypted>'
          : '',
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
      logger.info('运行时配置文件不存在，使用默认配置', {
        module: 'RuntimeConfig',
      });
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

    // 逐区块校验：单个区块脏数据只让该区块回退默认值，不连坐其它区块
    const savedObj =
      typeof savedRaw === 'object' &&
      savedRaw !== null &&
      !Array.isArray(savedRaw)
        ? (savedRaw as Record<string, unknown>)
        : {};

    const savedCache = parseSection(
      RuntimeConfigCacheSchema,
      savedObj.cache,
      'cache',
    );
    const savedRateLimiter = parseSection(
      RuntimeConfigRateLimiterSchema,
      savedObj.rateLimiter,
      'rateLimiter',
    );
    const savedEmbedding = parseSection(
      RuntimeConfigEmbeddingSchema,
      savedObj.embedding,
      'embedding',
    );

    // 深度合并：默认值 + 文件中的值
    const config: RuntimeConfig = {
      cache: { ...DEFAULT_RUNTIME_CONFIG.cache, ...savedCache },
      rateLimiter: {
        ...DEFAULT_RUNTIME_CONFIG.rateLimiter,
        ...savedRateLimiter,
      },
      embedding: {
        localEnabled:
          savedEmbedding?.localEnabled ??
          DEFAULT_RUNTIME_CONFIG.embedding.localEnabled,
        ollama: {
          ...DEFAULT_RUNTIME_CONFIG.embedding.ollama,
          ...savedEmbedding?.ollama,
        },
        cloud: {
          ...DEFAULT_RUNTIME_CONFIG.embedding.cloud,
          ...savedEmbedding?.cloud,
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

const currentConfig: RuntimeConfig = loadRuntimeConfig();

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
  // 写入前严格校验：非法值一律抛错，绝不落盘。
  //
  // 校验通过后仍合并「原始 partial」而不是 validation.data：
  // zod 默认会 strip 掉未声明字段，用 data 合并会静默丢弃调用方额外携带的
  // 字段，改变既有行为。这里只借用 zod 做「拦截」，不做「重塑」。
  const validation = RuntimeConfigUpdateSchema.safeParse(partial);
  if (!validation.success) {
    const issues: ConfigIssue[] = validation.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    logger.error('运行时配置更新被拒绝：参数非法', {
      module: 'RuntimeConfig',
      issues,
    });
    throw new RuntimeConfigValidationError(issues);
  }

  if (partial.cache) {
    currentConfig.cache = mergeDefined(currentConfig.cache, partial.cache);
  }
  if (partial.rateLimiter) {
    currentConfig.rateLimiter = mergeDefined(
      currentConfig.rateLimiter,
      partial.rateLimiter,
    );
  }
  if (partial.embedding) {
    currentConfig.embedding = {
      localEnabled:
        partial.embedding.localEnabled ?? currentConfig.embedding.localEnabled,
      ollama: mergeDefined(
        currentConfig.embedding.ollama,
        partial.embedding.ollama,
      ),
      cloud: mergeDefined(
        currentConfig.embedding.cloud,
        partial.embedding.cloud,
      ),
    };
  }
  saveRuntimeConfig(currentConfig);
  return currentConfig;
}
