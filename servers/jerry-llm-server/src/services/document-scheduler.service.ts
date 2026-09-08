/**
 * 文档版本管理定时任务
 * 负责：archived 版本通知、数据一致性校验、孤岛向量清理、重试队列、审计日志清理
 */

import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { DocumentVersion, VersionStatus, ParsingStatus } from '../entities/document-version.entity.js';
import { DocumentAuditLog } from '../entities/document-audit-log.entity.js';
import { PendingVectorOp, VectorOpStatus } from '../entities/pending-vector-op.entity.js';
import { DocumentService } from './document.service';
import { cleanOrphanVectors, fixDraftVectors } from '../fundamentals/vector-store';
import { logger } from '../fundamentals/logger';

/** 兜底定时任务单次最多处理的条目数，避免长时间阻塞事件循环 */
const FALLBACK_OPS_BATCH_SIZE = 10;

/** 兜底定时任务间隔（毫秒）：5 分钟 */
const FALLBACK_OPS_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class DocumentSchedulerService {
  /** 防止兜底定时任务与手动"全部重试"并发消费同一批队列条目 */
  private isRetryRunning = false;

  constructor(
    @InjectRepository(DocumentVersion)
    private versionRepo: Repository<DocumentVersion>,
    @InjectRepository(DocumentAuditLog)
    private auditLogRepo: Repository<DocumentAuditLog>,
    @InjectRepository(PendingVectorOp)
    private pendingVectorOpRepo: Repository<PendingVectorOp>,
    private documentService: DocumentService,
  ) {}

  /**
   * 扫描 archived 超过 90 天的版本，仅通知（不自动删除）
   */
  async scanArchivedVersions(): Promise<Array<{ documentId: number; versionId: number; versionNumber: number; archivedAt: Date }>> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const archivedVersions = await this.versionRepo.find({
      where: {
        status: VersionStatus.ARCHIVED,
      },
    });

    const oldVersions = archivedVersions.filter(v => v.archivedAt && v.archivedAt < ninetyDaysAgo);

    if (oldVersions.length > 0) {
      logger.info('发现超过 90 天的 archived 版本', { module: 'DocumentScheduler', count: oldVersions.length });
      for (const v of oldVersions) {
        logger.info('archived 版本待清理', {
          module: 'DocumentScheduler',
          documentId: v.documentId,
          versionId: v.id,
          versionNumber: v.versionNumber,
          archivedAt: v.archivedAt,
        });
      }
    }

    return oldVersions.map(v => ({
      documentId: v.documentId,
      versionId: v.id,
      versionNumber: v.versionNumber,
      archivedAt: v.archivedAt!,
    }));
  }

  /**
   * 校验 ChromaDB 中向量数与数据库记录是否一致
   */
  async verifyVectorConsistency(): Promise<{
    dbVersionCount: number;
    validVersionIds: string[];
    orphanVectorCount: number;
  }> {
    // 获取数据库中所有解析成功的版本
    const successVersions = await this.versionRepo.find({
      where: { parsingStatus: ParsingStatus.SUCCESS },
    });

    const validVersionIds = successVersions.map(v => String(v.id));

    // 清理孤岛向量
    const orphanCount = await cleanOrphanVectors(validVersionIds);

    logger.info('向量一致性校验完成', {
      module: 'DocumentScheduler',
      dbVersionCount: successVersions.length,
      orphanVectorCount: orphanCount,
    });

    return {
      dbVersionCount: successVersions.length,
      validVersionIds,
      orphanVectorCount: orphanCount,
    };
  }

  /**
   * 清理孤岛向量
   */
  async cleanOrphans(): Promise<number> {
    const successVersions = await this.versionRepo.find({
      where: { parsingStatus: ParsingStatus.SUCCESS },
    });
    const validVersionIds = successVersions.map(v => String(v.id));
    return cleanOrphanVectors(validVersionIds);
  }

  /**
   * 重试 PendingVectorOp 中失败的向量操作
   *
   * @param limit 本次最多处理的条目数；不传则处理全部（HTTP 手动"全部重试"走此路径）
   */
  async retryFailedOps(limit?: number): Promise<{ retried: number; total: number; results: Array<{ id: number; versionId: number; operation: string; success: boolean; error?: string }> }> {
    // 全量重建进行中时避让：REINDEX 条目正由 DocumentService.runFullReindex 逐条处理，
    // 并发消费会导致同一版本被重复嵌入入库
    if (this.documentService.isReindexRunning()) {
      logger.info('全量重建进行中，跳过本次重试队列处理', { module: 'DocumentScheduler' });
      return { retried: 0, total: 0, results: [] };
    }

    // 防重入：兜底定时任务与手动重试不并发
    if (this.isRetryRunning) {
      logger.info('重试队列任务已在执行中，跳过本次触发', { module: 'DocumentScheduler' });
      return { retried: 0, total: 0, results: [] };
    }

    this.isRetryRunning = true;
    try {
      const result = await this.documentService.retryFailedVectorOps(3, limit);
      logger.info('重试向量操作完成', { module: 'DocumentScheduler', retriedCount: result.retried, totalCount: result.total });
      return result;
    } finally {
      this.isRetryRunning = false;
    }
  }

  /**
   * 兜底定时任务：定期处理重试队列中残留的失败/待处理向量操作。
   *
   * 正常情况下 REINDEX 由 enqueueFullReindex 触发的后台执行器处理，
   * REMOVE/UPDATE_STATUS 由业务失败时入队并被本任务重试。此定时任务是
   * 宕机/漏触发兜底，限量处理避免长阻塞，并在全量重建进行中时避让。
   */
  @Interval(FALLBACK_OPS_INTERVAL_MS)
  async scheduledRetryFailedOps(): Promise<void> {
    await this.retryFailedOps(FALLBACK_OPS_BATCH_SIZE);
  }

  /**
   * 清理超过 180 天的审计日志
   */
  async cleanOldAuditLogs(): Promise<number> {
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - 180);

    const result = await this.auditLogRepo
      .createQueryBuilder()
      .delete()
      .where('createdAt < :date', { date: daysAgo })
      .execute();

    const deleted = result.affected || 0;
    if (deleted > 0) {
      logger.info('已清理过期审计日志', { module: 'DocumentScheduler', count: deleted });
    }
    return deleted;
  }

  /**
   * 清理已完成的 PendingVectorOp 记录（超过 7 天的）
   */
  async cleanCompletedVectorOps(): Promise<number> {
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - 7);

    const result = await this.pendingVectorOpRepo
      .createQueryBuilder()
      .delete()
      .where('status = :status AND createdAt < :date', {
        status: VectorOpStatus.COMPLETED,
        date: daysAgo,
      })
      .execute();

    return result.affected || 0;
  }

  /**
   * 修复 draft 状态的向量：将 ChromaDB 和 BM25 中 versionStatus=draft 的向量更新为 active
   * 用于修复历史版本中因 updateVersionVectorStatus 失败而遗留的 draft 状态
   */
  async fixDraftVectors(): Promise<{ fixedChromaCount: number; fixedBM25Count: number }> {
    logger.info('开始修复 draft 状态向量', { module: 'DocumentScheduler' });
    const result = await fixDraftVectors();
    logger.info('draft 向量修复完成', { module: 'DocumentScheduler', ...result });
    return result;
  }
}
