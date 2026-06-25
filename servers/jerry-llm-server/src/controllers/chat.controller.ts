// ==================== 聊天控制器 ====================
// 负责处理所有与对话、会话、消息相关的 HTTP 请求
// 路由前缀：/chat

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Get, Head, Post, Put, Delete, Patch, Body, Query, Param, Res, UseGuards, Req } from '@nestjs/common';
import type { Response } from 'express';
import * as crypto from 'crypto';
import { AppService } from '../app.service';
import { SessionService } from '../services/session.service';
import { UsageService } from '../services/usage.service';
import { EvaluationService } from '../services/evaluation.service';
import { ToolUsageService } from '../services/tool-usage.service';
import { GeneratedDocumentService } from '../services/generated-document.service.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { subscribeChatHistoryEvents } from '../fundamentals/chat-event-bus.js';
import {
  extractRichAssets,
  syncRichAssetsToFeishu,
  type AssetDocument,
} from '../fundamentals/feishu/feishu-asset-sync.js';
import { handleConfirmationResponse } from '../fundamentals/human-in-the-loop.js';
import { logger } from '../fundamentals/logger';
import { acquireLock } from '../fundamentals/distributed-lock';
import { isRedisReady } from '../fundamentals/redis-client';
import { inspectPromptInjection, logPromptInjectionDetection } from '../fundamentals/prompt-injection-guard.js';
import {
  deleteFeishuChatSessionBySessionId,
  findFeishuChatSessionBySessionId,
} from '../fundamentals/feishu/feishu-chat-session.js';
import {
  sendImageMessage,
  sendPlainTextMessage,
  uploadImage,
} from '../fundamentals/feishu-notify.service.js';
import { splitMarkdownImages } from '../fundamentals/feishu/feishu-markdown-image.js';

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
    private readonly authService: AuthService,
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
    // 在设置 SSE 响应头之前先做 Prompt 注入检测，
    // 高风险请求直接返回 JSON 拒绝包，避免响应头被预设为 text/event-stream
    // 导致前端按 SSE 协议解析 JSON 体
    const injectionDetection = inspectPromptInjection(body.message);
    logPromptInjectionDetection(injectionDetection, { userId: req.userId, sessionId: body.sessionId });
    if (injectionDetection.level === 'blocked') {
      res.status(400).json({
        success: false,
        message: '检测到高风险 Prompt 注入请求，已拒绝处理。请去除要求忽略系统规则、泄露隐藏提示或绕过安全限制的内容后重试。',
      });
      return;
    }

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

  // ==================== 实时事件接口 ====================

  /**
   * GET /chat/events?token=xxx
   * SSE 长连接：实时推送该用户的 chat_history 写入信号。
   *
   * 用于双端实时同步：飞书入站回复、Web→飞书回流等任意来源写库后，
   * Web 端无需 5 秒轮询即可立刻感知并刷新（轮询保留为断线兜底）。
   *
   * 鉴权：EventSource 无法自定义请求头，token 通过 query 传入，
   * 与 WebSocket 网关同一套 verifyToken；无 token 视为 default 用户。
   * 事件体只含信号（sessionId/role/source），不含正文，前端收到后走既有接口拉取。
   */
  @Get('events')
  async chatEvents(
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ) {
    // 解析 owner：与 OptionalAuthGuard 同义，未登录归 default
    let ownerUserId = 'default';
    if (token) {
      const decoded = this.authService.verifyToken(token);
      if (decoded) {
        ownerUserId = String(decoded.sub);
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 关闭 Nginx 缓冲，保证实时
    res.flushHeaders?.();

    // 连接建立提示帧，让前端 onopen 后立即确认通道可用
    res.write(`event: ready\ndata: ${JSON.stringify({ ownerUserId, at: Date.now() })}\n\n`);

    const unsubscribe = subscribeChatHistoryEvents(ownerUserId, (event) => {
      if (res.writableEnded) return;
      res.write(`event: chat_history\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // 心跳：每 25s 发一次注释帧，防止中间代理因空闲断开
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(`event: heartbeat\ndata: {}\n\n`);
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  // ==================== 聊天记录接口 ====================

  /**
   * POST /chat/history
   * 保存一条聊天记录（用户消息或 AI 回复）
   * 用户消息可携带 documentCards（文档卡片元信息数组）
   */
  @Post('history') // 映射 POST 请求到 /chat/history
  async saveChatHistory(
    @Body() body: { sessionId: string; role: string; content: string; documentCards?: unknown[] },
    @Req() req: any,
  ) {
    const saved = await this.sessionService.saveChatHistory(
      body.sessionId,
      body.role,
      body.content,
      req.userId,
      body.documentCards,
    );

    void this.syncWebMessageToFeishu(body.sessionId, body.role, body.content, req.userId).catch((error) => {
      logger.warn('Web 消息同步到飞书失败', {
        module: 'ChatController',
        sessionId: body.sessionId,
        role: body.role,
        error: error?.message || String(error),
      });
    });

    return saved;
  }

  /**
   * Web 端在飞书映射会话里继续对话时，把消息同步回飞书。
   * 只处理 /chat/history 入口，飞书入站链路不经过这里，避免形成重复发送循环。
   */
  private async syncWebMessageToFeishu(
    sessionId: string,
    role: string,
    content: string,
    userId: string,
  ): Promise<void> {
    if (!content.trim() || (role !== 'user' && role !== 'assistant')) return;

    const mapping = await findFeishuChatSessionBySessionId(sessionId);
    // ownerUserId 在飞书映射表里是字符串，登录态 req.userId 可能是数字，统一转字符串比较
    if (!mapping || String(mapping.ownerUserId) !== String(userId)) return;

    const receiveId = mapping.chatType === 'group' ? mapping.chatId : mapping.senderOpenId;
    const receiveIdType = mapping.chatType === 'group' ? 'chat_id' : 'open_id';

    // 幂等基线：同一条 (session, role, 内容) 在 5 分钟窗口内生成同一个 uuid，
    // 飞书侧会拒绝相同 uuid 的重复请求 —— 为后续接入失败重试做准备，避免重试发重复消息。
    const baseUuid = this.buildFeishuSyncUuid(sessionId, role, content);

    if (role === 'user') {
      const result = await sendPlainTextMessage(
        receiveId,
        receiveIdType,
        `来自 Web 端的消息：\n${content}`,
        baseUuid,
      );
      if (!result.success) {
        throw new Error(result.error || '飞书发送失败');
      }
      return;
    }

    // 先剥离图表/思维导图代码块（否则飞书会显示成一大段代码），再剥离 Markdown 图片
    const { text: richStripped, charts, mindmaps } = extractRichAssets(content);
    const { text, imageUrls } = splitMarkdownImages(richStripped);
    const hasRichAssets = charts.length > 0 || mindmaps.length > 0;
    const textToSend =
      text.trim() || (imageUrls.length > 0 || hasRichAssets ? 'AI 生成了内容：' : '');
    if (textToSend) {
      const textResult = await sendPlainTextMessage(receiveId, receiveIdType, textToSend, `${baseUuid}t`);
      if (!textResult.success) {
        throw new Error(textResult.error || '飞书发送失败');
      }
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      // 每张图片用 baseUuid + 序号派生独立 uuid，保证多图各自幂等且互不冲突
      const imageUuid = `${baseUuid}i${i}`;
      logger.info('Web 图片同步飞书：开始上传', {
        module: 'ChatController',
        sessionId,
        chatType: mapping.chatType,
        receiveIdType,
        imageUrl,
      });
      const uploadResult = await uploadImage(imageUrl);
      if (uploadResult.success && uploadResult.key) {
        logger.info('Web 图片同步飞书：上传成功', {
          module: 'ChatController',
          sessionId,
          chatType: mapping.chatType,
          receiveIdType,
          imageKey: uploadResult.key,
        });
        const imageResult = await sendImageMessage(receiveId, receiveIdType, uploadResult.key, imageUuid);
        if (imageResult.success) {
          logger.info('Web 图片同步飞书：图片消息发送成功', {
            module: 'ChatController',
            sessionId,
            chatType: mapping.chatType,
            receiveIdType,
            messageId: imageResult.messageId,
          });
          continue;
        }
        logger.warn('Web 图片同步飞书：图片消息发送失败，降级发送链接', {
          module: 'ChatController',
          sessionId,
          chatType: mapping.chatType,
          receiveIdType,
          imageUrl,
          error: imageResult.error,
        });
      } else {
        logger.warn('Web 图片同步飞书：上传失败，降级发送链接', {
          module: 'ChatController',
          sessionId,
          chatType: mapping.chatType,
          receiveIdType,
          imageUrl,
          error: uploadResult.error,
        });
      }

      const fallbackResult = await sendPlainTextMessage(receiveId, receiveIdType, imageUrl, `${imageUuid}f`);
      if (!fallbackResult.success) {
        throw new Error(fallbackResult.error || '飞书图片链接兜底发送失败');
      }
    }

    // 同步图表/思维导图/文档为飞书原生消息（文档从 generated_document 表按会话查询）
    let documents: AssetDocument[] = [];
    try {
      const since = Date.now() - 10 * 60 * 1000; // 只取最近 10 分钟内本会话生成的文档
      const docEntities = await this.generatedDocumentService.listRecentBySession(sessionId, since);
      const loaded = await Promise.all(
        docEntities.map(async (d) => {
          const read = await this.generatedDocumentService.read(d.key, null);
          return read ? { key: d.key, filename: d.filename, buffer: read.buffer } : null;
        }),
      );
      documents = loaded.filter((d): d is AssetDocument => d !== null);
    } catch (e: any) {
      logger.warn('Web 文档同步飞书：查询会话文档失败，跳过文档同步', {
        module: 'ChatController',
        sessionId,
        error: e?.message || String(e),
      });
    }

    if (charts.length > 0 || mindmaps.length > 0 || documents.length > 0) {
      await syncRichAssetsToFeishu({
        receiveId,
        receiveIdType,
        charts,
        mindmaps,
        documents,
        idempotencyBase: baseUuid,
        sessionId,
      });
    }
  }

  /**
   * 生成 Web→飞书同步的幂等 uuid。
   * 同一条 (sessionId, role, content) 在 5 分钟时间窗内得到相同值；
   * 飞书 uuid 仅允许 [0-9a-zA-Z]，最长 50，这里用 md5 hex（32 位）。
   */
  private buildFeishuSyncUuid(sessionId: string, role: string, content: string): string {
    const timeWindow = Math.floor(Date.now() / (5 * 60 * 1000));
    const raw = `web-sync|${sessionId}|${role}|${content}|${timeWindow}`;
    return crypto.createHash('md5').update(raw).digest('hex');
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
    const result = await this.sessionService.deleteSession(sessionId, req.userId);
    await deleteFeishuChatSessionBySessionId(sessionId, req.userId);
    return result;
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
