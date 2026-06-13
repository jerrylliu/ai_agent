import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { logger } from './logger';
import { config } from './config';
import { llmRateLimiter } from './llm-rate-limiter';

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

const DEEPSEEK_BASE_URL = config.deepseekBaseUrl;
const ZHIPU_BASE_URL = config.zhipuBaseUrl;
const OLLAMA_BASE_URL = config.ollamaBaseUrl;

let currentModelId = 'ollama:minicpm';
let deepseekApiKey = '';
let zhipuApiKey = '';

export function getCurrentModelId(): string {
  return currentModelId;
}

export function setDeepseekApiKey(apiKey: string): void {
  // 清理 API Key：去除首尾空白、中文引号等常见复制错误
  const cleaned = apiKey.trim()
    .replace(/[\u201C\u201D]/g, '"')  // 中文双引号 → 英文双引号
    .replace(/[\u2018\u2019]/g, "'")  // 中文单引号 → 英文单引号
    .replace(/\u3000/g, ' ');          // 全角空格 → 半角空格

  if (cleaned !== apiKey) {
    logger.warn('DeepSeek API Key 已自动清理空白字符和中文标点', { module: 'ModelProvider' });
  }

  // 检查是否仍包含非 ASCII 字符
  const nonAsciiMatch = cleaned.match(/[^\x00-\x7F]/g);
  if (nonAsciiMatch) {
    logger.error('DeepSeek API Key 包含非 ASCII 字符，这可能导致 API 调用失败', {
      module: 'ModelProvider',
      nonAsciiChars: nonAsciiMatch.map(c => `${c}(U+${c.charCodeAt(0).toString(16).padStart(4, '0')})`),
    });
  }

  deepseekApiKey = cleaned;
}

export function getDeepseekApiKey(): string {
  return deepseekApiKey;
}

export function setZhipuApiKey(apiKey: string): void {
  // 清理 API Key：去除首尾空白、中文引号等常见复制错误
  const cleaned = apiKey.trim()
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u3000/g, ' ');

  if (cleaned !== apiKey) {
    logger.warn('智谱 API Key 已自动清理空白字符和中文标点', { module: 'ModelProvider' });
  }

  const nonAsciiMatch = cleaned.match(/[^\x00-\x7F]/g);
  if (nonAsciiMatch) {
    logger.error('智谱 API Key 包含非 ASCII 字符，这可能导致 API 调用失败', {
      module: 'ModelProvider',
      nonAsciiChars: nonAsciiMatch.map(c => `${c}(U+${c.charCodeAt(0).toString(16).padStart(4, '0')})`),
    });
  }

  zhipuApiKey = cleaned;
}

export function getZhipuApiKey(): string {
  return zhipuApiKey;
}

export function switchModel(modelId: string): ModelConfig {
  const available = AVAILABLE_MODELS.find(m => m.id === modelId);
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
  logger.info('已切换模型', { module: 'ModelProvider', modelName: available.name, modelId });

  return buildModelConfig(modelId);
}

export function buildModelConfig(modelId: string, options?: { isFCMode?: boolean }): ModelConfig {
  const available = AVAILABLE_MODELS.find(m => m.id === modelId);
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
    config.apiKey = deepseekApiKey;
    config.baseUrl = DEEPSEEK_BASE_URL;
  } else if (provider === 'zhipu') {
    config.apiKey = zhipuApiKey;
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
      throw new Error(`DeepSeek API Key 包含非 ASCII 字符: ${nonAsciiMatch.map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(', ')}。请检查 API Key 是否被错误复制（可能包含中文引号或空格）`);
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
      throw new Error(`智谱 API Key 包含非 ASCII 字符: ${nonAsciiMatch.map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(', ')}。请检查 API Key 是否被错误复制`);
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
  const current = AVAILABLE_MODELS.find(m => m.id === currentModelId);
  return {
    currentModelId,
    availableModels: AVAILABLE_MODELS,
    hasDeepseekApiKey: !!deepseekApiKey,
    hasZhipuApiKey: !!zhipuApiKey,
    supportsVision: current?.supportsVision ?? false,
    supportsFunctionCalling: current?.supportsFunctionCalling ?? false,
  };
}

/**
 * 获取当前模型的能力参数（上下文长度 + FC 支持）
 * 用于工具注册和消息裁剪等场景，替代硬编码的 ID 前缀判断
 */
export function getModelCapabilities(modelId?: string): {
  contextLength: number;
  supportsFC: boolean;
  supportsVision: boolean;
  /** 是否支持 tool_choice 参数（强制工具调用） */
  supportsToolChoice: boolean;
} {
  const id = modelId || currentModelId;
  const available = AVAILABLE_MODELS.find(m => m.id === id);
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
  const provider = config?.provider || getCurrentModelId().split(':')[0] as ModelProvider;

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
