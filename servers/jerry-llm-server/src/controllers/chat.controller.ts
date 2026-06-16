// ==================== 聊天控制器 ====================
// 负责处理所有与对话、会话、消息相关的 HTTP 请求
// 路由前缀：/chat

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Get, Head, Post, Put, Delete, Patch, Body, Query, Param, Res, UseGuards, Req } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from '../app.service';
import { SessionService } from '../services/session.service';
import { UsageService } from '../services/usage.service';
import { EvaluationService } from '../services/evaluation.service';
import { ToolUsageService } from '../services/tool-usage.service';
import { GeneratedDocumentService } from '../services/generated-document.service.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import { handleConfirmationResponse } from '../fundamentals/human-in-the-loop.js';
import { logger } from '../fundamentals/logger';
import { acquireLock } from '../fundamentals/distributed-lock';
import { isRedisReady } from '../fundamentals/redis-client';

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
    private readonly toolUsageService: ToolUsageService,
    private readonly generatedDocumentService: GeneratedDocumentService,
  ) {}

  // ==================== 对话生成接口 ====================

  /**
   * POST /chat/prompt
   * 流式对话接口：接收用户消息，通过 SSE（Server-Sent Events）流式返回 AI 响应
   * 前端通过 EventSource 或 fetch + ReadableStream 读取流式数据
   */
  @Post('prompt') // 映射 POST 请求到 /chat/prompt
  // 在 OptionalAuthGuard 之后追加 RateLimitGuard：先认证拿到 userId，再按用户限流
  // 此处单独覆盖类级 @UseGuards，因为类级只声明了 OptionalAuthGuard
  @UseGuards(OptionalAuthGuard, RateLimitGuard)
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
      imageModel?: string; // 图片生成模型偏好
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

    // ====== 会话级分布式锁：同一 sessionId 不能并发执行多个 LLM 请求 ======
    // 场景：用户连点 send / 前端 retry 逻辑导致重复请求 → 第二次请求应被拒绝
    // 锁 TTL 5 分钟：覆盖最长流式响应时间（含工具调用 + 重试）；若业务超过 5 分钟，
    // 锁会自动过期，由后续请求接管（不会无限阻塞）
    // sessionId 为空时跳过锁（如匿名一次性请求），保持兼容
    const lockNamespace = body.sessionId ? `chat:session:${body.sessionId}` : null;
    const sessionLock = lockNamespace ? await acquireLock(lockNamespace, 300) : null;
    // 注意：lockNamespace 非空但 sessionLock 为 null 有两种可能：
    //   ① Redis 不可用（降级，跳过锁，行为同改造前）
    //   ② 锁被占用（真正的并发拦截）
    // 用 isRedisReady 反查区分两种情况，仅在"真并发"时拒绝
    if (lockNamespace && !sessionLock) {
      if (isRedisReady()) {
        // 锁被占：明确拒绝，告知前端
        res.status(409).json({
          success: false,
          message: '该会话正在处理上一条消息，请稍候再试',
        });
        return;
      }
      // Redis 不可用：降级放行，单实例下不影响
      logger.debug('SessionLock: Redis 不可用，降级放行', { module: 'ChatController' });
    }

    try {
      // 调用服务层的 prompt 方法，传入取消回调函数、userId、功能开关和 AbortController
      await this.appService.prompt(
        body.message, body.images, body.history, res, body.sessionId, () => cancelled, req.userId,
        body.memoryEnabled, body.summaryEnabled, body.injectMemory, llmAbortController, body.imageModel,
      );
    } finally {
      // 必须在 finally 释放：业务异常 / 客户端断开 / 正常完成都要释放锁
      if (sessionLock) {
        await sessionLock.release();
      }
    }
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

  // ==================== 生成文档下载/预览接口 ====================

  /**
   * GET /chat/documents/download/:key
   * 下载 generate_document 工具生成的文件（带 Content-Disposition: attachment）
   * 鉴权：登录用户只能下载自己 userId 的文档；'default' 用户共享 'default' 文档
   */
  @Get('documents/download/:key')
  async downloadGeneratedDocument(
    @Param('key') key: string,
    @Res() res: Response,
    @Req() req: any,
  ) {
    await this.serveGeneratedDocument(key, req.userId, res, 'attachment');
  }

  /**
   * GET /chat/documents/preview/:key
   * 内联预览（用于浏览器内嵌 iframe / 调用系统应用）
   */
  @Get('documents/preview/:key')
  async previewGeneratedDocument(
    @Param('key') key: string,
    @Res() res: Response,
    @Req() req: any,
  ) {
    await this.serveGeneratedDocument(key, req.userId, res, 'inline');
  }

  /**
   * GET /chat/documents/favorites
   * 获取当前用户所有收藏的文档清单（跨会话），用于"我的收藏"面板
   */
  @Get('documents/favorites')
  async listFavoriteDocuments(@Req() req: any) {
    const userId = req.userId || 'default';
    const docs = await this.generatedDocumentService.listFavorites(userId);
    return {
      success: true,
      data: docs.map((doc) => ({
        key: doc.key,
        filename: doc.filename,
        format: doc.format,
        sizeBytes: Number(doc.sizeBytes),
        downloadUrl: `/chat/documents/download/${doc.key}`,
        previewUrl: `/chat/documents/preview/${doc.key}`,
        expiresAt: doc.expiresAt.getTime(),
        favorited: doc.favorited,
      })),
    };
  }

  /**
   * HEAD /chat/documents/preview/:key
   * HEAD /chat/documents/download/:key
   * 轻量探测：前端在打开预览/触发下载前调用，确认文档可用，避免跳到外部浏览器才看到错误
   * 不返回文件内容，只返回 200/404 + 必要 headers
   */
  @Head('documents/preview/:key')
  @Head('documents/download/:key')
  async headGeneratedDocument(
    @Param('key') key: string,
    @Res() res: Response,
  ) {
    const entity = await this.generatedDocumentService.findByKey(key);
    if (!entity) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', entity.mimeType);
    res.setHeader('Content-Length', String(entity.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).end();
  }

  /**
   * DELETE /chat/documents/:key
   * 用户主动删除文档（含磁盘文件 + DB 元数据）
   */
  @Delete('documents/:key')
  async deleteGeneratedDocument(
    @Param('key') key: string,
    @Req() req: any,
  ) {
    const ok = await this.generatedDocumentService.deleteByKey(key, req.userId || null);
    if (!ok) {
      return { success: false, message: '文档不存在或无权删除' };
    }
    return { success: true };
  }

  /**
   * PATCH /chat/documents/:key/favorite
   * 切换收藏状态：body { favorited: true/false }
   * 收藏文档不参与自动清理，直到取消收藏或主动删除
   */
  @Patch('documents/:key/favorite')
  async toggleDocumentFavorite(
    @Param('key') key: string,
    @Body() body: { favorited: boolean },
    @Req() req: any,
  ) {
    const entity = await this.generatedDocumentService.setFavorite(
      key,
      req.userId || null,
      !!body.favorited,
    );
    if (!entity) {
      return { success: false, message: '文档不存在或无权修改' };
    }
    return { success: true, favorited: entity.favorited };
  }

  /**
   * 公共流式响应实现
   *
   * 鉴权策略：基于 capability URL 模式 —— key 是 80bit 熵的随机值，本身即作为访问凭证，
   * 与图片/思维导图等已有产物的访问模式保持一致。这样浏览器原生 <a download> 链接
   * 不再需要附带 Authorization header（原生 <a> 也无法附带），下载/预览始终可用。
   *
   * 鉴权失败/不存在时返回美观的 HTML 错误页（含返回按钮），而不是裸 JSON。
   */
  private async serveGeneratedDocument(
    key: string,
    userId: string,
    res: Response,
    disposition: 'attachment' | 'inline',
  ) {
    // 传 null 跳过 userId 校验：依靠 key 不可猜测保护
    const result = await this.generatedDocumentService.read(key, null);
    if (!result) {
      // 内容协商：API 调用方（前端 fetch 显式带 Accept: application/json）返回 JSON；
      // 浏览器导航返回美观 HTML 错误页
      const accept = String(res.req.headers['accept'] || '');
      if (accept.includes('application/json')) {
        res.status(404).json({
          success: false,
          message: '文档不存在或已过期',
          detail: '该文件的生成时间已超过保存期限，或被系统清理。请回到对话中要求 AI 重新生成。',
        });
      } else {
        this.sendDocumentErrorPage(
          res,
          404,
          '文档不存在或已过期',
          '该文件的生成时间已超过保存期限，或被系统清理。请回到对话中要求 AI 重新生成。',
        );
      }
      logger.warn('文档访问失败', { module: 'ChatController', key, disposition, userId });
      return;
    }
    const { entity, buffer } = result;
    // RFC 5987：filename* 用 UTF-8 编码兼容中文文件名
    const encodedName = encodeURIComponent(entity.filename);
    res.setHeader('Content-Type', entity.mimeType);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
    logger.info('文档已发送', {
      module: 'ChatController',
      key,
      disposition,
      userId,
      sizeBytes: buffer.length,
    });
  }

  /** 发送美观的 HTML 错误页（含返回按钮） */
  private sendDocumentErrorPage(res: Response, status: number, title: string, detail: string) {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: linear-gradient(135deg, #1f111e 0%, #2a1a2e 100%); color: #e8e0f0; padding: 20px; }
    .card { max-width: 480px; width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(95,246,255,0.25);
      border-radius: 16px; padding: 40px 32px; text-align: center; box-shadow: 0 20px 48px rgba(0,0,0,0.4); }
    .icon { width: 64px; height: 64px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;
      background: rgba(255,82,71,0.15); border-radius: 50%; }
    .icon svg { width: 32px; height: 32px; color: #ff5247; }
    h1 { margin: 0 0 12px; font-size: 22px; color: #ff5247; }
    p { margin: 0 0 28px; line-height: 1.7; color: #c8b8d8; font-size: 14px; }
    .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 20px; border-radius: 8px;
      font-size: 14px; font-weight: 500; text-decoration: none; cursor: pointer; border: none;
      transition: transform 0.15s, box-shadow 0.15s; }
    .btn-primary { background: #5ff6ff; color: #000; box-shadow: 0 4px 12px rgba(95,246,255,0.4); }
    .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(95,246,255,0.55); }
    .btn-ghost { background: transparent; color: #e8e0f0; border: 1px solid rgba(232,224,240,0.3); }
    .btn-ghost:hover { background: rgba(232,224,240,0.08); }
    .code { margin-top: 24px; font-size: 12px; color: #8a7a9a; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    </div>
    <h1>${title}</h1>
    <p>${detail}</p>
    <div class="actions">
      <button class="btn btn-primary" onclick="if(history.length>1){history.back()}else{window.close()}">← 返回</button>
      <button class="btn btn-ghost" onclick="window.close()">关闭页面</button>
    </div>
    <div class="code">错误代码：${status}</div>
  </div>
</body>
</html>`;
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(html);
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

  // ==================== 工具使用统计接口 ====================

  /**
   * GET /chat/tool-usage?days=7
   * 获取工具调用使用统计
   */
  @Get('tool-usage')
  async getToolUsageStats(
    @Query('days') days: string = '7',
    @Req() req: any,
  ) {
    const daysNum = parseInt(days, 10) || 7;
    return this.toolUsageService.getToolUsageStats(req.userId, daysNum);
  }

  // ==================== 人工确认接口 ====================

  /**
   * POST /chat/confirm
   * 用户对工具调用的确认/拒绝响应
   */
  @Post('confirm')
  async handleConfirmation(
    @Body() body: { confirmationId: string; confirmed: boolean },
  ) {
    const success = handleConfirmationResponse(body.confirmationId, body.confirmed);
    return { success, confirmationId: body.confirmationId };
  }

  // ==================== 会话标签/分类管理接口 ====================

  /**
   * PUT /chat/sessions/:sessionId/tags
   * 更新会话标签
   */
  @Put('sessions/:sessionId/tags')
  async updateSessionTags(
    @Param('sessionId') sessionId: string,
    @Body() body: { tags: string[] },
    @Req() req: any,
  ) {
    return this.sessionService.updateSessionTags(sessionId, body.tags, req.userId);
  }

  /**
   * PUT /chat/sessions/:sessionId/category
   * 更新会话分类
   */
  @Put('sessions/:sessionId/category')
  async updateSessionCategory(
    @Param('sessionId') sessionId: string,
    @Body() body: { category: string },
    @Req() req: any,
  ) {
    return this.sessionService.updateSessionCategory(sessionId, body.category, req.userId);
  }

  /**
   * GET /chat/sessions/by-tag/:tag
   * 按标签查询会话
   */
  @Get('sessions/by-tag/:tag')
  async getSessionsByTag(
    @Param('tag') tag: string,
    @Req() req: any,
  ) {
    return this.sessionService.getSessionsByTag(tag, req.userId);
  }

  /**
   * GET /chat/sessions/by-category/:category
   * 按分类查询会话
   */
  @Get('sessions/by-category/:category')
  async getSessionsByCategory(
    @Param('category') category: string,
    @Req() req: any,
  ) {
    return this.sessionService.getSessionsByCategory(category, req.userId);
  }

  /**
   * GET /chat/tags
   * 获取用户所有标签
   */
  @Get('tags')
  async getAllTags(@Req() req: any) {
    return this.sessionService.getAllTags(req.userId);
  }
}
