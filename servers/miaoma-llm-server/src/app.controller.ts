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

  // ============================================
  // 上传文件接口
  // 路由：POST /upload
  // 功能：接收前端上传的文件，保存到服务器的 uploads 目录
  //
  // 实现原理：
  // 1. 使用 @UseInterceptors(FileInterceptor('file')) 拦截器处理文件上传
  // 2. @UploadedFile() decorator 获取上传的文件对象
  // 3. 确保 uploads 目录存在（如果不存在则创建）
  // 4. 将文件写入到 uploads 目录
  // 5. 返回文件的访问 URL
  // ============================================
  @Post('upload')                                    // 定义 POST 路由为 /upload
  @UseInterceptors(FileInterceptor('file'))         // 使用 Multer 拦截器处理文件上传，'file' 是字段名
  async uploadFile(@UploadedFile() file: any) {     // @UploadedFile() 获取上传的文件对象，类型为 any

    // 拼接上传目录的绝对路径
    // __dirname: 当前文件的目录（src/app/）
    // '..': 向上两级目录
    // '..': 回到项目根目录（servers/miaoma-llm-server/）
    // 'uploads': 上传文件的存储目录
    const uploadDir = path.join(__dirname, '..', '..', 'uploads');

    // 检查上传目录是否存在
    // fs.existsSync() 同步检查目录是否存在
    if (!fs.existsSync(uploadDir)) {
      // 如果目录不存在，使用 recursive: true 创建目录
      // recursive: true 会自动创建所有不存在的父级目录
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // 生成唯一的文件名（避免中文名和特殊字符问题）
    // 使用时间戳 + 随机数 + 原始扩展名
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname); // 获取文件扩展名
    const safeFilename = `${timestamp}_${randomStr}${ext}`; // 安全文件名

    // 拼接文件的完整保存路径（使用安全的文件名）
    // path.join() 跨平台路径拼接
    const filePath = path.join(uploadDir, safeFilename);

    // 将文件内容写入到目标路径
    // file.buffer 是文件的二进制内容（Node.js Buffer 对象）
    // writeFileSync 同步写入文件（简单场景下使用，生产环境建议用异步）
    fs.writeFileSync(filePath, file.buffer);

    // 返回文件的访问 URL
    // 使用 encodeURIComponent 对文件名进行编码，避免中文和特殊字符导致 URL 无法访问
    // 格式：http://localhost:3000/files/时间戳_随机数.扩展名
    return { url: `http://localhost:3000/files/${safeFilename}` };
  }

  // ============================================
  // 上传文档到知识库
  // 路由：POST /knowledge/upload
  // 功能：接收文档文件，解析内容，添加到向量知识库
  // 支持格式：TXT、PDF、Word (.doc/.docx)
  // ============================================
  @Post('knowledge/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadToKnowledgeBase(@UploadedFile() file: any) {
    try {
      // 动态导入 rag-service（避免循环依赖）
      const { handleDocumentUpload } = await import('./fundamentals/rag-service.js');

      const result = await handleDocumentUpload(file);

      return {
        success: result.success,
        message: result.message,
        documentCount: result.documentCount,
      };
    } catch (error: any) {
      console.error('上传到知识库失败:', error);
      return {
        success: false,
        message: `上传失败: ${error.message}`,
      };
    }
  }

  // ============================================
  // 获取知识库状态
  // 路由：GET /knowledge/status
  // 功能：查询当前知识库的状态和统计信息
  // ============================================
  @Get('knowledge/status')
  async getKnowledgeBaseStatus() {
    try {
      const { getKnowledgeBaseStatus } = await import('./fundamentals/rag-service.js');
      return await getKnowledgeBaseStatus();
    } catch (error: any) {
      console.error('获取知识库状态失败:', error);
      return {
        status: 'error',
        message: `获取状态失败: ${error.message}`,
      };
    }
  }

  // ============================================
  // 搜索知识库
  // 路由：POST /knowledge/search
  // 功能：在知识库中搜索相关内容
  // ============================================
  @Post('knowledge/search')
  async searchKnowledgeBase(@Body() body: { query: string; topK?: number }) {
    try {
      const { retrieveFromKnowledgeBase } = await import('./fundamentals/rag-service.js');
      const { query, topK = 3 } = body;

      if (!query) {
        return {
          success: false,
          message: '请提供搜索查询内容',
        };
      }

      const result = await retrieveFromKnowledgeBase(query, topK);

      return {
        success: true,
        query: result.query,
        results: result.results,
        context: result.context,
      };
    } catch (error: any) {
      console.error('搜索知识库失败:', error);
      return {
        success: false,
        message: `搜索失败: ${error.message}`,
      };
    }
  }

  // ============================================
  // 获取知识库所有文档
  // 路由：GET /knowledge/documents
  // 功能：列出知识库中存储的所有文档
  // ============================================
  @Get('knowledge/documents')
  async getAllDocuments() {
    try {
      const { getAllDocuments } = await import('./fundamentals/vector-store.js');
      const documents = await getAllDocuments();

      return {
        success: true,
        documentCount: documents.length,
        documents,
      };
    } catch (error: any) {
      console.error('获取文档列表失败:', error);
      return {
        success: false,
        message: `获取文档列表失败: ${error.message}`,
      };
    }
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