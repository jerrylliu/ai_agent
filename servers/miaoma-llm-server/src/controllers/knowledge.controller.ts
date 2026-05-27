// ==================== 知识库控制器 ====================
// 负责处理知识库的上传、搜索、调试、管理等操作
// 知识库基于向量数据库（ChromaDB）+ BM25 全文索引实现混合检索
// 路由前缀：/knowledge

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Get, Post, Delete, Body, Query, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { logger } from '../fundamentals/logger';

// @Controller('knowledge') 声明该类为 NestJS 控制器，路由前缀为 /knowledge
// 即该控制器下所有路由都以 /knowledge 开头
@Controller('knowledge')
export class KnowledgeController {

  /**
   * POST /knowledge/upload
   * 上传文档到知识库
   * 支持格式：TXT、PDF、Word (.doc/.docx)
   * 文档会被自动切片、生成向量嵌入并存入 ChromaDB
   */
  @Post('upload') // 映射 POST 请求到 /knowledge/upload
  @UseInterceptors(FileInterceptor('file')) // 使用 Multer 拦截器解析 multipart/form-data 中的文件
  async uploadToKnowledgeBase(
    // @UploadedFile() 注入 Multer 解析后的文件对象，包含 path/size/mimetype/originalname 等字段
    @UploadedFile() file: any,
  ) {
    try {
      // 动态导入 rag-service，避免循环依赖问题
      // 动态 import() 在运行时加载模块，不会在文件顶部形成静态依赖
      const { handleDocumentUpload } = await import('../fundamentals/rag-service.js');
      // 调用文档上传处理函数：解析文档 → 切片 → 生成嵌入 → 存入向量库
      const result = await handleDocumentUpload(file);
      // 返回上传结果：是否成功、消息、文档数量
      return {
        success: result.success,
        message: result.message,
        documentCount: result.documentCount,
      };
    } catch (error: any) {
      // 捕获并记录上传失败的错误
      logger.error('上传到知识库失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `上传失败: ${error.message}` };
    }
  }

  /**
   * GET /knowledge/status
   * 获取知识库当前状态
   * 返回：知识库是否就绪、文档数量、集合名称等统计信息
   */
  @Get('status') // 映射 GET 请求到 /knowledge/status
  async getKnowledgeBaseStatus() {
    try {
      // 动态导入 rag-service
      const { getKnowledgeBaseStatus } = await import('../fundamentals/rag-service.js');
      // 调用服务层获取知识库状态
      return await getKnowledgeBaseStatus();
    } catch (error: any) {
      logger.error('获取知识库状态失败', { module: 'KnowledgeController', error: error.message });
      return { status: 'error', message: `获取状态失败: ${error.message}` };
    }
  }

  /**
   * POST /knowledge/search
   * 纯向量搜索知识库
   * 根据查询文本的语义相似度检索最相关的文档片段
   */
  @Post('search') // 映射 POST 请求到 /knowledge/search
  async searchKnowledgeBase(
    // @Body() 从请求体提取搜索参数
    @Body() body: { query: string; topK?: number; filter?: Record<string, any> },
  ) {
    try {
      // 动态导入 rag-service
      const { retrieveFromKnowledgeBase } = await import('../fundamentals/rag-service.js');
      // 解构请求参数：query（查询文本）、topK（返回结果数量，默认3）、filter（元数据过滤条件）
      const { query, topK = 3, filter } = body;
      // 校验必填参数：query 不能为空
      if (!query) {
        return { success: false, message: '请提供搜索查询内容' };
      }
      // 调用服务层执行向量检索
      const result = await retrieveFromKnowledgeBase(query, topK, filter);
      // 返回搜索结果：查询文本、匹配文档列表、拼接上下文、是否有结果
      return {
        success: true,
        query: result.query,
        results: result.results,
        context: result.context,
        hasResults: result.hasResults,
      };
    } catch (error: any) {
      logger.error('搜索知识库失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `搜索失败: ${error.message}` };
    }
  }

  /**
   * POST /knowledge/hybrid-search
   * 混合搜索知识库（向量语义搜索 + BM25 关键词搜索）
   * 通过加权融合两种检索方式的结果，提高召回率和准确率
   */
  @Post('hybrid-search') // 映射 POST 请求到 /knowledge/hybrid-search
  async hybridSearchKnowledgeBase(
    // @Body() 从请求体提取搜索参数
    @Body() body: {
      query: string; // 查询文本
      topK?: number; // 返回结果数量，默认3
      vectorWeight?: number; // 向量搜索权重，默认0.7（70%权重给语义搜索）
      bm25Weight?: number; // BM25搜索权重，默认0.3（30%权重给关键词搜索）
      filter?: Record<string, any>; // 元数据过滤条件
    },
  ) {
    try {
      // 动态导入 rag-service
      const { hybridRetrieveFromKnowledgeBase } = await import('../fundamentals/rag-service.js');
      // 解构请求参数，设置默认权重
      const { query, topK = 3, vectorWeight = 0.7, bm25Weight = 0.3, filter } = body;
      // 校验必填参数
      if (!query) {
        return { success: false, message: '请提供搜索查询内容' };
      }
      // 调用服务层执行混合检索（向量 + BM25 加权融合）
      const result = await hybridRetrieveFromKnowledgeBase(query, topK, vectorWeight, bm25Weight, filter);
      // 返回搜索结果
      return {
        success: true,
        query: result.query,
        results: result.results,
        context: result.context,
        hasResults: result.hasResults,
      };
    } catch (error: any) {
      logger.error('混合搜索知识库失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `搜索失败: ${error.message}` };
    }
  }

  /**
   * GET /knowledge/types
   * 获取知识库中所有文档的类型（如 txt、pdf、docx）
   */
  @Get('types') // 映射 GET 请求到 /knowledge/types
  async getDocumentTypes() {
    try {
      // 动态导入 vector-store
      const { getDocumentTypes } = await import('../fundamentals/vector-store.js');
      // 调用服务层获取文档类型列表
      const types = await getDocumentTypes();
      return { success: true, types };
    } catch (error: any) {
      logger.error('获取文档类型失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `获取失败: ${error.message}` };
    }
  }

  /**
   * GET /knowledge/documents
   * 获取知识库中所有文档的列表（包含元数据信息）
   */
  @Get('documents') // 映射 GET 请求到 /knowledge/documents
  async getAllDocuments() {
    try {
      // 动态导入 vector-store
      const { getAllDocuments } = await import('../fundamentals/vector-store.js');
      // 调用服务层获取所有文档
      const documents = await getAllDocuments();
      // 返回文档列表和文档总数
      return { success: true, documentCount: documents.length, documents };
    } catch (error: any) {
      logger.error('获取文档列表失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `获取文档列表失败: ${error.message}` };
    }
  }

  /**
   * GET /knowledge/debug?query=xxx
   * 调试接口：查看搜索流程的详细信息，包括切片和检索详情
   * 仅用于开发调试，不应在生产环境暴露
   */
  @Get('debug') // 映射 GET 请求到 /knowledge/debug
  async debugKnowledge(
    // @Query('query') 从 URL 查询参数中提取调试查询文本
    @Query('query') query: string,
  ) {
    try {
      // 动态导入 vector-store 的调试函数
      const { debugSearch, getAllDocumentsWithDebug } = await import('../fundamentals/vector-store.js');
      // 执行调试搜索，返回 topK=5 的详细检索信息
      const debugInfo = await debugSearch(query || '测试查询', 5);
      // 获取所有文档的调试信息
      const documentsInfo = await getAllDocumentsWithDebug();
      return { success: true, searchDebug: debugInfo, documentsInfo };
    } catch (error: any) {
      logger.error('调试失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `调试失败: ${error.message}` };
    }
  }

  /**
   * POST /knowledge/preview-chunk
   * 预览文本切片效果：将输入文本按配置的切片策略分割，返回切片结果
   * 用于调试切片参数，不影响知识库数据
   */
  @Post('preview-chunk') // 映射 POST 请求到 /knowledge/preview-chunk
  async previewChunk(
    // @Body() 从请求体提取待切片的文本
    @Body() body: { text: string },
  ) {
    try {
      // 动态导入 vector-store
      const { previewChunking } = await import('../fundamentals/vector-store.js');
      // 校验必填参数
      if (!body.text) {
        return { success: false, message: '请提供 text 参数' };
      }
      // 调用切片预览函数，返回切片数组
      const chunks = await previewChunking(body.text);
      // 返回切片详情：原文长度、切片数量、每个切片的索引/长度/内容
      return {
        success: true,
        originalLength: body.text.length,
        chunkCount: chunks.length,
        chunks: chunks.map((chunk, i) => ({ index: i, length: chunk.length, content: chunk })),
      };
    } catch (error: any) {
      logger.error('预览切片失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `预览切片失败: ${error.message}` };
    }
  }

  /**
   * POST /knowledge/preview-embedding
   * 预览文本的 Embedding 向量：将输入文本转换为向量表示
   * 用于调试嵌入模型，验证向量维度和数值
   */
  @Post('preview-embedding') // 映射 POST 请求到 /knowledge/preview-embedding
  async previewEmbedding(
    // @Body() 从请求体提取待嵌入的文本
    @Body() body: { text: string },
  ) {
    try {
      // 动态导入 vector-store
      const { previewEmbedding } = await import('../fundamentals/vector-store.js');
      // 校验必填参数
      if (!body.text) {
        return { success: false, message: '请提供 text 参数' };
      }
      // 调用嵌入预览函数，返回向量数组
      const embedding = await previewEmbedding(body.text);
      return { success: true, embedding };
    } catch (error: any) {
      logger.error('预览 Embedding 失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `预览 Embedding 失败: ${error.message}` };
    }
  }

  /**
   * DELETE /knowledge/clear
   * 清空知识库所有数据（包括 ChromaDB 向量数据和 BM25 索引）
   * 不可逆操作，谨慎调用
   */
  @Delete('clear') // 映射 DELETE 请求到 /knowledge/clear
  async clearKnowledgeBase() {
    try {
      // 动态导入 vector-store
      const { clearKnowledgeBase } = await import('../fundamentals/vector-store.js');
      // 调用服务层清空知识库
      await clearKnowledgeBase();
      return { success: true, message: '知识库已清空' };
    } catch (error: any) {
      logger.error('清空知识库失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `清空知识库失败: ${error.message}` };
    }
  }
}
