// ==================== AI 写作控制器 ====================
// 为编辑器提供 AI 补全 / 续写 / 改写能力
// 路由前缀：/ai

import { Controller, Post, Body, Res, Req, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { streamCompletion, invokeCompletion, type CompletionMode } from '../fundamentals/ai-writing.service.js';
import { logger } from '../fundamentals/logger.js';

@Controller('ai')
@UseGuards(OptionalAuthGuard)
export class AiWritingController {
  /**
   * POST /ai/completion
   * AI 写作补全（SSE 流式）
   *
   * Body:
   *   mode: 'autocomplete' | 'continue' | 'rewrite'
   *   context: 光标前文本（autocomplete/continue）或选中文本（rewrite）
   *   instruction?: 改写指令（仅 rewrite）
   *
   * SSE 事件：
   *   event: content  data: "补全文本片段"
   *   event: done     data: {}
   *   event: error    data: {"message":"..."}
   */
  @Post('completion')
  async completion(
    @Body() body: {
      mode?: CompletionMode;
      context?: string;
      instruction?: string;
    },
    @Res() res: Response,
    @Req() req: any,
  ) {
    // 参数校验
    const mode = body.mode || 'autocomplete';
    const context = (body.context || '').slice(0, 8000); // 上限 8000 字符，防止滥用
    const instruction = body.instruction?.slice(0, 500);

    if (!context && mode !== 'rewrite') {
      res.status(400).json({ success: false, message: 'context 不能为空' });
      return;
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 客户端断开时中断 LLM 调用
    const abortController = new AbortController();
    res.on('close', () => {
      abortController.abort();
    });

    logger.info('AI 写作补全请求', {
      module: 'AiWritingController',
      mode,
      contextLength: context.length,
      userId: req.userId,
    });

    await streamCompletion(
      { mode, context, instruction },
      res,
      abortController.signal,
    );
  }

  /**
   * POST /ai/complete
   * AI 写作补全（非流式，一次性返回完整结果）
   *
   * 用于自动补全场景：短文本、abort 可靠、无流式 hang 风险
   *
   * Body:
   *   mode: 'autocomplete' | 'continue' | 'rewrite'
   *   context: 光标前文本（autocomplete/continue）或选中文本（rewrite）
   *   instruction?: 改写指令（仅 rewrite）
   *
   * Response: { success: boolean, suggestion?: string, message?: string }
   */
  @Post('complete')
  async complete(
    @Body() body: {
      mode?: CompletionMode;
      context?: string;
      instruction?: string;
    },
    @Res() res: Response,
    @Req() req: any,
  ) {
    const mode = body.mode || 'autocomplete';
    const context = (body.context || '').slice(0, 8000);
    const instruction = body.instruction?.slice(0, 500);

    if (!context && mode !== 'rewrite') {
      res.status(400).json({ success: false, message: 'context 不能为空' });
      return;
    }

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    logger.info('AI 写作补全请求（非流式）', {
      module: 'AiWritingController',
      mode,
      contextLength: context.length,
      userId: req.userId,
    });

    try {
      const suggestion = await invokeCompletion(
        { mode, context, instruction },
        abortController.signal,
      );
      res.json({ success: true, suggestion });
    } catch (err) {
      const isAbort = abortController.signal.aborted || (err as Error).name === 'AbortError';
      if (!res.writableEnded) {
        if (isAbort) {
          res.json({ success: false, message: '客户端取消' });
        } else {
          res.status(500).json({ success: false, message: (err as Error).message });
        }
      }
    }
  }
}
