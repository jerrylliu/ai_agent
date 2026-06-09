// ==================== 聊天控制器 ====================
// 负责处理所有与对话、会话、消息相关的 HTTP 请求
// 路由前缀：/chat

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Get, Post, Put, Delete, Patch, Body, Query, Param, Res, UseGuards, Req } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from '../app.service';
import { SessionService } from '../services/session.service';
import { UsageService } from '../services/usage.service';
import { EvaluationService } from '../services/evaluation.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { logger } from '../fundamentals/logger';

// @Controller('chat') 声明该类为 NestJS 控制器，路由前缀为 /chat
// 即该控制器下所有路由都以 /chat 开头
@Controller('chat')
@UseGuards(OptionalAuthGuard) // 所有接口使用可选认证，登录用户使用真实 userId
export class ChatController {
  // 构造函数注入各领域 Service
  constructor(
    private readonly appService: AppService,
    private readonly sessionService: SessionService,
    private readonly usageService: UsageService,
    private readonly evaluationService: EvaluationService,
  ) {}

  // ==================== 对话生成接口 ====================

  /**
   * POST /chat/prompt
   * 流式对话接口：接收用户消息，通过 SSE（Server-Sent Events）流式返回 AI 响应
   * 前端通过 EventSource 或 fetch + ReadableStream 读取流式数据
   */
  @Post('prompt') // 映射 POST 请求到 /chat/prompt
  async prompt(
    // @Body() 从请求体中提取参数
    @Body() body: {
      message?: string; // 用户输入的消息文本
      images?: string[]; // 用户上传的图片 URL 数组（多模态模型支持）
      history?: Array<{ role: string; content: string; images?: string[] }>; // 历史对话上下文
      sessionId?: string; // 当前会话 ID，用于关联对话记录
      memoryEnabled?: boolean; // 记忆功能开关
      summaryEnabled?: boolean; // 摘要功能开关
      injectMemory?: boolean; // 是否注入记忆到上下文
    },
    // @Res() 注入 Express 原生 Response 对象，用于手动控制流式响应
    @Res() res: Response,
    @Req() req: any,
  ) {
    // 设置 SSE 响应头：内容类型为 text/event-stream
    res.setHeader('Content-Type', 'text/event-stream');
    // 禁用缓存，确保前端实时获取流式数据
    res.setHeader('Cache-Control', 'no-cache');
    // 保持长连接，避免代理服务器断开
    res.setHeader('Connection', 'keep-alive');

    // 取消标志：当客户端断开连接时设为 true，通知服务端停止生成
    let cancelled = false;

    // 创建 AbortController，用于中断 LLM 底层到 Ollama/DeepSeek 的 HTTP 连接
    const llmAbortController = new AbortController();

    // 监听连接关闭事件（客户端主动断开或网络中断）
    res.on('close', () => {
      cancelled = true; // 标记请求已取消（用于 isCancelled 回调判断）
      llmAbortController.abort(); // 中断 LLM 底层 HTTP 连接，停止 Ollama 推理
      logger.info('客户端断开连接，已发送中断信号到 LLM 底层连接', { module: 'ChatController' });
    });

    // 调用服务层的 prompt 方法，传入取消回调函数、userId、功能开关和 AbortController
    await this.appService.prompt(
      body.message, body.images, body.history, res, body.sessionId, () => cancelled, req.userId,
      body.memoryEnabled, body.summaryEnabled, body.injectMemory, llmAbortController,
    );
  }

  // ==================== RAG 检索增强接口 ====================

  /**
   * GET /chat/rag?message=xxx
   * RAG（检索增强生成）接口：根据用户消息检索知识库，返回相关上下文
   */
  @Get('rag') // 映射 GET 请求到 /chat/rag
  rag(@Query() { message }: { message?: string }) {
    return this.appService.rag(message); // 委托给服务层处理 RAG 检索
  }

  // ==================== 聊天记录接口 ====================

  /**
   * POST /chat/history
   * 保存一条聊天记录（用户消息或 AI 回复）
   */
  @Post('history') // 映射 POST 请求到 /chat/history
  async saveChatHistory(
    @Body() body: { sessionId: string; role: string; content: string },
    @Req() req: any,
  ) {
    return this.sessionService.saveChatHistory(body.sessionId, body.role, body.content, req.userId);
  }

  /**
   * GET /chat/history?sessionId=xxx
   * 获取指定会话的聊天历史记录
   */
  @Get('history') // 映射 GET 请求到 /chat/history
  async getSessionHistory(@Query('sessionId') sessionId: string) {
    return this.sessionService.getSessionHistory(sessionId);
  }

  /**
   * GET /chat/all-history
   * 获取所有聊天记录（用于调试和管理）
   */
  @Get('all-history') // 映射 GET 请求到 /chat/all-history
  async getAllChatHistory() {
    return this.sessionService.getAllChatHistory();
  }

  // ==================== 会话管理接口 ====================

  /**
   * GET /chat/sessions
   * 获取所有会话列表，按置顶和更新时间排序
   */
  @Get('sessions') // 映射 GET 请求到 /chat/sessions
  async getSessions(@Req() req: any) {
    return this.sessionService.getSessions(req.userId);
  }

  /**
   * POST /chat/sessions
   * 创建新会话
   */
  @Post('sessions') // 映射 POST 请求到 /chat/sessions
  async createSession(
    @Body() body: { sessionId: string; title: string },
    @Req() req: any,
  ) {
    return this.sessionService.createSession(body.sessionId, body.title, req.userId);
  }

  /**
   * GET /chat/sessions/:sessionId/export?format=json|markdown|text
   * 导出会话
   */
  @Get('sessions/:sessionId/export')
  async exportSession(
    @Param('sessionId') sessionId: string,
    @Query('format') format: string = 'json',
  ) {
    return this.sessionService.exportSession(sessionId, format);
  }

  /**
   * GET /chat/sessions/:sessionId/messages
   * 获取指定会话下的所有消息记录
   */
  @Get('sessions/:sessionId/messages') // 映射 GET 请求到 /chat/sessions/:sessionId/messages
  async getSessionMessages(@Param('sessionId') sessionId: string) {
    return this.sessionService.getSessionHistory(sessionId);
  }

  /**
   * GET /chat/sessions/:sessionId
   * 获取指定会话的详细信息
   */
  @Get('sessions/:sessionId') // 映射 GET 请求到 /chat/sessions/:sessionId
  async getSessionBySessionId(@Param('sessionId') sessionId: string) {
    return this.sessionService.getSessionBySessionId(sessionId);
  }

  /**
   * PUT /chat/sessions/:sessionId
   * 更新会话标题
   */
  @Put('sessions/:sessionId') // 映射 PUT 请求到 /chat/sessions/:sessionId
  async updateSessionTitle(
    @Param('sessionId') sessionId: string,
    @Body() body: { title: string },
    @Req() req: any,
  ) {
    return this.sessionService.updateSessionTitle(sessionId, body.title, req.userId);
  }

  /**
   * DELETE /chat/sessions/:sessionId
   * 删除指定会话及其所有聊天记录
   */
  @Delete('sessions/:sessionId') // 映射 DELETE 请求到 /chat/sessions/:sessionId
  async deleteSession(@Param('sessionId') sessionId: string, @Req() req: any) {
    return this.sessionService.deleteSession(sessionId, req.userId);
  }

  /**
   * PATCH /chat/sessions/:sessionId/pin
   * 切换会话的置顶状态
   */
  @Patch('sessions/:sessionId/pin') // 映射 PATCH 请求到 /chat/sessions/:sessionId/pin
  async toggleSessionPin(@Param('sessionId') sessionId: string, @Req() req: any) {
    return this.sessionService.toggleSessionPin(sessionId, req.userId);
  }

  /**
   * POST /chat/sessions/:sessionId/duplicate
   * 复制会话
   */
  @Post('sessions/:sessionId/duplicate')
  async duplicateSession(@Param('sessionId') sessionId: string, @Req() req: any) {
    return this.sessionService.duplicateSession(sessionId, req.userId);
  }

  // ==================== 消息管理接口 ====================

  /**
   * PUT /chat/messages/:id
   * 更新指定消息的内容
   */
  @Put('messages/:id') // 映射 PUT 请求到 /chat/messages/:id
  async updateMessage(
    @Param('id') id: string,
    @Body() body: { content: string },
  ) {
    return this.sessionService.updateMessage(id, body.content);
  }

  /**
   * DELETE /chat/messages/:id
   * 删除指定消息
   */
  @Delete('messages/:id') // 映射 DELETE 请求到 /chat/messages/:id
  async deleteMessage(@Param('id') id: string) {
    return this.sessionService.deleteMessage(id);
  }

  // ==================== LLM 用量统计接口 ====================

  /**
   * GET /chat/llm-usage?days=7
   * 获取 LLM 调用用量统计
   */
  @Get('llm-usage')
  async getLlmUsageStats(
    @Query('days') days: string = '7',
    @Req() req: any,
  ) {
    const daysNum = parseInt(days, 10) || 7;
    return this.usageService.getLlmUsageStats(req.userId, daysNum);
  }

  // ==================== 准确率评估接口 ====================

  /**
   * POST /chat/feedback
   * 提交消息反馈（点赞/点踩）
   */
  @Post('feedback')
  async submitFeedback(
    @Body() body: {
      sessionId: string;
      userMessage: string;
      assistantMessage: string;
      rating: 'positive' | 'negative';
      comment?: string;
      modelId?: string;
      usedKnowledgeBase?: boolean;
    },
    @Req() req: any,
  ) {
    return this.evaluationService.submitFeedback({
      userId: req.userId,
      ...body,
    });
  }

  /**
   * GET /chat/evaluation-stats?days=7
   * 获取准确率评估统计
   */
  @Get('evaluation-stats')
  async getEvaluationStats(
    @Query('days') days: string = '7',
    @Req() req: any,
  ) {
    const daysNum = parseInt(days, 10) || 7;
    return this.evaluationService.getEvaluationStats(req.userId, daysNum);
  }
}
