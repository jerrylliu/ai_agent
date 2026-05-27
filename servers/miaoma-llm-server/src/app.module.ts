import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ChatController } from './controllers/chat.controller.js';
import { MemoryController } from './controllers/memory.controller.js';
import { KnowledgeController } from './controllers/knowledge.controller.js';
import { ModelController } from './controllers/model.controller.js';
import { UploadController } from './controllers/upload.controller.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatHistory } from './entities/chat-history.entity.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';
import { SessionSummary } from './entities/session-summary.entity.js';
import { UserMemory } from './entities/user-memory.entity.js';
import { AuthModule } from './auth/auth.module.js';
import { WinstonLoggerModule } from './fundamentals/logger.js';
@Module({
  imports: [
    WinstonLoggerModule, // Winston 结构化日志模块
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'root',
      password: '123456',
      database: 'cyberpunk',
      entities: [ChatHistory, Session, User, SessionSummary, UserMemory],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([ChatHistory, Session, SessionSummary, UserMemory]),
    AuthModule,
  ],
  controllers: [AppController, ChatController, MemoryController, KnowledgeController, ModelController, UploadController],
  providers: [AppService],
})
export class AppModule {}
