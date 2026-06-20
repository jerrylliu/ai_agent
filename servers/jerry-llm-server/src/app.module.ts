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
import { SpeechService } from './services/speech.service.js';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { ToolUsage } from './entities/tool-usage.entity.js';
import { GeneratedDocument } from './entities/generated-document.entity.js';
import { DocumentService } from './services/document.service.js';
import { DocumentSchedulerService } from './services/document-scheduler.service.js';
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
import { AuthModule } from './auth/auth.module.js';
import { WinstonLoggerModule } from './fundamentals/logger.js';
import { initManageSession, setToolUsageCallback, initMcpProxy } from './fundamentals/tools/index.js';
import { initDocumentTools } from './fundamentals/tools/document-ops.js';
import { initGenerateDocumentTool } from './fundamentals/tools/generate-document.js';
import { config } from './fundamentals/config.js';
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
      entities: [ChatHistory, Session, User, SessionSummary, UserMemory, Document, DocumentVersion, DocumentAuditLog, PendingVectorOp, KnowledgeSource, KnowledgeSourceSyncLog, KnowledgeSourcePage, LlmUsage, MessageFeedback, AutoEvaluation, ToolUsage, GeneratedDocument],
      // 不在 NestJS 启动时加载 migrations：
      // 1. NestJS 运行在 ESM 模式，TypeORM 同步 require 加载 ESM 迁移文件会崩
      //    （报错：Unexpected module status 0 / MigrationInterface 命名导出缺失）
      // 2. 迁移统一通过 `pnpm migration:run` CLI 走 dist/typeorm-data-source.js 执行
      // 因此这里 migrations 留空，且 migrationsRun 强制为 false
      migrations: [],
      synchronize: config.db.synchronize,
      migrationsRun: false,
    }),
    TypeOrmModule.forFeature([ChatHistory, Session, SessionSummary, UserMemory, Document, DocumentVersion, DocumentAuditLog, PendingVectorOp, KnowledgeSource, KnowledgeSourceSyncLog, KnowledgeSourcePage, LlmUsage, MessageFeedback, AutoEvaluation, ToolUsage, GeneratedDocument]),
    AuthModule,
  ],
  controllers: [AppController, ChatController, MemoryController, KnowledgeController, ModelController, UploadController, DocumentController, KnowledgeSourceController, RedisDashboardController, SpeechController, AiWritingController],
  providers: [AppService, SessionService, SummaryService, MemoryService, UsageService, EvaluationService, DocumentService, DocumentSchedulerService, KnowledgeSourceService, KnowledgeSourceSchedulerService, ToolUsageService, GeneratedDocumentService, GeneratedDocumentSchedulerService, SpeechService],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly sessionService: SessionService,
    private readonly toolUsageService: ToolUsageService,
    private readonly documentService: DocumentService,
    private readonly generatedDocumentService: GeneratedDocumentService,
  ) {}

  onModuleInit() {
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
        return { entity: { mimeType: r.entity.mimeType, filename: r.entity.filename }, buffer: r.buffer };
      },
    });
    // 异步初始化 MCP 客户端（启动 MCP Server 子进程并拉取 tools 列表）
    // 不 await：避免 MCP Server 启动慢拖慢主服务启动；失败也不影响其他工具
    initMcpProxy().catch(() => {
      // 错误已在 initMcpProxy 内部记录日志，这里无需重复处理
    });
  }
}
