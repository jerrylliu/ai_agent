/**
 * 文档版本管理服务
 * 负责文档和版本的 CRUD、状态流转、审计日志、文件操作
 */

import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In, Not } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as Diff from 'diff';
import { Document } from '../entities/document.entity.js';
import {
  DocumentVersion,
  VersionStatus,
  ParsingStatus,
} from '../entities/document-version.entity.js';
import {
  DocumentAuditLog,
  AuditAction,
} from '../entities/document-audit-log.entity.js';
import {
  PendingVectorOp,
  VectorOpType,
  VectorOpStatus,
} from '../entities/pending-vector-op.entity.js';
import { ImageDescription } from '../entities/image-description.entity.js';
import { logger } from '../fundamentals/logger';
import {
  saveVersionFile,
  validateFileSize,
  validateFileType,
  calculateChecksum,
  deleteVersionFile,
  deleteDocumentFiles,
  deleteDocumentImageFiles,
  readVersionFile,
} from '../fundamentals/file-storage';
import { parseDocument, getMimeType } from '../fundamentals/document-parser';
import {
  addDocuments,
  addImageChunks,
  removeDocumentVersion,
  updateVersionVectorStatus,
  reindexVersion,
  resetVectorStore,
  isVectorStoreMemoryMode,
} from '../fundamentals/vector-store';
import type { ImageChunkInput } from '../fundamentals/vector-store';
import type { ImageAsset } from '../fundamentals/image-extractor';
import {
  translateImagesBatch,
  loadImageBuffer,
  persistImageAsset,
  computeImageHashExport,
} from '../fundamentals/vision-translator';
import { markdownToDocx } from '../fundamentals/document-generator';

/**
 * 把纯文本转换为 Tiptap JSONContent 格式
 * 按行拆分为 paragraph 节点（空行也保留）
 * 与前端 extractDocument 接口的转换逻辑保持一致
 */
function textToTiptapJson(text: string): unknown {
  // 与 upload.controller 的段落拆分逻辑保持一致：
  // 按空行分段（\n{2,}），每段一个 paragraph 节点
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 500); // 最多 500 段，防止恶意大文档
  const content = paragraphs.map((p) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: p }],
  }));
  return { type: 'doc', content };
}

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
    @InjectRepository(ImageDescription)
    private imageDescriptionRepo: Repository<ImageDescription>,
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
   * 按标题查找文档（用于编辑器草稿模式按文件名匹配已有文档）
   * @returns 找到返回 Document，未找到返回 null
   */
  async findByTitle(title: string): Promise<Document | null> {
    return this.documentRepo.findOne({ where: { title } });
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
      lastUpdatedAt:
        lastDoc.length > 0 ? lastDoc[0].updatedAt?.toISOString() : null,
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
   * 获取富文本编辑器内容
   * 返回 contentJson 反序列化后的对象；若文档尚未有编辑器内容则返回 null
   */
  async getDocumentContent(id: number): Promise<{
    contentJson: unknown | null;
    contentText: string | null;
    contentUpdatedAt: Date | null;
  }> {
    const doc = await this.getDocument(id);
    let contentJson: unknown | null = null;
    if (doc.contentJson) {
      try {
        contentJson = JSON.parse(doc.contentJson);
      } catch (err: any) {
        logger.warn('文档 contentJson 解析失败，返回 null', {
          module: 'DocumentService',
          documentId: id,
          error: err.message,
        });
      }
    }
    return {
      contentJson,
      contentText: doc.contentText,
      contentUpdatedAt: doc.contentUpdatedAt,
    };
  }

  /**
   * 从已解析的内容创建文档 + version 1（供 /upload/extract 调用）
   *
   * 与 uploadDocument 的区别：
   *   - 不重复解析文档（parsedText 已由调用方解析好）
   *   - 不校验文件类型（/upload/extract 已接受该文件）
   *   - 复用版本管理逻辑：创建 document + version 1 + 审计日志
   */
  async createDocumentFromUpload(
    file: {
      buffer: Buffer;
      originalname: string;
      size: number;
      mimetype: string;
    },
    parsedText: string,
    options: { title?: string; operator?: string },
  ): Promise<{ document: Document; version: DocumentVersion }> {
    const operator = options.operator || 'anonymous';

    // 校验文件大小（不校验类型，与 /upload/extract 行为一致）
    const sizeCheck = validateFileSize(file.size);
    if (!sizeCheck.valid) throw new BadRequestException(sizeCheck.message);

    return this.dataSource.transaction(async (manager) => {
      // 1. 创建文档记录
      let document = manager.create(Document, {
        title: options.title || file.originalname.replace(/\.[^/.]+$/, ''),
        tags: [],
      });
      document = await manager.save(document);

      // 2. 保存版本文件
      const versionNumber = 1;
      const fileInfo = saveVersionFile(
        document.id,
        versionNumber,
        file.buffer,
        file.originalname,
      );

      // 3. 写入 contentJson / contentText（用已解析的全文，不截断）
      if (parsedText) {
        const contentJson = textToTiptapJson(parsedText);
        document.contentJson = JSON.stringify(contentJson);
        document.contentText = parsedText;
        document.contentUpdatedAt = new Date();
        document = await manager.save(document);
      }

      // 4. 创建版本记录
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

      // 5. 审计日志
      const auditLog = manager.create(DocumentAuditLog, {
        documentId: document.id,
        versionId: savedVersion.id,
        action: AuditAction.UPLOAD,
        operator,
        detail: `上传版本 v${versionNumber} (${file.originalname})`,
      });
      await manager.save(auditLog);

      logger.info('文档从上传解析创建', {
        module: 'DocumentService',
        documentId: document.id,
        versionNumber,
        charCount: parsedText.length,
        operator,
      });

      return { document, version: savedVersion };
    });
  }

  /**
   * 从编辑器内容创建新版本（编辑器保存时调用）
   *
   * 将 contentText 保存为 .txt 版本文件，创建版本记录 + 审计日志。
   * 不自动入向量库（用户需手动点"发布到知识库"）。
   */
  async createVersionFromContent(
    documentId: number,
    contentText: string,
    operator: string = 'anonymous',
  ): Promise<DocumentVersion | null> {
    const doc = await this.getDocument(documentId);

    return this.dataSource.transaction(async (manager) => {
      // 计算新版本号
      const maxVersion = await manager.findOne(DocumentVersion, {
        where: { documentId: doc.id },
        order: { versionNumber: 'DESC' },
      });
      const versionNumber = (maxVersion?.versionNumber || 0) + 1;

      // 将 contentText 保存为版本文件
      const buffer = Buffer.from(contentText, 'utf-8');
      const fileInfo = saveVersionFile(
        doc.id,
        versionNumber,
        buffer,
        `edited-v${versionNumber}.txt`,
      );

      // 创建版本记录
      const version = manager.create(DocumentVersion, {
        documentId: doc.id,
        versionNumber,
        fileUrl: fileInfo.fileUrl,
        fileSize: String(fileInfo.fileSize),
        fileType: 'txt',
        checksum: fileInfo.checksum,
        status: VersionStatus.DRAFT,
        parsingStatus: ParsingStatus.PENDING,
        uploadedBy: operator,
      });
      const savedVersion = await manager.save(version);

      // 审计日志
      const auditLog = manager.create(DocumentAuditLog, {
        documentId: doc.id,
        versionId: savedVersion.id,
        action: AuditAction.UPLOAD,
        operator,
        detail: `编辑器保存 v${versionNumber}`,
      });
      await manager.save(auditLog);

      logger.info('编辑器保存创建新版本', {
        module: 'DocumentService',
        documentId: doc.id,
        versionNumber,
        charCount: contentText.length,
        operator,
      });

      return savedVersion;
    });
  }

  /**
   * 保存富文本编辑器内容
   * 入参 contentJson 必须是合法 JSON 可序列化对象；contentText 由调用方负责提取
   * 仅当内容真正变化时更新 contentUpdatedAt（用 JSON.stringify 比对）
   * 内容变化时同时创建新版本记录（走版本管理逻辑）
   */
  async saveDocumentContent(
    id: number,
    payload: { contentJson: unknown; contentText: string },
  ): Promise<Document> {
    const doc = await this.getDocument(id);
    const nextJson = JSON.stringify(payload.contentJson);
    const changed = doc.contentJson !== nextJson;
    doc.contentJson = nextJson;
    doc.contentText = payload.contentText ?? '';
    if (changed) {
      doc.contentUpdatedAt = new Date();
    }
    const saved = await this.documentRepo.save(doc);
    logger.info('保存编辑器内容', {
      module: 'DocumentService',
      documentId: id,
      changed,
      bytes: nextJson.length,
    });

    // 内容变化时创建新版本（走版本管理逻辑）
    if (changed) {
      try {
        await this.createVersionFromContent(id, payload.contentText ?? '');
      } catch (err) {
        // 版本创建失败不阻塞保存（contentJson 已写入，用户内容不会丢失）
        logger.warn('编辑器保存时创建版本失败，内容已保存', {
          module: 'DocumentService',
          documentId: id,
          error: (err as Error).message,
        });
      }
    }

    return saved;
  }

  /**
   * 按文件名保存文档（编辑器草稿保存时调用）
   *
   * 按 title（文件名去扩展名）匹配已有文档：
   * - 找到 → 更新内容 + 创建新版本（复用 saveDocumentContent 的变更检测逻辑）
   * - 未找到 → 新建文档 + v1
   *
   * 用于聊天输入框上传的文件：上传时仅解析不入库，
   * 用户在编辑器中编辑保存后才创建文档记录，走版本管理逻辑。
   */
  async saveByFilename(
    fileName: string,
    contentJson: unknown,
    contentText: string,
    operator: string = 'anonymous',
  ): Promise<{
    document: Document;
    version: DocumentVersion | null;
    isNew: boolean;
  }> {
    // 文件名去扩展名作为 title
    const title = fileName.replace(/\.[^/.]+$/, '');

    // 按 title 查找已有文档
    const existing = await this.documentRepo.findOne({ where: { title } });

    if (existing) {
      // 已有文档 → 复用 saveDocumentContent（内容变了才建新版本）
      await this.saveDocumentContent(existing.id, { contentJson, contentText });

      // 重新查询获取更新后的元信息（contentUpdatedAt 等）
      const updated = await this.documentRepo.findOne({
        where: { id: existing.id },
      });

      // 获取最新版本（可能是刚创建的新版本，也可能是未变化时的旧版本）
      const latestVersion = await this.versionRepo.findOne({
        where: { documentId: existing.id },
        order: { versionNumber: 'DESC' },
      });

      logger.info('草稿保存匹配到已有文档，已更新内容', {
        module: 'DocumentService',
        documentId: existing.id,
        title,
        operator,
      });

      return {
        document: updated ?? existing,
        version: latestVersion,
        isNew: false,
      };
    }

    // 新建文档 + v1
    return this.dataSource.transaction(async (manager) => {
      let document = manager.create(Document, {
        title,
        tags: [],
      });
      document = await manager.save(document);

      // 写入 contentJson / contentText
      document.contentJson = JSON.stringify(contentJson);
      document.contentText = contentText;
      document.contentUpdatedAt = new Date();
      document = await manager.save(document);

      // 创建 v1（编辑器内容保存为 .txt 版本文件）
      const versionNumber = 1;
      const buffer = Buffer.from(contentText, 'utf-8');
      const fileInfo = saveVersionFile(
        document.id,
        versionNumber,
        buffer,
        `${title}-v1.txt`,
      );

      const version = manager.create(DocumentVersion, {
        documentId: document.id,
        versionNumber,
        fileUrl: fileInfo.fileUrl,
        fileSize: String(fileInfo.fileSize),
        fileType: 'txt',
        checksum: fileInfo.checksum,
        status: VersionStatus.DRAFT,
        parsingStatus: ParsingStatus.PENDING,
        uploadedBy: operator,
      });
      const savedVersion = await manager.save(version);

      // 审计日志
      const auditLog = manager.create(DocumentAuditLog, {
        documentId: document.id,
        versionId: savedVersion.id,
        action: AuditAction.UPLOAD,
        operator,
        detail: `编辑器保存创建文档 v1 (${fileName})`,
      });
      await manager.save(auditLog);

      logger.info('草稿保存创建新文档', {
        module: 'DocumentService',
        documentId: document.id,
        title,
        operator,
      });

      return { document, version: savedVersion, isNew: true };
    });
  }

  /**
   * 发布文档到知识库（向量化 + 激活）
   *
   * 核心流程：
   * 1. 读取 document.contentText（用户编辑后的最终文本）
   * 2. contentText 为空时兜底解析原文件
   * 3. 重新发布（ACTIVE）时先删除旧向量
   * 4. 分块 → 入向量库
   * 5. DRAFT → activateVersion；ACTIVE → 仅更新向量
   *
   * 并发控制：通过 parsingStatus=PARSING 做版本级锁，
   * 正在处理的版本会拒绝重复触发。
   */
  async publishToVectorStore(
    versionId: number,
    operator: string = 'anonymous',
  ): Promise<DocumentVersion> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    // 并发锁：正在处理中的版本拒绝重复触发
    if (version.parsingStatus === ParsingStatus.PARSING) {
      throw new BadRequestException('该版本正在处理中，请稍后再试');
    }

    // ARCHIVED 状态不能发布
    if (version.status === VersionStatus.ARCHIVED) {
      throw new BadRequestException('归档版本不能发布，请使用回滚功能');
    }

    const isRepublish = version.status === VersionStatus.ACTIVE;

    // 设置处理中状态（并发锁）
    await this.versionRepo.update(versionId, {
      parsingStatus: ParsingStatus.PARSING,
      errorMessage: null,
    });

    try {
      // 读取编辑后的 contentText
      const doc = await this.getDocument(version.documentId);
      let textContent = doc.contentText;

      // contentText 为空时兜底解析原文件
      if (!textContent || textContent.trim().length === 0) {
        logger.warn('contentText 为空，回退到解析原文件', {
          module: 'DocumentService',
          versionId,
        });
        // parseDocument 接受文件路径而非 buffer，用 getAbsoluteTempPath 获取可读路径
        const tempInfo = this.getAbsoluteTempPath(
          version.fileUrl,
          version.fileType,
        );
        try {
          const mimeType = this.getMimeTypeByExt(version.fileType);
          const parsed = await parseDocument(tempInfo.filePath, mimeType);
          textContent = parsed.text;
          // 兜底解析时如果有图片，需要落盘 + 创建 pending 记录
          if (parsed.images.length > 0) {
            try {
              const persistedCount = await this.persistImagesOnUpload(
                parsed.images,
                version.documentId,
              );
              // Bug 2 修复：兜底解析提取到图片后必须修正 imageTotal，
              // 否则 REINDEX 重试时检查 imageTotal > 0 会跳过图片处理
              if (persistedCount > 0) {
                await this.documentRepo.increment(
                  { id: version.documentId },
                  'imageTotal',
                  persistedCount,
                );
                logger.info('兜底解析：修正 imageTotal', {
                  module: 'DocumentService',
                  documentId: version.documentId,
                  persistedCount,
                });
              }
            } catch (err: any) {
              logger.error('兜底解析图片落盘失败', {
                module: 'DocumentService',
                versionId,
                error: err.message,
              });
            }
          }
        } finally {
          if (tempInfo.isTemp) this.cleanupTempFile(tempInfo.filePath);
        }
      }

      if (!textContent || textContent.trim().length === 0) {
        throw new Error('文档内容为空，无法发布到知识库');
      }

      logger.info('开始向量化入库', {
        module: 'DocumentService',
        versionId,
        documentId: version.documentId,
        textLength: textContent.length,
        isRepublish,
      });

      // 重新发布时先删除旧向量
      if (isRepublish) {
        try {
          await removeDocumentVersion(versionId);
          logger.info('重新发布：已删除旧向量', {
            module: 'DocumentService',
            versionId,
          });
        } catch (err: any) {
          logger.warn('重新发布：删除旧向量失败，继续入库', {
            module: 'DocumentService',
            versionId,
            error: err.message,
          });
        }
      }

      // 向量化入库
      // 从 fileUrl 提取纯文件名作为 source，并写入 documentTitle 供前端展示
      const rawFileName = version.fileUrl
        ? version.fileUrl.split(/[\\/]/).pop() || version.fileUrl
        : doc.title;
      const metadata = {
        documentId: String(version.documentId),
        documentTitle: doc.title,
        versionId: String(versionId),
        versionStatus: VersionStatus.ACTIVE,
        source: rawFileName,
        fileType: version.fileType,
      };

      logger.info('向量化入库 metadata', {
        module: 'DocumentService',
        versionId,
        documentId: version.documentId,
        documentTitle: doc.title,
        source: rawFileName,
        textLength: textContent.length,
      });

      const chunkCount = await addDocuments([textContent], [metadata], {
        chunkingStrategy: 'parent-child',
      });

      // 图片描述块入库（从 image_description 表读取 pending 记录处理）
      // uploadDocument 阶段已落盘图片 + 创建 pending 记录
      // 兜底解析时也会落盘图片，这里统一处理所有 pending 记录
      // H4 修复：不再依赖 doc.imageTotal，直接查询 image_description 表的实际记录数
      const imageChunkCount = await this.processDocumentImages(
        version.documentId,
        versionId,
        doc.title,
        metadata,
      );

      await this.versionRepo.update(versionId, {
        parsingStatus: ParsingStatus.SUCCESS,
        chunkCount,
      });

      // DRAFT → 需要激活（会自动归档旧 active）；ACTIVE → 已经是 active，无需再激活
      if (!isRepublish) {
        await this.activateVersion(versionId, operator);
      }

      // 审计日志
      const log = this.auditLogRepo.create({
        documentId: version.documentId,
        versionId,
        action: AuditAction.ACTIVATE,
        operator,
        detail: isRepublish
          ? `重新发布到知识库（${chunkCount} 个文本块，${imageChunkCount} 个图片块）`
          : `发布到知识库（${chunkCount} 个文本块，${imageChunkCount} 个图片块）`,
      });
      await this.auditLogRepo.save(log);

      logger.info('发布到知识库成功', {
        module: 'DocumentService',
        versionId,
        documentId: version.documentId,
        chunkCount,
        imageChunkCount,
        isRepublish,
      });

      const result = await this.versionRepo.findOne({
        where: { id: versionId },
      });
      if (!result) throw new Error('版本记录更新后查询失败');
      return result;
    } catch (error: any) {
      await this.versionRepo.update(versionId, {
        parsingStatus: ParsingStatus.FAILED,
        errorMessage: error.message,
      });
      logger.error('发布到知识库失败', {
        module: 'DocumentService',
        versionId,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * 上传阶段：落盘图片 + 创建 pending 记录
   *
   * 在 uploadDocument 事务外执行，避免图片 IO 影响事务。
   * 落盘的图片在 publishToVectorStore 阶段被读取并调用 VLM 翻译。
   *
   * 幂等性：如果同一 docId 已有相同 imageHash 的记录，跳过落盘。
   *
   * @param images 解析阶段提取的图片资源数组
   * @param documentId 文档 ID
   */
  private async persistImagesOnUpload(
    images: ImageAsset[],
    documentId: number,
  ): Promise<number> {
    if (images.length === 0) return 0;

    const docIdStr = String(documentId);
    logger.info('开始落盘图片', {
      module: 'DocumentService',
      documentId: docIdStr,
      imageCount: images.length,
    });

    const now = new Date();
    const records: ImageDescription[] = [];

    for (const asset of images) {
      try {
        // 1. 计算图片 hash
        const imageHash = computeImageHashExport(asset.buffer);

        // 2. 幂等检查：同 docId + 同 imageHash 的记录已存在则跳过
        const existing = await this.imageDescriptionRepo.findOne({
          where: { docId: docIdStr, imageHash },
        });
        if (existing) {
          logger.debug('图片已存在，跳过落盘', {
            module: 'DocumentService',
            documentId: docIdStr,
            sourceIndex: asset.sourceIndex,
            imageHash,
          });
          continue;
        }

        // 3. 落盘原图
        const imagePath = await persistImageAsset(
          asset.buffer,
          docIdStr,
          asset.sourceIndex,
        );

        // 4. 创建 pending 记录
        const record = new ImageDescription();
        record.docId = docIdStr;
        record.versionId = null; // 上传阶段还没有 versionId，发布时关联
        record.sourceIndex = asset.sourceIndex;
        record.imageHash = imageHash;
        record.imagePath = imagePath;
        record.description = null;
        record.caption = asset.caption;
        record.page = asset.page;
        record.section = asset.section;
        record.surroundingText = asset.surroundingText;
        record.sourceType = asset.sourceType;
        record.status = 'pending';
        record.modelUsed = null;
        record.fallbackLayer = null;
        record.retryCount = 0;
        record.errorMessage = null;
        record.chunkId = null;
        record.createdAt = now;
        record.updatedAt = now;
        records.push(record);
      } catch (err: any) {
        logger.error('单张图片落盘失败', {
          module: 'DocumentService',
          documentId: docIdStr,
          sourceIndex: asset.sourceIndex,
          error: err.message,
        });
      }
    }

    if (records.length > 0) {
      try {
        await this.imageDescriptionRepo.save(records);
        logger.info('图片落盘完成', {
          module: 'DocumentService',
          documentId: docIdStr,
          totalImages: images.length,
          persistedImages: records.length,
        });
      } catch (saveErr: any) {
        // H5 修复：唯一约束冲突时说明已有并发/重复记录，非致命错误
        logger.warn('图片记录批量保存失败（可能唯一约束冲突）', {
          module: 'DocumentService',
          documentId: docIdStr,
          persistedImages: records.length,
          error: saveErr.message,
        });
      }
    }

    return records.length;
  }

  /**
   * 处理文档图片：VLM 翻译 + 入库 + 状态记录
   *
   * 支持两种场景：
   * 1. 首次发布：从 image_description 表读取 pending 记录，调用 VLM 翻译
   * 2. 重新发布：读取所有非 processing 记录（含 completed/failed/skipped），
   *    对已有描述的记录复用（不重复调 VLM），对 pending/failed 记录重新调 VLM
   *
   * 重新发布时 `removeDocumentVersion` 已删除旧向量（含图片块），
   * 本方法负责把图片描述块重新写入向量库。
   *
   * 失败处理：
   * - 单张图片失败走 Layer 4 兜底，不阻塞其他图片
   * - 整体异常不抛出，仅打日志（图片是增强项，不应阻塞文本入库）
   *
   * @param documentId 文档 ID
   * @param versionId 版本 ID
   * @param documentTitle 文档标题（用于 VLM Prompt 上下文）
   * @param baseMetadata 基础元数据（与文本块一致）
   * @returns 成功入库的图片描述块数量
   */
  private async processDocumentImages(
    documentId: number,
    versionId: number,
    documentTitle: string,
    baseMetadata: Record<string, any>,
  ): Promise<number> {
    const docIdStr = String(documentId);
    const versionIdStr = String(versionId);

    // 1. 查询所有记录（含 processing，重新发布时需处理崩溃残留的 processing 记录）
    // 重新发布时 completed/failed 记录也需要重新入库向量（旧向量已被 removeDocumentVersion 删除）
    const allRecords = await this.imageDescriptionRepo.find({
      where: { docId: docIdStr },
    });

    if (allRecords.length === 0) {
      logger.info('无图片记录，跳过图片处理', {
        module: 'DocumentService',
        documentId: docIdStr,
      });
      return 0;
    }

    // 恢复卡在 processing 的记录（服务崩溃残留）
    // 重新发布时旧向量已被 removeDocumentVersion 删除，这些记录需重新翻译入库
    const stuckRecords = allRecords.filter((r) => r.status === 'processing');
    if (stuckRecords.length > 0) {
      const now = new Date();
      for (const r of stuckRecords) {
        r.status = 'pending';
        r.errorMessage = '重新发布时从 processing 恢复';
        r.updatedAt = now;
      }
      await this.imageDescriptionRepo.save(stuckRecords);
      logger.warn('重新发布：恢复卡在 processing 的图片记录', {
        module: 'DocumentService',
        documentId: docIdStr,
        recoveredCount: stuckRecords.length,
      });
    }

    // 2. 分组：需要 VLM 翻译的 vs 已有描述可直接复用的
    const needTranslation = allRecords.filter(
      (r) => r.status === 'pending' || r.status === 'failed',
    );
    const hasDescription = allRecords.filter(
      (r) => r.status === 'completed' || r.status === 'skipped',
    );

    logger.info('开始处理文档图片', {
      module: 'DocumentService',
      documentId: docIdStr,
      versionId: versionIdStr,
      totalRecords: allRecords.length,
      needTranslationCount: needTranslation.length,
      reuseCount: hasDescription.length,
    });

    try {
      const imageChunks: ImageChunkInput[] = [];
      const recordsToUpdate: ImageDescription[] = [];

      // 3. 处理已有描述的记录（复用，不调 VLM）
      for (const record of hasDescription) {
        if (!record.description) {
          // 异常情况：completed/skipped 但无描述，降级为 pending 重新处理
          logger.warn('记录状态与描述不一致，降级重新翻译', {
            module: 'DocumentService',
            recordId: record.id,
            status: record.status,
          });
          needTranslation.push(record);
          continue;
        }

        imageChunks.push({
          description: record.description,
          baseMetadata: {
            ...baseMetadata,
            chunk_role: 'image',
          },
          imageMetadata: {
            imagePath: record.imagePath,
            imageHash: record.imageHash,
            caption: record.caption,
            page: record.page,
            section: record.section,
            imageSourceIndex: record.sourceIndex,
            sourceType: record.sourceType,
          },
        });

        // 更新 versionId（重新发布时需要关联到新版本）
        record.versionId = versionIdStr;
        recordsToUpdate.push(record);
      }

      // 4. 处理需要翻译的记录（加载图片 + 调 VLM）
      const assets: ImageAsset[] = [];
      const validRecords: ImageDescription[] = [];

      for (const record of needTranslation) {
        try {
          const buffer = await loadImageBuffer(record.imagePath);
          assets.push({
            buffer,
            sourceIndex: record.sourceIndex,
            caption: record.caption,
            page: record.page,
            section: record.section,
            surroundingText: record.surroundingText || '',
            originalPath: record.imagePath,
            sourceType: record.sourceType,
          });
          validRecords.push(record);
        } catch (err: any) {
          logger.error('加载图片 buffer 失败，标记为 failed', {
            module: 'DocumentService',
            documentId: docIdStr,
            sourceIndex: record.sourceIndex,
            imagePath: record.imagePath,
            error: err.message,
          });
          record.status = 'failed';
          record.errorMessage = `加载图片文件失败: ${err.message}`;
          record.updatedAt = new Date();
          recordsToUpdate.push(record);
        }
      }

      if (assets.length > 0) {
        // 5. 批量 VLM 翻译
        // Bug 5 修复：传入 existingImagePath（上传阶段已落盘），避免 translateImage 重复落盘
        const translationResults = await translateImagesBatch(
          assets.map((asset, idx) => ({
            asset,
            docId: docIdStr,
            documentTitle,
            existingImagePath: validRecords[idx].imagePath,
          })),
        );

        // 6. 构造图片描述块入库参数
        // 核心策略：content = VLM description + caption（文档标题标签）
        // caption 来自文档中图片前面的标题文本（如"地下城市：鲜血君王的领地"），
        // 让 BM25 检索能通过标题关键词找到图片，同时不超过 embedding 的 512 tokens 限制
        for (let idx = 0; idx < translationResults.length; idx++) {
          const result = translationResults[idx];
          const record = validRecords[idx];

          // 把 caption 作为标题标签追加到描述后面
          const captionLine = record.caption
            ? `\n【标题】${record.caption}`
            : '';
          imageChunks.push({
            description: result.description + captionLine,
            baseMetadata: {
              ...baseMetadata,
              chunk_role: 'image',
            },
            imageMetadata: {
              imagePath: result.imagePath,
              imageHash: result.imageHash,
              caption: record.caption,
              page: record.page,
              section: record.section,
              imageSourceIndex: record.sourceIndex,
              sourceType: record.sourceType,
            },
          });
        }

        // 7. 更新 image_description 记录状态
        const now = new Date();
        for (let i = 0; i < validRecords.length; i++) {
          const record = validRecords[i];
          const result = translationResults[i];

          record.versionId = versionIdStr;
          record.description = result.description;
          record.tags = null;
          record.status = result.success ? 'completed' : 'failed';
          record.modelUsed = result.modelUsed;
          record.fallbackLayer = result.fallbackLayer;
          record.errorMessage = result.errorMessage;
          record.updatedAt = now;
          recordsToUpdate.push(record);
        }
      }

      // 8. 入库 ChromaDB + BM25
      const addedCount =
        imageChunks.length > 0 ? await addImageChunks(imageChunks) : 0;

      // 9. 批量更新 DB 记录
      if (recordsToUpdate.length > 0) {
        await this.imageDescriptionRepo.save(recordsToUpdate);
      }

      // 10. 更新 document.imageProcessed（所有非 processing 记录数，含复用的）
      await this.documentRepo.update(documentId, {
        imageProcessed: allRecords.length,
      });

      logger.info('文档图片处理完成', {
        module: 'DocumentService',
        documentId: docIdStr,
        versionId: versionIdStr,
        totalRecords: allRecords.length,
        reusedCount: hasDescription.length,
        translatedCount: assets.length,
        addedChunks: addedCount,
      });

      return addedCount;
    } catch (error: any) {
      logger.error('文档图片处理失败（不影响文本入库）', {
        module: 'DocumentService',
        documentId: docIdStr,
        versionId: versionIdStr,
        totalRecords: allRecords.length,
        error: error.message,
        stack: error.stack,
      });
      return 0;
    }
  }

  /**
   * 修改文档元信息
   */
  async updateDocument(
    id: number,
    data: { title?: string; description?: string; tags?: string[] },
  ): Promise<Document> {
    const doc = await this.getDocument(id);
    if (data.title !== undefined) doc.title = data.title;
    if (data.description !== undefined) doc.description = data.description;
    if (data.tags !== undefined) doc.tags = data.tags;
    return this.documentRepo.save(doc);
  }

  /**
   * 删除整个文档（含所有版本文件 + 所有向量数据）
   */
  async deleteDocument(
    id: number,
    operator: string = 'anonymous',
  ): Promise<void> {
    const doc = await this.getDocument(id);
    const versions = await this.versionRepo.find({ where: { documentId: id } });

    logger.info('开始删除文档', {
      module: 'DocumentService',
      documentId: id,
      title: doc.title,
      versionCount: versions.length,
      operator,
    });

    // 删除所有版本的向量数据
    for (const version of versions) {
      if (version.parsingStatus === ParsingStatus.SUCCESS) {
        logger.info('删除版本向量数据', {
          module: 'DocumentService',
          documentId: id,
          versionId: version.id,
          versionNumber: version.versionNumber,
          status: version.status,
        });
        try {
          await removeDocumentVersion(version.id);
          logger.info('版本向量数据删除成功', {
            module: 'DocumentService',
            versionId: version.id,
          });
        } catch (error: any) {
          logger.error('删除版本向量数据失败，已加入重试队列', {
            module: 'DocumentService',
            versionId: version.id,
            error: error.message,
            stack: error.stack,
          });
          await this.enqueueVectorOp(version.id, VectorOpType.REMOVE);
        }
      } else {
        logger.info('跳过未成功解析的版本向量删除', {
          module: 'DocumentService',
          versionId: version.id,
          parsingStatus: version.parsingStatus,
        });
      }
    }

    // 删除文件
    logger.info('开始删除文档文件', {
      module: 'DocumentService',
      documentId: id,
    });
    deleteDocumentFiles(id);

    // H3 修复：删除文档图片目录，避免图片文件成为无引用的孤儿文件
    logger.info('开始删除文档图片目录', {
      module: 'DocumentService',
      documentId: id,
    });
    deleteDocumentImageFiles(id);

    // 清理 image_description 表（避免孤儿记录）
    try {
      await this.imageDescriptionRepo.delete({ docId: String(id) });
      logger.info('已清理图片描述记录', {
        module: 'DocumentService',
        documentId: id,
      });
    } catch (err: any) {
      logger.warn('清理图片描述记录失败（不影响文档删除）', {
        module: 'DocumentService',
        documentId: id,
        error: err.message,
      });
    }

    // 写审计日志（在删除前）
    await this.writeAuditLog(
      id,
      null,
      AuditAction.DELETE,
      operator,
      `删除文档 "${doc.title}" 及 ${versions.length} 个版本`,
    );

    // 删除数据库记录（级联删除版本和审计日志）
    await this.documentRepo.remove(doc);

    logger.info('文档删除完成', {
      module: 'DocumentService',
      documentId: id,
      title: doc.title,
      operator,
    });
  }

  // ==================== 版本操作 ====================

  /**
   * 上传文档（新建文档或新增版本）
   * 步骤：校验文件 → 计算 checksum → 存储文件 → 创建版本记录 → 异步解析 → 向量化
   */
  async uploadDocument(
    file: {
      buffer: Buffer;
      originalname: string;
      size: number;
      mimetype: string;
    },
    options: {
      documentId?: number;
      title?: string;
      description?: string;
      tags?: string[];
      operator?: string;
    },
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
    const result = await this.dataSource.transaction(async (manager) => {
      let document: Document | null;
      let versionNumber: number;

      if (options.documentId) {
        // 新增版本到已有文档
        document = await manager.findOne(Document, {
          where: { id: options.documentId },
        });
        if (!document)
          throw new NotFoundException(`文档 ${options.documentId} 不存在`);

        // 检查 checksum 是否与最新 active 版本重复
        const latestActive = await manager.findOne(DocumentVersion, {
          where: { documentId: document.id, status: VersionStatus.ACTIVE },
          order: { versionNumber: 'DESC' },
        });
        if (latestActive && latestActive.checksum === checksum) {
          throw new BadRequestException(
            '文件内容与当前活跃版本完全相同，无需重复上传',
          );
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
      const fileInfo = saveVersionFile(
        document.id,
        versionNumber,
        file.buffer,
        file.originalname,
      );

      // 4.5. 同步解析文档纯文本，写入 contentJson / contentText 供编辑器加载
      // 失败不阻塞上传流程（仅打日志），保证向量化和审计仍能完成
      /** 解析阶段提取的图片资源（在 try 块外声明，供事务返回值使用） */
      let parsedImages: ImageAsset[] = [];
      try {
        // parseDocument 接受文件路径而非 buffer，需先写到临时文件
        const tempDir = path.join(__dirname, '..', '..', 'uploads', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const tempFilePath = path.join(
          tempDir,
          `parse-${document.id}-${versionNumber}-${Date.now()}${path.extname(file.originalname)}`,
        );
        fs.writeFileSync(tempFilePath, file.buffer);

        const parsed = await parseDocument(
          tempFilePath,
          file.mimetype || getMimeType(file.originalname),
        );
        const fullText = parsed.text;
        parsedImages = parsed.images;

        // 用完立即删除临时文件
        try {
          fs.unlinkSync(tempFilePath);
        } catch {
          /* 忽略删除失败 */
        }

        if (fullText) {
          // 不截断：存储全文供向量库分块索引
          // 向量库的 addDocuments 会用 RecursiveCharacterTextSplitter 自动分块
          // 截断会导致 RAG 检索丢失后半部分内容
          const contentJson = textToTiptapJson(fullText);

          document.contentJson = JSON.stringify(contentJson);
          document.contentText = fullText;
          document.contentUpdatedAt = new Date();
          // 记录解析阶段提取的图片数量（VLM 翻译在发布到知识库时执行）
          document.imageTotal = parsed.images.length;
          document.imageProcessed = 0;
          document = await manager.save(document);

          logger.info('文档内容已解析并写入 contentJson', {
            module: 'DocumentService',
            documentId: document.id,
            charCount: fullText.length,
            imageCount: parsed.images.length,
          });
        }
      } catch (err) {
        logger.warn('解析文档为编辑器内容失败，跳过 contentJson 写入', {
          module: 'DocumentService',
          documentId: document.id,
          fileName: file.originalname,
          error: String(err),
        });
      }

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

      // 8. 不自动入向量库
      // 改造后：上传只解析内容写入 contentJson/contentText，版本保持 DRAFT
      // 用户需在编辑器中编辑后，手动点【发布到知识库】才入向量库
      // 这样用户有机会修改 OCR 错误、调整格式后再让 RAG 检索到正确内容

      logger.info('文档上传完成（未入向量库，等待用户发布）', {
        module: 'DocumentService',
        documentId: document.id,
        versionNumber,
        operator,
      });

      // 返回 images 供事务外落盘（避免图片 IO 影响事务）
      return { document, version: savedVersion, images: parsedImages };
    });

    // 事务外：落盘图片 + 创建 pending 记录（失败不阻塞上传流程）
    let persistedImageCount = 0;
    if (result.images.length > 0) {
      try {
        persistedImageCount = await this.persistImagesOnUpload(
          result.images,
          result.document.id,
        );
      } catch (err: any) {
        logger.error('图片落盘失败（不影响文档上传）', {
          module: 'DocumentService',
          documentId: result.document.id,
          imageCount: result.images.length,
          error: err.message,
          stack: err.stack,
        });
      }
    }

    // H4 修复：根据实际落盘数量修正 document.imageTotal，避免 imageTotal 与实际记录数不一致
    if (persistedImageCount !== result.document.imageTotal) {
      try {
        await this.documentRepo.update(result.document.id, {
          imageTotal: persistedImageCount,
        });
        logger.info('已修正文档 imageTotal', {
          module: 'DocumentService',
          documentId: result.document.id,
          parsedImageCount: result.document.imageTotal,
          persistedImageCount,
        });
      } catch (updateErr: any) {
        logger.warn('修正 imageTotal 失败', {
          module: 'DocumentService',
          documentId: result.document.id,
          error: updateErr.message,
        });
      }
    }

    return { document: result.document, version: result.version };
  }

  /**
   * 激活版本：旧 active → archived，新版本 → active
   */
  async activateVersion(
    versionId: number,
    operator: string = 'anonymous',
  ): Promise<DocumentVersion> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    if (version.status === VersionStatus.ACTIVE) {
      throw new BadRequestException('版本已经是 active 状态');
    }
    if (version.status === VersionStatus.ARCHIVED) {
      throw new BadRequestException(
        'archived 状态不能直接激活，请使用回滚功能',
      );
    }
    if (version.parsingStatus !== ParsingStatus.SUCCESS) {
      throw new BadRequestException(
        '只能激活解析成功的版本，当前解析状态为 ' + version.parsingStatus,
      );
    }

    logger.info('开始激活版本', {
      module: 'DocumentService',
      versionId,
      documentId: version.documentId,
      currentStatus: version.status,
      operator,
    });

    // 将当前 active 版本改为 archived
    const activeVersions = await this.versionRepo.find({
      where: { documentId: version.documentId, status: VersionStatus.ACTIVE },
    });
    logger.info('找到需要归档的 active 版本', {
      module: 'DocumentService',
      documentId: version.documentId,
      activeCount: activeVersions.length,
    });

    for (const av of activeVersions) {
      logger.info('归档旧 active 版本', {
        module: 'DocumentService',
        versionId: av.id,
        versionNumber: av.versionNumber,
      });
      try {
        await updateVersionVectorStatus(av.id, VersionStatus.ARCHIVED);
        logger.info('旧 active 版本向量状态已更新为 archived', {
          module: 'DocumentService',
          versionId: av.id,
        });
      } catch (error: any) {
        logger.error('更新旧 active 版本向量状态失败，已加入重试队列', {
          module: 'DocumentService',
          versionId: av.id,
          error: error.message,
        });
        await this.enqueueVectorOp(av.id, VectorOpType.UPDATE_STATUS, {
          newStatus: VersionStatus.ARCHIVED,
        });
      }
      av.status = VersionStatus.ARCHIVED;
      av.archivedAt = new Date();
      await this.versionRepo.save(av);
    }

    // 激活新版本：先更新向量，再改数据库
    try {
      await updateVersionVectorStatus(version.id, VersionStatus.ACTIVE);
      logger.info('新版本向量状态已更新为 active', {
        module: 'DocumentService',
        versionId: version.id,
      });
    } catch (error: any) {
      logger.error('更新新版本向量状态失败，已加入重试队列', {
        module: 'DocumentService',
        versionId: version.id,
        error: error.message,
      });
      await this.enqueueVectorOp(version.id, VectorOpType.UPDATE_STATUS, {
        newStatus: VersionStatus.ACTIVE,
      });
    }
    version.status = VersionStatus.ACTIVE;
    version.archivedAt = null;
    await this.versionRepo.save(version);

    // 更新文档 currentVersionId
    await this.documentRepo.update(version.documentId, {
      currentVersionId: version.id,
    });

    // 审计日志
    await this.writeAuditLog(
      version.documentId,
      version.id,
      AuditAction.ACTIVATE,
      operator,
      `激活版本 v${version.versionNumber}`,
    );

    logger.info('版本激活完成', {
      module: 'DocumentService',
      versionId,
      documentId: version.documentId,
      versionNumber: version.versionNumber,
      operator,
    });
    return version;
  }

  /**
   * 回滚到指定版本
   * 当前 active → archived，目标 archived → active
   */
  async rollbackVersion(
    documentId: number,
    targetVersionId: number,
    operator: string = 'anonymous',
  ): Promise<DocumentVersion> {
    const doc = await this.getDocument(documentId);
    const targetVersion = await this.versionRepo.findOne({
      where: { id: targetVersionId, documentId },
    });
    if (!targetVersion)
      throw new NotFoundException(`版本 ${targetVersionId} 不存在`);
    if (targetVersion.status === VersionStatus.ACTIVE) {
      throw new BadRequestException('目标版本已经是 active 状态');
    }
    if (targetVersion.status === VersionStatus.DRAFT) {
      throw new BadRequestException('draft 状态的版本不能回滚');
    }
    if (targetVersion.parsingStatus !== ParsingStatus.SUCCESS) {
      throw new BadRequestException('只能回滚到解析成功的版本');
    }

    logger.info('开始版本回滚', {
      module: 'DocumentService',
      documentId,
      targetVersionId,
      targetVersionNumber: targetVersion.versionNumber,
      operator,
    });

    // 当前 active → archived
    const activeVersions = await this.versionRepo.find({
      where: { documentId, status: VersionStatus.ACTIVE },
    });
    logger.info('找到需要归档的 active 版本', {
      module: 'DocumentService',
      documentId,
      activeCount: activeVersions.length,
    });

    for (const av of activeVersions) {
      logger.info('回滚：归档当前 active 版本', {
        module: 'DocumentService',
        versionId: av.id,
        versionNumber: av.versionNumber,
      });
      try {
        await updateVersionVectorStatus(av.id, VersionStatus.ARCHIVED);
        logger.info('回滚：当前 active 版本向量状态已更新为 archived', {
          module: 'DocumentService',
          versionId: av.id,
        });
      } catch (error: any) {
        logger.error('回滚：更新当前 active 版本向量状态失败，已加入重试队列', {
          module: 'DocumentService',
          versionId: av.id,
          error: error.message,
        });
        await this.enqueueVectorOp(av.id, VectorOpType.UPDATE_STATUS, {
          newStatus: VersionStatus.ARCHIVED,
        });
      }
      av.status = VersionStatus.ARCHIVED;
      av.archivedAt = new Date();
      await this.versionRepo.save(av);
    }

    // 目标版本 → active：先更新向量，再改数据库
    try {
      await updateVersionVectorStatus(targetVersion.id, VersionStatus.ACTIVE);
      logger.info('回滚：目标版本向量状态已更新为 active', {
        module: 'DocumentService',
        versionId: targetVersion.id,
      });
    } catch (error: any) {
      logger.error('回滚：更新目标版本向量状态失败，已加入重试队列', {
        module: 'DocumentService',
        versionId: targetVersion.id,
        error: error.message,
      });
      await this.enqueueVectorOp(targetVersion.id, VectorOpType.UPDATE_STATUS, {
        newStatus: VersionStatus.ACTIVE,
      });
    }
    targetVersion.status = VersionStatus.ACTIVE;
    targetVersion.archivedAt = null;
    await this.versionRepo.save(targetVersion);

    // 更新文档 currentVersionId
    doc.currentVersionId = targetVersion.id;
    await this.documentRepo.save(doc);

    // 审计日志
    await this.writeAuditLog(
      documentId,
      targetVersionId,
      AuditAction.ROLLBACK,
      operator,
      `回滚到版本 v${targetVersion.versionNumber}`,
    );

    logger.info('版本回滚完成', {
      module: 'DocumentService',
      documentId,
      targetVersionId,
      targetVersionNumber: targetVersion.versionNumber,
      operator,
    });
    return targetVersion;
  }

  /**
   * 修改版本状态（draft→active, active→archived）
   */
  async updateVersionStatus(
    versionId: number,
    newStatus: VersionStatus,
    operator: string = 'anonymous',
  ): Promise<DocumentVersion> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    // 状态流转校验
    if (
      version.status === VersionStatus.DRAFT &&
      newStatus === VersionStatus.ACTIVE
    ) {
      return this.activateVersion(versionId, operator);
    }
    if (
      version.status === VersionStatus.ACTIVE &&
      newStatus === VersionStatus.ARCHIVED
    ) {
      version.status = VersionStatus.ARCHIVED;
      version.archivedAt = new Date();
      await this.versionRepo.save(version);

      try {
        await updateVersionVectorStatus(version.id, VersionStatus.ARCHIVED);
      } catch (error: any) {
        logger.error('归档版本向量状态更新失败，已加入重试队列', {
          module: 'DocumentService',
          versionId,
          error: error.message,
        });
        await this.enqueueVectorOp(version.id, VectorOpType.UPDATE_STATUS, {
          newStatus: VersionStatus.ARCHIVED,
        });
      }

      const action =
        newStatus === VersionStatus.ARCHIVED
          ? AuditAction.ARCHIVE
          : AuditAction.ACTIVATE;
      await this.writeAuditLog(
        version.documentId,
        version.id,
        action,
        operator,
        `版本 v${version.versionNumber} 状态变更为 ${newStatus}`,
      );

      logger.info('版本状态变更', {
        module: 'DocumentService',
        versionId,
        newStatus,
        operator,
      });
      return version;
    }

    throw new BadRequestException(
      `不允许从 ${version.status} 状态变更为 ${newStatus}`,
    );
  }

  /**
   * 删除特定版本（同时清理向量 + BM25 索引）
   */
  async deleteVersion(
    versionId: number,
    operator: string = 'anonymous',
  ): Promise<void> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    if (version.status === VersionStatus.ACTIVE) {
      throw new BadRequestException(
        '不能删除 active 状态的版本，请先回滚到其他版本',
      );
    }

    logger.info('开始删除版本', {
      module: 'DocumentService',
      versionId,
      documentId: version.documentId,
      versionNumber: version.versionNumber,
      status: version.status,
      parsingStatus: version.parsingStatus,
      operator,
    });

    // 删除向量数据
    if (version.parsingStatus === ParsingStatus.SUCCESS) {
      logger.info('删除版本向量数据', { module: 'DocumentService', versionId });
      try {
        await removeDocumentVersion(version.id);
        logger.info('版本向量数据删除成功', {
          module: 'DocumentService',
          versionId,
        });
      } catch (error: any) {
        logger.error('删除版本向量数据失败，已加入重试队列', {
          module: 'DocumentService',
          versionId,
          error: error.message,
          stack: error.stack,
        });
        await this.enqueueVectorOp(version.id, VectorOpType.REMOVE);
      }
    } else {
      logger.info('跳过未成功解析版本的向量删除', {
        module: 'DocumentService',
        versionId,
        parsingStatus: version.parsingStatus,
      });
    }

    // 删除文件
    deleteVersionFile(version.fileUrl);

    // 审计日志
    await this.writeAuditLog(
      version.documentId,
      versionId,
      AuditAction.DELETE,
      operator,
      `删除版本 v${version.versionNumber}`,
    );

    // 删除数据库记录
    await this.versionRepo.remove(version);

    logger.info('版本已删除', {
      module: 'DocumentService',
      versionId,
      operator,
    });
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
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);
    return version;
  }

  /**
   * 轮询版本解析进度
   */
  async getVersionStatus(versionId: number): Promise<{
    parsingStatus: ParsingStatus;
    errorMessage?: string;
    chunkCount?: number;
  }> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
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
  async downloadVersion(
    versionId: number,
  ): Promise<{ buffer: Buffer; fileName: string; fileType: string } | null> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    const buffer = readVersionFile(version.fileUrl);
    if (!buffer) throw new NotFoundException('文件不存在');

    return {
      buffer,
      fileName: `v${version.versionNumber}.${version.fileType}`,
      fileType: version.fileType,
    };
  }

  /**
   * 导出指定版本内容到指定格式
   * 支持格式：md / txt / docx
   * - md/txt：直接返回解析后的文本
   * - docx：用 markdownToDocx 生成（纯文本按段落处理）
   */
  async exportVersion(
    versionId: number,
    format: 'md' | 'txt' | 'docx',
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);

    // 获取文档标题用于命名
    const document = await this.documentRepo.findOne({
      where: { id: version.documentId },
    });
    const baseName = (document?.title || `v${version.versionNumber}`).replace(
      /[<>:"/\\|?*]/g,
      '_',
    );

    // 解析版本文本（已 normalize）
    const text = await this.parseVersionText(version);

    if (format === 'docx') {
      // 纯文本按段落用空行分隔，转成 markdown 再生成 docx
      const markdown = text
        .split('\n')
        .filter((l) => l.trim())
        .join('\n\n');
      const buffer = await markdownToDocx(markdown, { title: document?.title });
      return {
        buffer,
        fileName: `${baseName}.docx`,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    }

    // md / txt：直接返回文本
    return {
      buffer: Buffer.from(text, 'utf-8'),
      fileName: `${baseName}.${format}`,
      mimeType: format === 'md' ? 'text/markdown' : 'text/plain',
    };
  }

  // ==================== 批量操作 ====================

  /**
   * 批量归档
   */
  async batchArchive(
    versionIds: number[],
    operator: string = 'anonymous',
  ): Promise<number> {
    let count = 0;
    for (const id of versionIds) {
      try {
        const version = await this.versionRepo.findOne({ where: { id } });
        if (version && version.status === VersionStatus.ACTIVE) {
          await this.updateVersionStatus(id, VersionStatus.ARCHIVED, operator);
          count++;
        }
      } catch (error: any) {
        logger.error('批量归档失败', {
          module: 'DocumentService',
          versionId: id,
          error: error.message,
        });
      }
    }
    return count;
  }

  /**
   * 批量删除
   */
  async batchDelete(
    versionIds: number[],
    operator: string = 'anonymous',
  ): Promise<number> {
    let count = 0;
    for (const id of versionIds) {
      try {
        await this.deleteVersion(id, operator);
        count++;
      } catch (error: any) {
        logger.error('批量删除失败', {
          module: 'DocumentService',
          versionId: id,
          error: error.message,
        });
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
      logger.error('写入审计日志失败', {
        module: 'DocumentService',
        documentId,
        action,
        error: error.message,
      });
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

  private getAbsoluteTempPath(
    fileUrl: string,
    ext: string,
  ): { filePath: string; isTemp: boolean } {
    const absPath = path.join(__dirname, '..', '..', 'uploads', fileUrl);
    if (fs.existsSync(absPath)) return { filePath: absPath, isTemp: false };

    const buffer = readVersionFile(fileUrl);
    if (!buffer) throw new Error('文件不存在');
    const tempPath = path.join(
      __dirname,
      '..',
      '..',
      'uploads',
      `temp_parse_${Date.now()}.${ext}`,
    );
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
      logger.warn('清理临时文件失败', {
        module: 'DocumentService',
        filePath,
        error: error.message,
      });
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

    const v1 = await this.versionRepo.findOne({
      where: { id: versionId1, documentId },
    });
    const v2 = await this.versionRepo.findOne({
      where: { id: versionId2, documentId },
    });

    if (!v1) throw new NotFoundException(`版本 ${versionId1} 不存在`);
    if (!v2) throw new NotFoundException(`版本 ${versionId2} 不存在`);

    // 读取文件内容并解析为纯文本
    const [text1, text2] = await Promise.all([
      this.parseVersionText(v1),
      this.parseVersionText(v2),
    ]);

    // 超大文档截断（>1MB 纯文本）
    const MAX_DIFF_SIZE = 1024 * 1024;
    const t1 =
      text1.length > MAX_DIFF_SIZE
        ? text1.substring(0, MAX_DIFF_SIZE) + '\n...(内容已截断)'
        : text1;
    const t2 =
      text2.length > MAX_DIFF_SIZE
        ? text2.substring(0, MAX_DIFF_SIZE) + '\n...(内容已截断)'
        : text2;

    // 计算行级 diff
    const changes = Diff.diffLines(t1, t2);

    logger.info('版本对比完成', {
      module: 'DocumentService',
      documentId,
      versionId1,
      versionId2,
      changeCount: changes.length,
    });

    return changes.map((change) => ({
      value: change.value,
      added: change.added || undefined,
      removed: change.removed || undefined,
    }));
  }

  /**
   * 解析版本文件为纯文本
   *
   * 注意：不同来源的版本文件格式不同（uploadDocument 保存原始 pdf/docx，
   * createVersionFromContent 保存编辑器 txt），解析后的换行/段落格式可能不一致。
   * 这里做 normalize 统一格式，保证 diffVersions 的行级对比准确。
   */
  private async parseVersionText(version: DocumentVersion): Promise<string> {
    const fileBuffer = readVersionFile(version.fileUrl);
    if (!fileBuffer) return '';

    const ext = version.fileType;
    const mimeType = this.getMimeTypeByExt(ext);

    let text: string;

    // 对于文本类文件直接读取
    if (['txt', 'md', 'csv', 'json', 'html'].includes(ext)) {
      text = fileBuffer.toString('utf-8');
    } else {
      // 对于二进制文件（pdf、docx 等），使用 document-parser 解析
      const tempInfo = this.getAbsoluteTempPath(version.fileUrl, ext);
      try {
        // parseVersionText 仅用于 diff/导出，不处理图片，取 text 即可
        const parsed = await parseDocument(tempInfo.filePath, mimeType);
        text = parsed.text;
      } catch (error: any) {
        logger.error('解析版本文件失败', {
          module: 'DocumentService',
          versionId: version.id,
          error: error.message,
        });
        return `[解析失败: ${error.message}]`;
      } finally {
        if (tempInfo.isTemp) {
          this.cleanupTempFile(tempInfo.filePath);
        }
      }
    }

    // normalize：统一换行符、去除连续空行和行首尾空格
    // 解决原始文件解析文本与编辑器 txt 文本格式不一致导致 diff 全标红的问题
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
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
      logger.info('向量操作已加入重试队列', {
        module: 'DocumentService',
        opId: op.id,
        versionId,
        operation,
        status: VectorOpStatus.PENDING,
      });
    } catch (error: any) {
      logger.error('写入重试队列失败', {
        module: 'DocumentService',
        versionId,
        operation,
        error: error.message,
      });
    }
  }

  /**
   * 重试失败的向量操作（定时任务调用）
   */
  async retryFailedVectorOps(maxRetry: number = 3): Promise<{
    retried: number;
    total: number;
    results: Array<{
      id: number;
      versionId: number;
      operation: string;
      success: boolean;
      error?: string;
    }>;
  }> {
    if (isVectorStoreMemoryMode()) {
      resetVectorStore();
      logger.info('检测到向量存储为内存模式，已重置，将重新连接 ChromaDB', {
        module: 'DocumentService',
      });
    }

    const pendingOps = await this.pendingVectorOpRepo.find({
      where: { status: In([VectorOpStatus.PENDING, VectorOpStatus.FAILED]) },
      order: { createdAt: 'ASC' },
    });

    const results: Array<{
      id: number;
      versionId: number;
      operation: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const op of pendingOps) {
      if (op.retryCount >= maxRetry) {
        logger.warn('向量操作重试次数已达上限，跳过', {
          module: 'DocumentService',
          opId: op.id,
          versionId: op.versionId,
          operation: op.operation,
          retryCount: op.retryCount,
          maxRetry,
        });
        results.push({
          id: op.id,
          versionId: op.versionId,
          operation: op.operation,
          success: false,
          error: `重试次数已达上限(${maxRetry})`,
        });
        continue;
      }

      try {
        op.status = VectorOpStatus.PROCESSING;
        op.retryCount += 1;
        await this.pendingVectorOpRepo.save(op);
        logger.info('向量操作开始重试', {
          module: 'DocumentService',
          opId: op.id,
          versionId: op.versionId,
          operation: op.operation,
          retryCount: op.retryCount,
          previousStatus: VectorOpStatus.FAILED,
          currentStatus: VectorOpStatus.PROCESSING,
        });

        switch (op.operation) {
          case VectorOpType.REMOVE:
            await removeDocumentVersion(op.versionId);
            break;
          case VectorOpType.UPDATE_STATUS: {
            const targetVersion = await this.versionRepo.findOne({
              where: { id: op.versionId },
            });
            if (!targetVersion) {
              logger.warn('UPDATE_STATUS 重试：版本记录已不存在，跳过', {
                module: 'DocumentService',
                versionId: op.versionId,
              });
              break;
            }
            const expectedStatus = op.params?.newStatus || 'archived';
            if (targetVersion.status === expectedStatus) {
              logger.info('UPDATE_STATUS 重试：版本状态已一致，直接更新向量', {
                module: 'DocumentService',
                versionId: op.versionId,
                status: expectedStatus,
              });
            } else {
              logger.info(
                'UPDATE_STATUS 重试：版本状态已变更，使用数据库当前状态',
                {
                  module: 'DocumentService',
                  versionId: op.versionId,
                  dbStatus: targetVersion.status,
                  queuedStatus: expectedStatus,
                },
              );
            }
            await updateVersionVectorStatus(op.versionId, targetVersion.status);
            break;
          }
          case VectorOpType.REINDEX: {
            const version = await this.versionRepo.findOne({
              where: { id: op.versionId },
            });
            if (version) {
              let textContent = op.params?.textContent;
              if (!textContent) {
                try {
                  textContent = await this.parseVersionText(version);
                  logger.info('REINDEX 重试：从文件重新解析获取文本内容', {
                    module: 'DocumentService',
                    versionId: op.versionId,
                    textLength: textContent.length,
                  });
                } catch (parseError: any) {
                  logger.error('REINDEX 重试：重新解析文件失败', {
                    module: 'DocumentService',
                    versionId: op.versionId,
                    error: parseError.message,
                  });
                  throw new Error(`重新解析文件失败: ${parseError.message}`);
                }
              }
              // DRAFT 版本重试时直接以 ACTIVE 状态入库，避免再次依赖 updateVersionVectorStatus
              // ARCHIVED 版本保持原状态（用户手动归档的，不应自动激活）
              const vectorStatus =
                version.status === VersionStatus.DRAFT
                  ? VersionStatus.ACTIVE
                  : version.status;
              // 查文档标题用于 metadata
              const docInfo = await this.getDocument(version.documentId).catch(
                () => null,
              );
              const chunkCount = await reindexVersion(
                op.versionId,
                version.documentId,
                textContent,
                vectorStatus,
                {
                  source: version.fileUrl,
                  fileType: version.fileType,
                  mimeType: this.getMimeTypeByExt(version.fileType),
                  documentTitle: docInfo?.title,
                },
              );
              await this.versionRepo.update(op.versionId, {
                parsingStatus: ParsingStatus.SUCCESS,
                chunkCount,
                errorMessage: '',
              });
              logger.info('REINDEX 重试：版本状态已同步', {
                module: 'DocumentService',
                versionId: op.versionId,
                parsingStatus: 'success',
                chunkCount,
                vectorStatus,
              });
              if (version.status === VersionStatus.DRAFT) {
                logger.info('REINDEX 重试：版本仍为 draft，自动激活', {
                  module: 'DocumentService',
                  versionId: op.versionId,
                });
                await this.activateVersion(
                  op.versionId,
                  version.uploadedBy || 'system',
                );
              }
            }
            break;
          }
        }

        op.status = VectorOpStatus.COMPLETED;
        await this.pendingVectorOpRepo.save(op);
        logger.info('向量操作重试成功', {
          module: 'DocumentService',
          opId: op.id,
          versionId: op.versionId,
          operation: op.operation,
          retryCount: op.retryCount,
          previousStatus: VectorOpStatus.PROCESSING,
          currentStatus: VectorOpStatus.COMPLETED,
        });
        results.push({
          id: op.id,
          versionId: op.versionId,
          operation: op.operation,
          success: true,
        });
      } catch (error: any) {
        op.status = VectorOpStatus.FAILED;
        op.errorMessage = error.message;
        await this.pendingVectorOpRepo.save(op);
        logger.error('向量操作重试失败', {
          module: 'DocumentService',
          opId: op.id,
          versionId: op.versionId,
          operation: op.operation,
          retryCount: op.retryCount,
          previousStatus: VectorOpStatus.PROCESSING,
          currentStatus: VectorOpStatus.FAILED,
          errorMessage: error.message,
        });
        results.push({
          id: op.id,
          versionId: op.versionId,
          operation: op.operation,
          success: false,
          error: error.message,
        });
      }
    }

    const retried = results.filter((r) => r.success).length;
    return { retried, total: pendingOps.length, results };
  }

  async getPendingVectorOps(): Promise<PendingVectorOp[]> {
    return this.pendingVectorOpRepo.find({
      where: {
        status: In([
          VectorOpStatus.PENDING,
          VectorOpStatus.FAILED,
          VectorOpStatus.PROCESSING,
        ]),
      },
      order: { createdAt: 'DESC' },
    });
  }

  async retrySingleVectorOp(
    opId: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (isVectorStoreMemoryMode()) {
      resetVectorStore();
      logger.info('检测到向量存储为内存模式，已重置，将重新连接 ChromaDB', {
        module: 'DocumentService',
      });
    }

    const op = await this.pendingVectorOpRepo.findOne({ where: { id: opId } });
    if (!op) throw new NotFoundException(`重试队列操作 ${opId} 不存在`);
    if (op.status === VectorOpStatus.COMPLETED) return { success: true };

    try {
      op.status = VectorOpStatus.PROCESSING;
      op.retryCount += 1;
      await this.pendingVectorOpRepo.save(op);

      switch (op.operation) {
        case VectorOpType.REMOVE:
          await removeDocumentVersion(op.versionId);
          break;
        case VectorOpType.UPDATE_STATUS: {
          const targetVersion = await this.versionRepo.findOne({
            where: { id: op.versionId },
          });
          if (!targetVersion) {
            logger.warn('UPDATE_STATUS 单条重试：版本记录已不存在，跳过', {
              module: 'DocumentService',
              versionId: op.versionId,
            });
            break;
          }
          const expectedStatus = op.params?.newStatus || 'archived';
          if (targetVersion.status === expectedStatus) {
            logger.info(
              'UPDATE_STATUS 单条重试：版本状态已一致，直接更新向量',
              {
                module: 'DocumentService',
                versionId: op.versionId,
                status: expectedStatus,
              },
            );
          } else {
            logger.info(
              'UPDATE_STATUS 单条重试：版本状态已变更，使用数据库当前状态',
              {
                module: 'DocumentService',
                versionId: op.versionId,
                dbStatus: targetVersion.status,
                queuedStatus: expectedStatus,
              },
            );
          }
          await updateVersionVectorStatus(op.versionId, targetVersion.status);
          break;
        }
        case VectorOpType.REINDEX: {
          const version = await this.versionRepo.findOne({
            where: { id: op.versionId },
          });
          if (version) {
            let textContent = op.params?.textContent;
            if (!textContent) {
              textContent = await this.parseVersionText(version);
            }
            const currentStatus = version.status;
            // 查文档标题用于 metadata
            const docInfo = await this.getDocument(version.documentId).catch(
              () => null,
            );
            const chunkCount = await reindexVersion(
              op.versionId,
              version.documentId,
              textContent,
              currentStatus,
              {
                source: version.fileUrl,
                fileType: version.fileType,
                mimeType: this.getMimeTypeByExt(version.fileType),
                documentTitle: docInfo?.title,
              },
            );
            await this.versionRepo.update(op.versionId, {
              parsingStatus: ParsingStatus.SUCCESS,
              chunkCount,
              errorMessage: '',
            });
            logger.info('REINDEX 单条重试：版本状态已同步', {
              module: 'DocumentService',
              versionId: op.versionId,
              parsingStatus: 'success',
              chunkCount,
              currentStatus,
            });

            // 重新发布时也处理图片（从 pending 记录驱动）
            if (docInfo && docInfo.imageTotal > 0) {
              try {
                const imageChunkCount = await this.processDocumentImages(
                  version.documentId,
                  op.versionId,
                  docInfo.title,
                  {
                    documentId: String(version.documentId),
                    documentTitle: docInfo.title,
                    versionId: String(op.versionId),
                    versionStatus: currentStatus,
                    source: version.fileUrl,
                    fileType: version.fileType,
                  },
                );
                logger.info('REINDEX 单条重试：图片处理完成', {
                  module: 'DocumentService',
                  versionId: op.versionId,
                  imageChunkCount,
                });
              } catch (imgErr: any) {
                logger.error('REINDEX 单条重试：图片处理失败', {
                  module: 'DocumentService',
                  versionId: op.versionId,
                  error: imgErr.message,
                });
              }
            }

            if (currentStatus === VersionStatus.DRAFT) {
              logger.info('REINDEX 单条重试：版本仍为 draft，自动激活', {
                module: 'DocumentService',
                versionId: op.versionId,
              });
              await this.activateVersion(
                op.versionId,
                version.uploadedBy || 'system',
              );
            }
          }
          break;
        }
      }

      op.status = VectorOpStatus.COMPLETED;
      await this.pendingVectorOpRepo.save(op);
      logger.info('单条向量操作重试成功', {
        module: 'DocumentService',
        opId,
        versionId: op.versionId,
        operation: op.operation,
      });
      return { success: true };
    } catch (error: any) {
      op.status = VectorOpStatus.FAILED;
      op.errorMessage = error.message;
      await this.pendingVectorOpRepo.save(op);
      logger.error('单条向量操作重试失败', {
        module: 'DocumentService',
        opId,
        versionId: op.versionId,
        error: error.message,
      });
      return { success: false, error: error.message };
    }
  }

  async deletePendingVectorOp(opId: number): Promise<void> {
    const op = await this.pendingVectorOpRepo.findOne({ where: { id: opId } });
    if (!op) throw new NotFoundException(`重试队列操作 ${opId} 不存在`);
    await this.pendingVectorOpRepo.remove(op);
    logger.info('已清除重试队列记录', {
      module: 'DocumentService',
      opId,
      versionId: op.versionId,
      operation: op.operation,
    });
  }
}
