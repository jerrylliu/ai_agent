import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { GeneratedDocumentService } from './generated-document.service.js';
import { config } from '../fundamentals/config.js';
import { logger } from '../fundamentals/logger.js';

/**
 * 生成文档清理调度器
 *
 * 启动时根据 config.document.cleanupIntervalMin 注册一次性 setInterval，
 * 周期性调用 GeneratedDocumentService.cleanup() 清理过期/闲置文件。
 */
@Injectable()
export class GeneratedDocumentSchedulerService implements OnModuleInit {
  private readonly nestLogger = new Logger(GeneratedDocumentSchedulerService.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly generatedDocumentService: GeneratedDocumentService,
  ) {}

  onModuleInit(): void {
    const intervalMs = Math.max(config.document.cleanupIntervalMin, 1) * 60 * 1000;
    const timer = setInterval(() => {
      this.runCleanup();
    }, intervalMs);

    this.schedulerRegistry.addInterval('generated-document-cleanup', timer);
    this.nestLogger.log(
      `生成文档清理任务已注册，间隔 ${config.document.cleanupIntervalMin} 分钟`,
    );

    // 启动时立即跑一次（异步，不阻塞 onModuleInit）
    this.runCleanup();
  }

  private runCleanup(): void {
    this.generatedDocumentService.cleanup().catch((err) => {
      logger.error('生成文档清理任务异常', {
        module: 'GeneratedDocumentScheduler',
        error: err?.message || String(err),
      });
    });
  }
}
