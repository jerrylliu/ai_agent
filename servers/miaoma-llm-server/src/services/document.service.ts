/**
 * 文档版本管理服务
 * 负责文档和版本的 CRUD、状态流转、审计日志、文件操作
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as Diff from 'diff';
import { Document } from '../entities/document.entity.js';
import { DocumentVersion, VersionStatus, ParsingStatus } from '../entities/document-version.entity.js';
import { DocumentAuditLog, AuditAction } from '../entities/document-audit-log.entity.js';
import { PendingVectorOp, VectorOpType, VectorOpStatus } from '../entities/pending-vector-op.entity.js';
import { logger } from '../fundamentals/logger';
import {
  saveVersionFile,
  validateFileSize,
  validateFileType,
  calculateChecksum,
  deleteVersionFile,
  deleteDocumentFiles,
  readVersionFile,
} from '../fundamentals/file-storage';
import { parseDocument } from '../fundamentals/document-parser';
import { addDocuments, removeDocumentVersion, updateVersionVectorStatus, reindexVersion } from '../fundamentals/vector-store';

@Injectable()
export class DocumentService {
  constructor(
    @InjectRepository(Document)
    private documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private versionRepo: Repository<DocumentVersion>,
    @InjectRepository(DocumentAuditLog)
    private auditLogRepo: Repository<DocumentAuditLog>,
    @InjectRepository(PendingVectorOp)
    private pendingVectorOpRepo: Repository<PendingVectorOp>,
    private dataSource: DataSource,
  ) {}

  // ==================== 文档操作 ====================

  /**
   * 列出所有文档（含最新版本信息）
   */
  async listDocuments(): Promise<Document[]> {
    return this.documentRepo.find({
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * 获取知识库统计信息（从文档版本管理数据库聚合）
   */
  async getKnowledgeStats(): Promise<{
    documentCount: number;
    activeVersionCount: number;
    totalVersionCount: number;
    totalChunkCount: number;
    lastUpdatedAt: string | null;
  }> {
    const documentCount = await this.documentRepo.count();

    const activeVersionCount = await this.versionRepo.count({
      where: { status: VersionStatus.ACTIVE },
    });

    const totalVersionCount = await this.versionRepo.count();

    const chunkResult = await this.versionRepo
      .createQueryBuilder('v')
      .select('SUM(v.chunkCount)', 'totalChunks')
      .where('v.status = :status', { status: VersionStatus.ACTIVE })
      .getRawOne();

    const lastDoc = await this.documentRepo.find({
      order: { updatedAt: 'DESC' },
      take: 1,
    });

    return {
      documentCount,
      activeVersionCount,
      totalVersionCount,
      totalChunkCount: Number(chunkResult?.totalChunks || 0),
      lastUpdatedAt: lastDoc.length > 0 ? lastDoc[0].updatedAt?.toISOString() : null,
    };
  }

  /**
   * 获取文档详情
   */
  async getDocument(id: number): Promise<Document> {
    const doc = await this.documentRepo.findOne({ where: { id } });
    if (!doc) throw new NotFoundException(`文档 ${id} 不存在`);
    return doc;
  }

  /**
   * 修改文档元信息
   */
  async updateDocument(id: number, data: { title?: string; description?: string; tags?: string[] }): Promise<Document> {
    const doc = await this.getDocument(id);
    if (data.title !== undefined) doc.title = data.title;
    if (data.description !== undefined) doc.description = data.description;
    if (data.tags !== undefined) doc.tags = data.tags;
    return this.documentRepo.save(doc);
  }

  /**
   * 删除整个文档（含所有版本文件 + 所有向量数据）
   */
  async deleteDocument(id: number, operator: string = 'anonymous'): Promise<void> {
    const doc = await this.getDocument(id);
    const versions = await this.versionRepo.find({ where: { documentId: id } });

    logger.info('开始删除文档', { module: 'DocumentService', documentId: id, title: doc.title, versionCount: versions.length, operator });

    // 删除所有版本的向量数据
    for (const version of versions) {
      if (version.parsingStatus === ParsingStatus.SUCCESS) {
        logger.info('删除版本向量数据', { module: 'DocumentService', documentId: id, versionId: version.id, versionNumber: version.versionNumber, status: version.status });
        try {
          await removeDocumentVersion(version.id);
          logger.info('版本向量数据删除成功', { module: 'DocumentService', versionId: version.id });
        } catch (error: any) {
          logger.error('删除版本向量数据失败，已加入重试队列', { module: 'DocumentService', versionId: version.id, error: error.message, stack: error.stack });
          await this.enqueueVectorOp(version.id, VectorOpType.REMOVE);
        }
      } else {
        logger.info('跳过未成功解析的版本向量删除', { module: 'DocumentService', versionId: version.id, parsingStatus: version.parsingStatus });
      }
    }

    // 删除文件
    logger.info('开始删除文档文件', { module: 'DocumentService', documentId: id });
    deleteDocumentFiles(id);

    // 写审计日志（在删除前）
    await this.writeAuditLog(id, null, AuditAction.DELETE, operator, `删除文档 "${doc.title}" 及 ${versions.length} 个版本`);

    // 删除数据库记录（级联删除版本和审计日志）
    await this.documentRepo.remove(doc);

    logger.info('文档删除完成', { module: 'DocumentService', documentId: id, title: doc.title, operator });
  }

  // ==================== 版本操作 ====================

  /**
   * 上传文档（新建文档或新增版本）
   * 步骤：校验文件 → 计算 checksum → 存储文件 → 创建版本记录 → 异步解析 → 向量化
   */
  async uploadDocument(
    file: { buffer: Buffer; originalname: string; size: number; mimetype: string },
    options: { documentId?: number; title?: string; description?: string; tags?: string[]; operator?: string },
  ): Promise<{ document: Document; version: DocumentVersion }> {
    const operator = options.operator || 'anonymous';

    // 1. 校验文件
    const sizeCheck = validateFileSize(file.size);
    if (!sizeCheck.valid) throw new BadRequestException(sizeCheck.message);

    const typeCheck = validateFileType(file.originalname);
    if (!typeCheck.valid) throw new BadRequestException(typeCheck.message);

    // 2. 计算 checksum
    const checksum = calculateChecksum(file.buffer);

    // 3. 使用事务保证数据一致性
    return this.dataSource.transaction(async (manager) => {
      let document: Document | null;
      let versionNumber: number;

      if (options.documentId) {
        // 新增版本到已有文档
        document = await manager.findOne(Document, { where: { id: options.documentId } });
        if (!document) throw new NotFoundException(`文档 ${options.documentId} 不存在`);

        // 检查 checksum 是否与最新 active 版本重复
        const latestActive = await manager.findOne(DocumentVersion, {
          where: { documentId: document.id, status: VersionStatus.ACTIVE },
          order: { versionNumber: 'DESC' },
        });
        if (latestActive && latestActive.checksum === checksum) {
          throw new BadRequestException('文件内容与当前活跃版本完全相同，无需重复上传');
        }

        // 计算新版本号
        const maxVersion = await manager.findOne(DocumentVersion, {
          where: { documentId: document.id },
          order: { versionNumber: 'DESC' },
        });
        versionNumber = (maxVersion?.versionNumber || 0) + 1;
      } else {
        // 新建文档
        document = manager.create(Document, {
          title: options.title || file.originalname.replace(/\.[^/.]+$/, ''),
          description: options.description ?? undefined,
          tags: options.tags || [],
        });
        document = await manager.save(document);
        versionNumber = 1;
      }

      // 4. 保存文件
      const fileInfo = saveVersionFile(document.id, versionNumber, file.buffer, file.originalname);

      // 5. 创建版本记录
      const version = manager.create(DocumentVersion, {
        documentId: document.id,
        versionNumber,
        fileUrl: fileInfo.fileUrl,
        fileSize: String(fileInfo.fileSize),
        fileType: fileInfo.fileType,
        checksum: fileInfo.checksum,
        status: VersionStatus.DRAFT,
        parsingStatus: ParsingStatus.PENDING,
        uploadedBy: operator,
      });
      const savedVersion = await manager.save(version);

      // 7. 写审计日志
      const auditLog = manager.create(DocumentAuditLog, {
        documentId: document.id,
        versionId: savedVersion.id,
        action: AuditAction.UPLOAD,
        operator,
        detail: `上传版本 v${versionNumber} (${file.originalname})`,
      });
      await manager.save(auditLog);

      // 8. 异步解析和向量化
      this.processVersionAsync(savedVersion.id, document.id).catch((err) => {
        logger.error('异步解析向量化失败', { module: 'DocumentService', versionId: savedVersion.id, error: String(err) });
      });

      logger.info('文档上传完成', { module: 'DocumentService', documentId: document.id, versionNumber, operator });

      return { document, version: savedVersion };
    });
  }

  /**
   * 异步处理版本：解析 → 切分 → 向量化 → 激活
   */
  private async processVersionAsync(versionId: number, documentId: number): Promise<void> {
    logger.info('开始异步处理版本', { module: 'DocumentService', versionId, documentId });
    let tempFilePath: string | null = null;
    try {
      await this.versionRepo.update(versionId, { parsingStatus: ParsingStatus.PARSING });
      logger.info('版本解析状态已更新为 parsing', { module: 'DocumentService', versionId });

      const version = await this.versionRepo.findOne({ where: { id: versionId } });
      if (!version) {
        logger.error('版本记录不存在，终止处理', { module: 'DocumentService', versionId });
        return;
      }

      const fileBuffer = readVersionFile(version.fileUrl);
      if (!fileBuffer) {
        logger.error('文件不存在或无法读取', { module: 'DocumentService', versionId, fileUrl: version.fileUrl });
        await this.versionRepo.update(versionId, {
          parsingStatus: ParsingStatus.FAILED,
          errorMessage: '文件不存在或无法读取',
        });
        return;
      }
      logger.info('文件读取成功', { module: 'DocumentService', versionId, fileUrl: version.fileUrl, fileSize: fileBuffer.length });

      const ext = version.fileType;
      const mimeType = this.getMimeTypeByExt(ext);
      logger.info('开始解析文档', { module: 'DocumentService', versionId, fileType: ext, mimeType });
      const tempInfo = this.getAbsoluteTempPath(version.fileUrl, ext);
      tempFilePath = tempInfo.filePath;
      const textContent = await parseDocument(tempInfo.filePath, mimeType);

      if (!textContent || textContent.trim().length === 0) {
        logger.error('文档内容为空或无法提取文本', { module: 'DocumentService', versionId, textLength: textContent?.length || 0 });
        await this.versionRepo.update(versionId, {
          parsingStatus: ParsingStatus.FAILED,
          errorMessage: '文档内容为空或无法提取文本',
        });
        return;
      }
      logger.info('文档解析完成', { module: 'DocumentService', versionId, textLength: textContent.length });

      const metadata = {
        documentId: String(documentId),
        versionId: String(versionId),
        versionStatus: VersionStatus.DRAFT,
        source: version.fileUrl,
        fileType: version.fileType,
      };
      logger.info('开始向量化入库', { module: 'DocumentService', versionId, documentId });

      const chunkCount = await addDocuments([textContent], [metadata]);
      logger.info('向量化入库完成', { module: 'DocumentService', versionId, documentId, chunkCount });

      await this.versionRepo.update(versionId, {
        parsingStatus: ParsingStatus.SUCCESS,
        chunkCount,
      });

      logger.info('开始自动激活版本', { module: 'DocumentService', versionId });
      await this.activateVersion(versionId, version.uploadedBy || 'system');

      logger.info('版本解析向量化完成', { module: 'DocumentService', versionId, documentId, chunkCount });
    } catch (error: any) {
      await this.versionRepo.update(versionId, {
        parsingStatus: ParsingStatus.FAILED,
        errorMessage: error.message,
      });
      logger.error('版本处理失败', { module: 'DocumentService', versionId, error: error.message, stack: error.stack });
    } finally {
      if (tempFilePath) {
        this.cleanupTempFile(tempFilePath);
      }
    }
  }

  /**
   * 激活版本：旧 active → archived，新版本 → active
   */
  async activateVersion(versionId: number, operator: string = 'anonymous'): Promise<DocumentVersion> {
    const version = await this.versionRepo.findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    if (version.status === VersionStatus.ACTIVE) {
      throw new BadRequestException('版本已经是 active 状态');
    }
    if (version.status === VersionStatus.ARCHIVED) {
      throw new BadRequestException('archived 状态不能直接激活，请使用回滚功能');
    }

    logger.info('开始激活版本', { module: 'DocumentService', versionId, documentId: version.documentId, currentStatus: version.status, operator });

    // 将当前 active 版本改为 archived
    const activeVersions = await this.versionRepo.find({
      where: { documentId: version.documentId, status: VersionStatus.ACTIVE },
    });
    logger.info('找到需要归档的 active 版本', { module: 'DocumentService', documentId: version.documentId, activeCount: activeVersions.length });

    for (const av of activeVersions) {
      logger.info('归档旧 active 版本', { module: 'DocumentService', versionId: av.id, versionNumber: av.versionNumber });
      try {
        await updateVersionVectorStatus(av.id, VersionStatus.ARCHIVED);
        logger.info('旧 active 版本向量状态已更新为 archived', { module: 'DocumentService', versionId: av.id });
      } catch (error: any) {
        logger.error('更新旧 active 版本向量状态失败，已加入重试队列', { module: 'DocumentService', versionId: av.id, error: error.message });
        await this.enqueueVectorOp(av.id, VectorOpType.UPDATE_STATUS, { newStatus: VersionStatus.ARCHIVED });
      }
      av.status = VersionStatus.ARCHIVED;
      av.archivedAt = new Date();
      await this.versionRepo.save(av);
    }

    // 激活新版本：先更新向量，再改数据库
    try {
      await updateVersionVectorStatus(version.id, VersionStatus.ACTIVE);
      logger.info('新版本向量状态已更新为 active', { module: 'DocumentService', versionId: version.id });
    } catch (error: any) {
      logger.error('更新新版本向量状态失败，已加入重试队列', { module: 'DocumentService', versionId: version.id, error: error.message });
      await this.enqueueVectorOp(version.id, VectorOpType.UPDATE_STATUS, { newStatus: VersionStatus.ACTIVE });
    }
    version.status = VersionStatus.ACTIVE;
    version.archivedAt = null;
    await this.versionRepo.save(version);

    // 更新文档 currentVersionId
    await this.documentRepo.update(version.documentId, { currentVersionId: version.id });

    // 审计日志
    await this.writeAuditLog(version.documentId, version.id, AuditAction.ACTIVATE, operator, `激活版本 v${version.versionNumber}`);

    logger.info('版本激活完成', { module: 'DocumentService', versionId, documentId: version.documentId, versionNumber: version.versionNumber, operator });
    return version;
  }

  /**
   * 回滚到指定版本
   * 当前 active → archived，目标 archived → active
   */
  async rollbackVersion(documentId: number, targetVersionId: number, operator: string = 'anonymous'): Promise<DocumentVersion> {
    const doc = await this.getDocument(documentId);
    const targetVersion = await this.versionRepo.findOne({ where: { id: targetVersionId, documentId } });
    if (!targetVersion) throw new NotFoundException(`版本 ${targetVersionId} 不存在`);
    if (targetVersion.status === VersionStatus.ACTIVE) {
      throw new BadRequestException('目标版本已经是 active 状态');
    }
    if (targetVersion.status === VersionStatus.DRAFT) {
      throw new BadRequestException('draft 状态的版本不能回滚');
    }
    if (targetVersion.parsingStatus !== ParsingStatus.SUCCESS) {
      throw new BadRequestException('只能回滚到解析成功的版本');
    }

    logger.info('开始版本回滚', { module: 'DocumentService', documentId, targetVersionId, targetVersionNumber: targetVersion.versionNumber, operator });

    // 当前 active → archived
    const activeVersions = await this.versionRepo.find({
      where: { documentId, status: VersionStatus.ACTIVE },
    });
    logger.info('找到需要归档的 active 版本', { module: 'DocumentService', documentId, activeCount: activeVersions.length });

    for (const av of activeVersions) {
      logger.info('回滚：归档当前 active 版本', { module: 'DocumentService', versionId: av.id, versionNumber: av.versionNumber });
      try {
        await updateVersionVectorStatus(av.id, VersionStatus.ARCHIVED);
        logger.info('回滚：当前 active 版本向量状态已更新为 archived', { module: 'DocumentService', versionId: av.id });
      } catch (error: any) {
        logger.error('回滚：更新当前 active 版本向量状态失败，已加入重试队列', { module: 'DocumentService', versionId: av.id, error: error.message });
        await this.enqueueVectorOp(av.id, VectorOpType.UPDATE_STATUS, { newStatus: VersionStatus.ARCHIVED });
      }
      av.status = VersionStatus.ARCHIVED;
      av.archivedAt = new Date();
      await this.versionRepo.save(av);
    }

    // 目标版本 → active：先更新向量，再改数据库
    try {
      await updateVersionVectorStatus(targetVersion.id, VersionStatus.ACTIVE);
      logger.info('回滚：目标版本向量状态已更新为 active', { module: 'DocumentService', versionId: targetVersion.id });
    } catch (error: any) {
      logger.error('回滚：更新目标版本向量状态失败，已加入重试队列', { module: 'DocumentService', versionId: targetVersion.id, error: error.message });
      await this.enqueueVectorOp(targetVersion.id, VectorOpType.UPDATE_STATUS, { newStatus: VersionStatus.ACTIVE });
    }
    targetVersion.status = VersionStatus.ACTIVE;
    targetVersion.archivedAt = null;
    await this.versionRepo.save(targetVersion);

    // 更新文档 currentVersionId
    doc.currentVersionId = targetVersion.id;
    await this.documentRepo.save(doc);

    // 审计日志
    await this.writeAuditLog(documentId, targetVersionId, AuditAction.ROLLBACK, operator, `回滚到版本 v${targetVersion.versionNumber}`);

    logger.info('版本回滚完成', { module: 'DocumentService', documentId, targetVersionId, targetVersionNumber: targetVersion.versionNumber, operator });
    return targetVersion;
  }

  /**
   * 修改版本状态（draft→active, active→archived）
   */
  async updateVersionStatus(versionId: number, newStatus: VersionStatus, operator: string = 'anonymous'): Promise<DocumentVersion> {
    const version = await this.versionRepo.findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    // 状态流转校验
    if (version.status === VersionStatus.DRAFT && newStatus === VersionStatus.ACTIVE) {
      return this.activateVersion(versionId, operator);
    }
    if (version.status === VersionStatus.ACTIVE && newStatus === VersionStatus.ARCHIVED) {
      version.status = VersionStatus.ARCHIVED;
      version.archivedAt = new Date();
      await this.versionRepo.save(version);
      await updateVersionVectorStatus(version.id, VersionStatus.ARCHIVED);

      const action = newStatus === VersionStatus.ARCHIVED ? AuditAction.ARCHIVE : AuditAction.ACTIVATE;
      await this.writeAuditLog(version.documentId, version.id, action, operator, `版本 v${version.versionNumber} 状态变更为 ${newStatus}`);

      logger.info('版本状态变更', { module: 'DocumentService', versionId, newStatus, operator });
      return version;
    }

    throw new BadRequestException(`不允许从 ${version.status} 状态变更为 ${newStatus}`);
  }

  /**
   * 删除特定版本（同时清理向量 + BM25 索引）
   */
  async deleteVersion(versionId: number, operator: string = 'anonymous'): Promise<void> {
    const version = await this.versionRepo.findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    if (version.status === VersionStatus.ACTIVE) {
      throw new BadRequestException('不能删除 active 状态的版本，请先回滚到其他版本');
    }

    logger.info('开始删除版本', { module: 'DocumentService', versionId, documentId: version.documentId, versionNumber: version.versionNumber, status: version.status, parsingStatus: version.parsingStatus, operator });

    // 删除向量数据
    if (version.parsingStatus === ParsingStatus.SUCCESS) {
      logger.info('删除版本向量数据', { module: 'DocumentService', versionId });
      try {
        await removeDocumentVersion(version.id);
        logger.info('版本向量数据删除成功', { module: 'DocumentService', versionId });
      } catch (error: any) {
        logger.error('删除版本向量数据失败，已加入重试队列', { module: 'DocumentService', versionId, error: error.message, stack: error.stack });
        await this.enqueueVectorOp(version.id, VectorOpType.REMOVE);
      }
    } else {
      logger.info('跳过未成功解析版本的向量删除', { module: 'DocumentService', versionId, parsingStatus: version.parsingStatus });
    }

    // 删除文件
    deleteVersionFile(version.fileUrl);

    // 审计日志
    await this.writeAuditLog(version.documentId, versionId, AuditAction.DELETE, operator, `删除版本 v${version.versionNumber}`);

    // 删除数据库记录
    await this.versionRepo.remove(version);

    logger.info('版本已删除', { module: 'DocumentService', versionId, operator });
  }

  /**
   * 列出某文档的所有版本
   */
  async listVersions(documentId: number): Promise<DocumentVersion[]> {
    await this.getDocument(documentId);
    return this.versionRepo.find({
      where: { documentId },
      order: { versionNumber: 'DESC' },
    });
  }

  /**
   * 获取特定版本详情
   */
  async getVersion(versionId: number): Promise<DocumentVersion> {
    const version = await this.versionRepo.findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);
    return version;
  }

  /**
   * 轮询版本解析进度
   */
  async getVersionStatus(versionId: number): Promise<{ parsingStatus: ParsingStatus; errorMessage?: string; chunkCount?: number }> {
    const version = await this.versionRepo.findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);
    return {
      parsingStatus: version.parsingStatus,
      errorMessage: version.errorMessage || undefined,
      chunkCount: version.chunkCount || undefined,
    };
  }

  /**
   * 下载历史版本原文件
   */
  async downloadVersion(versionId: number): Promise<{ buffer: Buffer; fileName: string; fileType: string } | null> {
    const version = await this.versionRepo.findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    const buffer = readVersionFile(version.fileUrl);
    if (!buffer) throw new NotFoundException('文件不存在');

    return {
      buffer,
      fileName: `v${version.versionNumber}.${version.fileType}`,
      fileType: version.fileType,
    };
  }

  // ==================== 批量操作 ====================

  /**
   * 批量归档
   */
  async batchArchive(versionIds: number[], operator: string = 'anonymous'): Promise<number> {
    let count = 0;
    for (const id of versionIds) {
      try {
        const version = await this.versionRepo.findOne({ where: { id } });
        if (version && version.status === VersionStatus.ACTIVE) {
          await this.updateVersionStatus(id, VersionStatus.ARCHIVED, operator);
          count++;
        }
      } catch (error: any) {
        logger.error('批量归档失败', { module: 'DocumentService', versionId: id, error: error.message });
      }
    }
    return count;
  }

  /**
   * 批量删除
   */
  async batchDelete(versionIds: number[], operator: string = 'anonymous'): Promise<number> {
    let count = 0;
    for (const id of versionIds) {
      try {
        await this.deleteVersion(id, operator);
        count++;
      } catch (error: any) {
        logger.error('批量删除失败', { module: 'DocumentService', versionId: id, error: error.message });
      }
    }
    return count;
  }

  // ==================== 审计日志 ====================

  /**
   * 查询文档操作历史
   */
  async getAuditLog(documentId: number): Promise<DocumentAuditLog[]> {
    await this.getDocument(documentId);
    return this.auditLogRepo.find({
      where: { documentId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 写审计日志
   */
  private async writeAuditLog(
    documentId: number,
    versionId: number | null,
    action: AuditAction,
    operator: string,
    detail: string,
  ): Promise<void> {
    try {
      const log = this.auditLogRepo.create({
        documentId,
        versionId: versionId ?? undefined,
        action,
        operator,
        detail,
      });
      await this.auditLogRepo.save(log);
    } catch (error: any) {
      logger.error('写入审计日志失败', { module: 'DocumentService', documentId, action, error: error.message });
    }
  }

  // ==================== 辅助方法 ====================

  private getMimeTypeByExt(ext: string): string {
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      json: 'application/json',
      html: 'text/html',
    };
    return map[ext] || 'application/octet-stream';
  }

  private getAbsoluteTempPath(fileUrl: string, ext: string): { filePath: string; isTemp: boolean } {
    const absPath = path.join(__dirname, '..', '..', 'uploads', fileUrl);
    if (fs.existsSync(absPath)) return { filePath: absPath, isTemp: false };

    const buffer = readVersionFile(fileUrl);
    if (!buffer) throw new Error('文件不存在');
    const tempPath = path.join(__dirname, '..', '..', 'uploads', `temp_parse_${Date.now()}.${ext}`);
    fs.writeFileSync(tempPath, buffer);
    return { filePath: tempPath, isTemp: true };
  }

  private cleanupTempFile(filePath: string): void {
    try {
      if (filePath.includes('temp_parse_') && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info('已清理临时文件', { module: 'DocumentService', filePath });
      }
    } catch (error: any) {
      logger.warn('清理临时文件失败', { module: 'DocumentService', filePath, error: error.message });
    }
  }

  // ==================== 版本对比 ====================

  /**
   * 对比两个版本的文本差异
   * @returns 行级 diff 结果
   */
  async diffVersions(
    documentId: number,
    versionId1: number,
    versionId2: number,
  ): Promise<Array<{ value: string; added?: boolean; removed?: boolean }>> {
    await this.getDocument(documentId);

    const v1 = await this.versionRepo.findOne({ where: { id: versionId1, documentId } });
    const v2 = await this.versionRepo.findOne({ where: { id: versionId2, documentId } });

    if (!v1) throw new NotFoundException(`版本 ${versionId1} 不存在`);
    if (!v2) throw new NotFoundException(`版本 ${versionId2} 不存在`);

    // 读取文件内容并解析为纯文本
    const [text1, text2] = await Promise.all([
      this.parseVersionText(v1),
      this.parseVersionText(v2),
    ]);

    // 超大文档截断（>1MB 纯文本）
    const MAX_DIFF_SIZE = 1024 * 1024;
    const t1 = text1.length > MAX_DIFF_SIZE ? text1.substring(0, MAX_DIFF_SIZE) + '\n...(内容已截断)' : text1;
    const t2 = text2.length > MAX_DIFF_SIZE ? text2.substring(0, MAX_DIFF_SIZE) + '\n...(内容已截断)' : text2;

    // 计算行级 diff
    const changes = Diff.diffLines(t1, t2);

    logger.info('版本对比完成', { module: 'DocumentService', documentId, versionId1, versionId2, changeCount: changes.length });

    return changes.map(change => ({
      value: change.value,
      added: change.added || undefined,
      removed: change.removed || undefined,
    }));
  }

  /**
   * 解析版本文件为纯文本
   */
  private async parseVersionText(version: DocumentVersion): Promise<string> {
    const fileBuffer = readVersionFile(version.fileUrl);
    if (!fileBuffer) return '';

    const ext = version.fileType;
    const mimeType = this.getMimeTypeByExt(ext);

    // 对于文本类文件直接读取
    if (['txt', 'md', 'csv', 'json', 'html'].includes(ext)) {
      return fileBuffer.toString('utf-8');
    }

    // 对于二进制文件（pdf、docx 等），使用 document-parser 解析
    const tempInfo = this.getAbsoluteTempPath(version.fileUrl, ext);
    try {
      return await parseDocument(tempInfo.filePath, mimeType);
    } catch (error: any) {
      logger.error('解析版本文件失败', { module: 'DocumentService', versionId: version.id, error: error.message });
      return `[解析失败: ${error.message}]`;
    } finally {
      if (tempInfo.isTemp) {
        this.cleanupTempFile(tempInfo.filePath);
      }
    }
  }

  // ==================== 数据一致性保障 ====================

  /**
   * 写入向量操作重试队列（向量操作失败时调用）
   */
  async enqueueVectorOp(
    versionId: number,
    operation: VectorOpType,
    params?: Record<string, any>,
  ): Promise<void> {
    try {
      const op = this.pendingVectorOpRepo.create({
        versionId,
        operation,
        status: VectorOpStatus.PENDING,
        params: params || {},
      });
      await this.pendingVectorOpRepo.save(op);
      logger.info('向量操作已加入重试队列', { module: 'DocumentService', versionId, operation });
    } catch (error: any) {
      logger.error('写入重试队列失败', { module: 'DocumentService', versionId, operation, error: error.message });
    }
  }

  /**
   * 重试失败的向量操作（定时任务调用）
   */
  async retryFailedVectorOps(maxRetry: number = 3): Promise<number> {
    const failedOps = await this.pendingVectorOpRepo.find({
      where: { status: VectorOpStatus.FAILED },
    });

    let retried = 0;
    for (const op of failedOps) {
      if (op.retryCount >= maxRetry) {
        logger.warn('向量操作重试次数已达上限，跳过', { module: 'DocumentService', opId: op.id, retryCount: op.retryCount });
        continue;
      }

      try {
        op.status = VectorOpStatus.PROCESSING;
        op.retryCount += 1;
        await this.pendingVectorOpRepo.save(op);

        switch (op.operation) {
          case VectorOpType.REMOVE:
            await removeDocumentVersion(op.versionId);
            break;
          case VectorOpType.UPDATE_STATUS:
            await updateVersionVectorStatus(op.versionId, op.params?.newStatus || 'archived');
            break;
          case VectorOpType.REINDEX: {
            const version = await this.versionRepo.findOne({ where: { id: op.versionId } });
            if (version) {
              let textContent = op.params?.textContent;
              if (!textContent) {
                try {
                  textContent = await this.parseVersionText(version);
                  logger.info('REINDEX 重试：从文件重新解析获取文本内容', { module: 'DocumentService', versionId: op.versionId, textLength: textContent.length });
                } catch (parseError: any) {
                  logger.error('REINDEX 重试：重新解析文件失败', { module: 'DocumentService', versionId: op.versionId, error: parseError.message });
                  throw new Error(`重新解析文件失败: ${parseError.message}`);
                }
              }
              await reindexVersion(
                op.versionId,
                version.documentId,
                textContent,
                op.params?.versionStatus || 'active',
                { source: version.fileUrl, fileType: version.fileType },
              );
            }
            break;
          }
        }

        op.status = VectorOpStatus.COMPLETED;
        await this.pendingVectorOpRepo.save(op);
        retried++;
      } catch (error: any) {
        op.status = VectorOpStatus.FAILED;
        op.errorMessage = error.message;
        await this.pendingVectorOpRepo.save(op);
        logger.error('向量操作重试失败', { module: 'DocumentService', opId: op.id, error: error.message });
      }
    }

    return retried;
  }
}
