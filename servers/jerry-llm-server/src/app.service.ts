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
    history?: Array<{ role: string; content: string; images?: string[] }>,
    res?: Response,
    sessionId?: string,
    isCancelled?: () => boolean,
    userId: string = 'default',
    memoryEnabled?: boolean,
    summaryEnabled?: boolean,
    injectMemory?: boolean,
    abortController?: AbortController,
    imageModel?: string,
    /** 流式结束后的助手完整回复回调（供 Controller 做服务端自动落库，数据完整性不依赖客户端网络） */
    onAssistantReply?: (reply: string, citations?: unknown[]) => void,
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
    // 检索 query = 当前消息 + 最近 1~2 轮：用户说"继续"这类短消息时纯当前句
    // 语义几乎为零，拼上近期轮次才能保证召回（方案 §5.2）；纯图片消息
    // message 为空 → getMemoriesForInjection 内部跳过向量层走 ①+③
    let memoryTexts: string[] = [];
    if (memoryEnabled !== false && injectMemory !== false) {
      const recentTurns = (history ?? [])
        .slice(-2)
        .map((h) => h.content)
        .filter((c): c is string => typeof c === 'string' && c.length > 0);
      // 截断防御：超长 query 会拖慢 embedding 调用（3 秒超时内可能完不成），
      // 检索只要"话题意图"，2000 字符远超足够
      const retrievalQuery = [...recentTurns, message ?? '']
        .join('\n')
        .slice(0, 2000);
      const { memoryTexts: texts } =
        await this.memoryService.getMemoriesForInjection(userId, retrievalQuery);
      memoryTexts = texts;
    }

    await promptInvoke(
      message,
      images,
      history,
      res,
      sessionSummary,
      memoryTexts,
      isCancelled,
      abortController,
      userId,
      sessionId,
      (usage: UsageData) => {
        this.usageService.saveLlmUsage(usage).catch((err) => {
          logger.error('保存 LLM 用量失败', {
            module: 'AppService',
            error: String(err),
          });
        });
        // 自动评估：异步执行，不阻塞主流程
        if (usage.assistantMessage) {
          this.evaluationService
            .autoEvaluate({
              userId: usage.userId,
              sessionId: usage.sessionId || '',
              userMessage: usage.userMessage,
              assistantMessage: usage.assistantMessage,
              modelId: usage.modelId,
              usedKnowledgeBase: usage.usedKnowledgeBase,
              responseTimeMs: usage.responseTimeMs,
              // 检索上下文：在线 judge faithfulness 判分的依据来源（4 条完成路径均上报）
              retrievedContexts: usage.retrievedContexts,
            })
            .catch((err) => {
              logger.error('自动评估失败', {
                module: 'AppService',
                error: String(err),
              });
            });
        }
        // 服务端自动落库：流结束时把完整助手回复上抛给 Controller 保存
        // （onUsageComplete 在全部 4 条完成路径都会触发：FC 正常/强制回答、RAG 流式、非流式）
        if (
          onAssistantReply &&
          usage.sessionId &&
          usage.assistantMessage?.trim()
        ) {
          // citations：3 条流式完成路径从 prompt.ts 解析点贯通而来，
          // 使服务端落库行从源头携带引用，避免前端富化保存不广播导致首渲丢失
          onAssistantReply(usage.assistantMessage, usage.citations);
        }
      },
      imageModel,
    );
  }

  rag(message?: string) {
    return ragWithLLM(message || '');
  }
}
