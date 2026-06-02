// ==================== 知识库控制器 ====================
// 负责处理知识库的搜索、调试、管理等操作
// 知识库基于向量数据库（ChromaDB）+ BM25 全文索引实现混合检索
// 上传已统一走文档版本管理 (/documents/upload)
// 路由前缀：/knowledge

import { Controller, Get, Post, Delete, Body, Query, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentService } from '../services/document.service';
import { KnowledgeSourceService } from '../services/knowledge-source.service.js';
import { logger } from '../fundamentals/logger';

@Controller('knowledge')
export class KnowledgeController {

  constructor(
    private readonly documentService: DocumentService,
    private readonly knowledgeSourceService: KnowledgeSourceService,
  ) {}

  /**
   * POST /knowledge/upload
   * 上传文档到知识库（已重定向到文档版本管理）
   * 保留此接口兼容旧前端，内部调用 DocumentService
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadToKnowledgeBase(
    @UploadedFile() file: any,
  ) {
    try {
      if (!file) {
        return { success: false, message: '请选择要上传的文件' };
      }

      // 统一走文档版本管理
      const result = await this.documentService.uploadDocument(
        { buffer: file.buffer, originalname: file.originalname, size: file.size, mimetype: file.mimetype },
        { title: file.originalname.replace(/\.[^/.]+$/, ''), operator: 'anonymous' },
      );

      return {
        success: true,
        message: `文档上传成功，版本 v${result.version.versionNumber} 正在解析中`,
        documentCount: 1,
      };
    } catch (error: any) {
      logger.error('上传到知识库失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `上传失败: ${error.message}` };
    }
  }

  /**
   * GET /knowledge/status
   * 获取知识库当前状态（从文档版本管理数据库聚合）
   */
  @Get('status')
  async getKnowledgeBaseStatus() {
    try {
      const stats = await this.documentService.getKnowledgeStats();

      const knowledgeSourcePageCount = await this.knowledgeSourceService.getTotalPageCount();

      const knowledgeSources = await this.knowledgeSourceService.findAll();
      const hasContentUpdate = knowledgeSources.some(s => s.hasContentUpdate);

      let vectorStoreInfo: any = {};
      try {
        const { getKnowledgeBaseStatus } = await import('../fundamentals/rag-service.js');
        vectorStoreInfo = await getKnowledgeBaseStatus();
      } catch {
      }

      const totalDocumentCount = stats.documentCount + knowledgeSourcePageCount;

      return {
        status: 'ready',
        documentCount: totalDocumentCount,
        uploadedDocumentCount: stats.documentCount,
        knowledgeSourcePageCount,
        hasContentUpdate,
        activeVersionCount: stats.activeVersionCount,
        totalVersionCount: stats.totalVersionCount,
        totalChunkCount: stats.totalChunkCount,
        lastUpdatedAt: stats.lastUpdatedAt,
        ...vectorStoreInfo,
      };
    } catch (error: any) {
      logger.error('获取知识库状态失败', { module: 'KnowledgeController', error: error.message });
      return { status: 'error', message: `获取状态失败: ${error.message}` };
    }
  }

  /**
   * POST /knowledge/search
   * 纯向量搜索知识库
   */
  @Post('search')
  async searchKnowledgeBase(
    @Body() body: { query: string; topK?: number; filter?: Record<string, any> },
  ) {
    try {
      const { retrieveFromKnowledgeBase } = await import('../fundamentals/rag-service.js');
      const { query, topK = 3, filter } = body;
      if (!query) {
        return { success: false, message: '请提供搜索查询内容' };
      }
      const result = await retrieveFromKnowledgeBase(query, topK, filter);
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
   */
  @Post('hybrid-search')
  async hybridSearchKnowledgeBase(
    @Body() body: {
      query: string;
      topK?: number;
      vectorWeight?: number;
      bm25Weight?: number;
      filter?: Record<string, any>;
    },
  ) {
    try {
      const { hybridRetrieveFromKnowledgeBase } = await import('../fundamentals/rag-service.js');
      const { query, topK = 3, vectorWeight = 0.7, bm25Weight = 0.3, filter } = body;
      if (!query) {
        return { success: false, message: '请提供搜索查询内容' };
      }
      const result = await hybridRetrieveFromKnowledgeBase(query, topK, vectorWeight, bm25Weight, filter);
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
   * 获取知识库中所有文档的类型
   */
  @Get('types')
  async getDocumentTypes() {
    try {
      const { getDocumentTypes } = await import('../fundamentals/vector-store.js');
      const types = await getDocumentTypes();
      return { success: true, types };
    } catch (error: any) {
      logger.error('获取文档类型失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `获取失败: ${error.message}` };
    }
  }

  /**
   * GET /knowledge/documents
   * 获取知识库中所有文档的列表
   */
  @Get('documents')
  async getAllDocuments() {
    try {
      const { getAllDocuments } = await import('../fundamentals/vector-store.js');
      const documents = await getAllDocuments();
      return { success: true, documentCount: documents.length, documents };
    } catch (error: any) {
      logger.error('获取文档列表失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `获取文档列表失败: ${error.message}` };
    }
  }

  /**
   * GET /knowledge/debug?query=xxx
   * 调试接口
   */
  @Get('debug')
  async debugKnowledge(
    @Query('query') query: string,
  ) {
    try {
      const { debugSearch, getAllDocumentsWithDebug } = await import('../fundamentals/vector-store.js');
      const debugInfo = await debugSearch(query || '测试查询', 5);
      const documentsInfo = await getAllDocumentsWithDebug();
      return { success: true, searchDebug: debugInfo, documentsInfo };
    } catch (error: any) {
      logger.error('调试失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `调试失败: ${error.message}` };
    }
  }

  /**
   * POST /knowledge/preview-chunk
   * 预览文本切片效果
   */
  @Post('preview-chunk')
  async previewChunk(
    @Body() body: { text: string },
  ) {
    try {
      const { previewChunking } = await import('../fundamentals/vector-store.js');
      if (!body.text) {
        return { success: false, message: '请提供 text 参数' };
      }
      const chunks = await previewChunking(body.text);
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
   * 预览文本的 Embedding 向量
   */
  @Post('preview-embedding')
  async previewEmbedding(
    @Body() body: { text: string },
  ) {
    try {
      const { previewEmbedding } = await import('../fundamentals/vector-store.js');
      if (!body.text) {
        return { success: false, message: '请提供 text 参数' };
      }
      const embedding = await previewEmbedding(body.text);
      return { success: true, embedding };
    } catch (error: any) {
      logger.error('预览 Embedding 失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `预览 Embedding 失败: ${error.message}` };
    }
  }

  /**
   * DELETE /knowledge/clear
   * 清空知识库（删除所有文档，含版本、向量、文件）
   */
  @Delete('clear')
  async clearKnowledgeBase() {
    try {
      // 通过文档版本管理逐个删除，保留审计日志
      const documents = await this.documentService.listDocuments();
      let deletedCount = 0;
      for (const doc of documents) {
        try {
          await this.documentService.deleteDocument(doc.id, 'system-clear');
          deletedCount++;
        } catch (err: any) {
          logger.error('清空时删除文档失败', { module: 'KnowledgeController', documentId: doc.id, error: err.message });
        }
      }

      // 额外清理可能存在的无版本管理的孤岛向量
      try {
        const { clearKnowledgeBase } = await import('../fundamentals/vector-store.js');
        await clearKnowledgeBase();
      } catch {
        // 向量库清理失败不影响结果
      }

      logger.info('知识库已清空', { module: 'KnowledgeController', deletedCount });
      return { success: true, message: `知识库已清空，共删除 ${deletedCount} 个文档` };
    } catch (error: any) {
      logger.error('清空知识库失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `清空知识库失败: ${error.message}` };
    }
  }
}
