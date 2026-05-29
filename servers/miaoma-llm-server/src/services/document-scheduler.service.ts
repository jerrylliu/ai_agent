/**
 * 文档版本管理定时任务
 * 负责：archived 版本通知、数据一致性校验、孤岛向量清理、重试队列、审计日志清理
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { DocumentVersion, VersionStatus, ParsingStatus } from '../entities/document-version.entity.js';
import { DocumentAuditLog } from '../entities/document-audit-log.entity.js';
import { PendingVectorOp, VectorOpStatus } from '../entities/pending-vector-op.entity.js';
import { DocumentService } from './document.service';
import { cleanOrphanVectors } from '../fundamentals/vector-store';
import { logger } from '../fundamentals/logger';

@Injectable()
export class DocumentSchedulerService {
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
   */
  async retryFailedOps(): Promise<{ retried: number; total: number; results: Array<{ id: number; versionId: number; operation: string; success: boolean; error?: string }> }> {
    const result = await this.documentService.retryFailedVectorOps();
    logger.info('重试向量操作完成', { module: 'DocumentScheduler', retriedCount: result.retried, totalCount: result.total });
    return result;
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
}
