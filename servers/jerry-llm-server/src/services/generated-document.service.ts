import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GeneratedDocument } from '../entities/generated-document.entity.js';
import { config } from '../fundamentals/config.js';
import { logger } from '../fundamentals/logger.js';

/**
 * 生成文档服务
 *
 * 职责：
 *   - 接收 generate_document 工具产出的 Buffer，落盘到 DOCUMENT_STORAGE_DIR
 *   - 在 generated_document 表中记录元数据（含 userId、key、过期时间）
 *   - 提供按 key 读取文件的方法（同时续期 lastAccessedAt）
 *   - 周期性清理过期/闲置/被孤儿引用的文件
 *
 * 与旧内存缓存的差异：
 *   - 重启不丢失
 *   - 多实例可通过共享卷读取
 *   - 可按 userId 校验下载权限
 */
@Injectable()
export class GeneratedDocumentService {
  private readonly storageDir: string;

  constructor(
    @InjectRepository(GeneratedDocument)
    private readonly repo: Repository<GeneratedDocument>,
  ) {
    // 解析为绝对路径，避免 cwd 切换导致目录不一致
    this.storageDir = path.isAbsolute(config.document.storageDir)
      ? config.document.storageDir
      : path.resolve(process.cwd(), config.document.storageDir);
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
      logger.info('文档存储目录已创建', { module: 'GeneratedDocumentService', dir: this.storageDir });
    }
  }

  /** 生成短 key，使用 crypto 随机 16 字节再截断为 16 字符（≈80bit 熵，比 Math.random 更安全） */
  private async genKey(): Promise<string> {
    const MAX_RETRIES = 5;
    for (let i = 0; i < MAX_RETRIES; i++) {
      const key = crypto.randomBytes(12).toString('base64url').slice(0, 16);
      const exists = await this.repo.findOne({ where: { key } });
      if (!exists) return key;
      logger.warn('genKey 碰撞，重试', { module: 'GeneratedDocumentService', attempt: i + 1 });
    }
    // 极端情况：5 次都碰撞，加长 key 到 24 字符
    return crypto.randomBytes(18).toString('base64url').slice(0, 24);
  }

  /**
   * 保存生成结果：写文件 + 入库
   * 抛错场景：文件大小超过单文件上限
   */
  async save(params: {
    buffer: Buffer;
    filename: string;
    format: 'pdf' | 'docx' | 'html';
    mimeType: string;
    userId?: string;
    sessionId?: string;
  }): Promise<GeneratedDocument> {
    const maxBytes = config.document.maxDocSizeMB * 1024 * 1024;
    if (params.buffer.length > maxBytes) {
      throw new Error(
        `文档大小 ${(params.buffer.length / 1024 / 1024).toFixed(2)}MB 超过 ${config.document.maxDocSizeMB}MB 上限`,
      );
    }

    const key = await this.genKey();
    // 文件名按 key 落盘（含扩展名），避免中文/特殊字符踩坑
    const safeName = `${key}.${params.format}`;
    const absPath = path.join(this.storageDir, safeName);

    // 先写磁盘，如果后续入库失败则回滚删除文件
    fs.writeFileSync(absPath, params.buffer);

    const checksum = crypto.createHash('sha256').update(params.buffer).digest('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.document.ttlDays * 24 * 60 * 60 * 1000);

    const entity = this.repo.create({
      key,
      userId: params.userId || 'default',
      sessionId: params.sessionId || null,
      filename: params.filename,
      format: params.format,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      filePath: safeName,
      checksum,
      lastAccessedAt: now,
      expiresAt,
    } as Partial<GeneratedDocument>);

    let saved: GeneratedDocument;
    try {
      saved = await this.repo.save(entity);
    } catch (dbErr: any) {
      // 入库失败：回滚磁盘文件，避免孤儿文件
      try {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      } catch (unlinkErr: any) {
        logger.warn('save 回滚删除磁盘文件失败', {
          module: 'GeneratedDocumentService',
          key,
          error: unlinkErr?.message,
        });
      }
      throw dbErr;
    }
    logger.info('文档已落盘并入库', {
      module: 'GeneratedDocumentService',
      key,
      filename: params.filename,
      sizeBytes: params.buffer.length,
      userId: params.userId,
    });
    return saved;
  }

  /**
   * 查询当前用户所有收藏且未过期的文档清单
   * 用于前端"我的收藏"面板展示
   *
   * 注意：收藏文档不受硬过期限制（cleanup 也不清理收藏文档），
   * 因此这里不加 expiresAt 过滤——只要 favorited=true 就展示。
   */
  async listFavorites(userId: string): Promise<GeneratedDocument[]> {
    return this.repo.find({
      where: { userId, favorited: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 按 key 查询元数据（不读取文件内容）
   *
   * 过期逻辑：与 cleanup() 保持一致——收藏文档不参与过期判断，
   * 因为用户显式标记"永久保留"意味着不打算被自动清理。
   */
  async findByKey(key: string): Promise<GeneratedDocument | null> {
    const entity = await this.repo.findOne({ where: { key } });
    if (!entity) return null;

    // 收藏文档不参与过期判断（与 cleanup 一致）
    if (!entity.favorited && entity.expiresAt < new Date()) {
      await this.deleteEntity(entity);
      return null;
    }
    return entity;
  }

  /**
   * 读取文件内容并续期 lastAccessedAt
   * @param key 文档 key
   * @param userId 当前请求的 userId（用于权限校验，传 null 跳过校验，仅供内部如邮件发送使用）
   */
  async read(key: string, userId: string | null): Promise<{ entity: GeneratedDocument; buffer: Buffer } | null> {
    const entity = await this.findByKey(key);
    if (!entity) return null;

    // 权限校验：登录用户只能下载自己的文档
    // 'default' 表示未登录访问，文档归属也是 'default'，仍允许同共享空间访问（与现有产品行为一致）
    if (userId !== null && entity.userId !== userId) {
      logger.warn('文档访问被拒绝（userId 不匹配）', {
        module: 'GeneratedDocumentService',
        key,
        ownerUserId: entity.userId,
        requestUserId: userId,
      });
      return null;
    }

    const absPath = path.join(this.storageDir, entity.filePath);
    if (!fs.existsSync(absPath)) {
      logger.warn('文档文件丢失（DB 有记录但磁盘缺失），清理元数据', {
        module: 'GeneratedDocumentService',
        key,
        filePath: entity.filePath,
      });
      await this.deleteEntity(entity);
      return null;
    }

    const buffer = fs.readFileSync(absPath);

    // 续期 lastAccessedAt（不阻塞主流程，错误忽略）
    this.repo.update(entity.id, { lastAccessedAt: new Date() }).catch((err) => {
      logger.warn('更新 lastAccessedAt 失败', { module: 'GeneratedDocumentService', key, error: err?.message });
    });

    return { entity, buffer };
  }

  /**
   * 清理过期 / 闲置 / 孤儿文件
   * 由定时任务调用，返回清理详情（含被删除的 keys，便于推送 SSE 事件给前端）
   *
   * 清理规则：
   *   - 收藏文档（favorited = true）一律不参与自动清理
   *   - 闲置条件：lastAccessedAt 超过 idleDays 且不为 NULL（NULL 行视为从未访问，也应清理）
   *   - 去重：expired 和 idle 结果可能有交集，使用 Set 按 id 去重
   */
  async cleanup(): Promise<{ deletedExpired: number; deletedIdle: number; deletedKeys: string[]; deletedBySession: Map<string, string[]> }> {
    const now = new Date();
    const idleThreshold = new Date(now.getTime() - config.document.idleDays * 24 * 60 * 60 * 1000);

    // 1. 硬过期（排除收藏）
    const expired = await this.repo.find({
      where: { expiresAt: LessThan(now), favorited: false },
    });

    // 2. 长期未访问（排除收藏；含 lastAccessedAt 为 NULL 的行）
    const idle = await this.repo.find({
      where: [
        { lastAccessedAt: LessThan(idleThreshold), favorited: false },
        { lastAccessedAt: IsNull(), favorited: false },
      ],
    });

    // 按 id 去重，避免 expired 和 idle 交集导致重复删除
    const toDelete = new Map<number, GeneratedDocument>();
    for (const e of expired) toDelete.set(e.id, e);
    let idleOnlyCount = 0;
    for (const e of idle) {
      if (!toDelete.has(e.id)) {
        toDelete.set(e.id, e);
        idleOnlyCount++;
      }
    }

    const deletedKeys: string[] = [];
    // 按 sessionId 分组，便于 SSE 仅推送给对应会话
    const deletedBySession = new Map<string, string[]>();
    for (const e of toDelete.values()) {
      await this.deleteEntity(e);
      deletedKeys.push(e.key);
      const sid = e.sessionId || '';
      if (!deletedBySession.has(sid)) deletedBySession.set(sid, []);
      deletedBySession.get(sid)!.push(e.key);
    }

    const deletedExpired = expired.length;
    const deletedIdle = idleOnlyCount;

    if (toDelete.size > 0) {
      logger.info('生成文档清理任务完成', {
        module: 'GeneratedDocumentService',
        deletedExpired,
        deletedIdle,
        total: toDelete.size,
      });
    }
    return { deletedExpired, deletedIdle, deletedKeys, deletedBySession };
  }

  /**
   * 用户主动删除单个文档
   * @returns true 表示成功删除；false 表示文档不存在或权限不足
   */
  async deleteByKey(key: string, userId: string | null): Promise<boolean> {
    const entity = await this.repo.findOne({ where: { key } });
    if (!entity) return false;
    if (userId !== null && entity.userId !== userId) {
      logger.warn('文档删除被拒绝（userId 不匹配）', {
        module: 'GeneratedDocumentService',
        key,
        ownerUserId: entity.userId,
        requestUserId: userId,
      });
      return false;
    }
    await this.deleteEntity(entity);
    logger.info('用户主动删除文档', { module: 'GeneratedDocumentService', key, userId });
    return true;
  }

  /**
   * 切换收藏状态（收藏后不再参与自动清理）
   * @returns 更新后的实体；null 表示文档不存在或权限不足
   */
  async setFavorite(key: string, userId: string | null, favorited: boolean): Promise<GeneratedDocument | null> {
    const entity = await this.repo.findOne({ where: { key } });
    if (!entity) return null;
    if (userId !== null && entity.userId !== userId) {
      logger.warn('文档收藏被拒绝（userId 不匹配）', {
        module: 'GeneratedDocumentService',
        key,
        ownerUserId: entity.userId,
        requestUserId: userId,
      });
      return null;
    }
    entity.favorited = favorited;
    // 收藏时同时刷新 lastAccessedAt，避免恰好处于 idle 边缘被清理
    if (favorited) entity.lastAccessedAt = new Date();
    return this.repo.save(entity);
  }

  /** 删除单个文档（文件 + 数据库记录） */
  private async deleteEntity(entity: GeneratedDocument): Promise<void> {
    try {
      const absPath = path.join(this.storageDir, entity.filePath);
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } catch (err: any) {
      logger.warn('删除生成文档文件失败', {
        module: 'GeneratedDocumentService',
        key: entity.key,
        error: err?.message,
      });
    }
    await this.repo.delete(entity.id).catch(() => undefined);
  }
}
