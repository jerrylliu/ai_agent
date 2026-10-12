// ==================== 记忆与摘要控制器 ====================
// 负责处理用户记忆（长期知识存储）和会话摘要的 CRUD 操作
// 路由前缀：/memory

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Query,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { MemoryService } from '../services/memory.service';
import { SummaryService } from '../services/summary.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';

// @Controller('memory') 声明该类为 NestJS 控制器，路由前缀为 /memory
@Controller('memory')
@UseGuards(OptionalAuthGuard) // 所有接口使用可选认证，登录用户使用真实 userId
export class MemoryController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly summaryService: SummaryService,
  ) {}

  // ==================== 记忆 CRUD 接口 ====================

  /**
   * GET /memory/memories?userId=default
   * 获取指定用户的所有记忆列表
   */
  @Get('memories')
  async getUserMemories(@Query('userId') userId?: string, @Req() req?: any) {
    const effectiveUserId = req?.userId || userId || 'default';
    const memories = await this.memoryService.getUserMemories(effectiveUserId);
    return { success: true, memories, count: memories.length };
  }

  /**
   * POST /memory/memories
   * 手动添加一条用户记忆
   */
  @Post('memories')
  async addUserMemory(
    @Body()
    body: {
      content: string;
      category?: string;
      importance?: number;
      userId?: string;
    },
    @Req() req: any,
  ) {
    if (!body.content) {
      return { success: false, message: '请提供 content 参数' };
    }
    const effectiveUserId = req.userId || body.userId || 'default';
    const memory = await this.memoryService.addUserMemory(
      body.content,
      body.category || 'fact',
      body.importance || 3,
      effectiveUserId,
    );
    return { success: true, memory };
  }

  /**
   * DELETE /memory/memories?userId=default
   * 清空指定用户的所有记忆
   */
  @Delete('memories')
  async clearUserMemories(@Query('userId') userId?: string, @Req() req?: any) {
    const effectiveUserId = req?.userId || userId || 'default';
    await this.memoryService.clearUserMemories(effectiveUserId);
    return { success: true, message: '所有记忆已清空' };
  }

  /**
   * PUT /memory/memories/:id
   * 更新指定记忆的内容、分类或重要性
   */
  @Put('memories/:id')
  async updateUserMemory(
    @Param('id') id: string,
    @Body() body: { content: string; category?: string; importance?: number },
    @Req() req: any,
  ) {
    if (!body.content) {
      return { success: false, message: '请提供 content 参数' };
    }
    try {
      const memory = await this.memoryService.updateUserMemory(
        parseInt(id),
        req?.userId || 'default',
        body.content,
        body.category,
        body.importance,
      );
      return { success: true, memory };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  /**
   * DELETE /memory/memories/:id
   * 删除指定的一条记忆（校验归属，防止跨用户删除）
   */
  @Delete('memories/:id')
  async deleteUserMemory(@Param('id') id: string, @Req() req: any) {
    try {
      await this.memoryService.deleteUserMemory(
        parseInt(id),
        req?.userId || 'default',
      );
      return { success: true, message: '记忆已删除' };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  /**
   * POST /memory/memories/extract/:sessionId
   * 手动触发记忆提取
   */
  @Post('memories/extract/:sessionId')
  async extractMemories(
    @Param('sessionId') sessionId: string,
    @Req() req: any,
  ) {
    await this.memoryService.checkAndExtractMemories(sessionId, req.userId);
    const memories = await this.memoryService.getUserMemories(req.userId);
    return { success: true, memories, count: memories.length };
  }

  /**
   * POST /memory/memories/rebuild-vectors
   * 全量重建当前用户的记忆向量（手动对账 / 存量迁移 / 假空自愈三合一）
   *
   * 对应前端记忆模块的"全部同步"按钮；单个补传复用 updateUserMemory 的
   * 写穿分档（或直接调 syncMemoryVector），此处只做全量动作
   */
  @Post('memories/rebuild-vectors')
  async rebuildMemoryVectors(@Req() req: any) {
    const effectiveUserId = req?.userId || 'default';
    try {
      const written = await this.memoryService.rebuildVectorsForUser(
        effectiveUserId,
      );
      return { success: true, syncedCount: written };
    } catch (error: any) {
      return {
        success: false,
        message: `向量重建失败: ${error.message}`,
      };
    }
  }

  /**
   * POST /memory/memories/:id/sync-vector
   * 单条补传：把指定记忆同步到向量库（对应"待同步"条目的补传按钮）
   *
   * 复用 updateUserMemory 写穿逻辑（内容不变 → 仅属性分档不会 re-embed，
   * 这里需要强制全量同步，直接走 syncVectorAfterWrite 全量路径）
   */
  @Post('memories/:id/sync-vector')
  async syncMemoryVector(@Param('id') id: string, @Req() req: any) {
    const memoryId = parseInt(id);
    try {
      await this.memoryService.syncSingleMemoryVector(
        memoryId,
        req?.userId || 'default',
      );
      return { success: true };
    } catch (error: any) {
      return { success: false, message: `同步失败: ${error.message}` };
    }
  }

  // ==================== 会话摘要接口 ====================

  /**
   * GET /memory/sessions/:sessionId/summary
   * 获取指定会话的摘要信息
   */
  @Get('sessions/:sessionId/summary')
  async getSessionSummary(@Param('sessionId') sessionId: string) {
    const summary = await this.summaryService.getSessionSummary(sessionId);
    return summary || { sessionId, summaryContent: '', coveredMessageCount: 0 };
  }

  /**
   * POST /memory/sessions/:sessionId/summary
   * 手动触发生成或更新指定会话的摘要
   */
  @Post('sessions/:sessionId/summary')
  async generateSessionSummary(@Param('sessionId') sessionId: string) {
    try {
      await this.summaryService.checkAndUpdateSummary(sessionId);
      const summary = await this.summaryService.getSessionSummary(sessionId);
      if (summary) {
        return summary;
      }
      return {
        success: false,
        message: '摘要生成失败 - checkAndUpdateSummary 未抛异常但摘要为空',
      };
    } catch (error: any) {
      return {
        success: false,
        message: `摘要生成异常: ${error.message}`,
        stack: error.stack,
      };
    }
  }
}
