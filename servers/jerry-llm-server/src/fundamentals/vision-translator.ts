/**
 * VLM 视觉翻译模块
 *
 * 职责：
 * 1. 调用 VLM 模型（OpenAI 兼容协议）将图片翻译为文字描述
 * 2. 失败时按分层降级策略兜底
 *    - Layer 1: VLM 主模型（带 3 次重试，应对偶发超时/限流）
 *    - Layer 2: VLM 备用模型（主模型全部失败时降级，2 次重试）
 *    - Layer 3: tesseract.js OCR（VLM 全部不可用时提取图片内文字）
 *    - Layer 4: 元数据兜底（无描述质量，仅靠 caption/上下文命中检索）
 * 3. 落盘原图到 IMAGE_STORAGE_DIR
 * 4. 写入 image_description 表，记录状态和降级路径
 *
 * 不依赖 NestJS DI，直接导出函数供 DocumentService 调用。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { logger } from './logger.js';
import { config } from './config.js';
import type { ImageAsset } from './image-extractor/index.js';

// ==================== 类型定义 ====================

/** 实际使用的降级层级 */
export type FallbackLayer = 1 | 2 | 3 | 4;

/** VLM 翻译结果 */
export interface TranslationResult {
  /** 生成的描述文本（成功时为 VLM 输出，兜底时为占位文本） */
  description: string;
  /** 实际使用的降级层级 */
  fallbackLayer: FallbackLayer;
  /** 实际使用的模型名 */
  modelUsed: string;
  /** 是否成功（Layer 4 也算"成功"但质量低） */
  success: boolean;
  /** 失败原因（success=false 时填充） */
  errorMessage: string | null;
  /** 原图落盘的相对路径（相对 IMAGE_STORAGE_DIR） */
  imagePath: string;
  /** 图片内容 SHA256 */
  imageHash: string;
}

/** 单图片翻译的输入参数 */
export interface TranslateImageInput {
  /** 图片资源 */
  asset: ImageAsset;
  /** 文档 ID（用于落盘目录） */
  docId: string;
  /** 文档标题（用于 VLM Prompt 上下文） */
  documentTitle: string;
  /**
   * 已有的图片落盘路径（相对路径，相对 IMAGE_STORAGE_DIR）
   *
   * 上传阶段 persistImagesOnUpload 已落盘图片，发布阶段传入此路径可跳过重复落盘。
   * 不传时 translateImage 内部会调用 persistImage 落盘。
   */
  existingImagePath?: string;
}

// ==================== 主入口 ====================

/**
 * 翻译单张图片为文字描述
 *
 * 流程：
 * 1. 计算图片 hash，落盘原图
 * 2. Layer 1：VLM 主模型调用（带 2 次重试）
 * 3. Layer 2：VLM 备用模型调用（主模型全部失败时，1 次重试）
 * 4. Layer 3：tesseract.js OCR（VLM 全部失败时提取图片内文字）
 * 5. Layer 4：元数据兜底（OCR 也无结果时最后的检索保证）
 *
 * @param input 翻译输入
 * @returns 翻译结果（始终返回，不抛异常，失败走 Layer 4）
 */
export async function translateImage(
  input: TranslateImageInput,
): Promise<TranslationResult> {
  const { asset, docId, documentTitle } = input;

  // 1. 计算图片 hash + 落盘原图
  const imageHash = computeImageHash(asset.buffer);

  // M3 修复：检查图片大小，超过上限走 Layer 4 兜底
  const maxSizeBytes = config.imageStorage.maxSizeBytes;
  if (asset.buffer.length > maxSizeBytes) {
    logger.warn('图片超过大小限制，走元数据兜底', {
      module: 'VisionTranslator',
      docId,
      imageIndex: asset.sourceIndex,
      imageHash,
      imageSize: asset.buffer.length,
      maxSizeBytes,
    });
    const placeholderPath = `${docId}/img_${asset.sourceIndex}.png`.replace(/\\/g, '/');
    return buildFallbackResult(
      asset,
      placeholderPath,
      imageHash,
      `图片超过大小限制（${(asset.buffer.length / 1024 / 1024).toFixed(1)}MB > ${(maxSizeBytes / 1024 / 1024).toFixed(1)}MB）`,
    );
  }

  let imagePath: string;
  // Bug 5 修复：优先使用已有路径（上传阶段已落盘），避免重复落盘浪费 IO
  if (input.existingImagePath) {
    imagePath = input.existingImagePath;
  } else {
    try {
      imagePath = await persistImage(asset.buffer, docId, asset.sourceIndex);
    } catch (persistErr: unknown) {
      // H1 修复：落盘失败时直接走 Layer 4 兜底，避免击穿整个批量处理
      const errMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      logger.error('图片落盘失败，直接走元数据兜底', {
        module: 'VisionTranslator',
        docId,
        imageIndex: asset.sourceIndex,
        imageHash,
        error: errMsg,
      });
      // 用占位路径（无法通过 /images 访问，但至少不会抛异常）
      // Bug 4 修复：统一使用正斜杠，与 persistImage 返回的路径格式一致
      const placeholderPath = `${docId}/img_${asset.sourceIndex}.png`;
      return buildFallbackResult(asset, placeholderPath, imageHash, `图片落盘失败: ${errMsg}`);
    }
  }

  // VLM 未启用且 OCR 未启用 -> 直接走 Layer 4
  if (!isVlmAvailable() && !isOcrAvailable()) {
    logger.warn('VLM 与 OCR 均未启用，直接走元数据兜底', {
      module: 'VisionTranslator',
      docId,
      imageIndex: asset.sourceIndex,
      imageHash,
    });
    return buildFallbackResult(asset, imagePath, imageHash, 'VLM 与 OCR 均未启用');
  }

  // 2. Layer 1：VLM 主模型调用（带 3 次重试，应对偶发超时/限流）
  if (isVlmAvailable()) {
    const primaryResult = await tryVlmWithRetry({
      asset,
      documentTitle,
      docId,
      imageHash,
      imagePath,
      fallback: false,
      maxRetries: 3,
      layer: 1,
    });
    if (primaryResult) return primaryResult;

    // 3. Layer 2：VLM 备用模型（配置了 fallbackModel 才尝试，2 次重试）
    if (hasFallbackModel()) {
      const fallbackResult = await tryVlmWithRetry({
        asset,
        documentTitle,
        docId,
        imageHash,
        imagePath,
        fallback: true,
        maxRetries: 2,
        layer: 2,
      });
      if (fallbackResult) return fallbackResult;
    }
  }

  // 4. Layer 3：OCR 提取图片内文字
  if (isOcrAvailable()) {
    try {
      const ocrText = await ocrImage(asset.buffer);
      if (ocrText && ocrText.trim().length > 0) {
        logger.info('OCR 提取成功（Layer 3）', {
          module: 'VisionTranslator',
          docId,
          imageIndex: asset.sourceIndex,
          imageHash,
          textLength: ocrText.length,
        });
        return {
          description: buildOcrDescription(asset, ocrText),
          fallbackLayer: 3,
          modelUsed: 'tesseract-ocr',
          success: true,
          errorMessage: null,
          imagePath,
          imageHash,
        };
      }
      logger.warn('OCR 返回空文本', {
        module: 'VisionTranslator',
        docId,
        imageIndex: asset.sourceIndex,
        imageHash,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('OCR 处理异常', {
        module: 'VisionTranslator',
        docId,
        imageIndex: asset.sourceIndex,
        imageHash,
        error: errMsg,
      });
    }
  }

  // 5. Layer 4：元数据兜底
  logger.warn('VLM + OCR 全部失败，走元数据兜底', {
    module: 'VisionTranslator',
    docId,
    imageIndex: asset.sourceIndex,
    imageHash,
  });
  return buildFallbackResult(asset, imagePath, imageHash, 'VLM + OCR 全部失败');
}

// ==================== 批量翻译（并发限流） ====================

/**
 * 批量翻译图片（并发限流）
 *
 * 并发数由 VLM_CONCURRENCY 配置控制（默认 3）。
 * 单文档调用次数超过 VLM_MAX_CALLS_PER_DOC 时，超出的图片直接走 Layer 4。
 *
 * @param inputs 翻译输入数组
 * @param documentTitle 文档标题
 * @returns 翻译结果数组（与输入顺序一致）
 */
export async function translateImagesBatch(
  inputs: TranslateImageInput[],
): Promise<TranslationResult[]> {
  if (inputs.length === 0) return [];

  const concurrency = Math.max(1, config.vlm.concurrency);
  const maxCalls = config.vlm.maxCallsPerDoc;

  // 文档级总超时 = 单图超时 × 图片数 + 容错时间
  // 超过总超时后，未处理的图片直接走 Layer 4 元数据兜底
  const perImageTimeoutMs = config.vlm.timeoutMs;
  const toleranceMs = config.vlm.docTimeoutToleranceMs;
  const vlmInputs = inputs.slice(0, maxCalls);
  const docTotalTimeoutMs = perImageTimeoutMs * vlmInputs.length + toleranceMs;
  const startTime = Date.now();

  logger.info('开始批量翻译图片', {
    module: 'VisionTranslator',
    totalImages: inputs.length,
    concurrency,
    maxCallsPerDoc: maxCalls,
    perImageTimeoutMs,
    docTotalTimeoutMs,
    docTimeoutToleranceMs: toleranceMs,
  });

  const results: TranslationResult[] = new Array<TranslationResult>(
    inputs.length,
  );

  // 超出 maxCalls 的图片直接走 Layer 4（按索引顺序，前面的优先走 VLM）
  const fallbackInputs = inputs.slice(maxCalls);

  if (fallbackInputs.length > 0) {
    logger.warn('图片数量超过单文档上限，超出部分走元数据兜底', {
      module: 'VisionTranslator',
      totalImages: inputs.length,
      vlmCount: vlmInputs.length,
      fallbackCount: fallbackInputs.length,
      maxCallsPerDoc: maxCalls,
    });
  }

  // 并发执行 VLM 翻译，每个 worker 在取任务前检查文档级总超时
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= vlmInputs.length) break;

          // 文档级总超时检查：超过则该图片直接走 Layer 4
          const elapsed = Date.now() - startTime;
          if (elapsed > docTotalTimeoutMs) {
            logger.warn('文档总超时，剩余图片走元数据兜底', {
              module: 'VisionTranslator',
              imageIndex: vlmInputs[idx].asset.sourceIndex,
              elapsedMs: elapsed,
              docTotalTimeoutMs,
            });
            results[idx] = await buildTimeoutFallbackResult(vlmInputs[idx]);
            continue;
          }

          try {
            results[idx] = await translateImage(vlmInputs[idx]);
          } catch (translateErr: unknown) {
            // H2 修复：单图翻译异常不应击穿整个批量处理，填充 Layer 4 兜底结果
            const errMsg = translateErr instanceof Error ? translateErr.message : String(translateErr);
            logger.error('单张图片翻译异常，已填充兜底结果', {
              module: 'VisionTranslator',
              docId: vlmInputs[idx].docId,
              imageIndex: vlmInputs[idx].asset.sourceIndex,
              error: errMsg,
            });
            const input = vlmInputs[idx];
            const fallbackHash = computeImageHash(input.asset.buffer);
            // 优先使用已落盘路径（如果 translateImage 抛异常前已落盘则无法获知），这里用占位路径
            // Bug 4 修复：统一使用正斜杠，与 persistImage 返回的路径格式一致
            const fallbackPath = `${input.docId}/img_${input.asset.sourceIndex}.png`;
            results[idx] = buildFallbackResult(
              input.asset,
              fallbackPath,
              fallbackHash,
              `翻译异常: ${errMsg}`,
            );
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  // 超出部分直接构造 Layer 4 结果（无需调用 VLM）
  for (let i = 0; i < fallbackInputs.length; i++) {
    const input = fallbackInputs[i];
    const resultIdx = maxCalls + i;
    const imageHash = computeImageHash(input.asset.buffer);
    let imagePath: string;
    try {
      imagePath = await persistImage(
        input.asset.buffer,
        input.docId,
        input.asset.sourceIndex,
      );
    } catch (persistErr: unknown) {
      // S2-1 修复：落盘失败时用占位路径，避免丢失前面已完成的全部 VLM 结果
      const errMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      logger.error('超出上限图片落盘失败，使用占位路径', {
        module: 'VisionTranslator',
        docId: input.docId,
        imageIndex: input.asset.sourceIndex,
        error: errMsg,
      });
      // Bug 4 修复：统一使用正斜杠，与 persistImage 返回的路径格式一致
      imagePath = `${input.docId}/img_${input.asset.sourceIndex}.png`;
    }
    results[resultIdx] = buildFallbackResult(
      input.asset,
      imagePath,
      imageHash,
      '超出单文档调用上限',
    );
  }

  // 统计
  const layer1Count = results.filter((r) => r.fallbackLayer === 1).length;
  const layer2Count = results.filter((r) => r.fallbackLayer === 2).length;
  const layer3Count = results.filter((r) => r.fallbackLayer === 3).length;
  const layer4Count = results.filter((r) => r.fallbackLayer === 4).length;
  const totalDurationMs = Date.now() - startTime;
  logger.info('批量翻译完成', {
    module: 'VisionTranslator',
    totalImages: inputs.length,
    layer1Count,
    layer2Count,
    layer3Count,
    layer4Count,
    successCount: layer1Count + layer2Count + layer3Count,
    fallbackCount: layer4Count,
    totalDurationMs,
  });

  return results;
}

/**
 * 为文档级总超时的图片构造 Layer 4 兜底结果
 *
 * 与 buildFallbackResult 的区别：需要先落盘图片并计算 hash，
 * 因为这些图片没走过 translateImage 的落盘流程。
 */
async function buildTimeoutFallbackResult(
  input: TranslateImageInput,
): Promise<TranslationResult> {
  const imageHash = computeImageHash(input.asset.buffer);
  let imagePath: string;
  try {
    imagePath = await persistImage(
      input.asset.buffer,
      input.docId,
      input.asset.sourceIndex,
    );
  } catch (persistErr: unknown) {
    // S2-2 修复：落盘失败时用占位路径，避免 persistImage 异常击穿整个批量处理
    const errMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    logger.error('文档总超时兜底：图片落盘失败，使用占位路径', {
      module: 'VisionTranslator',
      docId: input.docId,
      imageIndex: input.asset.sourceIndex,
      error: errMsg,
    });
    // Bug 4 修复：统一使用正斜杠，与 persistImage 返回的路径格式一致
    imagePath = `${input.docId}/img_${input.asset.sourceIndex}.png`;
  }
  return buildFallbackResult(
    input.asset,
    imagePath,
    imageHash,
    '文档级总超时，未调用 VLM',
  );
}

// ==================== VLM 调用（带重试 + 降级） ====================

/**
 * 尝试用 VLM（主模型或备用模型）翻译图片，带重试
 *
 * @returns 成功返回 TranslationResult，全部失败返回 null（由上层继续降级）
 */
async function tryVlmWithRetry(params: {
  asset: ImageAsset;
  documentTitle: string;
  docId: string;
  imageHash: string;
  imagePath: string;
  fallback: boolean;
  maxRetries: number;
  layer: 1 | 2;
}): Promise<TranslationResult | null> {
  const {
    asset,
    documentTitle,
    docId,
    imageHash,
    imagePath,
    fallback,
    maxRetries,
    layer,
  } = params;

  const modelLabel = fallback ? config.vlm.fallbackModel : config.vlm.primaryModel;
  let lastError: string = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callVlm(asset, documentTitle, fallback);
      logger.info(`图片翻译成功（Layer ${layer}）`, {
        module: 'VisionTranslator',
        docId,
        imageIndex: asset.sourceIndex,
        imageHash,
        attempt,
        model: modelLabel,
        fallbackLayer: layer,
        descriptionLength: result.description.length,
      });
      return {
        description: result.description,
        fallbackLayer: layer,
        modelUsed: modelLabel,
        success: true,
        errorMessage: null,
        imagePath,
        imageHash,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`VLM 调用失败（Layer ${layer}）`, {
        module: 'VisionTranslator',
        docId,
        imageIndex: asset.sourceIndex,
        attempt,
        maxRetries,
        model: modelLabel,
        error: lastError,
      });

      // 指数退避：2s -> 4s -> 8s（应对偶发超时/限流，给 VLM 服务恢复时间）
      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        await sleep(backoffMs);
      }
    }
  }

  logger.warn(`Layer ${layer} 重试全部失败`, {
    module: 'VisionTranslator',
    docId,
    imageIndex: asset.sourceIndex,
    imageHash,
    model: modelLabel,
    lastError,
  });
  return null;
}

/**
 * 调用 VLM 模型翻译单张图片
 *
 * 使用 OpenAI 兼容协议，通过 ChatOpenAI 实例发起请求。
 * 图片以 base64 data URL 形式放入 HumanMessage 的 content 数组。
 *
 * 返回值：纯文本描述（VLM 直接输出的文本，不再要求 JSON 格式）
 *
 * @throws VLM 调用失败时抛出，由上层重试或降级
 */
async function callVlm(
  asset: ImageAsset,
  documentTitle: string,
  fallback: boolean = false,
): Promise<{ description: string }> {
  const model = createVlmModel(fallback);

  const prompt = buildVlmPrompt(asset, documentTitle);
  const imageDataUrl = bufferToDataUrl(asset.buffer);

  const message = new HumanMessage({
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  });

  const response = await model.invoke([message]);
  const text =
    typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((c: unknown) => (c as { text?: string }).text || '')
            .join('')
        : '';

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('VLM 返回空描述');
  }

  return { description: trimmed };
}

/**
 * 创建 VLM 模型实例
 *
 * @param fallback true=使用备用模型配置，false=使用主模型配置
 *
 * 每次调用创建新实例，避免共享状态。
 * 超时通过 ChatOpenAI 的 timeout 参数控制。
 */
function createVlmModel(fallback: boolean = false): ChatOpenAI {
  const model = fallback && config.vlm.fallbackModel
    ? config.vlm.fallbackModel
    : config.vlm.primaryModel;
  const apiBase = fallback && config.vlm.fallbackApiBase
    ? config.vlm.fallbackApiBase
    : config.vlm.apiBase;
  const apiKey = fallback && config.vlm.fallbackApiKey
    ? config.vlm.fallbackApiKey
    : config.vlm.apiKey;

  return new ChatOpenAI({
    model,
    apiKey,
    configuration: {
      baseURL: apiBase,
    },
    timeout: config.vlm.timeoutMs,
    maxRetries: 0, // 重试由本模块控制，避免双层重试
    temperature: 0.3, // 描述任务用低温度，保证稳定
  });
}

/**
 * 构造 VLM Prompt（上下文锚点策略）
 *
 * 核心策略：以文档上下文为主，VLM 描述为辅
 * - 图片的上下文（surroundingText）由文档解析阶段精确提取，包含图片前后的标题和正文
 * - VLM 只负责描述图片本身的视觉内容
 * - 上下文信息会在入库时追加到描述后面，用于 BM25 关键词检索
 *
 * Prompt 要求 VLM：
 * - 描述图片类型和主要内容（200-400 字）
 * - 如果图片内容与文档上下文描述不符，指出差异
 * - 不要编造文档上下文中没有的专有名词
 */
function buildVlmPrompt(asset: ImageAsset, documentTitle: string): string {
  const captionLine = asset.caption
    ? `- 原文图注：${asset.caption}`
    : '- 原文图注：（无）';
  const sectionLine = asset.section ? `- 所在章节：${asset.section}` : '';
  const pageLine = asset.page != null ? `- 所在页码：第${asset.page}页` : '';

  return `你正在为知识库系统生成图片描述。请严格按以下要求输出。

## 上下文
- 文档标题：${documentTitle}
${pageLine}
${sectionLine}
${captionLine}
- 图片前后文摘要：${asset.surroundingText}

## 输出要求
请输出 200-400 字的中文描述，包含：
1. 图片类型（如：柱状图、流程图、截图、图标、示意图）
2. 图片主要内容（详细描述所见元素、数据、流程、角色、场景等）
3. 如有图注，原样附在末尾

## 注意事项
- 以文档上下文中的专有名词为准，不要编造上下文中没有的名称
- 如果图片内容与文档描述不符，在描述中指出差异
- 直接输出描述文本，不要输出 JSON、Markdown 标记或任何前缀`;
}

// ==================== Layer 3 OCR ====================

/**
 * tesseract.js Worker 的最小类型声明
 *
 * 避免直接引用 tesseract.js 的类型（该包为可选依赖，未安装时
 * TypeScript 模块解析会失败）。这里只声明 OCR 流程用到的 4 个方法。
 */
interface TesseractWorkerLike {
  loadLanguage(lang: string): Promise<unknown>;
  initialize(lang: string): Promise<unknown>;
  recognize(image: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

/**
 * OCR 单次调用超时（毫秒）
 *
 * tesseract.js 处理大图或损坏图片时可能长时间阻塞，
 * 超时后由 finally 块中的 worker.terminate() 中断后台任务，
 * 上层降级到 Layer 4 元数据兜底。
 */
const OCR_TIMEOUT_MS = 120_000;

/**
 * 使用 tesseract.js 对图片做 OCR
 *
 * 仅在 OCR_ENABLED=true 且 tesseract.js 已安装时启用。
 * 动态 import 避免未安装时启动失败；未安装时运行时报错会被
 * 上层 try/catch 捕获，降级到 Layer 4。
 *
 * @returns 提取到的文本（可能为空字符串）
 */
async function ocrImage(buffer: Buffer): Promise<string> {
  if (!config.ocr.enabled) return '';

  let worker: TesseractWorkerLike | null = null;
  try {
    // tesseract.js 是可选依赖：OCR_ENABLED=true 时才需要安装
    // 未安装时 @ts-expect-error 抑制类型解析错误，运行时会抛错由上层降级
    // @ts-expect-error - tesseract.js 是可选依赖，未安装时模块解析失败
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker() as TesseractWorkerLike;
    await worker.loadLanguage(config.ocr.lang);
    await worker.initialize(config.ocr.lang);

    // S2-5 修复：为 recognize 添加超时控制，避免 tesseract.js 挂起无限阻塞
    // 超时后外层 finally 中的 worker.terminate() 会中断后台任务
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recognizePromise = worker.recognize(buffer);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`OCR 超时（${OCR_TIMEOUT_MS / 1000}s）`)),
        OCR_TIMEOUT_MS,
      );
    });
    try {
      const { data } = await Promise.race([recognizePromise, timeoutPromise]);
      return data.text || '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore terminate error */
      }
    }
  }
}

/**
 * 把 OCR 文本包装成可检索的描述块
 *
 * OCR 文本质量不稳定，但能保证图片内的关键词（如仪表盘上的数值、
 * 截图里的标题）能被检索到。描述头部明确标注来源是 OCR。
 */
function buildOcrDescription(asset: ImageAsset, ocrText: string): string {
  const parts: string[] = ['[图片 OCR 文本]'];

  if (asset.caption) {
    parts.push(`图注：${asset.caption}`);
  }
  if (asset.section) {
    parts.push(`章节：${asset.section}`);
  }
  if (asset.page != null) {
    parts.push(`页码：第${asset.page}页`);
  }

  parts.push('识别文本：');
  parts.push(ocrText.trim());

  return parts.join('\n');
}

// ==================== Layer 4 元数据兜底 ====================

/**
 * 构造 Layer 4 元数据兜底结果
 *
 * VLM + OCR 全部失败时的最后防线，保证图片至少能被检索到（通过 caption / 上下文）。
 * 原图仍落盘，回答时可回传给多模态 LLM 做视觉理解。
 */
function buildFallbackResult(
  asset: ImageAsset,
  imagePath: string,
  imageHash: string,
  errorMessage: string,
): TranslationResult {
  const parts: string[] = ['[图片]'];

  if (asset.caption) {
    parts.push(asset.caption);
  } else {
    parts.push('未命名图片');
  }

  if (asset.section) {
    parts.push(`所在章节：${asset.section}`);
  }

  if (asset.page != null) {
    parts.push(`所在页码：第${asset.page}页`);
  }

  if (asset.surroundingText) {
    parts.push(`上下文摘要：${asset.surroundingText.slice(0, 200)}`);
  }

  return {
    description: parts.join(' | '),
    fallbackLayer: 4,
    modelUsed: 'fallback-metadata',
    success: false,
    errorMessage,
    imagePath,
    imageHash,
  };
}

// ==================== 工具函数 ====================

/** 检查 VLM 是否可用（开关开启 + API Key/Base 配置完整） */
function isVlmAvailable(): boolean {
  return (
    config.vlm.enabled &&
    config.vlm.apiKey.length > 0 &&
    config.vlm.apiBase.length > 0
  );
}

/** 检查是否配置了备用模型（Layer 2 触发条件） */
function hasFallbackModel(): boolean {
  return config.vlm.fallbackModel.length > 0;
}

/** 检查 OCR 是否可用（开关开启） */
function isOcrAvailable(): boolean {
  return config.ocr.enabled;
}

/** 计算图片 buffer 的 SHA256 hash（用于幂等去重） */
function computeImageHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 落盘原图到 IMAGE_STORAGE_DIR/{docId}/img_{index}.png
 *
 * @returns 相对路径（相对 IMAGE_STORAGE_DIR）
 */
async function persistImage(
  buffer: Buffer,
  docId: string,
  index: number,
): Promise<string> {
  const storageDir = path.resolve(process.cwd(), config.imageStorage.dir);
  const docDir = path.join(storageDir, docId);

  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }

  const filename = `img_${index}.png`;
  const fullPath = path.join(docDir, filename);

  await fs.promises.writeFile(fullPath, buffer);

  // 返回相对路径（相对 storageDir），便于后续通过 API 提供访问
  // 统一使用正斜杠，避免 Windows 反斜杠存入 DB 导致 URL 拼接问题
  return path.join(docId, filename).replace(/\\/g, '/');
}

/** Buffer 转 base64 data URL（供 OpenAI Vision API 使用） */
function bufferToDataUrl(buffer: Buffer): string {
  const base64 = buffer.toString('base64');
  // 通过文件头 magic bytes 检测图片格式，避免硬编码 image/png
  // 格式错误的 MIME 类型可能导致 VLM API 返回 400
  const mime = detectImageMime(buffer);
  return `data:${mime};base64,${base64}`;
}

/**
 * 通过文件头 magic bytes 检测图片 MIME 类型
 *
 * 支持的格式：PNG / JPEG / GIF / WebP / BMP
 * 不匹配任何已知格式时默认返回 image/png（最通用）
 */
function detectImageMime(buffer: Buffer): string {
  if (buffer.length < 4) return 'image/png';

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }

  // 未知格式默认 png
  return 'image/png';
}

/** sleep 工具函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 文件加载（供 publishToVectorStore 使用） ====================

/**
 * 从存储路径加载图片 buffer
 *
 * uploadDocument 阶段落盘图片后，publishToVectorStore 阶段通过此函数
 * 从文件系统重新加载 buffer，避免在内存中持有大量图片数据。
 *
 * @param imagePath 相对路径（相对 IMAGE_STORAGE_DIR，与 persistImage 返回值一致）
 * @returns 图片 buffer
 */
export async function loadImageBuffer(imagePath: string): Promise<Buffer> {
  const storageDir = path.resolve(process.cwd(), config.imageStorage.dir);
  const fullPath = path.join(storageDir, imagePath);
  return fs.promises.readFile(fullPath);
}

/**
 * 落盘单张图片并返回相对路径（供 uploadDocument 阶段调用）
 *
 * 与 persistImage 功能相同，但导出给 DocumentService 使用，
 * 避免 DocumentService 直接操作文件系统。
 *
 * @param buffer 图片二进制内容
 * @param docId 文档 ID
 * @param index 图片索引
 * @returns 相对路径（相对 IMAGE_STORAGE_DIR）
 */
export async function persistImageAsset(
  buffer: Buffer,
  docId: string,
  index: number,
): Promise<string> {
  return persistImage(buffer, docId, index);
}

/**
 * 计算图片 buffer 的 SHA256 hash（导出版本，供 uploadDocument 阶段去重使用）
 */
export function computeImageHashExport(buffer: Buffer): string {
  return computeImageHash(buffer);
}
