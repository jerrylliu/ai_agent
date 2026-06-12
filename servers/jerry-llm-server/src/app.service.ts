import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { promptTemplate as promptInvoke } from './fundamentals/prompt';
import { ragWithLLM } from './fundamentals/rag-service';
import { logger } from './fundamentals/logger';
import { SummaryService } from './services/summary.service';
import { MemoryService } from './services/memory.service';
import { UsageService } from './services/usage.service';
import { EvaluationService } from './services/evaluation.service';
import type { UsageData } from './fundamentals/prompt';

@Injectable()
export class AppService {
  constructor(
    private readonly summaryService: SummaryService,
    private readonly memoryService: MemoryService,
    private readonly usageService: UsageService,
    private readonly evaluationService: EvaluationService,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  async prompt(
    message?: string,
    images?: string[],
    history?: Array<{ role: string, content: string, images?: string[] }>,
    res?: Response,
    sessionId?: string,
    isCancelled?: () => boolean,
    userId: string = 'default',
    memoryEnabled?: boolean,
    summaryEnabled?: boolean,
    injectMemory?: boolean,
    abortController?: AbortController,
    imageModel?: string,
  ) {
    // 获取会话摘要（如果摘要功能已启用）
    let sessionSummary: string | undefined;
    if (sessionId && summaryEnabled !== false) {
      const summary = await this.summaryService.getSessionSummary(sessionId);
      if (summary && summary.summaryContent) {
        sessionSummary = summary.summaryContent;
      }
    }

    // 获取用户记忆（如果记忆功能已启用且允许注入）
    let memoryTexts: string[] = [];
    if (memoryEnabled !== false && injectMemory !== false) {
      const { memoryTexts: texts } = await this.memoryService.getMemoriesForInjection(userId, 20);
      memoryTexts = texts;
    }

    await promptInvoke(
      message, images, history, res, sessionSummary, memoryTexts,
      isCancelled, abortController, userId, sessionId,
      (usage: UsageData) => {
        this.usageService.saveLlmUsage(usage).catch((err) => {
          logger.error('保存 LLM 用量失败', { module: 'AppService', error: String(err) });
        });
        // 自动评估：异步执行，不阻塞主流程
        if (usage.assistantMessage) {
          this.evaluationService.autoEvaluate({
            userId: usage.userId,
            sessionId: usage.sessionId || '',
            userMessage: usage.userMessage,
            assistantMessage: usage.assistantMessage,
            modelId: usage.modelId,
            usedKnowledgeBase: usage.usedKnowledgeBase,
            responseTimeMs: usage.responseTimeMs,
          }).catch((err) => {
            logger.error('自动评估失败', { module: 'AppService', error: String(err) });
          });
        }
      },
      imageModel,
    );
  }

  rag(message?: string) {
    return ragWithLLM(message || '');
  }
}
