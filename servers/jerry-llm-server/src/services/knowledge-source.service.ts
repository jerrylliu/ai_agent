import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { createHash } from 'crypto';
import { KnowledgeSource, SourceType, SyncStatus } from '../entities/knowledge-source.entity.js';
import { KnowledgeSourceSyncLog, SyncLogStatus } from '../entities/knowledge-source-sync-log.entity.js';
import { KnowledgeSourcePage } from '../entities/knowledge-source-page.entity.js';
import { crawlWebsite, type WebCrawlConfig, type CrawlResult, type CrawlPage } from '../fundamentals/web-crawler';
import { fetchFeishuContent, type FeishuConfig, type FeishuFetchResult, type FeishuPage } from '../fundamentals/feishu-connector';
import { addDocuments, deleteDocuments } from '../fundamentals/vector-store';
import { logger } from '../fundamentals/logger';

function computeContentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').substring(0, 32);
}

interface PageItem {
  key: string;
  title: string;
  content: string;
  url: string;
}

@Injectable()
export class KnowledgeSourceService {
  constructor(
    @InjectRepository(KnowledgeSource)
    private sourceRepo: Repository<KnowledgeSource>,
    @InjectRepository(KnowledgeSourceSyncLog)
    private syncLogRepo: Repository<KnowledgeSourceSyncLog>,
    @InjectRepository(KnowledgeSourcePage)
    private pageRepo: Repository<KnowledgeSourcePage>,
  ) {}

  async create(data: {
    name: string;
    type: SourceType;
    config: Record<string, any>;
    syncInterval?: number;
    maxDepth?: number;
    maxPages?: number;
    preferMarkdown?: boolean;
    enableJsRendering?: boolean;
  }): Promise<KnowledgeSource> {
    const source = this.sourceRepo.create({
      name: data.name,
      type: data.type,
      config: data.config,
      syncInterval: data.syncInterval ?? 60,
      maxDepth: data.maxDepth ?? 2,
      maxPages: data.maxPages ?? 50,
      preferMarkdown: data.preferMarkdown ?? true,
      enableJsRendering: data.enableJsRendering ?? false,
      lastSyncStatus: SyncStatus.IDLE,
      enabled: true,
    });

    const saved = await this.sourceRepo.save(source);
    logger.info('知识源创建成功', { module: 'KnowledgeSourceService', sourceId: saved.id, name: saved.name, type: saved.type });
    return saved;
  }

  async findAll(): Promise<KnowledgeSource[]> {
    return this.sourceRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: number): Promise<KnowledgeSource> {
    const source = await this.sourceRepo.findOne({ where: { id } });
    if (!source) throw new NotFoundException(`知识源 #${id} 不存在`);
    return source;
  }

  async update(id: number, data: Partial<Pick<KnowledgeSource, 'name' | 'config' | 'syncInterval' | 'maxDepth' | 'maxPages' | 'preferMarkdown' | 'enableJsRendering' | 'enabled'>>): Promise<KnowledgeSource> {
    const source = await this.findOne(id);
    Object.assign(source, data);
    const saved = await this.sourceRepo.save(source);
    logger.info('知识源更新成功', { module: 'KnowledgeSourceService', sourceId: id });
    return saved;
  }

  async remove(id: number): Promise<void> {
    const source = await this.findOne(id);

    // 先删除向量数据（ChromaDB + BM25），避免删除数据库记录后向量变成孤岛
    try {
      await deleteDocuments({ sourceId: id });
      logger.info('知识源向量数据已删除', { module: 'KnowledgeSourceService', sourceId: id });
    } catch (err: any) {
      logger.error('知识源向量数据删除失败', { module: 'KnowledgeSourceService', sourceId: id, error: err.message });
    }

    await this.pageRepo.delete({ sourceId: id });
    await this.sourceRepo.remove(source);
    logger.info('知识源删除成功', { module: 'KnowledgeSourceService', sourceId: id, name: source.name });
  }

  async getSyncLogs(sourceId: number, limit: number = 20): Promise<KnowledgeSourceSyncLog[]> {
    return this.syncLogRepo.find({
      where: { sourceId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getStats(): Promise<{ total: number; enabled: number; syncing: number; failed: number; success: number }> {
    const sources = await this.sourceRepo.find();
    return {
      total: sources.length,
      enabled: sources.filter(s => s.enabled).length,
      syncing: sources.filter(s => s.lastSyncStatus === SyncStatus.SYNCING).length,
      failed: sources.filter(s => s.lastSyncStatus === SyncStatus.FAILED).length,
      success: sources.filter(s => s.lastSyncStatus === SyncStatus.SUCCESS).length,
    };
  }

  async getPageCount(sourceId: number): Promise<number> {
    return this.pageRepo.count({ where: { sourceId, isDeleted: false } });
  }

  async getTotalPageCount(): Promise<number> {
    return this.pageRepo.count({ where: { isDeleted: false } });
  }

  /**
   * 重置所有知识源（清空知识库后调用）
   * 1. 清空所有知识源的页面数据
   * 2. 标记所有知识源需要重新同步
   */
  async markAllForResync(): Promise<number> {
    // 清空所有知识源的页面数据（TypeORM 不允许空条件 delete，使用 createQueryBuilder）
    const pageDeleteResult = await this.pageRepo.createQueryBuilder().delete().execute();
    logger.info('已清空知识源页面数据', { module: 'KnowledgeSourceService', deletedPages: pageDeleteResult.affected });

    // 标记所有启用的知识源需要重新同步
    const sources = await this.sourceRepo.find({ where: { enabled: true } });
    let count = 0;
    for (const source of sources) {
      source.hasContentUpdate = true;
      source.lastSyncStatus = SyncStatus.IDLE;
      source.lastSyncError = null;
      await this.sourceRepo.save(source);
      count++;
    }
    logger.info('已标记所有知识源需要重新同步', { module: 'KnowledgeSourceService', count });
    return count;
  }

  async syncSource(sourceId: number): Promise<KnowledgeSourceSyncLog> {
    const source = await this.findOne(sourceId);

    if (source.lastSyncStatus === SyncStatus.SYNCING) {
      throw new Error(`知识源 "${source.name}" 正在同步中，请稍后再试`);
    }

    source.lastSyncStatus = SyncStatus.SYNCING;
    source.lastSyncError = null;
    await this.sourceRepo.save(source);

    const syncLog = this.syncLogRepo.create({
      sourceId: source.id,
      status: SyncLogStatus.RUNNING,
      startedAt: new Date(),
      pagesFetched: 0,
      chunksAdded: 0,
      chunksUpdated: 0,
    });
    await this.syncLogRepo.save(syncLog);

    logger.info('知识源同步开始', { module: 'KnowledgeSourceService', sourceId, name: source.name, type: source.type });

    try {
      let pagesFetched = 0;
      let chunksAdded = 0;
      let chunksUpdated = 0;
      let pagesNew = 0;
      let pagesUpdated = 0;
      let pagesDeleted = 0;
      let updatedPageDetails: Array<{ title: string; url: string }> = [];

      switch (source.type) {
        case SourceType.WEB: {
          const result = await this.syncWebSource(source);
          pagesFetched = result.pagesFetched;
          chunksAdded = result.chunksAdded;
          chunksUpdated = result.chunksUpdated;
          pagesNew = result.pagesNew;
          pagesUpdated = result.pagesUpdated;
          pagesDeleted = result.pagesDeleted;
          updatedPageDetails = result.updatedPageDetails;
          break;
        }
        case SourceType.FEISHU: {
          const result = await this.syncFeishuSource(source);
          pagesFetched = result.pagesFetched;
          chunksAdded = result.chunksAdded;
          chunksUpdated = result.chunksUpdated;
          pagesNew = result.pagesNew;
          pagesUpdated = result.pagesUpdated;
          pagesDeleted = result.pagesDeleted;
          updatedPageDetails = result.updatedPageDetails;
          break;
        }
        default:
          throw new Error(`不支持的知识源类型: ${source.type}`);
      }

      const hasContentUpdate = pagesUpdated > 0 || pagesDeleted > 0;

      syncLog.status = SyncLogStatus.SUCCESS;
      syncLog.pagesFetched = pagesFetched;
      syncLog.chunksAdded = chunksAdded;
      syncLog.chunksUpdated = chunksUpdated;
      syncLog.pagesNew = pagesNew;
      syncLog.pagesUpdated = pagesUpdated;
      syncLog.pagesDeleted = pagesDeleted;
      syncLog.updatedPageDetails = updatedPageDetails.length > 0 ? updatedPageDetails : null;
      syncLog.finishedAt = new Date();

      source.lastSyncStatus = SyncStatus.SUCCESS;
      source.lastSyncAt = new Date();
      source.lastSyncError = null;
      source.hasContentUpdate = hasContentUpdate;

      logger.info('知识源同步成功', {
        module: 'KnowledgeSourceService',
        sourceId,
        name: source.name,
        pagesFetched,
        chunksAdded,
        chunksUpdated,
        pagesNew,
        pagesUpdated,
        pagesDeleted,
        hasContentUpdate,
      });
    } catch (error: any) {
      syncLog.status = SyncLogStatus.FAILED;
      syncLog.errorMessage = error.message;
      syncLog.finishedAt = new Date();

      source.lastSyncStatus = SyncStatus.FAILED;
      source.lastSyncError = error.message;

      logger.error('知识源同步失败', {
        module: 'KnowledgeSourceService',
        sourceId,
        name: source.name,
        error: error.message,
      });
    }

    await this.syncLogRepo.save(syncLog);
    await this.sourceRepo.save(source);

    return syncLog;
  }

  private async incrementalSync(source: KnowledgeSource, pages: PageItem[]): Promise<{ pagesFetched: number; chunksAdded: number; chunksUpdated: number; pagesNew: number; pagesUpdated: number; pagesDeleted: number; updatedPageDetails: Array<{ title: string; url: string }> }> {
    const existingPages = await this.pageRepo.find({ where: { sourceId: source.id } });
    const existingMap = new Map(existingPages.map(p => [p.pageKey, p]));
    const activeMap = new Map(existingPages.filter(p => !p.isDeleted).map(p => [p.pageKey, p]));

    const currentKeys = new Set(pages.map(p => p.key));

    const newPages: PageItem[] = [];
    const updatedPages: PageItem[] = [];
    const deletedKeys: string[] = [];

    for (const page of pages) {
      const hash = computeContentHash(page.content);
      const existing = activeMap.get(page.key);

      if (!existing) {
        newPages.push(page);
      } else if (existing.contentHash !== hash) {
        updatedPages.push(page);
      }
    }

    for (const [key] of activeMap) {
      if (!currentKeys.has(key)) {
        deletedKeys.push(key);
      }
    }

    logger.info('增量同步分析', {
      module: 'KnowledgeSourceService',
      sourceId: source.id,
      total: pages.length,
      newCount: newPages.length,
      updatedCount: updatedPages.length,
      deletedCount: deletedKeys.length,
    });

    if (deletedKeys.length > 0) {
      for (const key of deletedKeys) {
        const page = existingMap.get(key);
        if (page?.pageUrl) {
          try {
            await deleteDocuments({ source: page.pageUrl, sourceId: source.id });
            logger.info('已删除远端移除页面的向量', { module: 'KnowledgeSourceService', sourceId: source.id, pageKey: key });
          } catch (e: any) {
            logger.warn('删除远端移除页面的向量失败', { module: 'KnowledgeSourceService', pageKey: key, error: e.message });
          }
        }
      }
    }

    if (updatedPages.length > 0) {
      for (const page of updatedPages) {
        try {
          await deleteDocuments({ source: page.url, sourceId: source.id });
          logger.info('已删除更新页面的旧向量', { module: 'KnowledgeSourceService', sourceId: source.id, pageUrl: page.url });
        } catch (e: any) {
          logger.warn('删除更新页面的旧向量失败', { module: 'KnowledgeSourceService', pageUrl: page.url, error: e.message });
        }
      }
    }

    const pagesToVectorize = [...newPages, ...updatedPages];

    let chunksAdded = 0;
    let chunksUpdated = 0;

    if (pagesToVectorize.length > 0) {
      const texts: string[] = [];
      const metadataList: Array<{ source: string; docType: string; sourceType: string; sourceId: number; sourceName: string; crawledAt: string; [key: string]: any }> = [];

      for (const page of pagesToVectorize) {
        const content = `# ${page.title}\n\n来源: ${page.url}\n\n${page.content}`;
        texts.push(content);
        metadataList.push({
          source: page.url,
          docType: source.type,
          sourceType: source.type,
          sourceId: source.id,
          sourceName: source.name,
          crawledAt: new Date().toISOString(),
          versionStatus: 'active',
          // 爬虫内容被拼成 Markdown 格式，显式标注类型，避免自适应 Chunking 降级为 default
          fileType: 'md',
          mimeType: 'text/markdown',
        });
      }

      const chunkCount = await addDocuments(texts, metadataList, {
        chunkingStrategy: 'parent-child',
      });
      chunksAdded = newPages.length > 0 ? Math.round(chunkCount * (newPages.length / pagesToVectorize.length)) : 0;
      chunksUpdated = chunkCount - chunksAdded;
    }

    const now = new Date();
    for (const page of newPages) {
      const hash = computeContentHash(page.content);
      const softDeleted = existingMap.get(page.key);
      if (softDeleted && softDeleted.isDeleted) {
        softDeleted.pageTitle = page.title;
        softDeleted.contentHash = hash;
        softDeleted.pageUrl = page.url;
        softDeleted.isDeleted = false;
        softDeleted.syncedAt = now;
        await this.pageRepo.save(softDeleted);
      } else {
        const entity = this.pageRepo.create({
          sourceId: source.id,
          pageKey: page.key,
          pageTitle: page.title,
          contentHash: hash,
          pageUrl: page.url,
          isDeleted: false,
          syncedAt: now,
        });
        await this.pageRepo.save(entity);
      }
    }

    for (const page of updatedPages) {
      const hash = computeContentHash(page.content);
      const existing = existingMap.get(page.key)!;
      existing.pageTitle = page.title;
      existing.contentHash = hash;
      existing.pageUrl = page.url;
      existing.syncedAt = now;
      await this.pageRepo.save(existing);
    }

    if (deletedKeys.length > 0) {
      await this.pageRepo.update({ sourceId: source.id, pageKey: In(deletedKeys) }, { isDeleted: true, syncedAt: now });
    }

    const updatedPageDetails = updatedPages.map(p => ({ title: p.title, url: p.url }));

    return {
      pagesFetched: pages.length,
      chunksAdded,
      chunksUpdated,
      pagesNew: newPages.length,
      pagesUpdated: updatedPages.length,
      pagesDeleted: deletedKeys.length,
      updatedPageDetails,
    };
  }

  private async syncWebSource(source: KnowledgeSource): Promise<{ pagesFetched: number; chunksAdded: number; chunksUpdated: number; pagesNew: number; pagesUpdated: number; pagesDeleted: number; updatedPageDetails: Array<{ title: string; url: string }> }> {
    const config: WebCrawlConfig = {
      startUrl: source.config?.startUrl || source.config?.url,
      maxDepth: source.maxDepth,
      maxPages: source.maxPages,
      includePatterns: source.config?.includePatterns,
      excludePatterns: source.config?.excludePatterns,
      preferMarkdown: source.preferMarkdown,
      enableJsRendering: source.enableJsRendering,
    };

    if (!config.startUrl) {
      throw new Error('Web 类型知识源缺少 startUrl 配置');
    }

    const crawlResult: CrawlResult = await crawlWebsite(config);

    if (crawlResult.pages.length === 0) {
      logger.warn('Web 爬取未获取到有效页面', { module: 'KnowledgeSourceService', sourceId: source.id });
      return { pagesFetched: 0, chunksAdded: 0, chunksUpdated: 0, pagesNew: 0, pagesUpdated: 0, pagesDeleted: 0, updatedPageDetails: [] };
    }

    const pages: PageItem[] = crawlResult.pages.map((p: CrawlPage) => ({
      key: p.url,
      title: p.title,
      content: p.markdown,
      url: p.url,
    }));

    return this.incrementalSync(source, pages);
  }

  private async syncFeishuSource(source: KnowledgeSource): Promise<{ pagesFetched: number; chunksAdded: number; chunksUpdated: number; pagesNew: number; pagesUpdated: number; pagesDeleted: number; updatedPageDetails: Array<{ title: string; url: string }> }> {
    const config: FeishuConfig = {
      appId: source.config?.appId,
      appSecret: source.config?.appSecret,
      wikiSpaceId: source.config?.wikiSpaceId,
      docToken: source.config?.docToken,
      includePatterns: source.config?.includePatterns,
      excludePatterns: source.config?.excludePatterns,
      maxPages: source.maxPages,
      feishuDomain: source.config?.feishuDomain,
    };

    if (!config.appId || !config.appSecret) {
      throw new Error('飞书类型知识源缺少 appId 或 appSecret 配置');
    }
    if (!config.wikiSpaceId && !config.docToken) {
      throw new Error('飞书类型知识源必须提供 wikiSpaceId 或 docToken');
    }

    const fetchResult: FeishuFetchResult = await fetchFeishuContent(config);

    if (fetchResult.pages.length === 0) {
      logger.warn('飞书未获取到有效页面', { module: 'KnowledgeSourceService', sourceId: source.id });
      return { pagesFetched: 0, chunksAdded: 0, chunksUpdated: 0, pagesNew: 0, pagesUpdated: 0, pagesDeleted: 0, updatedPageDetails: [] };
    }

    const pages: PageItem[] = fetchResult.pages.map((p: FeishuPage) => ({
      key: `feishu:${p.id}`,
      title: p.title,
      content: p.markdown,
      url: p.url,
    }));

    return this.incrementalSync(source, pages);
  }

  async getSourcesNeedingSync(): Promise<KnowledgeSource[]> {
    const sources = await this.sourceRepo.find({ where: { enabled: true } });

    return sources.filter(source => {
      if (source.lastSyncStatus === SyncStatus.SYNCING) return false;
      if (!source.lastSyncAt) return true;

      const elapsed = Date.now() - source.lastSyncAt.getTime();
      return elapsed >= source.syncInterval * 60 * 1000;
    });
  }

  async resetSyncStatus(sourceId: number): Promise<void> {
    const source = await this.findOne(sourceId);
    if (source.lastSyncStatus === SyncStatus.SYNCING) {
      source.lastSyncStatus = SyncStatus.IDLE;
      source.lastSyncError = null;
      await this.sourceRepo.save(source);
      logger.info('知识源同步状态已重置', { module: 'KnowledgeSourceService', sourceId });
    }
  }

  async acknowledgeContentUpdate(sourceId: number): Promise<void> {
    const source = await this.findOne(sourceId);
    source.hasContentUpdate = false;
    await this.sourceRepo.save(source);
    logger.info('知识源内容更新已确认', { module: 'KnowledgeSourceService', sourceId });
  }

  async batchSync(sourceIds: number[]): Promise<Array<{ sourceId: number; success: boolean; message: string }>> {
    const results: Array<{ sourceId: number; success: boolean; message: string }> = [];

    for (const id of sourceIds) {
      try {
        const log = await this.syncSource(id);
        results.push({ sourceId: id, success: log.status === SyncLogStatus.SUCCESS, message: log.status === SyncLogStatus.SUCCESS ? '同步成功' : (log.errorMessage || '同步失败') });
      } catch (error: any) {
        results.push({ sourceId: id, success: false, message: error.message });
      }
    }

    return results;
  }
}
