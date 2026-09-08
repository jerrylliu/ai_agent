/**
 * 嵌入模型提供者 — 本地 Ollama / 云端 OpenAI 兼容端点双模式
 *
 * 根据「运行时嵌入配置 + 生效模式」构建嵌入模型实例：
 * - ollama 模式：OllamaEmbeddings（本地模型，默认 bge-m3）
 * - cloud 模式：OpenAIEmbeddings 指向 OpenAI 兼容嵌入端点
 *   （预置供应商：硅基流动，另支持自定义端点）
 *
 * 生效模式不由本模块决定：store-state 按 localEnabled 总开关 + 本地探测结果解析，
 * 本模块只做纯工厂（配置快照 + 模式均由调用方传入），避免隐藏状态。
 *
 * BGE 查询前缀策略（延续原 store-state 设计）：
 * bge-large / bge-base / bge-small（v1.5 系列）要求查询时加指令前缀，否则查询嵌入
 * 与文档嵌入不在同一语义空间，导致检索准确率极低。仅查询时加前缀（embedQuery），
 * 入库不加（embedDocuments）。
 * bge-m3 属于新架构，官方明确不需要任何指令前缀，加了反而损害效果，因此排除。
 */

import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { Embeddings } from '@langchain/core/embeddings';
import { logger } from '../logger.js';
import { decrypt } from '../crypto.js';
import type {
  EmbeddingMode,
  EmbeddingRuntimeConfig,
} from '../runtime-config.js';

// ==================== BGE 查询前缀 ====================

/**
 * BGE 查询前缀
 *
 * 实测：不加前缀 "考勤异常处理细则" vs 考勤文档相似度 0.51（低于无关技术文档 0.56）；
 *       加前缀后相似度提升至 0.66，正确匹配。
 */
export const BGE_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

/**
 * 判断模型是否需要 BGE 查询前缀
 *
 * 只有 bge v1.5 系列（large / base / small）需要指令前缀；
 * bge-m3、bge-en-icl 等新架构模型不需要，加前缀会降低检索质量。
 */
export function needsBgeQueryPrefix(model: string): boolean {
  if (/bge-m3/i.test(model)) return false;
  return /bge-(large|base|small)/i.test(model) || /bge[^\s]*v1\.5/i.test(model);
}

/** 包装 OllamaEmbeddings，为 BGE 模型自动添加查询前缀 */
class BgeOllamaEmbeddings extends OllamaEmbeddings {
  async embedQuery(text: string): Promise<number[]> {
    return super.embedQuery(`${BGE_QUERY_PREFIX}${text}`);
  }
}

/** 包装 OpenAIEmbeddings，为 BGE 模型自动添加查询前缀 */
class BgeOpenAIEmbeddings extends OpenAIEmbeddings {
  async embedQuery(text: string): Promise<number[]> {
    return super.embedQuery(`${BGE_QUERY_PREFIX}${text}`);
  }
}

// ==================== 云端供应商预设 ====================

/** 供应商可选嵌入模型（前端下拉用） */
export interface EmbeddingModelOption {
  value: string;
  label: string;
}

export interface EmbeddingProviderPreset {
  label: string;
  baseUrl: string;
  defaultModel: string;
  description: string;
  /**
   * 单次嵌入请求的最大批量条数
   *
   * LangChain OpenAIEmbeddings 默认 batchSize=512，会超过云端供应商的单次批量上限，
   * 直接报 400/413（硅基流动实测上限 64，超出返回 code 20042）。
   */
  batchSize: number;
  /** 可选模型列表（custom 为空数组，需用户手填） */
  models: readonly EmbeddingModelOption[];
}

/**
 * 云端嵌入供应商预设
 *
 * 用户选择供应商后，前端用预设填充 baseUrl / 默认模型；
 * custom 供应商的 baseUrl / model 必须手填。
 */
export const EMBEDDING_PROVIDER_PRESETS = {
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'BAAI/bge-m3',
    description: 'BAAI/bge-m3 有免费额度，1024 维、8192 token 上下文',
    // 硅基流动 embeddings 单次批量上限实测为 64，取 32 保守值
    batchSize: 32,
    models: [
      { value: 'BAAI/bge-m3', label: 'BAAI/bge-m3（推荐 · 1024 维 · 8192 上下文）' },
      { value: 'Qwen/Qwen3-Embedding-8B', label: 'Qwen/Qwen3-Embedding-8B（32768 上下文）' },
    ],
  },
  custom: {
    label: '自定义端点',
    baseUrl: '',
    defaultModel: '',
    description: '自行填写 OpenAI 兼容的 /v1/embeddings 端点',
    // 未知端点按最保守批量，避免触发对端 413
    batchSize: 10,
    models: [],
  },
} as const satisfies Record<string, EmbeddingProviderPreset>;

export type PresetCloudProvider = keyof typeof EMBEDDING_PROVIDER_PRESETS;

/**
 * 解析云端嵌入的生效模型名（不解密 apiKey）
 *
 * 供集合指纹等只需要模型名的轻量场景使用，避免无谓的解密开销与失败面。
 */
export function resolveCloudModel(cloud: EmbeddingRuntimeConfig['cloud']): string {
  const preset = EMBEDDING_PROVIDER_PRESETS[cloud.provider];
  return cloud.model.trim() || preset?.defaultModel || '';
}

/**
 * 解析云端嵌入生效配置（空字段回退到供应商预设）
 *
 * @throws 缺少 baseUrl / model 时抛错
 */
export function resolveCloudConfig(cloud: EmbeddingRuntimeConfig['cloud']): {
  baseUrl: string;
  model: string;
  apiKey: string;
  batchSize: number;
} {
  const preset = EMBEDDING_PROVIDER_PRESETS[cloud.provider];
  const baseUrl = cloud.baseUrl.trim() || preset?.baseUrl || '';
  const model = resolveCloudModel(cloud);
  const apiKey = decrypt(cloud.apiKeyEncrypted);

  if (!baseUrl) {
    throw new Error('云端嵌入未配置服务地址（baseUrl）');
  }
  if (!model) {
    throw new Error('云端嵌入未配置模型名称');
  }
  return { baseUrl, model, apiKey, batchSize: preset?.batchSize ?? 10 };
}

// ==================== 实例工厂 ====================

/**
 * 根据「运行时嵌入配置 + 生效模式」构建嵌入模型实例（纯工厂函数，无隐藏状态）
 *
 * @throws 云端模式缺少 API Key / 必要配置时抛错
 */
export function buildEmbeddings(
  cfg: EmbeddingRuntimeConfig,
  mode: EmbeddingMode,
): Embeddings {
  if (mode === 'ollama') {
    const { baseUrl, model } = cfg.ollama;
    const EmbeddingsClass = needsBgeQueryPrefix(model)
      ? BgeOllamaEmbeddings
      : OllamaEmbeddings;
    return new EmbeddingsClass({ model, baseUrl });
  }

  const { baseUrl, model, apiKey, batchSize } = resolveCloudConfig(cfg.cloud);
  if (!apiKey) {
    throw new Error('云端嵌入模式缺少 API Key，请先在设置中配置');
  }
  const EmbeddingsClass = needsBgeQueryPrefix(model)
    ? BgeOpenAIEmbeddings
    : OpenAIEmbeddings;
  return new EmbeddingsClass({
    model,
    apiKey,
    // OpenAI 兼容端点（硅基流动 / 自定义）通过 baseURL 区分
    configuration: { baseURL: baseUrl },
    timeout: 30000,
    // 云端免费档常见 429 限流，重试 1 次不足以跨过瞬时限流窗口
    maxRetries: 3,
    // 必须显式设置：默认 512 会超过云端单次批量上限，整批入库直接失败
    batchSize,
  });
}

// ==================== 试嵌入验证 ====================

export interface EmbeddingTestResult {
  /** 是否验证通过 */
  ok: boolean;
  /** 向量维度（验证通过时返回） */
  dimensions?: number;
  /** 耗时（毫秒） */
  latencyMs?: number;
  /** 失败原因（验证失败时返回） */
  error?: string;
}

/** 单次试嵌入超时（毫秒） */
const EMBEDDING_TEST_TIMEOUT_MS = 30000;

/**
 * 试嵌入：真实生成一次向量，验证地址 / Key / 模型配置是否可用
 *
 * @param mode 要验证的模式（与当前生效模式无关，供「测试本地 / 测试云端」独立验证）
 */
export async function testEmbedding(
  cfg: EmbeddingRuntimeConfig,
  mode: EmbeddingMode,
): Promise<EmbeddingTestResult> {
  const start = Date.now();
  try {
    const instance = buildEmbeddings(cfg, mode);
    const vector = await withTimeout(
      instance.embedQuery('嵌入连接测试'),
      EMBEDDING_TEST_TIMEOUT_MS,
      `嵌入测试超时（超过 ${EMBEDDING_TEST_TIMEOUT_MS / 1000} 秒）`,
    );
    return { ok: true, dimensions: vector.length, latencyMs: Date.now() - start };
  } catch (error: any) {
    logger.warn('嵌入测试失败', {
      module: 'EmbeddingProvider',
      mode,
      error: error.message,
    });
    return { ok: false, latencyMs: Date.now() - start, error: error.message };
  }
}

/** 给 Promise 加超时保护（用于防止试嵌入请求挂起） */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 生成嵌入配置的可读描述（用于日志与接口返回，不含敏感信息）
 */
export function describeEmbeddingConfig(
  cfg: EmbeddingRuntimeConfig,
  mode: EmbeddingMode,
): string {
  if (mode === 'ollama') {
    return `本地 Ollama（${cfg.ollama.model} @ ${cfg.ollama.baseUrl}）`;
  }
  const preset = EMBEDDING_PROVIDER_PRESETS[cfg.cloud.provider];
  const baseUrl = cfg.cloud.baseUrl.trim() || preset?.baseUrl || '未配置';
  const model = resolveCloudModel(cfg.cloud) || '未配置';
  return `云端嵌入（${cfg.cloud.provider}：${model} @ ${baseUrl}）`;
}
