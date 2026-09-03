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
import { UNTRUSTED_CONTEXT_INSTRUCTION } from '../fundamentals/prompt-injection-guard.js';

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
   * 增强搜索知识库（查询改写 → 多跳混合搜索 → Rerank）
   *
   * 复用聊天 RAG 管线的核心模块，让面板搜索准确度与聊天一致：
   * 1. 查询改写（rewriteQuery）：LLM 提取关键词 + 拆子查询，解决长查询语义稀释
   * 2. 多跳混合搜索（multiHopSearch）：第1跳用改写查询搜，LLM 看结果判断是否追问，
   *    需要则生成新查询再搜第2跳，合并去重。与聊天管线完全一致，有"纠错机制"
   * 3. Rerank（rerankResults）：DashScope reranker 精排候选结果
   *
   * 每个阶段都有降级：改写失败用原始查询、多跳失败降级单次搜索、rerank 失败用 RRF 顺序
   */
  @Post('search')
  async searchKnowledgeBase(
    @Body() body: { query: string; topK?: number; filter?: Record<string, any> },
  ) {
    const startTime = Date.now();
    try {
      const { query, topK = 3, filter } = body;
      if (!query) {
        return { success: false, message: '请提供搜索查询内容' };
      }

      logger.info('知识库搜索开始（增强管线：改写→混合搜索→rerank）', {
        module: 'KnowledgeController',
        query: query.substring(0, 100),
        topK,
        filter,
      });

      // ==================== 阶段1：查询改写 ====================
      const { rewriteQuery } = await import('../fundamentals/vector-store/query-rewriter.js');
      let rewritten: {
        mainQuery: string;
        subQueries: string[];
        keywords: string[];
        wasRewritten: boolean;
      };
      try {
        rewritten = await rewriteQuery(query);
        logger.info('查询改写阶段完成', {
          module: 'KnowledgeController',
          wasRewritten: rewritten.wasRewritten,
          mainQuery: rewritten.mainQuery.substring(0, 100),
          subQueryCount: rewritten.subQueries.length,
        });
      } catch (error: any) {
        logger.warn('查询改写阶段异常，降级为原始查询', {
          module: 'KnowledgeController',
          error: error.message,
        });
        rewritten = { mainQuery: query, subQueries: [], keywords: [], wasRewritten: false };
      }

      // ==================== 阶段2：多跳混合搜索（与聊天管线一致） ====================
      // 复用 multiHopSearch：第1跳用改写查询搜，LLM 看结果判断是否需要追问，
      // 若需要则生成新查询再搜第2跳，合并去重所有跳的结果。
      // 这是聊天管线准确度高的核心原因：有"纠错机制"，第1跳搜偏了能补救。
      const { multiHopSearch } = await import(
        '../fundamentals/vector-store/multi-hop-search.js'
      );
      // 每跳多取候选给 rerank 精排，topK*4 至少 20
      const hopTopK = Math.max(topK * 4, 20);
      let multiHopResult: {
        results: Array<{
          content: string;
          metadata: any;
          score: number;
          sources: string[];
          hop: number;
        }>;
        hopsExecuted: number;
        hopDetails: Array<{ hop: number; query: string; resultCount: number }>;
      };
      try {
        multiHopResult = await multiHopSearch(query, rewritten, hopTopK, {
          maxHops: 2,
          enabled: true,
          filter,
        });
        logger.info('多跳搜索阶段完成', {
          module: 'KnowledgeController',
          hopsExecuted: multiHopResult.hopsExecuted,
          hopDetails: multiHopResult.hopDetails.map((h) => ({
            hop: h.hop,
            query: h.query.substring(0, 80),
            resultCount: h.resultCount,
          })),
          totalCandidates: multiHopResult.results.length,
        });
      } catch (error: any) {
        logger.warn('多跳搜索阶段异常，降级为单次混合搜索', {
          module: 'KnowledgeController',
          error: error.message,
        });
        // 降级：直接用改写后的主查询做单次混合搜索
        const { hybridRetrieveFromKnowledgeBase } = await import(
          '../fundamentals/rag-service.js'
        );
        const fallback = await hybridRetrieveFromKnowledgeBase(
          rewritten.mainQuery,
          hopTopK,
          0.7,
          0.3,
          filter,
        );
        multiHopResult = {
          results: fallback.results.map((r) => ({ ...r, hop: 1 })),
          hopsExecuted: 1,
          hopDetails: [
            { hop: 1, query: rewritten.mainQuery, resultCount: fallback.results.length },
          ],
        };
        logger.info('降级单次混合搜索完成', {
          module: 'KnowledgeController',
          candidateCount: multiHopResult.results.length,
        });
      }

      const candidates = multiHopResult.results;

      // 无候选结果，直接返回空
      if (candidates.length === 0) {
        logger.info('知识库搜索无结果', {
          module: 'KnowledgeController',
          durationMs: Date.now() - startTime,
        });
        return { success: true, query, results: [], context: '', hasResults: false };
      }

      // 候选数保护：DashScope rerank 最多 100 条，超出截断
      const rerankCandidates = candidates.slice(0, 100);

      // ==================== 阶段3：Rerank 精排 ====================
      const { rerankResults } = await import(
        '../fundamentals/vector-store/result-reranker.js'
      );
      let finalResults: Array<{
        content: string;
        metadata: any;
        score: number;
        sources: string[];
      }>;
      try {
        const reranked = await rerankResults(query, rerankCandidates, {
          strategy: 'dashscope',
        });
        finalResults = reranked.slice(0, topK).map((r) => ({
          content: r.content,
          metadata: r.metadata,
          score: r.score,
          sources: (r as any).sources || [],
        }));
        logger.info('Rerank 阶段完成', {
          module: 'KnowledgeController',
          candidateCount: rerankCandidates.length,
          finalCount: finalResults.length,
          topRerankScore: reranked[0]?.rerankScore?.toFixed(3) ?? 'N/A',
        });
      } catch (error: any) {
        logger.warn('Rerank 阶段异常，降级为 RRF 顺序', {
          module: 'KnowledgeController',
          error: error.message,
        });
        finalResults = rerankCandidates.slice(0, topK);
      }

      const rawContext = finalResults
        .map((r, i) => `【文档 ${i + 1}】\n${r.content}`)
        .join('\n\n');
      // 检索内容属于不可信上下文：附加隔离指令，防止文档中的恶意指令覆盖系统规则
      const context =
        rawContext.trim().length > 0 ? rawContext + UNTRUSTED_CONTEXT_INSTRUCTION : rawContext;

      logger.info('知识库搜索完成（增强管线）', {
        module: 'KnowledgeController',
        durationMs: Date.now() - startTime,
        resultCount: finalResults.length,
        wasRewritten: rewritten.wasRewritten,
      });

      return {
        success: true,
        query,
        results: finalResults,
        context,
        hasResults: finalResults.length > 0,
      };
    } catch (error: any) {
      logger.error('知识库搜索失败', {
        module: 'KnowledgeController',
        error: error.message,
        stack: error.stack,
        durationMs: Date.now() - startTime,
      });
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
      const { getDocumentTypes } = await import('../fundamentals/vector-store/index.js');
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
      const { getAllDocuments } = await import('../fundamentals/vector-store/index.js');
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
      const { debugSearch, getAllDocumentsWithDebug } = await import('../fundamentals/vector-store/index.js');
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
      const { previewChunking } = await import('../fundamentals/vector-store/index.js');
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
      const { previewEmbedding } = await import('../fundamentals/vector-store/index.js');
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
        const { clearKnowledgeBase } = await import('../fundamentals/vector-store/index.js');
        await clearKnowledgeBase();
      } catch {
        // 向量库清理失败不影响结果
      }

      // 标记所有知识源需要重新同步（清空向量后知识源页面数据仍在数据库中，但向量已丢失）
      try {
        await this.knowledgeSourceService.markAllForResync();
      } catch (err: any) {
        logger.error('标记知识源重新同步失败', { module: 'KnowledgeController', error: err.message });
      }

      logger.info('知识库已重置', { module: 'KnowledgeController', deletedCount });
      return { success: true, message: `知识库已重置，共删除 ${deletedCount} 个文档` };
    } catch (error: any) {
      logger.error('重置知识库失败', { module: 'KnowledgeController', error: error.message });
      return { success: false, message: `重置知识库失败: ${error.message}` };
    }
  }
}
