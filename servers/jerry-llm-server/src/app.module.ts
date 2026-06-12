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
import { AuthModule } from './auth/auth.module.js';
import { WinstonLoggerModule } from './fundamentals/logger.js';
import { initManageSession, setToolUsageCallback, initMcpProxy } from './fundamentals/tools/index.js';
import { initDocumentTools } from './fundamentals/tools/document-ops.js';
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
      entities: [ChatHistory, Session, User, SessionSummary, UserMemory, Document, DocumentVersion, DocumentAuditLog, PendingVectorOp, KnowledgeSource, KnowledgeSourceSyncLog, KnowledgeSourcePage, LlmUsage, MessageFeedback, AutoEvaluation, ToolUsage],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([ChatHistory, Session, SessionSummary, UserMemory, Document, DocumentVersion, DocumentAuditLog, PendingVectorOp, KnowledgeSource, KnowledgeSourceSyncLog, KnowledgeSourcePage, LlmUsage, MessageFeedback, AutoEvaluation, ToolUsage]),
    AuthModule,
  ],
  controllers: [AppController, ChatController, MemoryController, KnowledgeController, ModelController, UploadController, DocumentController, KnowledgeSourceController],
  providers: [AppService, SessionService, SummaryService, MemoryService, UsageService, EvaluationService, DocumentService, DocumentSchedulerService, KnowledgeSourceService, KnowledgeSourceSchedulerService, ToolUsageService],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly sessionService: SessionService,
    private readonly toolUsageService: ToolUsageService,
    private readonly documentService: DocumentService,
  ) {}

  onModuleInit() {
    initManageSession(this.sessionService);
    // 注入工具调用指标持久化回调
    setToolUsageCallback((data) => this.toolUsageService.saveToolUsage(data));
    // 注入 DocumentService 到文档操作工具
    initDocumentTools(this.documentService);
    // 异步初始化 MCP 客户端（启动 MCP Server 子进程并拉取 tools 列表）
    // 不 await：避免 MCP Server 启动慢拖慢主服务启动；失败也不影响其他工具
    initMcpProxy().catch(() => {
      // 错误已在 initMcpProxy 内部记录日志，这里无需重复处理
    });
  }
}
