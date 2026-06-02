import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KnowledgeSourceService } from './knowledge-source.service.js';
import { logger } from '../fundamentals/logger';

const NETWORK_CHECK_URL = 'https://open.feishu.cn';
const NETWORK_CHECK_TIMEOUT_MS = 5000;

async function isNetworkAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NETWORK_CHECK_TIMEOUT_MS);
    await fetch(NETWORK_CHECK_URL, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class KnowledgeSourceSchedulerService {
  private isRunning = false;

  constructor(private readonly sourceService: KnowledgeSourceService) {}

  @Cron('0 */10 * * * *')
  async handleCronSync(): Promise<void> {
    const result = await this.syncAllDueSources();
    if (result.synced > 0 || result.errors > 0) {
      logger.info('知识源定时同步执行结果', { module: 'KnowledgeSourceScheduler', ...result });
    }
  }

  async syncAllDueSources(): Promise<{ synced: number; skipped: number; errors: number }> {
    if (this.isRunning) {
      logger.warn('知识源同步调度正在执行中，跳过本次', { module: 'KnowledgeSourceScheduler' });
      return { synced: 0, skipped: 0, errors: 0 };
    }

    this.isRunning = true;
    let synced = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const sources = await this.sourceService.getSourcesNeedingSync();

      if (sources.length === 0) {
        return { synced: 0, skipped: 0, errors: 0 };
      }

      const networkOk = await isNetworkAvailable();
      if (!networkOk) {
        logger.warn('网络不可达，跳过本次定时同步', { module: 'KnowledgeSourceScheduler', dueCount: sources.length });
        return { synced: 0, skipped: sources.length, errors: 0 };
      }

      logger.info('知识源定时同步开始', { module: 'KnowledgeSourceScheduler', dueCount: sources.length });

      for (const source of sources) {
        try {
          await this.sourceService.syncSource(source.id);
          synced++;
        } catch (error: any) {
          errors++;
          logger.error('知识源定时同步失败', {
            module: 'KnowledgeSourceScheduler',
            sourceId: source.id,
            name: source.name,
            error: error.message,
          });
        }
      }

      logger.info('知识源定时同步完成', { module: 'KnowledgeSourceScheduler', synced, errors });
    } finally {
      this.isRunning = false;
    }

    return { synced, skipped, errors };
  }
}
