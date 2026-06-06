// ==================== 记忆与摘要控制器 ====================
// 负责处理用户记忆（长期知识存储）和会话摘要的 CRUD 操作
// 路由前缀：/memory

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Get, Post, Put, Delete, Body, Query, Param, UseGuards, Req } from '@nestjs/common';
// 导入应用服务层，提供业务逻辑
import { AppService } from '../app.service';
// 导入可选认证守卫
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';

// @Controller('memory') 声明该类为 NestJS 控制器，路由前缀为 /memory
// 即该控制器下所有路由都以 /memory 开头
@Controller('memory')
@UseGuards(OptionalAuthGuard) // 所有接口使用可选认证，登录用户使用真实 userId
export class MemoryController {
  // 构造函数注入 AppService，通过依赖注入获取服务实例
  constructor(private readonly appService: AppService) {}

  // ==================== 记忆 CRUD 接口 ====================

  /**
   * GET /memory/memories?userId=default
   * 获取指定用户的所有记忆列表
   * 返回格式：{ success, memories（记忆数组）, count（记忆总数） }
   */
  @Get('memories') // 映射 GET 请求到 /memory/memories
  async getUserMemories(
    @Query('userId') userId?: string,
    @Req() req?: any,
  ) {
    // 优先使用 token 中的 userId，其次使用查询参数，最后使用 'default'
    const effectiveUserId = req?.userId || userId || 'default';
    const memories = await this.appService.getUserMemories(effectiveUserId);
    return { success: true, memories, count: memories.length };
  }

  /**
   * POST /memory/memories
   * 手动添加一条用户记忆
   * 请求体：{ content（记忆内容）, category（分类，可选）, importance（重要性1-5，可选）, userId（用户ID，可选） }
   */
  @Post('memories') // 映射 POST 请求到 /memory/memories
  async addUserMemory(
    @Body() body: { content: string; category?: string; importance?: number; userId?: string },
    @Req() req: any,
  ) {
    if (!body.content) {
      return { success: false, message: '请提供 content 参数' };
    }
    const effectiveUserId = req.userId || body.userId || 'default';
    const memory = await this.appService.addUserMemory(
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
  @Delete('memories') // 映射 DELETE 请求到 /memory/memories
  async clearUserMemories(
    @Query('userId') userId?: string,
    @Req() req?: any,
  ) {
    const effectiveUserId = req?.userId || userId || 'default';
    await this.appService.clearUserMemories(effectiveUserId);
    return { success: true, message: '所有记忆已清空' };
  }

  /**
   * PUT /memory/memories/:id
   * 更新指定记忆的内容、分类或重要性
   */
  @Put('memories/:id') // 映射 PUT 请求到 /memory/memories/:id
  async updateUserMemory(
    // @Param('id') 从 URL 路径参数中提取记忆 ID
    @Param('id') id: string,
    // @Body() 从请求体提取更新字段
    @Body() body: { content: string; category?: string; importance?: number },
  ) {
    // 校验必填参数：content 不能为空
    if (!body.content) {
      return { success: false, message: '请提供 content 参数' };
    }
    // 调用服务层更新记忆，将 id 从字符串转为数字
    const memory = await this.appService.updateUserMemory(parseInt(id), body.content, body.category, body.importance);
    return { success: true, memory };
  }

  /**
   * DELETE /memory/memories/:id
   * 删除指定的一条记忆
   */
  @Delete('memories/:id') // 映射 DELETE 请求到 /memory/memories/:id
  async deleteUserMemory(
    // @Param('id') 从 URL 路径参数中提取记忆 ID
    @Param('id') id: string,
  ) {
    // 调用服务层删除记忆，将 id 从字符串转为数字
    await this.appService.deleteUserMemory(parseInt(id));
    return { success: true, message: '记忆已删除' };
  }

  /**
   * POST /memory/memories/extract/:sessionId
   * 手动触发记忆提取：从指定会话的对话内容中自动提取关键信息存入记忆库
   */
  @Post('memories/extract/:sessionId')
  async extractMemories(
    @Param('sessionId') sessionId: string,
    @Req() req: any,
  ) {
    await this.appService.checkAndExtractMemories(sessionId, req.userId);
    const memories = await this.appService.getUserMemories(req.userId);
    return { success: true, memories, count: memories.length };
  }

  // ==================== 会话摘要接口 ====================

  /**
   * GET /memory/sessions/:sessionId/summary
   * 获取指定会话的摘要信息
   * 如果摘要不存在，返回空摘要占位对象
   */
  @Get('sessions/:sessionId/summary') // 映射 GET 请求到 /memory/sessions/:sessionId/summary
  async getSessionSummary(
    // @Param('sessionId') 从 URL 路径参数中提取会话 ID
    @Param('sessionId') sessionId: string,
  ) {
    // 调用服务层获取会话摘要
    const summary = await this.appService.getSessionSummary(sessionId);
    // 如果摘要存在则返回，否则返回空摘要占位对象
    return summary || { sessionId, summaryContent: '', coveredMessageCount: 0 };
  }

  /**
   * POST /memory/sessions/:sessionId/summary
   * 手动触发生成或更新指定会话的摘要
   * 摘要由 AI 根据对话内容自动生成，概括对话的核心要点
   */
  @Post('sessions/:sessionId/summary') // 映射 POST 请求到 /memory/sessions/:sessionId/summary
  async generateSessionSummary(
    // @Param('sessionId') 从 URL 路径参数中提取会话 ID
    @Param('sessionId') sessionId: string,
  ) {
    try {
      // 调用服务层生成/更新摘要（内部会判断是否需要重新生成）
      await this.appService.checkAndUpdateSummary(sessionId);
      // 生成完成后获取最新摘要
      const summary = await this.appService.getSessionSummary(sessionId);
      if (summary) {
        return summary; // 返回生成的摘要
      }
      // 摘要为空但未抛异常的异常情况
      return { success: false, message: '摘要生成失败 - checkAndUpdateSummary 未抛异常但摘要为空' };
    } catch (error: any) {
      // 捕获异常，返回错误信息（包含错误堆栈便于调试）
      return { success: false, message: `摘要生成异常: ${error.message}`, stack: error.stack };
    }
  }
}
