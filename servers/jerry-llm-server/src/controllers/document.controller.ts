/**
 * 文档版本管理控制器
 * 路由前缀：/documents
 * 所有日志使用 Winston logger
 */

import {
  Controller, Get, Post, Put, Delete, Patch,
  Body, Param, Query, Res, UseGuards, UseInterceptors,
  UploadedFile, ParseIntPipe, HttpException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DocumentService } from '../services/document.service';
import { DocumentScanService } from '../services/document-scan.service';
import { DocumentSchedulerService } from '../services/document-scheduler.service';
import { VersionStatus, DocumentVersion } from '../entities/document-version.entity';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { logger } from '../fundamentals/logger';

function serializeVersion(v: DocumentVersion) {
  return { ...v, fileSize: Number(v.fileSize) };
}

function serializeVersions(versions: DocumentVersion[]) {
  return versions.map(serializeVersion);
}

@Controller('documents')
@UseGuards(OptionalAuthGuard)
export class DocumentController {

  constructor(
    private readonly documentService: DocumentService,
    private readonly schedulerService: DocumentSchedulerService,
    private readonly documentScanService: DocumentScanService,
  ) {}

  /**
   * POST /documents/upload
   * 上传文档（新建文档或新增版本）
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile() file: any,
    @Body('documentId') documentIdStr?: string,
    @Body('title') title?: string,
    @Body('description') description?: string,
    @Body('tags') tagsStr?: string,
    @Body() body?: any,
  ) {
    try {
      if (!file) {
        throw new HttpException('请选择要上传的文件', 400);
      }

      const operator = body?.userId || 'anonymous';
      const documentId = documentIdStr ? parseInt(documentIdStr, 10) : undefined;
      const tags = tagsStr ? JSON.parse(tagsStr) : undefined;

      const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

      const result = await this.documentService.uploadDocument(
        { buffer: file.buffer, originalname, size: file.size, mimetype: file.mimetype },
        { documentId, title, description, tags, operator },
      );

      return {
        success: true,
        message: `文档上传成功，版本 v${result.version.versionNumber} 正在解析中`,
        document: result.document,
        version: serializeVersion(result.version),
      };
    } catch (error: any) {
      logger.error('文档上传失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * POST /documents/save-draft
   * 编辑器草稿保存：按文件名匹配创建文档或新增版本
   *
   * 用于聊天输入框上传的文件（上传时仅解析不入库，保存时才走版本管理）。
   * Body: { fileName: string, contentJson: object, contentText: string }
   */
  @Post('save-draft')
  async saveDraft(
    @Body() body: { fileName: string; contentJson: unknown; contentText: string },
  ) {
    try {
      if (!body.fileName) {
        throw new HttpException('文件名不能为空', 400);
      }
      if (body.contentJson === undefined || body.contentJson === null) {
        throw new HttpException('contentJson 不能为空', 400);
      }

      const result = await this.documentService.saveByFilename(
        body.fileName,
        body.contentJson,
        body.contentText ?? '',
      );

      return {
        success: true,
        message: result.isNew ? '文档创建成功' : '已新增版本',
        document: result.document,
        version: result.version ? serializeVersion(result.version) : null,
        isNew: result.isNew,
      };
    } catch (error: any) {
      logger.error('草稿保存失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents
   * 列出所有文档
   */
  @Get()
  async listDocuments() {
    try {
      const documents = await this.documentService.listDocuments();
      return { success: true, documents };
    } catch (error: any) {
      logger.error('获取文档列表失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  /**
   * GET /documents/by-title?title=xxx
   * 按标题查找文档（用于编辑器草稿模式按文件名匹配已有文档）
   */
  @Get('by-title')
  async findByTitle(@Query('title') title: string) {
    try {
      if (!title) {
        throw new HttpException('title 不能为空', 400);
      }
      const document = await this.documentService.findByTitle(title);
      return { success: true, document };
    } catch (error: any) {
      logger.error('按标题查找文档失败', { module: 'DocumentController', title, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * POST /documents/batch-archive
   * 批量归档
   */
  @Post('batch-archive')
  async batchArchive(@Body('versionIds') versionIds: number[], @Body('operator') operator?: string) {
    try {
      const count = await this.documentService.batchArchive(versionIds, operator || 'anonymous');
      return { success: true, message: `已归档 ${count} 个版本` };
    } catch (error: any) {
      logger.error('批量归档失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * POST /documents/batch-delete
   * 批量删除
   */
  @Post('batch-delete')
  async batchDelete(@Body('versionIds') versionIds: number[], @Body('operator') operator?: string) {
    try {
      const count = await this.documentService.batchDelete(versionIds, operator || 'anonymous');
      return { success: true, message: `已删除 ${count} 个版本` };
    } catch (error: any) {
      logger.error('批量删除失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  // ==================== 定时任务手动触发 ====================

  /**
   * POST /documents/scheduler/scan-archived
   * 扫描超过 90 天的 archived 版本
   */
  @Post('scheduler/scan-archived')
  async scanArchivedVersions() {
    try {
      const oldVersions = await this.schedulerService.scanArchivedVersions();
      return { success: true, count: oldVersions.length, versions: oldVersions };
    } catch (error: any) {
      logger.error('扫描 archived 版本失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  /**
   * POST /documents/scheduler/verify-vectors
   * 校验向量一致性
   */
  @Post('scheduler/verify-vectors')
  async verifyVectorConsistency() {
    try {
      const result = await this.schedulerService.verifyVectorConsistency();
      return { success: true, ...result };
    } catch (error: any) {
      logger.error('向量一致性校验失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  /**
   * POST /documents/scheduler/clean-orphans
   * 清理孤岛向量
   */
  @Post('scheduler/clean-orphans')
  async cleanOrphans() {
    try {
      const count = await this.schedulerService.cleanOrphans();
      return { success: true, message: `已清理 ${count} 个孤岛向量` };
    } catch (error: any) {
      logger.error('清理孤岛向量失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  /**
   * POST /documents/scheduler/retry-failed-ops
   * 重试失败的向量操作
   */
  @Post('scheduler/retry-failed-ops')
  async retryFailedOps() {
    try {
      const result = await this.schedulerService.retryFailedOps();
      return { success: true, message: `已重试 ${result.retried}/${result.total} 个向量操作`, ...result };
    } catch (error: any) {
      logger.error('重试向量操作失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  /**
   * POST /documents/scheduler/clean-audit-logs
   * 清理过期审计日志
   */
  @Post('scheduler/clean-audit-logs')
  async cleanAuditLogs() {
    try {
      const count = await this.schedulerService.cleanOldAuditLogs();
      return { success: true, message: `已清理 ${count} 条过期审计日志` };
    } catch (error: any) {
      logger.error('清理审计日志失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  /**
   * POST /documents/scheduler/fix-draft-vectors
   * 修复 draft 状态的向量（将 versionStatus=draft 更新为 active）
   */
  @Post('scheduler/fix-draft-vectors')
  async fixDraftVectors() {
    try {
      const result = await this.schedulerService.fixDraftVectors();
      return {
        success: true,
        message: `已修复 ${result.fixedChromaCount} 个 ChromaDB 向量和 ${result.fixedBM25Count} 个 BM25 文档`,
        ...result,
      };
    } catch (error: any) {
      logger.error('修复 draft 向量失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  @Get('pending-ops')
  async getPendingOps() {
    try {
      const ops = await this.documentService.getPendingVectorOps();
      return { success: true, ops };
    } catch (error: any) {
      logger.error('获取重试队列失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, 500);
    }
  }

  @Post('pending-ops/:id/retry')
  async retrySingleOp(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.documentService.retrySingleVectorOp(id);
      return { success: result.success, error: result.error };
    } catch (error: any) {
      logger.error('单条重试失败', { module: 'DocumentController', opId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Delete('pending-ops/:id')
  async deletePendingOp(@Param('id', ParseIntPipe) id: number) {
    try {
      await this.documentService.deletePendingVectorOp(id);
      return { success: true, message: '已清除重试队列记录' };
    } catch (error: any) {
      logger.error('清除重试队列记录失败', { module: 'DocumentController', opId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  // ==================== 注入扫描人工复核 ====================

  /**
   * GET /documents/scan/pending-reviews
   * 查询待人工复核的版本列表（扫描判定为可疑）
   *
   * 注意：字面量路由必须声明在 :id 参数路由之前，避免被参数路由吞掉
   */
  @Get('scan/pending-reviews')
  async getPendingScanReviews() {
    try {
      const items = await this.documentScanService.listPendingReviews();
      return {
        success: true,
        items: items.map((item) => ({
          version: serializeVersion(item.version),
          documentTitle: item.documentTitle,
        })),
      };
    } catch (error: any) {
      logger.error('获取待复核列表失败', { module: 'DocumentController', error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * POST /documents/scan/:versionId/approve
   * 复核通过：校验内容未被篡改后发布该版本到知识库
   */
  @Post('scan/:versionId/approve')
  async approveScanReview(
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body('operator') operator?: string,
  ) {
    try {
      const version = await this.documentScanService.approveVersion(versionId, operator || 'anonymous');
      return { success: true, version: serializeVersion(version) };
    } catch (error: any) {
      logger.error('复核通过失败', { module: 'DocumentController', versionId, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * POST /documents/scan/:versionId/reject
   * 复核拒绝：该版本不允许发布
   */
  @Post('scan/:versionId/reject')
  async rejectScanReview(
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body('operator') operator?: string,
    @Body('reason') reason?: string,
  ) {
    try {
      const version = await this.documentScanService.rejectVersion(versionId, operator || 'anonymous', reason);
      return { success: true, version: serializeVersion(version) };
    } catch (error: any) {
      logger.error('复核拒绝失败', { module: 'DocumentController', versionId, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * POST /documents/:id/versions/:versionId/publish
   * 发布版本到知识库（先经过注入扫描门禁，再向量化 + 激活）
   *
   * 用户在编辑器中编辑文档后，手动触发将编辑后的内容入向量库。
   * - 扫描通过：向量化入库（DRAFT → 激活；ACTIVE → 删旧向量重新入库）
   * - 待人工复核：不入库，返回 scanGate.verdict = needs_review
   * - 命中拦截：不入库，返回 scanGate.verdict = blocked
   * - 扫描门禁关闭（DOC_SCAN_ENABLED=false）：scanGate = null，行为与旧版一致
   */
  @Post(':id/versions/:versionId/publish')
  async publishToVectorStore(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body('operator') operator?: string,
  ) {
    try {
      const result = await this.documentScanService.publishWithScanGate(versionId, operator || 'anonymous');
      return { success: true, version: serializeVersion(result.version), scanGate: result.scanGate };
    } catch (error: any) {
      logger.error('发布到知识库失败', { module: 'DocumentController', versionId, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id/versions
   * 列出某文档的所有版本
   */
  @Get(':id/versions')
  async listVersions(@Param('id', ParseIntPipe) id: number) {
    try {
      const versions = await this.documentService.listVersions(id);
      return { success: true, versions: serializeVersions(versions) };
    } catch (error: any) {
      logger.error('获取版本列表失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id/versions/:versionId
   * 获取特定版本详情
   */
  @Get(':id/versions/:versionId')
  async getVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
  ) {
    try {
      const version = await this.documentService.getVersion(versionId);
      return { success: true, version: serializeVersion(version) };
    } catch (error: any) {
      logger.error('获取版本详情失败', { module: 'DocumentController', versionId, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id/versions/:versionId/status
   * 轮询版本解析进度
   */
  @Get(':id/versions/:versionId/status')
  async getVersionStatus(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
  ) {
    try {
      const status = await this.documentService.getVersionStatus(versionId);
      return { success: true, ...status };
    } catch (error: any) {
      logger.error('获取版本状态失败', { module: 'DocumentController', versionId, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id/versions/:versionId/download
   * 下载历史版本原文件
   */
  @Get(':id/versions/:versionId/download')
  async downloadVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Res() res: Response,
  ) {
    try {
      const result = await this.documentService.downloadVersion(versionId);
      if (!result) {
        return res.status(404).json({ success: false, message: '文件不存在' });
      }

      const mimeTypeMap: Record<string, string> = {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
      };

      res.setHeader('Content-Type', mimeTypeMap[result.fileType] || 'application/octet-stream');
      const encodedName = encodeURIComponent(result.fileName);
      res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
      res.send(result.buffer);
    } catch (error: any) {
      logger.error('下载版本文件失败', { module: 'DocumentController', versionId, error: error.message });
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /documents/:id/versions/:versionId/export?format=md|txt|docx
   * 导出指定版本内容到指定格式（包含编辑后的最新内容）
   */
  @Get(':id/versions/:versionId/export')
  async exportVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Query('format') format: 'md' | 'txt' | 'docx',
    @Res() res: Response,
  ) {
    try {
      if (!['md', 'txt', 'docx'].includes(format)) {
        return res.status(400).json({ success: false, message: 'format 仅支持 md / txt / docx' });
      }

      const result = await this.documentService.exportVersion(versionId, format);
      res.setHeader('Content-Type', result.mimeType);
      const encodedName = encodeURIComponent(result.fileName);
      res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
      res.send(result.buffer);
    } catch (error: any) {
      logger.error('导出版本失败', { module: 'DocumentController', versionId, format, error: error.message });
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PATCH /documents/:id/versions/:versionId
   * 修改版本状态
   */
  @Patch(':id/versions/:versionId')
  async updateVersionStatus(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body('status') status: VersionStatus,
    @Body('operator') operator?: string,
  ) {
    try {
      const version = await this.documentService.updateVersionStatus(versionId, status, operator || 'anonymous');
      return { success: true, version: serializeVersion(version) };
    } catch (error: any) {
      logger.error('修改版本状态失败', { module: 'DocumentController', versionId, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id
   * 获取文档元信息（标题、描述、标签等，不含编辑器内容）
   */
  @Get(':id')
  async getDocument(@Param('id', ParseIntPipe) id: number) {
    try {
      return await this.documentService.getDocument(id);
    } catch (error: any) {
      logger.error('获取文档详情失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id/content
   * 获取富文本编辑器内容（Tiptap JSON）
   */
  @Get(':id/content')
  async getDocumentContent(@Param('id', ParseIntPipe) id: number) {
    try {
      const content = await this.documentService.getDocumentContent(id);
      return { success: true, ...content };
    } catch (error: any) {
      logger.error('获取文档内容失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * PUT /documents/:id/content
   * 保存富文本编辑器内容
   * Body: { contentJson: object, contentText: string }
   */
  @Put(':id/content')
  async saveDocumentContent(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { contentJson: unknown; contentText?: string },
  ) {
    try {
      if (body.contentJson === undefined || body.contentJson === null) {
        throw new HttpException('contentJson 不能为空', 400);
      }
      const document = await this.documentService.saveDocumentContent(id, {
        contentJson: body.contentJson,
        contentText: body.contentText ?? '',
      });
      return {
        success: true,
        contentUpdatedAt: document.contentUpdatedAt,
      };
    } catch (error: any) {
      logger.error('保存文档内容失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * PUT /documents/:id
   * 修改文档元信息
   */
  @Put(':id')
  async updateDocument(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { title?: string; description?: string; tags?: string[] },
  ) {
    try {
      const document = await this.documentService.updateDocument(id, body);
      return { success: true, document };
    } catch (error: any) {
      logger.error('修改文档信息失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * POST /documents/:id/rollback
   * 回滚到指定版本
   */
  @Post(':id/rollback')
  async rollbackVersion(
    @Param('id', ParseIntPipe) id: number,
    @Body('versionId') versionId: number,
    @Body('operator') operator?: string,
  ) {
    try {
      const version = await this.documentService.rollbackVersion(id, versionId, operator || 'anonymous');
      return { success: true, message: `已回滚到版本 v${version.versionNumber}`, version: serializeVersion(version) };
    } catch (error: any) {
      logger.error('版本回滚失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * DELETE /documents/:id/versions/:versionId
   * 删除特定版本
   */
  @Delete(':id/versions/:versionId')
  async deleteVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body('operator') operator?: string,
  ) {
    try {
      await this.documentService.deleteVersion(versionId, operator || 'anonymous');
      return { success: true, message: '版本已删除' };
    } catch (error: any) {
      logger.error('删除版本失败', { module: 'DocumentController', versionId, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * DELETE /documents/:id
   * 删除整个文档
   */
  @Delete(':id')
  async deleteDocument(
    @Param('id', ParseIntPipe) id: number,
    @Body('operator') operator?: string,
  ) {
    try {
      await this.documentService.deleteDocument(id, operator || 'anonymous');
      return { success: true, message: '文档已删除' };
    } catch (error: any) {
      logger.error('删除文档失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id/diff?v1=x&v2=y
   * 对比两个版本的文本差异
   */
  @Get(':id/diff')
  async diffVersions(
    @Param('id', ParseIntPipe) id: number,
    @Query('v1', ParseIntPipe) v1: number,
    @Query('v2', ParseIntPipe) v2: number,
  ) {
    try {
      const changes = await this.documentService.diffVersions(id, v1, v2);
      return { success: true, diff: changes };
    } catch (error: any) {
      logger.error('版本对比失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }

  /**
   * GET /documents/:id/audit-log
   * 查询文档操作历史
   */
  @Get(':id/audit-log')
  async getAuditLog(@Param('id', ParseIntPipe) id: number) {
    try {
      const logs = await this.documentService.getAuditLog(id);
      return { success: true, logs };
    } catch (error: any) {
      logger.error('获取审计日志失败', { module: 'DocumentController', documentId: id, error: error.message });
      throw new HttpException(error.message, error.status || 500);
    }
  }
}
