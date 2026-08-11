/**
 * 图片异步重试定时任务
 *
 * 职责：
 * 1. 定期扫描 image_description 表中 status='failed' 且 retryCount < maxRetry 的记录
 * 2. 重新加载原图 buffer，调用 vision-translator 重试翻译
 * 3. 重试成功：更新 DB 记录 + 补入向量库（新增优质描述块）
 * 4. 重试仍失败：retryCount++；达到上限则标记为 'skipped'
 *
 * 设计说明：
 * - Layer 4 兜底块在首次入库时已写入向量库（描述质量低但保证可检索）
 * - 重试成功后会写入新的优质描述块，旧 Layer 4 块保留（短描述排名低，不影响检索质量）
 * - chunkId 字段在重试成功后回填，便于未来引入单 chunk 删除时做去重
 *
 * 触发方式：@Cron 装饰器，间隔由 IMAGE_RETRY_INTERVAL_MIN 控制（默认 10 分钟）
 * 单次最多处理 50 条，避免长时间阻塞
 */

import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ImageDescription } from '../entities/image-description.entity.js';
import { Document } from '../entities/document.entity.js';
import { DocumentVersion, VersionStatus } from '../entities/document-version.entity.js';
import { logger } from '../fundamentals/logger.js';
import { config } from '../fundamentals/config.js';
import {
  translateImage,
  loadImageBuffer,
} from '../fundamentals/vision-translator.js';
import { addImageChunks } from '../fundamentals/vector-store/index.js';
import type { ImageChunkInput } from '../fundamentals/vector-store/index.js';

/** 单次扫描最多处理的记录数，避免长时间阻塞 */
const BATCH_LIMIT = 50;

/** processing 状态超时阈值（毫秒），超过此时间认为服务崩溃，需恢复 */
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

@Injectable()
export class ImageRetrySchedulerService {
  constructor(
    @InjectRepository(ImageDescription)
    private imageDescriptionRepo: Repository<ImageDescription>,
    @InjectRepository(Document)
    private documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private versionRepo: Repository<DocumentVersion>,
  ) {}

  /**
   * 定时扫描失败图片并重试
   * 间隔由 IMAGE_RETRY_INTERVAL_MIN 控制，默认每 10 分钟执行一次
   *
   * 同时恢复因服务崩溃卡在 'processing' 状态的记录（超过 PROCESSING_TIMEOUT_MS）
   */
  @Cron(`*/${Math.min(config.imageRetry.intervalMin, 59)} * * * *`)
  async retryFailedImages(): Promise<void> {
    // VLM 未启用时，重试没有意义（仍然会走 Layer 4）
    // OCR 也未启用时同理
    if (!config.vlm.enabled && !config.ocr.enabled) {
      return;
    }

    // 1. 恢复卡在 processing 的记录（服务崩溃后未正常恢复）
    await this.recoverStuckProcessingRecords();

    const maxRetry = config.imageRetry.maxRetry;
    let candidates: ImageDescription[] = [];

    try {
      candidates = await this.imageDescriptionRepo.find({
        where: {
          status: 'failed' as const,
        },
        take: BATCH_LIMIT,
      });
    } catch (err: any) {
      logger.error('图片重试任务：查询候选记录失败', {
        module: 'ImageRetryScheduler',
        error: err.message,
      });
      return;
    }

    // 过滤掉已达重试上限的记录（一次性标记为 skipped）
    const overLimit = candidates.filter((r) => r.retryCount >= maxRetry);
    const toRetry = candidates.filter((r) => r.retryCount < maxRetry);

    if (overLimit.length > 0) {
      const now = new Date();
      for (const r of overLimit) {
        r.status = 'skipped' as const;
        r.errorMessage = `重试次数已达上限（${maxRetry}）`;
        r.updatedAt = now;
      }
      try {
        await this.imageDescriptionRepo.save(overLimit);
        logger.info('图片重试任务：标记 skipped 记录', {
          module: 'ImageRetryScheduler',
          count: overLimit.length,
        });
      } catch (err: any) {
        logger.error('图片重试任务：标记 skipped 失败', {
          module: 'ImageRetryScheduler',
          error: err.message,
        });
      }
    }

    if (toRetry.length === 0) {
      return;
    }

    logger.info('图片重试任务：开始处理', {
      module: 'ImageRetryScheduler',
      candidateCount: toRetry.length,
      maxRetry,
    });

    // 按 docId 分组，便于批量查询文档标题
    const docIds = [...new Set(toRetry.map((r) => r.docId))];
    const docs = await this.documentRepo.find({
      where: { id: In(docIds.map((id) => Number(id))) },
    });
    const docTitleMap = new Map<string, string>();
    for (const d of docs) {
      docTitleMap.set(String(d.id), d.title);
    }

    // 批量查询版本信息，获取 fileType 和 status（fileType 在 DocumentVersion 上，不在 Document 上）
    // S2-3 修复：需要版本状态判断是否已归档，避免向已归档版本写入 active 状态的向量块
    const versionIds = [
      ...new Set(
        toRetry
          .map((r) => r.versionId)
          .filter((v): v is string => v != null && v.length > 0),
      ),
    ];
    const versionInfoMap = new Map<
      string,
      { fileType: string; status: VersionStatus }
    >();
    if (versionIds.length > 0) {
      const versions = await this.versionRepo.find({
        where: { id: In(versionIds.map((v) => Number(v))) },
      });
      for (const v of versions) {
        versionInfoMap.set(String(v.id), {
          fileType: v.fileType || '',
          status: v.status,
        });
      }
    }

    let successCount = 0;
    let stillFailedCount = 0;
    let skippedCount = 0;

    for (const record of toRetry) {
      try {
        const versionInfo = record.versionId
          ? versionInfoMap.get(record.versionId)
          : undefined;
        const result = await this.retrySingleRecord(
          record,
          docTitleMap.get(record.docId) || '未知文档',
          versionInfo?.fileType || '',
          versionInfo?.status,
        );
        if (result === 'success') {
          successCount++;
        } else if (result === 'skipped') {
          skippedCount++;
        } else {
          stillFailedCount++;
        }
      } catch (err: any) {
        logger.error('图片重试任务：单条处理异常', {
          module: 'ImageRetryScheduler',
          recordId: record.id,
          docId: record.docId,
          sourceIndex: record.sourceIndex,
          error: err.message,
        });
        stillFailedCount++;
      }
    }

    logger.info('图片重试任务：本轮完成', {
      module: 'ImageRetryScheduler',
      total: toRetry.length,
      successCount,
      stillFailedCount,
      skippedCount,
    });
  }

  /**
   * 恢复卡在 processing 状态的记录
   *
   * 服务崩溃时，正在处理的图片记录会停留在 'processing' 状态。
   * 超过 PROCESSING_TIMEOUT_MS 后，将这些记录重置为 'failed'，让重试流程重新处理。
   */
  private async recoverStuckProcessingRecords(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
      const stuckRecords = await this.imageDescriptionRepo.find({
        where: {
          status: 'processing' as const,
        },
        take: BATCH_LIMIT,
      });

      // 过滤出超时的记录（updatedAt 早于阈值）
      const timedOut = stuckRecords.filter(
        (r) => r.updatedAt.getTime() < cutoff.getTime(),
      );

      if (timedOut.length === 0) return;

      const now = new Date();
      for (const r of timedOut) {
        r.status = 'failed' as const;
        r.errorMessage = `processing 状态超时（>${PROCESSING_TIMEOUT_MS / 60000}分钟），已恢复`;
        r.updatedAt = now;
      }

      await this.imageDescriptionRepo.save(timedOut);
      logger.warn('恢复卡在 processing 的图片记录', {
        module: 'ImageRetryScheduler',
        recoveredCount: timedOut.length,
        timeoutMs: PROCESSING_TIMEOUT_MS,
      });
    } catch (err: any) {
      logger.error('恢复 processing 记录失败', {
        module: 'ImageRetryScheduler',
        error: err.message,
      });
    }
  }

  /**
   * 重试单条失败记录
   *
   * @returns 'success' | 'failed' | 'skipped'
   */
  private async retrySingleRecord(
    record: ImageDescription,
    documentTitle: string,
    fileType: string,
    versionStatus: VersionStatus | undefined,
  ): Promise<'success' | 'failed' | 'skipped'> {
    // S2-3 修复：版本已归档或不存在时跳过重试，避免写入错误状态的向量块
    if (versionStatus === undefined || versionStatus === VersionStatus.ARCHIVED) {
      record.status = 'skipped' as const;
      record.errorMessage = versionStatus === undefined
        ? '版本不存在，跳过重试'
        : '版本已归档，跳过重试';
      record.updatedAt = new Date();
      await this.imageDescriptionRepo.save(record);
      logger.warn('图片重试：版本不可用，标记 skipped', {
        module: 'ImageRetryScheduler',
        recordId: record.id,
        docId: record.docId,
        versionId: record.versionId,
        versionStatus: versionStatus ?? 'undefined',
      });
      return 'skipped';
    }

    // 1. 标记为 processing，避免并发重复处理
    // 注意：retryCount 延迟到 loadImageBuffer 成功后才 +1，
    // 避免图片文件丢失时白白消耗重试次数
    record.status = 'processing' as const;
    record.updatedAt = new Date();
    await this.imageDescriptionRepo.save(record);

    // 2. 加载原图 buffer
    let buffer: Buffer;
    try {
      buffer = await loadImageBuffer(record.imagePath);
    } catch (err: unknown) {
      // 图片文件丢失，直接标记为 skipped（无法恢复）
      // 不消耗 retryCount，因为这不是 VLM 调用失败
      const errMsg = err instanceof Error ? err.message : String(err);
      record.status = 'skipped' as const;
      record.errorMessage = `原图文件丢失: ${errMsg}`;
      record.updatedAt = new Date();
      await this.imageDescriptionRepo.save(record);
      logger.warn('图片重试：原图文件丢失，标记 skipped', {
        module: 'ImageRetryScheduler',
        recordId: record.id,
        imagePath: record.imagePath,
      });
      return 'skipped';
    }

    // 3. 图片加载成功，消耗一次重试次数
    record.retryCount += 1;

    // 4. 调用 vision-translator 重试翻译
    // S2-4 修复：translateImage 设计为永不抛异常，但为防止未来代码变更引入未覆盖的异常路径，
    // 此处增加 try/catch 保护，异常时将记录回退为 failed 而非卡在 processing
    let translationResult;
    try {
      translationResult = await translateImage({
        asset: {
          buffer,
          sourceIndex: record.sourceIndex,
          caption: record.caption,
          page: record.page,
          section: record.section,
          surroundingText: record.surroundingText || '',
          originalPath: record.imagePath,
          sourceType: record.sourceType,
        },
        docId: record.docId,
        documentTitle,
        // Bug 5 修复：传入已有路径，避免重复落盘
        existingImagePath: record.imagePath,
      });
    } catch (translateErr: unknown) {
      const errMsg = translateErr instanceof Error ? translateErr.message : String(translateErr);
      logger.error('图片重试：translateImage 抛出异常', {
        module: 'ImageRetryScheduler',
        recordId: record.id,
        docId: record.docId,
        error: errMsg,
      });
      if (record.retryCount >= config.imageRetry.maxRetry) {
        record.status = 'skipped' as const;
      } else {
        record.status = 'failed' as const;
      }
      record.errorMessage = `translateImage 异常: ${errMsg}`;
      record.updatedAt = new Date();
      await this.imageDescriptionRepo.save(record);
      return record.status === 'skipped' ? 'skipped' : 'failed';
    }

    // 4. 重试仍走 Layer 4（success=false）-> 失败
    if (!translationResult.success) {
      // 达到重试上限 -> skipped，否则保持 failed 等待下一轮
      if (record.retryCount >= config.imageRetry.maxRetry) {
        record.status = 'skipped' as const;
        record.errorMessage = `重试 ${record.retryCount} 次仍失败: ${translationResult.errorMessage}`;
      } else {
        record.status = 'failed' as const;
        record.errorMessage = translationResult.errorMessage;
      }
      record.updatedAt = new Date();
      await this.imageDescriptionRepo.save(record);
      return record.status === 'skipped' ? 'skipped' : 'failed';
    }

    // 5. 重试成功 -> 更新 DB + 补入向量库
    record.status = 'completed' as const;
    record.description = translationResult.description;
    record.tags = null;

    record.modelUsed = translationResult.modelUsed;
    record.fallbackLayer = translationResult.fallbackLayer;
    record.errorMessage = null;
    record.updatedAt = new Date();

    // 构造入库 metadata（与首次 processDocumentImages 保持一致）
    // S2-3 修复：使用实际版本状态，而非硬编码 ACTIVE
    const baseMetadata = {
      documentId: record.docId,
      documentTitle,
      versionId: record.versionId || '',
      versionStatus: versionStatus,
      source: documentTitle,
      fileType,
    };

    // 合并 description + caption：标题作为标签追加到描述后面
    // caption 来自文档中图片前面的标题文本，让 BM25 检索能通过标题关键词找到图片
    const captionLine = record.caption
      ? `\n【标题】${record.caption}`
      : '';

    const chunkInput: ImageChunkInput = {
      description: translationResult.description + captionLine,
      baseMetadata: {
        ...baseMetadata,
        chunk_role: 'image',
      },
      imageMetadata: {
        imagePath: translationResult.imagePath,
        imageHash: translationResult.imageHash,
        caption: record.caption,
        page: record.page,
        section: record.section,
        imageSourceIndex: record.sourceIndex,
        sourceType: record.sourceType,
      },
    };

    try {
      const added = await addImageChunks([chunkInput]);
      logger.info('图片重试成功，已补入向量库', {
        module: 'ImageRetryScheduler',
        recordId: record.id,
        docId: record.docId,
        sourceIndex: record.sourceIndex,
        fallbackLayer: translationResult.fallbackLayer,
        modelUsed: translationResult.modelUsed,
        addedChunks: added,
      });
    } catch (err: any) {
      // 向量库写入失败不回滚 DB（DB 记录已成功，下次全量重发布时会重建）
      logger.error('图片重试成功但向量库写入失败', {
        module: 'ImageRetryScheduler',
        recordId: record.id,
        docId: record.docId,
        error: err.message,
      });
    }

    await this.imageDescriptionRepo.save(record);
    return 'success';
  }
}
