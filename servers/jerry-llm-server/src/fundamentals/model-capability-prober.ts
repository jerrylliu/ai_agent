/**
 * 模型能力探测共享模块
 *
 * 从 scripts/probe-model-capabilities.ts 抽取的纯探测逻辑，供应用内接口和命令行脚本共用。
 *
 * 设计要点：
 * 1. 零运行时依赖——不 import logger / config / model-provider，避免 ESM/CJS 兼容问题，
 *    保证 ts-node 脚本和 NestJS 运行时都能安全 import
 * 2. API Key 来源通过参数注入（keys），优先级：调用方传入 > 环境变量
 * 3. 探测逻辑与原脚本保持一致：失败时保留旧值，不写 false 避免网络抖动误伤
 * 4. 进度通过 onProgress 回调通知调用方，由调用方决定如何记录日志 / 反馈 UI
 */
import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { ChatOllama } from '@langchain/ollama';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ==================== 类型定义 ====================

export type ModelProvider = 'ollama' | 'deepseek' | 'zhipu';

export interface ProbeTarget {
  id: string;
  provider: ModelProvider;
  name: string;
  requiresApiKey: boolean;
}

export interface ProbeResult {
  supportsToolChoice: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  probeNotes: string;
}

export interface CapabilitiesFile {
  lastProbedAt: string;
  models: Record<string, ProbeResult>;
}

/**
 * 调用方传入的 API Key，优先于环境变量
 */
export interface ProbeKeys {
  deepseek?: string;
  zhipu?: string;
}

/**
 * 探测进度回调
 * - status='probing'：开始探测某模型
 * - status='done'：探测完成，detail 为 probeNotes
 * - status='skipped'：跳过（未配置 key / Ollama 未启动），detail 为原因
 * - status='failed'：探测整体失败（如超时），detail 为错误信息
 */
export type ProbeProgress = (
  modelId: string,
  status: 'probing' | 'done' | 'skipped' | 'failed',
  detail?: string,
) => void;

// ==================== 探测目标清单 ====================
// 与 src/fundamentals/model-provider.ts 的 AVAILABLE_MODELS 保持同步
// 这里只列出需要探测的关键字段，避免 import 运行时模块引入 ESM/CJS 兼容问题

export const PROBE_TARGETS: ProbeTarget[] = [
  {
    id: 'ollama:minicpm',
    provider: 'ollama',
    name: 'MiniCPM (本地)',
    requiresApiKey: false,
  },
  {
    id: 'ollama:qwen3.5-new',
    provider: 'ollama',
    name: 'Qwen3.5 New (本地)',
    requiresApiKey: false,
  },
  {
    id: 'ollama:qwen3.5-2b',
    provider: 'ollama',
    name: 'Qwen3.5 2B (本地)',
    requiresApiKey: false,
  },
  {
    id: 'deepseek:deepseek-v4-flash',
    provider: 'deepseek',
    name: 'DeepSeek-V4-Flash',
    requiresApiKey: true,
  },
  {
    id: 'deepseek:deepseek-v4-pro',
    provider: 'deepseek',
    name: 'DeepSeek-V4-Pro',
    requiresApiKey: true,
  },
  {
    id: 'zhipu:glm-4.6v',
    provider: 'zhipu',
    name: 'GLM-4.6V',
    requiresApiKey: true,
  },
  {
    id: 'zhipu:glm-4.7',
    provider: 'zhipu',
    name: 'GLM-4.7',
    requiresApiKey: true,
  },
];

/**
 * 探测用的 LLM 类型——只需 invoke 和 bindTools 两个方法
 * 避免 BaseChatModel 上 bindTools 签名不完整导致的 any 断言
 */
interface ProbeLLM {
  invoke: (messages: unknown[], options?: unknown) => Promise<unknown>;
  bindTools: (tools: unknown[], kwargs?: Record<string, unknown>) => ProbeLLM;
}

// ==================== 探测逻辑 ====================

/**
 * 1x1 透明 PNG，用于探测 vision 支持
 */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * 最小工具定义，用于探测 FC 支持
 */
const PROBE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'probe_tool',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
  },
};

const PROBE_TIMEOUT_MS = 30_000;

/**
 * 探测单个模型的能力
 *
 * 探测策略（每项独立，互不影响）：
 * - tool_choice：发一个带 tool_choice='auto' 的最小请求，报 400 且消息含 tool_choice → 不支持
 * - vision：发一个带 1x1 PNG 的最小请求，报错且消息含 image/vision/multimodal → 不支持
 * - functionCalling：bindTools 后发最小请求，报错 → 不支持
 *
 * 探测失败（网络/限流/超时）的判定：
 * - 抛超时错误 → 不写入结果（调用方保留旧值）
 * - 其他未识别错误 → 乐观保留默认值 true，但在 probeNotes 里记录
 *
 * @param target 探测目标
 * @param keys 调用方传入的 API Key（优先于环境变量）
 */
export async function probeModel(
  target: ProbeTarget,
  keys?: ProbeKeys,
): Promise<ProbeResult> {
  const notes: string[] = [];
  let supportsToolChoice = true;
  let supportsVision = true;
  let supportsFunctionCalling = true;

  // ---------- 探测 1：tool_choice 支持 ----------
  // 注意：必须先 bindTools 再传 tool_choice='required'，否则 API 可能忽略该参数导致误判
  try {
    const llm = createLLMForProbe(target, keys);
    const llmWithTools = llm.bindTools([PROBE_TOOL], {
      tool_choice: 'required',
    });
    await withTimeout(
      llmWithTools.invoke([new HumanMessage('请调用 probe_tool 工具')]),
      PROBE_TIMEOUT_MS,
    );
    notes.push('tool_choice: ok');
  } catch (e: unknown) {
    const msg = getErrorMessage(e).toLowerCase();
    if (/tool_choice/i.test(msg)) {
      supportsToolChoice = false;
      notes.push(`tool_choice: not supported (${truncate(msg, 80)})`);
    } else if (isTimeoutError(e)) {
      throw e;
    } else {
      notes.push(`tool_choice: inconclusive (${truncate(msg, 80)})`);
    }
  }

  // ---------- 探测 2：vision 支持 ----------
  try {
    const llm = createLLMForProbe(target, keys);
    const multimodalContent = [
      { type: 'text' as const, text: 'describe this image' },
      { type: 'image_url' as const, image_url: { url: TINY_PNG_DATA_URL } },
    ];
    await withTimeout(
      llm.invoke([new HumanMessage({ content: multimodalContent })]),
      PROBE_TIMEOUT_MS,
    );
    notes.push('vision: ok');
  } catch (e: unknown) {
    const msg = getErrorMessage(e).toLowerCase();
    // 排除鉴权类错误（不是模型能力问题）
    if (
      /image|vision|multimodal|unsupported/i.test(msg) &&
      !/auth|key|401|403/.test(msg)
    ) {
      supportsVision = false;
      notes.push(`vision: not supported (${truncate(msg, 120)})`);
    } else if (isTimeoutError(e)) {
      throw e;
    } else {
      notes.push(`vision: inconclusive (${truncate(msg, 80)})`);
    }
  }

  // ---------- 探测 3：function calling 支持 ----------
  try {
    const llm = createLLMForProbe(target, keys);
    const llmWithTools = llm.bindTools([PROBE_TOOL]);
    await withTimeout(
      llmWithTools.invoke([new HumanMessage('hi')]),
      PROBE_TIMEOUT_MS,
    );
    notes.push('fc: ok');
  } catch (e: unknown) {
    const msg = getErrorMessage(e).toLowerCase();
    if (/tool|function|bind/i.test(msg) && !/auth|key|401|403/.test(msg)) {
      supportsFunctionCalling = false;
      notes.push('fc: not supported');
    } else if (isTimeoutError(e)) {
      throw e;
    } else {
      notes.push(`fc: inconclusive (${truncate(msg, 80)})`);
    }
  }

  return {
    supportsToolChoice,
    supportsVision,
    supportsFunctionCalling,
    probeNotes: notes.join('; '),
  };
}

// ==================== LLM 实例构造 ====================
// 独立实现，不依赖 model-provider.ts，避免 ESM/CJS 兼容问题

function createLLMForProbe(target: ProbeTarget, keys?: ProbeKeys): ProbeLLM {
  const [provider, modelName] = target.id.split(':') as [ModelProvider, string];

  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    return new ChatOllama({
      model: modelName,
      temperature: 0,
      numCtx: 2048, // 探测用小上下文即可
      baseUrl,
    }) as unknown as ProbeLLM;
  }

  if (provider === 'deepseek') {
    // 优先用调用方传入的 key（应用内存），回退到环境变量（脚本场景）
    const apiKey = keys?.deepseek || process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未配置');
    const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    return new ChatOpenAI({
      model: modelName,
      temperature: 0,
      apiKey,
      configuration: { baseURL },
    }) as unknown as ProbeLLM;
  }

  if (provider === 'zhipu') {
    const apiKey = keys?.zhipu || process.env.ZHIPU_API_KEY || '';
    if (!apiKey) throw new Error('ZHIPU_API_KEY 未配置');
    const baseURL =
      process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    return new ChatOpenAI({
      model: modelName,
      temperature: 0,
      apiKey,
      configuration: { baseURL },
    }) as unknown as ProbeLLM;
  }

  throw new Error(`不支持的 provider: ${String(provider)}`);
}

// ==================== 批量探测 ====================

/**
 * 探测所有可用模型并返回结果（不写文件，由调用方决定持久化）
 *
 * 跳过策略：
 * - Ollama 模型：服务未启动时跳过
 * - 云端模型：未配置 API Key 时跳过
 * - 单模型探测超时：保留旧结果不覆盖
 *
 * @param keys 调用方传入的 API Key
 * @param onProgress 进度回调
 * @param modelFilter 只探测指定模型（可选）
 */
export async function probeAllModels(
  keys?: ProbeKeys,
  onProgress?: ProbeProgress,
  modelFilter?: string,
): Promise<CapabilitiesFile> {
  const existing = loadCapabilitiesFile();
  const results: Record<string, ProbeResult> = { ...existing.models };

  for (const target of PROBE_TARGETS) {
    if (modelFilter && target.id !== modelFilter) {
      continue;
    }

    // 本地模型未启动 Ollama 服务时跳过
    if (target.provider === 'ollama') {
      const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const reachable = await isOllamaReachable(baseUrl);
      if (!reachable) {
        onProgress?.(target.id, 'skipped', `Ollama 服务未启动 (${baseUrl})`);
        continue;
      }
    }

    // 云端模型未配置 API Key 时跳过
    if (target.requiresApiKey) {
      const hasKey =
        (target.provider === 'deepseek' &&
          (keys?.deepseek || process.env.DEEPSEEK_API_KEY)) ||
        (target.provider === 'zhipu' &&
          (keys?.zhipu || process.env.ZHIPU_API_KEY));
      if (!hasKey) {
        const envVar =
          target.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ZHIPU_API_KEY';
        onProgress?.(target.id, 'skipped', `未配置 ${envVar}`);
        continue;
      }
    }

    onProgress?.(target.id, 'probing');

    try {
      const result = await probeModel(target, keys);
      results[target.id] = result;
      onProgress?.(target.id, 'done', result.probeNotes);
    } catch (e: unknown) {
      // 探测整体失败（如超时）→ 保留 existing.models[target.id]，不覆盖
      onProgress?.(target.id, 'failed', getErrorMessage(e));
    }
  }

  return {
    lastProbedAt: new Date().toISOString(),
    models: results,
  };
}

// ==================== 文件 IO ====================

/**
 * 获取 capabilities.json 输出路径
 *
 * 策略：
 * - CJS 环境（ts-node / nest build 后）：__dirname 指向当前文件所在目录
 * - 兜底：按 cwd 推导
 */
export function getCapabilitiesFilePath(): string {
  if (typeof __dirname !== 'undefined') {
    return join(__dirname, 'capabilities.json');
  }
  // ESM 兜底
  return join(process.cwd(), 'src', 'fundamentals', 'capabilities.json');
}

/**
 * 读取现有的 capabilities.json
 * 文件不存在或解析失败时返回空结构
 */
export function loadCapabilitiesFile(): CapabilitiesFile {
  const filePath = getCapabilitiesFilePath();
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as CapabilitiesFile;
  } catch {
    return { lastProbedAt: '', models: {} };
  }
}

/**
 * 将探测结果写入 capabilities.json
 */
export function saveCapabilitiesFile(data: CapabilitiesFile): void {
  const filePath = getCapabilitiesFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ==================== 辅助函数 ====================

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isTimeoutError(e: unknown): boolean {
  const msg = getErrorMessage(e).toLowerCase();
  return (
    (e instanceof Error && e.name === 'AbortError') ||
    msg.includes('probe_timeout') ||
    msg.includes('timeout')
  );
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + '...' : s;
}

async function isOllamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const url = new URL('/api/tags', baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
