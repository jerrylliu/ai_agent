import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KnowledgeSourceService } from './knowledge-source.service.js';
import { logger } from '../fundamentals/logger';
import { sendCardMessage, buildCardJson, detectReceiveIdType } from '../fundamentals/feishu-notify.service.js';

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

/**
 * 向飞书推送知识源同步结果（E2）
 * 仅当配置了 NOTIFY_FEISHU_KNOWLEDGE_SYNC_USER 且有同步活动时发送
 * 静默失败：通知失败不影响同步主流程
 */
async function notifyFeishuSyncResult(synced: number, skipped: number, errors: number, errorDetails: Array<{ name: string; error: string }>): Promise<void> {
  const recipient = process.env.NOTIFY_FEISHU_KNOWLEDGE_SYNC_USER;
  if (!recipient) return;
  // 没有任何同步活动时不推送，避免空通知打扰
  if (synced === 0 && errors === 0) return;

  try {
    const headerColor = errors > 0 ? 'red' : 'green';
    const title = errors > 0 ? `⚠️ 知识库同步：${errors} 个失败` : `✅ 知识库同步完成`;

    const fields: Array<{ label: string; value: string }> = [
      { label: '成功', value: String(synced) },
      { label: '失败', value: String(errors) },
      { label: '跳过', value: String(skipped) },
      { label: '时间', value: new Date().toLocaleString('zh-CN') },
    ];

    let content = `本次定时同步共处理 **${synced + errors + skipped}** 个知识源。`;
    if (errorDetails.length > 0) {
      content += '\n\n**失败详情**：\n' + errorDetails.slice(0, 5).map((d) => `• ${d.name}: ${d.error.substring(0, 80)}`).join('\n');
      if (errorDetails.length > 5) {
        content += `\n• ... 还有 ${errorDetails.length - 5} 条`;
      }
    }

    const card = buildCardJson({ title, content, headerColor, fields });
    const idType = detectReceiveIdType(recipient);
    const result = await sendCardMessage(recipient, idType, card);
    if (!result.success) {
      logger.warn('知识源同步飞书通知失败', { module: 'KnowledgeSourceScheduler', error: result.error });
    }
  } catch (error: any) {
    logger.warn('知识源同步飞书通知异常', { module: 'KnowledgeSourceScheduler', error: error.message });
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

      const errorDetails: Array<{ name: string; error: string }> = [];

      for (const source of sources) {
        try {
          await this.sourceService.syncSource(source.id);
          synced++;
        } catch (error: any) {
          errors++;
          errorDetails.push({ name: source.name, error: error.message });
          logger.error('知识源定时同步失败', {
            module: 'KnowledgeSourceScheduler',
            sourceId: source.id,
            name: source.name,
            error: error.message,
          });
        }
      }

      logger.info('知识源定时同步完成', { module: 'KnowledgeSourceScheduler', synced, errors });

      // E2：飞书推送同步结果（异步，失败不影响主流程）
      void notifyFeishuSyncResult(synced, skipped, errors, errorDetails);
    } finally {
      this.isRunning = false;
    }

    return { synced, skipped, errors };
  }
}
