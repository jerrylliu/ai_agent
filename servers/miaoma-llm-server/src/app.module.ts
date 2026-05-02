import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatHistory } from './entities/chat-history.entity';
import { Session } from './entities/session.entity';
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql', // 修改为 mysql
      host: '127.0.0.1', // MySQL 主机
      port: 3306, // MySQL 端口
      username: 'root', // MySQL 用户名
      password: '123456', // MySQL 密码
      database: 'cyberpunk', // 数据库名
      entities: [ChatHistory, Session],
      synchronize: true, // 开发环境使用，生产环境建议关闭
    }),
    TypeOrmModule.forFeature([ChatHistory, Session]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
