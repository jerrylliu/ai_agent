import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';
import { config } from './config.js';
import { llmRateLimiter } from './llm-rate-limiter.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import { getRedis, isRedisReady } from './redis-client.js';

export type ModelProvider = 'ollama' | 'deepseek' | 'zhipu';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  numCtx?: number;
  apiKey?: string;
  baseUrl?: string;
  isFCMode?: boolean; // FC 模式下自动提升 numCtx
}

export interface AvailableModel {
  id: string;
  provider: ModelProvider;
  name: string;
  description: string;
  requiresApiKey: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  /**
   * 是否支持 tool_choice 参数（强制工具调用）。
   * 大多数模型支持，但 DeepSeek "Thinking mode"（推理模型）等不支持，
   * 传该参数会返回 400 错误。
   */
  supportsToolChoice?: boolean;
}

export const AVAILABLE_MODELS: AvailableModel[] = [
  {
    id: 'ollama:minicpm',
    provider: 'ollama',
    name: 'MiniCPM (本地)',
    description: '本地小型模型，适合简单对话',
    requiresApiKey: false,
    supportsVision: true,
    supportsFunctionCalling: false,
  },
  {
    id: 'ollama:qwen3.5-new',
    provider: 'ollama',
    name: 'Qwen3.5 New (本地)',
    description: '本地超轻量模型，资源占用极低',
    requiresApiKey: false,
    supportsVision: false,
    supportsFunctionCalling: true,
  },
  {
    id: 'ollama:qwen3.5-2b',
    provider: 'ollama',
    name: 'Qwen3.5 2B (本地)',
    description: '本地中等模型，平衡效果与速度',
    requiresApiKey: false,
    supportsVision: false,
    supportsFunctionCalling: true,
  },
  {
    id: 'deepseek:deepseek-v4-flash',
    provider: 'deepseek',
    name: 'DeepSeek-V4-Flash (线上)',
    description: 'DeepSeek 线上模型，效果优秀',
    requiresApiKey: true,
    supportsVision: false,
    supportsFunctionCalling: true,
    supportsToolChoice: false, // DeepSeek V4 系列 Thinking mode 不支持 tool_choice
  },
  {
    id: 'deepseek:deepseek-v4-pro',
    provider: 'deepseek',
    name: 'DeepSeek-V4-Pro (线上)',
    description: 'DeepSeek 推理模型，深度思考',
    requiresApiKey: true,
    supportsVision: false,
    supportsFunctionCalling: true,
    supportsToolChoice: false, // Thinking mode 不支持 tool_choice 参数
  },
  {
    id: 'zhipu:glm-4.6v',
    provider: 'zhipu',
    name: 'GLM-4.6V (线上)',
    description: '智谱视觉模型，支持图片理解',
    requiresApiKey: true,
    supportsVision: true,
    supportsFunctionCalling: true,
  },
  {
    id: 'zhipu:glm-4.7',
    provider: 'zhipu',
    name: 'GLM-4.7 (线上)',
    description: '智谱最新模型，效果优秀',
    requiresApiKey: true,
    supportsVision: false,
    supportsFunctionCalling: true,
  },
];

// ==================== 模型能力探测结果覆盖 ====================
//
// 设计说明：
// - AVAILABLE_MODELS 是人工维护的静态默认值（真相源）
// - capabilities.json 是探测脚本（scripts/probe-model-capabilities.ts）生成的覆盖值
// - 运行时通过 resolveModelCapabilities() 合并两者，探测结果优先
// - 如果 JSON 文件不存在或某模型未被探测，回退到静态默认值（故障安全）
// - 探测脚本每周通过 GitHub Actions 跑一次，生成 PR 供人工 review 后合并

interface ProbedCapabilities {
  supportsToolChoice?: boolean;
  supportsVision?: boolean;
  supportsFunctionCalling?: boolean;
  probeNotes?: string;
}

interface CapabilitiesFile {
  lastProbedAt: string;
  models: Record<string, ProbedCapabilities>;
}

/**
 * 读取 capabilities.json（探测脚本生成）
 *
 * 读取策略：
 * 1. 开发环境：从源码 src/fundamentals/capabilities.json 读
 * 2. 生产环境：从 dist/fundamentals/capabilities.json 读（nest build 会复制 .json）
 * 3. 文件不存在或解析失败：返回空对象，回退到静态默认值
 *
 * 注意：用 readFileSync 同步读取一次并缓存，避免每次 getModelCapabilities 都读盘
 */
let cachedCapabilities: CapabilitiesFile | null = null;
let capabilitiesLoadAttempted = false;

function loadCapabilitiesFile(): CapabilitiesFile | null {
  if (capabilitiesLoadAttempted) {
    return cachedCapabilities;
  }
  capabilitiesLoadAttempted = true;

  const candidatePaths: string[] = [];

  // CJS 环境（NestJS 编译后 / ts-node 运行）：__dirname 指向当前文件所在目录
  // model-provider.ts 与 capabilities.json 同目录，直接拼接
  if (typeof __dirname !== 'undefined') {
    candidatePaths.push(join(__dirname, 'capabilities.json'));
    // 兼容 dist/fundamentals/ 编译后路径，capabilities.json 可能被复制到 dist 同级
    candidatePaths.push(join(__dirname, '..', 'capabilities.json'));
  }

  // 兜底：按 cwd 推导（适用于各种异常情况）
  candidatePaths.push(
    join(process.cwd(), 'src', 'fundamentals', 'capabilities.json'),
  );
  candidatePaths.push(
    join(process.cwd(), 'dist', 'fundamentals', 'capabilities.json'),
  );

  for (const filePath of candidatePaths) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as CapabilitiesFile;
      cachedCapabilities = parsed;
      logger.info('已加载模型能力探测结果', {
        module: 'ModelProvider',
        path: filePath,
        lastProbedAt: parsed.lastProbedAt,
        modelCount: Object.keys(parsed.models || {}).length,
      });
      return cachedCapabilities;
    } catch {
      // 文件不存在或解析失败，尝试下一个候选路径
      continue;
    }
  }

  logger.info('未找到 capabilities.json，使用静态默认能力值', {
    module: 'ModelProvider',
  });
  return null;
}

/**
 * 清空 capabilities.json 的内存缓存
 *
 * 使用场景：应用内探测接口写入新的 capabilities.json 后调用，
 * 让后续 getModelCapabilities / resolveModelCapabilities 重新读盘。
 */
export function invalidateCapabilitiesCache(): void {
  cachedCapabilities = null;
  capabilitiesLoadAttempted = false;
  logger.info(
    '已清空模型能力探测结果缓存，下次读取将重新加载 capabilities.json',
    {
      module: 'ModelProvider',
    },
  );
}

/**
 * 合并静态默认值和探测覆盖值
 *
 * 优先级：探测结果 > 静态默认值
 * - 探测结果中明确存在的字段覆盖静态值
 * - 探测结果中未包含的字段保持静态默认值
 * - 完全没有探测结果的模型，全量使用静态默认值
 */
function resolveModelCapabilities(modelId: string): AvailableModel | undefined {
  const staticConfig = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!staticConfig) {
    return undefined;
  }

  const capabilities = loadCapabilitiesFile();
  const probed = capabilities?.models?.[modelId];
  if (!probed) {
    return staticConfig;
  }

  // 只覆盖探测结果中明确存在的字段（undefined 表示未探测，保持默认）
  // 注意：supportsToolChoice 静态标注为 false 时不可被探测覆盖——
  //       探测脚本用简单消息可能无法复现 thinking mode 的 400 错误，
  //       而静态 false 是已确认的 API 限制，必须优先。
  return {
    ...staticConfig,
    supportsToolChoice:
      staticConfig.supportsToolChoice === false
        ? false
        : (probed.supportsToolChoice ?? staticConfig.supportsToolChoice),
    supportsVision: probed.supportsVision ?? staticConfig.supportsVision,
    supportsFunctionCalling:
      probed.supportsFunctionCalling ?? staticConfig.supportsFunctionCalling,
  };
}

const DEEPSEEK_BASE_URL = config.deepseekBaseUrl;
const ZHIPU_BASE_URL = config.zhipuBaseUrl;
const OLLAMA_BASE_URL = config.ollamaBaseUrl;

let currentModelId = 'ollama:minicpm';
let deepseekApiKey = '';
let zhipuApiKey = '';

// ==================== API Key Redis 持久化 ====================
//
// API Key 加密后存入 Redis，服务重启时自动恢复，无需重新输入。
// Redis 不可用时降级为纯内存模式（重启后需重新输入）。

const APIKEY_REDIS_PREFIX = 'api-key:';
const DEEPSEEK_KEY_REDIS = `${APIKEY_REDIS_PREFIX}deepseek`;
const ZHIPU_KEY_REDIS = `${APIKEY_REDIS_PREFIX}zhipu`;
const CURRENT_MODEL_REDIS = 'model-settings:current';

/** 持久化加密后的 API Key 到 Redis（fire-and-forget） */
async function persistApiKey(redisKey: string, encryptedKey: string): Promise<void> {
  if (!isRedisReady()) return;
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(redisKey, encryptedKey);
  } catch (e: any) {
    logger.warn('API Key Redis 持久化失败（内存仍可用）', {
      module: 'ModelProvider',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

/**
 * 从 Redis 恢复 API Key（服务启动时调用）
 *
 * 读取加密的 API Key 并直接设置到内存变量（跳过清理逻辑，因为存储前已清理过）。
 * 应在 main.ts 中 Redis 初始化后调用。
 */
export async function loadApiKeysFromStorage(): Promise<void> {
  if (!isRedisReady()) {
    logger.info('Redis 未就绪，API Key 跳过恢复（需手动输入）', { module: 'ModelProvider' });
    return;
  }
  try {
    const redis = getRedis();
    if (!redis) return;

    const [deepseekStored, zhipuStored] = await Promise.all([
      redis.get(DEEPSEEK_KEY_REDIS),
      redis.get(ZHIPU_KEY_REDIS),
    ]);

    if (deepseekStored && isEncrypted(deepseekStored)) {
      deepseekApiKey = deepseekStored;
      logger.info('DeepSeek API Key 已从 Redis 恢复', { module: 'ModelProvider' });
    }
    if (zhipuStored && isEncrypted(zhipuStored)) {
      zhipuApiKey = zhipuStored;
      logger.info('智谱 API Key 已从 Redis 恢复', { module: 'ModelProvider' });
    }
  } catch (e: any) {
    logger.warn('API Key 从 Redis 恢复失败', {
      module: 'ModelProvider',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

export function getCurrentModelId(): string {
  return currentModelId;
}

export function setDeepseekApiKey(apiKey: string): void {
  // 清理 API Key：去除首尾空白、中文引号等常见复制错误
  const cleaned = apiKey
    .trim()
    .replace(/[\u201C\u201D]/g, '"') // 中文双引号 → 英文双引号
    .replace(/[\u2018\u2019]/g, "'") // 中文单引号 → 英文单引号
    .replace(/\u3000/g, ' '); // 全角空格 → 半角空格

  if (cleaned !== apiKey) {
    logger.warn('DeepSeek API Key 已自动清理空白字符和中文标点', {
      module: 'ModelProvider',
    });
  }

  // 检查是否仍包含非 ASCII 字符
  const nonAsciiMatch = cleaned.match(/[^\x00-\x7F]/g);
  if (nonAsciiMatch) {
    logger.error(
      'DeepSeek API Key 包含非 ASCII 字符，这可能导致 API 调用失败',
      {
        module: 'ModelProvider',
        nonAsciiChars: nonAsciiMatch.map(
          (c) => `${c}(U+${c.charCodeAt(0).toString(16).padStart(4, '0')})`,
        ),
      },
    );
  }

  deepseekApiKey = encrypt(cleaned);
  // 持久化到 Redis（fire-and-forget，重启后自动恢复）
  void persistApiKey(DEEPSEEK_KEY_REDIS, deepseekApiKey);
}

export function getDeepseekApiKey(): string {
  if (!deepseekApiKey) return '';
  // 兼容历史明文：存储的值不是密文格式时直接返回
  if (!isEncrypted(deepseekApiKey)) return deepseekApiKey;
  return decrypt(deepseekApiKey);
}

export function setZhipuApiKey(apiKey: string): void {
  // 清理 API Key：去除首尾空白、中文引号等常见复制错误
  const cleaned = apiKey
    .trim()
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u3000/g, ' ');

  if (cleaned !== apiKey) {
    logger.warn('智谱 API Key 已自动清理空白字符和中文标点', {
      module: 'ModelProvider',
    });
  }

  const nonAsciiMatch = cleaned.match(/[^\x00-\x7F]/g);
  if (nonAsciiMatch) {
    logger.error('智谱 API Key 包含非 ASCII 字符，这可能导致 API 调用失败', {
      module: 'ModelProvider',
      nonAsciiChars: nonAsciiMatch.map(
        (c) => `${c}(U+${c.charCodeAt(0).toString(16).padStart(4, '0')})`,
      ),
    });
  }

  zhipuApiKey = encrypt(cleaned);
}

export function getZhipuApiKey(): string {
  if (!zhipuApiKey) return '';
  if (!isEncrypted(zhipuApiKey)) return zhipuApiKey;
  return decrypt(zhipuApiKey);
}

export function switchModel(modelId: string): ModelConfig {
  const available = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!available) {
    throw new Error(`未知的模型: ${modelId}`);
  }

  if (available.requiresApiKey) {
    if (available.provider === 'deepseek' && !deepseekApiKey) {
      throw new Error(`模型 ${available.name} 需要 API Key，请先配置`);
    }
    if (available.provider === 'zhipu' && !zhipuApiKey) {
      throw new Error(`模型 ${available.name} 需要 API Key，请先配置`);
    }
  }

  currentModelId = modelId;
  logger.info('已切换模型', {
    module: 'ModelProvider',
    modelName: available.name,
    modelId,
  });

  return buildModelConfig(modelId);
}

export function buildModelConfig(
  modelId: string,
  options?: { isFCMode?: boolean },
): ModelConfig {
  const available = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!available) {
    throw new Error(`未知的模型: ${modelId}`);
  }

  const [provider, model] = modelId.split(':') as [ModelProvider, string];

  const config: ModelConfig = {
    provider,
    model,
    temperature: 0.7,
    isFCMode: options?.isFCMode,
  };

  if (provider === 'ollama') {
    // FC 模式需要更大上下文容纳工具 Schema 和调用结果
    config.numCtx = options?.isFCMode ? 6144 : 4096;
    config.baseUrl = OLLAMA_BASE_URL;
  } else if (provider === 'deepseek') {
    config.apiKey = getDeepseekApiKey();
    config.baseUrl = DEEPSEEK_BASE_URL;
  } else if (provider === 'zhipu') {
    config.apiKey = getZhipuApiKey();
    config.baseUrl = ZHIPU_BASE_URL;
  }

  return config;
}

export function createLLM(config?: ModelConfig): BaseChatModel {
  const modelConfig = config || buildModelConfig(currentModelId);

  if (modelConfig.provider === 'ollama') {
    return new ChatOllama({
      model: modelConfig.model,
      temperature: modelConfig.temperature ?? 0.7,
      numCtx: modelConfig.numCtx ?? 8192,
      repeatPenalty: 1.1,
      topK: 20,
      topP: 0.9,
      numGpu: 0,
      baseUrl: modelConfig.baseUrl || OLLAMA_BASE_URL,
      think: false, // 关闭 Qwen3.5 等模型的思考模式，避免输出 <tool_call>Thinking Process 内容和无限重复
    }) as unknown as BaseChatModel;
  }

  if (modelConfig.provider === 'deepseek') {
    if (!modelConfig.apiKey) {
      throw new Error('DeepSeek 模型需要 API Key');
    }

    // 验证 API Key 不包含非 ASCII 字符（会导致 ByteString 错误）
    const nonAsciiMatch = modelConfig.apiKey.match(/[^\x00-\x7F]/g);
    if (nonAsciiMatch) {
      throw new Error(
        `DeepSeek API Key 包含非 ASCII 字符: ${nonAsciiMatch.map((c) => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(', ')}。请检查 API Key 是否被错误复制（可能包含中文引号或空格）`,
      );
    }

    return new ChatOpenAI({
      model: modelConfig.model,
      temperature: modelConfig.temperature ?? 0.7,
      apiKey: modelConfig.apiKey,
      configuration: {
        baseURL: modelConfig.baseUrl || DEEPSEEK_BASE_URL,
      },
    }) as unknown as BaseChatModel;
  }

  if (modelConfig.provider === 'zhipu') {
    if (!modelConfig.apiKey) {
      throw new Error('智谱模型需要 API Key');
    }

    // 验证 API Key 不包含非 ASCII 字符
    const nonAsciiMatch = modelConfig.apiKey.match(/[^\x00-\x7F]/g);
    if (nonAsciiMatch) {
      throw new Error(
        `智谱 API Key 包含非 ASCII 字符: ${nonAsciiMatch.map((c) => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(', ')}。请检查 API Key 是否被错误复制`,
      );
    }

    return new ChatOpenAI({
      model: modelConfig.model,
      temperature: modelConfig.temperature ?? 0.7,
      apiKey: modelConfig.apiKey,
      configuration: {
        baseURL: modelConfig.baseUrl || ZHIPU_BASE_URL,
      },
    }) as unknown as BaseChatModel;
  }

  throw new Error(`不支持的模型提供者: ${modelConfig.provider}`);
}

export function getModelInfo(): {
  currentModelId: string;
  availableModels: AvailableModel[];
  hasDeepseekApiKey: boolean;
  hasZhipuApiKey: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
} {
  // 当前模型和列表中的能力都用合并后的结果（探测优先）
  const current = resolveModelCapabilities(currentModelId);
  return {
    currentModelId,
    availableModels: AVAILABLE_MODELS.map(
      (m) => resolveModelCapabilities(m.id) ?? m,
    ),
    hasDeepseekApiKey: !!deepseekApiKey,
    hasZhipuApiKey: !!zhipuApiKey,
    supportsVision: current?.supportsVision ?? false,
    supportsFunctionCalling: current?.supportsFunctionCalling ?? false,
  };
}

/**
 * 获取当前模型的能力参数（上下文长度 + FC 支持）
 * 用于工具注册和消息裁剪等场景，替代硬编码的 ID 前缀判断
 *
 * 能力值来源：静态 AVAILABLE_MODELS + capabilities.json 探测覆盖
 */
export function getModelCapabilities(modelId?: string): {
  contextLength: number;
  supportsFC: boolean;
  supportsVision: boolean;
  /** 是否支持 tool_choice 参数（强制工具调用） */
  supportsToolChoice: boolean;
} {
  const id = modelId || currentModelId;
  const available = resolveModelCapabilities(id);
  const config = buildModelConfig(id, { isFCMode: true });

  return {
    contextLength: config.numCtx ?? (id.startsWith('ollama:') ? 4096 : 32768),
    supportsFC: available?.supportsFunctionCalling ?? false,
    supportsVision: available?.supportsVision ?? false,
    // 默认所有 FC 模型都支持 tool_choice，除非明确标注为 false
    supportsToolChoice: available?.supportsToolChoice ?? true,
  };
}

// ==================== 限流 LLM 调用 ====================

/**
 * 创建受限流保护的 LLM 实例
 *
 * 返回的 LLM 实例的 invoke、stream 和 bindTools 方法都会被限流保护：
 * - 快速操作（查询改写、追问判断、重排序）使用 fast 池
 * - 流式生成（主对话）使用 streaming 池
 * - Ollama 本地模型不限流
 * - bindTools 返回的实例也继承限流保护
 *
 * @param config 模型配置
 * @param pool 限流池类型：'fast' 或 'streaming'
 * @returns 包装后的 LLM 实例
 */
export function createRateLimitedLLM(
  config?: ModelConfig,
  pool: 'fast' | 'streaming' = 'fast',
): BaseChatModel {
  const llm = createLLM(config);
  const provider =
    config?.provider || (getCurrentModelId().split(':')[0] as ModelProvider);

  // Ollama 不限流，直接返回原始实例
  if (provider === 'ollama') {
    return llm;
  }

  // 包装 invoke 方法，加入限流
  const originalInvoke = llm.invoke.bind(llm);
  llm.invoke = async function (...args: any[]) {
    return llmRateLimiter.execute(
      provider,
      pool,
      () => originalInvoke(...args),
      `${pool}_invoke`,
    );
  };

  // 包装 stream 方法，加入限流（SSE 流式场景）
  if (typeof llm.stream === 'function') {
    const originalStream = llm.stream.bind(llm);
    llm.stream = async function (...args: any[]) {
      return llmRateLimiter.execute(
        provider,
        pool,
        () => originalStream(...args),
        `${pool}_stream`,
      );
    };
  }

  // 包装 bindTools 方法，确保返回的实例也受限流保护
  if (typeof llm.bindTools === 'function') {
    const originalBindTools = llm.bindTools.bind(llm);
    (llm as any).bindTools = function (...args: any[]) {
      const boundLLM = originalBindTools(...args);

      // 包装 bindTools 返回实例的 invoke 方法
      if (typeof boundLLM.invoke === 'function') {
        const boundInvoke = boundLLM.invoke.bind(boundLLM);
        boundLLM.invoke = async function (...invokeArgs: any[]) {
          return llmRateLimiter.execute(
            provider,
            pool,
            () => boundInvoke(...invokeArgs),
            `${pool}_fc_invoke`,
          );
        };
      }

      // 包装 bindTools 返回实例的 stream 方法
      if (typeof boundLLM.stream === 'function') {
        const boundStream = boundLLM.stream.bind(boundLLM);
        boundLLM.stream = async function (...streamArgs: any[]) {
          return llmRateLimiter.execute(
            provider,
            pool,
            () => boundStream(...streamArgs),
            `${pool}_fc_stream`,
          );
        };
      }

      return boundLLM;
    };
  }

  return llm;
}
