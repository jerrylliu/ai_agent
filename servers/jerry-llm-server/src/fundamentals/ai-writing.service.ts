/**
 * AI 写作服务
 *
 * 为编辑器提供补全 / 续写 / 改写能力，通过 SSE 流式输出。
 * 复用现有 model-provider + sse-writer + llm-rate-limiter，不引入新依赖。
 *
 * 三种模式：
 *   - autocomplete: 取光标前文本，预测接下来的少量内容（幽灵补全）
 *   - continue:     续写，输出更长段落
 *   - rewrite:      根据指令改写选中的文本
 */

import type { Response } from 'express';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createRateLimitedLLM, buildModelConfig, getCurrentModelId } from './model-provider.js';
import { sendContent, startHeartbeat, stopHeartbeat } from './sse-writer.js';
import { logger } from './logger.js';

/** 补全模式 */
export type CompletionMode = 'autocomplete' | 'continue' | 'rewrite';

/** 请求参数 */
export interface CompletionParams {
  mode: CompletionMode;
  /** 光标前的文本（autocomplete / continue）或选中的文本（rewrite） */
  context: string;
  /** 改写指令（仅 rewrite 模式） */
  instruction?: string;
}

/** 各模式的 System Prompt */
const SYSTEM_PROMPTS: Record<CompletionMode, string> = {
  autocomplete: `你是一个写作补全助手。根据用户已有的文字，预测接下来的内容。
规则：
- 只输出补全部分，不要重复用户已有内容
- 补全长度控制在 1-3 句话，不要长篇大论
- 保持与原文一致的语气和风格
- 不要输出任何解释、前缀、引号，直接给出续写内容`,

  continue: `你是一个写作续写助手。根据用户已有的文字，继续往下写。
规则：
- 只输出续写部分，不要重复用户已有内容
- 续写 1-2 段，保持逻辑连贯
- 保持与原文一致的语气和风格
- 不要输出任何解释或前缀`,

  rewrite: `你是一个文本改写助手。根据指令改写用户选中的文本。
规则：
- 只输出改写后的文本，不要输出原文或解释
- 严格遵循改写指令
- 保持原意，除非指令明确要求改变`,
};

/**
 * 执行 AI 写作补全，通过 SSE 流式输出
 *
 * @param params 补全参数
 * @param res    Express Response（SSE）
 * @param signal AbortSignal，客户端断开时 abort
 */
export async function streamCompletion(
  params: CompletionParams,
  res: Response,
  signal: AbortSignal,
): Promise<void> {
  const { mode, context, instruction } = params;

  // 构建消息序列（显式声明类型，避免推断为 SystemMessage[] 导致 push 其他类型报错）
  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPTS[mode])];

  if (mode === 'rewrite') {
    messages.push(
      new HumanMessage(`改写指令：${instruction || '润色'}\n\n原文：\n${context}`),
    );
  } else {
    // autocomplete / continue：把已有文本放在 HumanMessage 中，让 LLM 接着写
    // 不用 AIMessage 方式，因为部分模型（如 Ollama）对空 HumanMessage 后接 AIMessage 的支持不好
    messages.push(
      new HumanMessage(`已有的文字：\n${context}\n\n请直接继续写接下来的内容，只输出续写部分：`),
    );
  }

  // 用 fast 池限流（补全请求频率高，但单次输出短）
  const modelConfig = buildModelConfig(getCurrentModelId());
  // 补全场景降低温度，减少发散
  modelConfig.temperature = mode === 'rewrite' ? 0.5 : 0.3;
  const llm = createRateLimitedLLM(modelConfig, 'fast');

  // 启动心跳保活
  const heartbeat = startHeartbeat(res, 5000);

  try {
    // 流式调用 LLM（与 prompt.ts 保持一致的调用方式）
    const stream = await llm.stream(messages, { signal });

    for await (const chunk of stream) {
      if (signal.aborted) break;

      // chunk.content 可能是 string 或复杂结构，统一用 toString() 提取
      const text = chunk.content?.toString() || '';

      if (text) {
        sendContent(res, text);
      }
    }

    // 正常结束
    if (!res.writableEnded) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (err) {
    // 客户端主动断开（用户继续打字触发新请求）是正常行为，不记 error
    const isAbort = signal.aborted || (err as Error).name === 'AbortError';
    if (isAbort) {
      logger.info('AI 写作补全被客户端取消', {
        module: 'AIWritingService',
        mode,
      });
    } else {
      logger.error('AI 写作补全失败', {
        module: 'AIWritingService',
        mode,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }

    if (!res.writableEnded) {
      const msg = isAbort ? '客户端取消' : (err as Error).message;
      res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
    }
  } finally {
    stopHeartbeat(heartbeat);
    if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * 执行 AI 写作补全（非流式），一次性返回完整文本
 *
 * 用于自动补全场景：短文本、不需要逐字渲染、abort 100% 可靠
 *
 * @param params 补全参数
 * @param signal AbortSignal
 * @returns 补全文本
 */
export async function invokeCompletion(
  params: CompletionParams,
  signal: AbortSignal,
): Promise<string> {
  const { mode, context, instruction } = params;

  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPTS[mode])];

  if (mode === 'rewrite') {
    messages.push(
      new HumanMessage(`改写指令：${instruction || '润色'}\n\n原文：\n${context}`),
    );
  } else {
    messages.push(
      new HumanMessage(`已有的文字：\n${context}\n\n请直接继续写接下来的内容，只输出续写部分：`),
    );
  }

  const modelConfig = buildModelConfig(getCurrentModelId());
  modelConfig.temperature = mode === 'rewrite' ? 0.5 : 0.3;
  const llm = createRateLimitedLLM(modelConfig, 'fast');

  try {
    const result = await llm.invoke(messages, { signal });
    return result.content?.toString() || '';
  } catch (err) {
    const isAbort = signal.aborted || (err as Error).name === 'AbortError';
    if (isAbort) {
      logger.info('AI 写作补全被客户端取消', {
        module: 'AIWritingService',
        mode,
      });
      throw err;
    }
    logger.error('AI 写作补全失败', {
      module: 'AIWritingService',
      mode,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    throw err;
  }
}
