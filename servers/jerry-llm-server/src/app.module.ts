import { Module, OnModuleInit } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ChatController } from './controllers/chat.controller.js';
import { MemoryController } from './controllers/memory.controller.js';
import { KnowledgeController } from './controllers/knowledge.controller.js';
import { ModelController } from './controllers/model.controller.js';
import { UploadController } from './controllers/upload.controller.js';
import { DocumentController } from './controllers/document.controller.js';
import { KnowledgeSourceController } from './controllers/knowledge-source.controller.js';
import { RedisDashboardController } from './controllers/redis-dashboard.controller.js';
import { SpeechController } from './controllers/speech.controller.js';
import { AiWritingController } from './controllers/ai-writing.controller.js';
import { FeishuEventController } from './controllers/feishu-event.controller.js';
import { MetricsController } from './controllers/metrics.controller.js';
import { SpeechService } from './services/speech.service.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatHistory } from './entities/chat-history.entity.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';
import { SessionSummary } from './entities/session-summary.entity.js';
import { UserMemory } from './entities/user-memory.entity.js';
import { Document } from './entities/document.entity.js';
import { DocumentVersion } from './entities/document-version.entity.js';
import { DocumentAuditLog } from './entities/document-audit-log.entity.js';
import { PendingVectorOp } from './entities/pending-vector-op.entity.js';
import { KnowledgeSource } from './entities/knowledge-source.entity.js';
import { KnowledgeSourceSyncLog } from './entities/knowledge-source-sync-log.entity.js';
import { KnowledgeSourcePage } from './entities/knowledge-source-page.entity.js';
import { LlmUsage } from './entities/llm-usage.entity.js';
import { MessageFeedback } from './entities/message-feedback.entity.js';
import { AutoEvaluation } from './entities/auto-evaluation.entity.js';
import { SearchFeedback } from './entities/search-feedback.entity.js';
import { ToolUsage } from './entities/tool-usage.entity.js';
import { GeneratedDocument } from './entities/generated-document.entity.js';
import { FeishuChatSession } from './entities/feishu-chat-session.entity.js';
import { ImageDescription } from './entities/image-description.entity.js';
import { DocumentService } from './services/document.service.js';
import { DocumentScanService } from './services/document-scan.service.js';
import { DocumentSchedulerService } from './services/document-scheduler.service.js';
import { ImageRetrySchedulerService } from './services/image-retry-scheduler.service.js';
import { KnowledgeSourceService } from './services/knowledge-source.service.js';
import { KnowledgeSourceSchedulerService } from './services/knowledge-source-scheduler.service.js';
import { SessionService } from './services/session.service.js';
import { SummaryService } from './services/summary.service.js';
import { MemoryService } from './services/memory.service.js';
import { UsageService } from './services/usage.service.js';
import { EvaluationService } from './services/evaluation.service.js';
import { ToolUsageService } from './services/tool-usage.service.js';
import { GeneratedDocumentService } from './services/generated-document.service.js';
import { GeneratedDocumentSchedulerService } from './services/generated-document-scheduler.service.js';
import { HealthService } from './services/health.service.js';
import { AuthModule } from './auth/auth.module.js';
import { WinstonLoggerModule } from './fundamentals/logger.js';
import {
  initManageSession,
  setToolUsageCallback,
  initMcpProxy,
} from './fundamentals/tools/index.js';
import { initDocumentTools } from './fundamentals/tools/document-ops.js';
import { initGenerateDocumentTool } from './fundamentals/tools/generate-document.js';
import { config } from './fundamentals/config.js';
import { logger } from './fundamentals/logger.js';
import { startFeishuWsClient } from './fundamentals/feishu-ws-client.js';
import {
  setFeishuPromptInvoker,
  setFeishuAssistantPersister,
  setFeishuSessionCleaner,
  setFeishuDocumentFetcher,
} from './fundamentals/feishu-event-processor.js';
import { initFeishuChatSessionRepository } from './fundamentals/feishu/feishu-chat-session.js';
@Module({
  imports: [
    WinstonLoggerModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: config.db.host,
      port: config.db.port,
      username: config.db.username,
      password: config.db.password,
      database: config.db.database,
      entities: [
        ChatHistory,
        Session,
        User,
        SessionSummary,
        UserMemory,
        Document,
        DocumentVersion,
        DocumentAuditLog,
        PendingVectorOp,
        KnowledgeSource,
        KnowledgeSourceSyncLog,
        KnowledgeSourcePage,
        LlmUsage,
        MessageFeedback,
        AutoEvaluation,
        SearchFeedback,
        ToolUsage,
        GeneratedDocument,
        FeishuChatSession,
        ImageDescription,
      ],
      // 不在 NestJS 启动时加载 migrations：
      // 1. NestJS 运行在 ESM 模式，TypeORM 同步 require 加载 ESM 迁移文件会崩
      //    （报错：Unexpected module status 0 / MigrationInterface 命名导出缺失）
      // 2. 迁移统一通过 `pnpm migration:run` CLI 走 dist/typeorm-data-source.js 执行
      // 因此这里 migrations 留空，且 migrationsRun 强制为 false
      migrations: [],
      synchronize: config.db.synchronize,
      migrationsRun: false,
    }),
    TypeOrmModule.forFeature([
      ChatHistory,
      Session,
      SessionSummary,
      UserMemory,
      Document,
      DocumentVersion,
      DocumentAuditLog,
      PendingVectorOp,
      KnowledgeSource,
      KnowledgeSourceSyncLog,
      KnowledgeSourcePage,
      LlmUsage,
      MessageFeedback,
      AutoEvaluation,
      SearchFeedback,
      ToolUsage,
      GeneratedDocument,
      FeishuChatSession,
      ImageDescription,
    ]),
    AuthModule,
  ],
  controllers: [
    AppController,
    ChatController,
    MemoryController,
    KnowledgeController,
    ModelController,
    UploadController,
    DocumentController,
    KnowledgeSourceController,
    RedisDashboardController,
    SpeechController,
    AiWritingController,
    FeishuEventController,
    MetricsController,
  ],
  providers: [
    AppService,
    SessionService,
    SummaryService,
    MemoryService,
    UsageService,
    EvaluationService,
    DocumentService,
    // 文档安全扫描服务（入库前注入扫描门禁 + 人工复核）
    DocumentScanService,
    DocumentSchedulerService,
    ImageRetrySchedulerService,
    KnowledgeSourceService,
    KnowledgeSourceSchedulerService,
    ToolUsageService,
    GeneratedDocumentService,
    GeneratedDocumentSchedulerService,
    SpeechService,
    HealthService,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly sessionService: SessionService,
    private readonly toolUsageService: ToolUsageService,
    private readonly documentService: DocumentService,
    private readonly generatedDocumentService: GeneratedDocumentService,
    private readonly appService: AppService,
    @InjectRepository(FeishuChatSession)
    private readonly feishuChatSessionRepository: Repository<FeishuChatSession>,
  ) {}

  onModuleInit() {
    initFeishuChatSessionRepository(this.feishuChatSessionRepository);

    initManageSession(this.sessionService);
    // 注入工具调用指标持久化回调
    setToolUsageCallback((data) => this.toolUsageService.saveToolUsage(data));
    // 注入 DocumentService 到文档操作工具
    initDocumentTools(this.documentService);
    // 注入 GeneratedDocumentService 到 generate_document 工具
    initGenerateDocumentTool({
      save: async (params) => {
        const e = await this.generatedDocumentService.save(params);
        return { key: e.key, expiresAt: e.expiresAt };
      },
      read: async (key, userId) => {
        const r = await this.generatedDocumentService.read(key, userId);
        if (!r) return null;
        return {
          entity: { mimeType: r.entity.mimeType, filename: r.entity.filename },
          buffer: r.buffer,
        };
      },
    });
    // 异步初始化 MCP 客户端（启动 MCP Server 子进程并拉取 tools 列表）
    // 不 await：避免 MCP Server 启动慢拖慢主服务启动；失败也不影响其他工具
    initMcpProxy().catch(() => {
      // 错误已在 initMcpProxy 内部记录日志，这里无需重复处理
    });

    // 启动飞书事件长连接（当 NOTIFY_FEISHU_EVENT_MODE=ws 且 AppId/Secret 已配置时）
    // 长连接模式避免依赖公网回调地址，适合开发期间没有固定域名的场景
    if (config.notify.feishuEventMode === 'ws') {
      startFeishuWsClient({
        appId: config.notify.feishuAppId,
        appSecret: config.notify.feishuAppSecret,
        domain: config.notify.feishuDomain,
      });
    }

    // D1/D2 接线：把 AppService.prompt 注入到飞书消息处理器，
    // 让飞书消息可以走 Web 端同一个 Agent 主链路（避免重复实现）。
    //
    // 注入器内部做三件事（漏洞 1 + 2 修复）：
    //   1. 调用前：加载该 sessionId 的历史消息，喂给 Agent（让多轮对话工作）
    //   2. 调用前：把当前用户消息存进 chat_history（保持与 Web 端数据结构一致）
    //   3. 流式结束后：由 setFeishuAssistantPersister 把 assistant 内容存进 chat_history
    setFeishuPromptInvoker(async ({ message, sessionId, res, isCancelled }) => {
      // 飞书入站聊天默认归到 default 用户，这样未登录 Web 端能直接看到；
      // 如果要在登录态账号里看，请配置 NOTIFY_FEISHU_CHAT_USER_ID=users 表里的 id。
      const chatOwnerUserId = config.notify.feishuChatUserId || 'default';

      // 1) 加载历史（数据库里没有就是空数组，多轮对话第一句开始累积）
      let history:
        | Array<{ role: string; content: string; images?: string[] }>
        | undefined;
      try {
        const records = await this.sessionService.getSessionHistory(sessionId);
        history = records.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        }));
      } catch {
        // 第一次会话 sessionId 在 DB 里不存在 → 返回空，正常
        history = [];
      }

      // 2) 落 user 消息（必须 await：否则用户马上查数据库时可能看不到，失败也会被吞）
      await this.sessionService.saveChatHistory(
        sessionId,
        'user',
        message ?? '',
        chatOwnerUserId,
        undefined,
        'feishu',
      );
      logger.info('飞书聊天：user 消息已落库', {
        module: 'AppModule',
        sessionId,
        userId: chatOwnerUserId,
        contentLength: (message ?? '').length,
      });

      // 3) 调主 Agent
      await this.appService.prompt(
        message,
        undefined, // images
        history,
        res,
        sessionId,
        isCancelled,
        chatOwnerUserId,
      );
    });

    // 注入 assistant 历史持久化器（流式结束后由 processIncomingMessage 调）
    setFeishuAssistantPersister(async ({ sessionId, content }) => {
      const chatOwnerUserId = config.notify.feishuChatUserId || 'default';
      await this.sessionService.saveChatHistory(
        sessionId,
        'assistant',
        content,
        chatOwnerUserId,
        undefined,
        'feishu',
      );
      logger.info('飞书聊天：assistant 消息已落库', {
        module: 'AppModule',
        sessionId,
        userId: chatOwnerUserId,
        contentLength: content.length,
      });
    });

    setFeishuSessionCleaner(async ({ sessionId, userId }) => {
      await this.sessionService.deleteSession(sessionId, userId);
      logger.info('飞书聊天：会话已清空', {
        module: 'AppModule',
        sessionId,
        userId,
      });
    });

    // 注入会话文档查询器：飞书入站回复时把本次新生成的文档同步成飞书原生文件
    setFeishuDocumentFetcher(async ({ sessionId, afterMs }) => {
      const entities = await this.generatedDocumentService.listRecentBySession(
        sessionId,
        afterMs,
      );
      const loaded = await Promise.all(
        entities.map(async (d) => {
          const read = await this.generatedDocumentService.read(d.key, null);
          return read
            ? { key: d.key, filename: d.filename, buffer: read.buffer }
            : null;
        }),
      );
      return loaded.filter(
        (d): d is { key: string; filename: string; buffer: Buffer } =>
          d !== null,
      );
    });
  }
}
