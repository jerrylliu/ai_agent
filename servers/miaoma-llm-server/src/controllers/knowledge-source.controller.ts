import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { KnowledgeSourceService } from '../services/knowledge-source.service.js';
import { SourceType } from '../entities/knowledge-source.entity.js';
import { logger } from '../fundamentals/logger';
import { CreateKnowledgeSourceSchema, UpdateKnowledgeSourceSchema, BatchSyncSchema, type CreateKnowledgeSourceInput, type UpdateKnowledgeSourceInput } from './knowledge-source.schema.js';

@Controller('knowledge-sources')
export class KnowledgeSourceController {
  constructor(private readonly sourceService: KnowledgeSourceService) {}

  @Post()
  async create(
    @Body() body: { name: string; type: SourceType; config: Record<string, any>; syncInterval?: number; maxDepth?: number; maxPages?: number; preferMarkdown?: boolean; enableJsRendering?: boolean },
  ) {
    try {
      const validated = CreateKnowledgeSourceSchema.parse(body) as CreateKnowledgeSourceInput & { type: SourceType };
      const source = await this.sourceService.create(validated);
      return { success: true, data: source };
    } catch (error: any) {
      logger.error('创建知识源失败', { module: 'KnowledgeSourceController', error: error.message });
      if (error.name === 'ZodError') {
        const messages = error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return { success: false, message: messages };
      }
      return { success: false, message: error.message };
    }
  }

  @Get()
  async findAll() {
    try {
      const sources = await this.sourceService.findAll();
      return { success: true, data: sources };
    } catch (error: any) {
      logger.error('获取知识源列表失败', { module: 'KnowledgeSourceController', error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Get('stats')
  async getStats() {
    try {
      const stats = await this.sourceService.getStats();
      return { success: true, data: stats };
    } catch (error: any) {
      logger.error('获取知识源统计失败', { module: 'KnowledgeSourceController', error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Get('types')
  async getTypes() {
    return {
      success: true,
      data: Object.values(SourceType).map(t => ({
        value: t,
        label: t === 'web' ? 'Web 网页' : t === 'feishu' ? '飞书' : t,
      })),
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    try {
      const source = await this.sourceService.findOne(Number(id));
      return { success: true, data: source };
    } catch (error: any) {
      logger.error('获取知识源详情失败', { module: 'KnowledgeSourceController', id, error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Get(':id/page-count')
  async getPageCount(@Param('id') id: string) {
    try {
      const count = await this.sourceService.getPageCount(Number(id));
      return { success: true, data: { count } };
    } catch (error: any) {
      logger.error('获取页面数量失败', { module: 'KnowledgeSourceController', id, error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: Partial<{ name: string; config: Record<string, any>; syncInterval: number; maxDepth: number; maxPages: number; preferMarkdown: boolean; enableJsRendering: boolean; enabled: boolean }>,
  ) {
    try {
      const validated = UpdateKnowledgeSourceSchema.parse(body) as UpdateKnowledgeSourceInput;
      const source = await this.sourceService.update(Number(id), validated);
      return { success: true, data: source };
    } catch (error: any) {
      logger.error('更新知识源失败', { module: 'KnowledgeSourceController', id, error: error.message });
      if (error.name === 'ZodError') {
        const messages = error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return { success: false, message: messages };
      }
      return { success: false, message: error.message };
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    try {
      await this.sourceService.remove(Number(id));
      return { success: true, message: '知识源已删除' };
    } catch (error: any) {
      logger.error('删除知识源失败', { module: 'KnowledgeSourceController', id, error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Post(':id/sync')
  async syncSource(@Param('id') id: string) {
    try {
      const syncLog = await this.sourceService.syncSource(Number(id));
      return { success: true, data: syncLog };
    } catch (error: any) {
      logger.error('手动同步知识源失败', { module: 'KnowledgeSourceController', id, error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Post(':id/reset-status')
  async resetSyncStatus(@Param('id') id: string) {
    try {
      await this.sourceService.resetSyncStatus(Number(id));
      return { success: true, message: '同步状态已重置' };
    } catch (error: any) {
      logger.error('重置同步状态失败', { module: 'KnowledgeSourceController', id, error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Post(':id/acknowledge-update')
  async acknowledgeUpdate(@Param('id') id: string) {
    try {
      await this.sourceService.acknowledgeContentUpdate(Number(id));
      return { success: true, message: '更新已确认' };
    } catch (error: any) {
      logger.error('确认更新失败', { module: 'KnowledgeSourceController', id, error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Get(':id/logs')
  async getSyncLogs(@Param('id') id: string, @Query('limit') limit?: string) {
    try {
      const logs = await this.sourceService.getSyncLogs(Number(id), limit ? Number(limit) : 20);
      return { success: true, data: logs };
    } catch (error: any) {
      logger.error('获取同步日志失败', { module: 'KnowledgeSourceController', id, error: error.message });
      return { success: false, message: error.message };
    }
  }

  @Post('batch/sync')
  async batchSync(@Body() body: { sourceIds: number[] }) {
    try {
      const validated = BatchSyncSchema.parse(body);
      const results = await this.sourceService.batchSync(validated.sourceIds);
      return { success: true, data: results };
    } catch (error: any) {
      logger.error('批量同步失败', { module: 'KnowledgeSourceController', error: error.message });
      if (error.name === 'ZodError') {
        const messages = error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return { success: false, message: messages };
      }
      return { success: false, message: error.message };
    }
  }
}
