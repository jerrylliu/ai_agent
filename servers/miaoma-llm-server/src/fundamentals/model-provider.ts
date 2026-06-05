import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { logger } from './logger';

export type ModelProvider = 'ollama' | 'deepseek' | 'zhipu';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  numCtx?: number;
  apiKey?: string;
  baseUrl?: string;
}

export interface AvailableModel {
  id: string;
  provider: ModelProvider;
  name: string;
  description: string;
  requiresApiKey: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
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
  },
  {
    id: 'deepseek:deepseek-v4-pro',
    provider: 'deepseek',
    name: 'DeepSeek-V4-Pro (线上)',
    description: 'DeepSeek 推理模型，深度思考',
    requiresApiKey: true,
    supportsVision: false,
    supportsFunctionCalling: true,
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

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const OLLAMA_BASE_URL = 'http://localhost:11434';

let currentModelId = 'ollama:minicpm';
let deepseekApiKey = '';
let zhipuApiKey = '';

export function getCurrentModelId(): string {
  return currentModelId;
}

export function setDeepseekApiKey(apiKey: string): void {
  deepseekApiKey = apiKey;
}

export function getDeepseekApiKey(): string {
  return deepseekApiKey;
}

export function setZhipuApiKey(apiKey: string): void {
  zhipuApiKey = apiKey;
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

export function buildModelConfig(modelId: string): ModelConfig {
  const available = AVAILABLE_MODELS.find(m => m.id === modelId);
  if (!available) {
    throw new Error(`未知的模型: ${modelId}`);
  }

  const [provider, model] = modelId.split(':') as [ModelProvider, string];

  const config: ModelConfig = {
    provider,
    model,
    temperature: 0.7,
  };

  if (provider === 'ollama') {
    config.numCtx = 4096;
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
