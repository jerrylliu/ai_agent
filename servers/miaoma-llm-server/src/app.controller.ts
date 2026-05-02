// 从 @nestjs/common 模块导入 Controller、Get 和 Query 装饰器
import { Controller, Get, Post, Body, Query, Put, Patch, Delete, Param, UseInterceptors, UploadedFile, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
// 从当前目录的 app.service 文件导入 AppService 服务类
import { AppService } from './app.service';

// 使用 @Controller 装饰器定义一个控制器类，处理根路径的请求
@Controller()
// 导出 AppController 类，用于处理应用程序的 HTTP 请求
export class AppController {
  // 构造函数，通过依赖注入获取 AppService 实例
  constructor(private readonly appService: AppService) { }

  // 定义一个 POST 路由 'prompt'，用于处理提示相关的请求
  @Post('prompt')
  // prompt 方法接收请求体中的 message 和 history，并调用 appService.prompt 方法
  async prompt(@Body() body: { message?: string, history?: Array<{ role: string, content: string }> }, @Res() res:Response) {
    // 设置响应头，支持流式返回
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // 调用 appService 的 prompt 方法
    await this.appService.prompt(body.message, body.history, res);
  }

  // 定义一个 GET 路由 'rag'，用于处理 RAG（检索增强生成）相关的请求
  @Get('rag')
  // rag 方法接收查询参数中的 message，并调用 appService.rag 方法（无返回值）
  rag(@Query() { message }: { message?: string }) {
    // 调用 appService 的 rag 方法，不返回结果
    this.appService.rag(message);
  }

  // 定义根路径的 GET 路由，返回问候语
  @Get()
  // getHello 方法返回一个字符串类型的问候语
  getHello(): string {
    // 调用 appService 的 getHello 方法并返回结果
    return this.appService.getHello();
  }

  // 保存对话记录
  @Post('chat-history')
  async saveChatHistory(@Body() body: { sessionId: string; role: string; content: string }) {
    return this.appService.saveChatHistory(body.sessionId, body.role, body.content);
  }

  // 获取会话历史
  @Get('chat-history')
  async getSessionHistory(@Query('sessionId') sessionId: string) {
    return this.appService.getSessionHistory(sessionId);
  }

  // 获取所有会话
  @Get('sessions')
  async getSessions() {
    return this.appService.getSessions();
  }

  // 创建新会话
  @Post('sessions')
  async createSession(@Body() body: { sessionId: string; title: string }) {
    return this.appService.createSession(body.sessionId, body.title);
  }

  // 获取指定会话
  @Get('sessions/:sessionId')
  async getSessionBySessionId(@Param('sessionId') sessionId: string) {
    return this.appService.getSessionBySessionId(sessionId);
  }

  // 更新会话标题
  @Put('sessions/:sessionId')
  async updateSessionTitle(@Param('sessionId') sessionId: string, @Body() body: { title: string }) {
    return this.appService.updateSessionTitle(sessionId, body.title);
  }

  // 删除会话
  @Delete('sessions/:sessionId')
  async deleteSession(@Param('sessionId') sessionId: string) {
    return this.appService.deleteSession(sessionId);
  }

  // 切换会话置顶状态
  @Patch('sessions/:sessionId/pin')
  async toggleSessionPin(@Param('sessionId') sessionId: string) {
    return this.appService.toggleSessionPin(sessionId);
  }

  // 获取会话消息
  @Get('sessions/:sessionId/messages')
  async getSessionMessages(@Param('sessionId') sessionId: string) {
    return this.appService.getSessionHistory(sessionId);
  }

  // 获取所有聊天记录（用于调试）
  @Get('all-chat-history')
  async getAllChatHistory() {
    return this.appService.getAllChatHistory();
  }

  // 上传文件
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: any) {
    const uploadDir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, file.originalname);
    fs.writeFileSync(filePath, file.buffer);

    return { url: `http://localhost:3000/files/${file.originalname}` };
  }

  // 更新消息
  @Put('messages/:id')
  async updateMessage(@Param('id') id: string, @Body() body: { content: string }) {
    return this.appService.updateMessage(id, body.content);
  }

  // 删除消息
  @Delete('messages/:id')
  async deleteMessage(@Param('id') id: string) {
    return this.appService.deleteMessage(id);
  }



}