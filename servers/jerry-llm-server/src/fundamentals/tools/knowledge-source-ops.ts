/**
 * 知识源操作工具
 *
 * 让 Agent 可以操作知识源管理界面：
 * - list_knowledge_sources: 列出知识源及同步状态
 * - add_knowledge_source: 添加 Web 爬取源
 * - delete_knowledge_source: 删除知识源（级联删向量与页面）
 * - sync_knowledge_source: 触发知识源同步
 * - get_knowledge_status: 查看知识库状态与统计
 * - rebuild_knowledge_index: 全量重建向量索引
 *
 * 边界约定：
 * - 仅支持 web 类型爬取源：feishu 类型需要 appId/appSecret（密钥类信息
 *   对 AI 物理不可达，见设计文档"永远不开放给 AI 的"清单）
 * - sync/rebuild 是长任务，工具只负责入队/触发并立即返回，进度用
 *   list_knowledge_sources / get_knowledge_status 查询
 */

import { z } from 'zod';
import { logger } from '../logger';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== Service 注入 ====================

let knowledgeSourceService: any = null;
let documentService: any = null;

/**
 * 注入服务实例（AppModule 初始化时调用）
 */
export function initKnowledgeSourceTools(services: {
  knowledgeSourceService: any;
  documentService: any;
}): void {
  knowledgeSourceService = services.knowledgeSourceService;
  documentService = services.documentService;
  logger.info('知识源操作工具：服务已注入', {
    module: 'Tool:KnowledgeSourceOps',
  });
}

// ==================== list_knowledge_sources（只读） ====================

export const listKnowledgeSourcesParamsSchema = z.object({});

export const listKnowledgeSourcesSchema = buildToolJsonSchema(
  'list_knowledge_sources',
  '列出全部知识源爬取源（含ID/名称/类型/同步状态/最后同步时间）。用户要整理爬取源、查看同步情况、找知识源ID时使用。',
  listKnowledgeSourcesParamsSchema,
);

export interface KnowledgeSourceListItem {
  sourceId: number;
  name: string;
  type: string;
  enabled: boolean;
  lastSyncStatus: string;
  lastSyncAt?: string;
  lastSyncError?: string;
  hasContentUpdate: boolean;
}

export interface ListKnowledgeSourcesResult {
  success: boolean;
  total: number;
  sources: KnowledgeSourceListItem[];
  message: string;
}

export async function executeListKnowledgeSources(): Promise<ListKnowledgeSourcesResult> {
  if (!knowledgeSourceService) {
    return { success: false, total: 0, sources: [], message: '知识源服务未初始化' };
  }
  try {
    const sources: any[] = await knowledgeSourceService.findAll();
    const items: KnowledgeSourceListItem[] = sources.map((s) => ({
      sourceId: s.id,
      name: s.name,
      type: String(s.type),
      enabled: !!s.enabled,
      lastSyncStatus: String(s.lastSyncStatus),
      lastSyncAt: s.lastSyncAt ? new Date(s.lastSyncAt).toISOString() : undefined,
      lastSyncError: s.lastSyncError || undefined,
      hasContentUpdate: !!s.hasContentUpdate,
    }));
    logger.info('FC工具 [list_knowledge_sources] 查询完成', {
      module: 'Tool:KnowledgeSourceOps',
      total: items.length,
    });
    return {
      success: true,
      total: items.length,
      sources: items,
      message:
        items.length > 0
          ? `共 ${items.length} 个知识源`
          : '当前没有任何知识源',
    };
  } catch (error: any) {
    logger.error('FC工具 [list_knowledge_sources] 查询失败', {
      module: 'Tool:KnowledgeSourceOps',
      error: error.message,
    });
    return {
      success: false,
      total: 0,
      sources: [],
      message: `查询知识源列表失败: ${error.message}`,
    };
  }
}

// ==================== add_knowledge_source（高危：需人工确认） ====================

export const addKnowledgeSourceParamsSchema = z.object({
  name: z.string().min(1).max(100).describe('知识源名称'),
  url: z.string().url().describe('爬取起始 URL（http/https）'),
  syncInterval: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('自动同步间隔（分钟，默认 60）'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('爬取深度（默认 2，最大 5）'),
  maxPages: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('最多爬取页面数（默认 50）'),
});

export type AddKnowledgeSourceParams = z.infer<
  typeof addKnowledgeSourceParamsSchema
>;

export const addKnowledgeSourceSchema = buildToolJsonSchema(
  'add_knowledge_source',
  '添加 Web 爬取知识源（爬取指定网站内容入知识库）。只支持 web 类型；飞书知识源需要密钥，请引导用户在界面手动添加。添加后可用 sync_knowledge_source 触发首次同步。',
  addKnowledgeSourceParamsSchema,
);

export interface AddKnowledgeSourceResult {
  success: boolean;
  sourceId?: number;
  name: string;
  message: string;
}

export async function executeAddKnowledgeSource(
  rawParams: unknown,
): Promise<AddKnowledgeSourceResult> {
  const parsed = safeParseToolParams(addKnowledgeSourceParamsSchema, rawParams);
  if (!parsed.success) {
    return {
      success: false,
      name: (rawParams as { name?: string })?.name || '',
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!knowledgeSourceService) {
    return { success: false, name: params.name, message: '知识源服务未初始化' };
  }

  try {
    const created = await knowledgeSourceService.create({
      name: params.name,
      type: 'web',
      config: { url: params.url },
      syncInterval: params.syncInterval,
      maxDepth: params.maxDepth,
      maxPages: params.maxPages,
    });
    logger.info('FC工具 [add_knowledge_source] 添加成功', {
      module: 'Tool:KnowledgeSourceOps',
      sourceId: created.id,
      name: params.name,
    });
    return {
      success: true,
      sourceId: created.id,
      name: created.name,
      message: `知识源《${created.name}》已添加（ID: ${created.id}，尚未同步）。可用 sync_knowledge_source 触发首次同步`,
    };
  } catch (error: any) {
    logger.error('FC工具 [add_knowledge_source] 添加失败', {
      module: 'Tool:KnowledgeSourceOps',
      name: params.name,
      error: error.message,
    });
    return {
      success: false,
      name: params.name,
      message: `添加知识源失败: ${error.message}`,
    };
  }
}

// ==================== delete_knowledge_source（高危：需人工确认） ====================

export const deleteKnowledgeSourceParamsSchema = z.object({
  sourceId: z.number().int().positive().describe('要删除的知识源ID'),
  name: z
    .string()
    .optional()
    .describe(
      '知识源名称（建议填写，用于删除前核对目标：与实际名称不符将拒绝执行，防止误删）',
    ),
});

export type DeleteKnowledgeSourceParams = z.infer<
  typeof deleteKnowledgeSourceParamsSchema
>;

export const deleteKnowledgeSourceSchema = buildToolJsonSchema(
  'delete_knowledge_source',
  '删除知识源（其下已爬取的页面与向量数据一并删除，不可恢复）。必须先用 list_knowledge_sources 确认目标ID后再调用。',
  deleteKnowledgeSourceParamsSchema,
);

export interface DeleteKnowledgeSourceResult {
  success: boolean;
  sourceId: number;
  name?: string;
  message: string;
}

export async function executeDeleteKnowledgeSource(
  rawParams: unknown,
): Promise<DeleteKnowledgeSourceResult> {
  const parsed = safeParseToolParams(
    deleteKnowledgeSourceParamsSchema,
    rawParams,
  );
  if (!parsed.success) {
    return {
      success: false,
      sourceId: (rawParams as { sourceId?: number })?.sourceId ?? 0,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!knowledgeSourceService) {
    return {
      success: false,
      sourceId: params.sourceId,
      message: '知识源服务未初始化',
    };
  }

  try {
    // 删除前核对名称：LLM 传参张冠李戴是误删的主要来源，名称不符直接拒绝
    const source = await knowledgeSourceService.findOne(params.sourceId);
    if (
      params.name?.trim() &&
      source.name?.trim() &&
      params.name.trim() !== source.name.trim()
    ) {
      return {
        success: false,
        sourceId: params.sourceId,
        name: source.name,
        message: `名称核对失败：知识源ID ${params.sourceId} 的实际名称是《${source.name}》，与传入的《${params.name}》不符。请先用 list_knowledge_sources 核实后再重试`,
      };
    }

    await knowledgeSourceService.remove(params.sourceId);

    logger.info('FC工具 [delete_knowledge_source] 删除成功', {
      module: 'Tool:KnowledgeSourceOps',
      sourceId: params.sourceId,
      name: source.name,
    });
    return {
      success: true,
      sourceId: params.sourceId,
      name: source.name,
      message: `知识源《${source.name}》已删除（含已爬取页面与向量数据）`,
    };
  } catch (error: any) {
    logger.error('FC工具 [delete_knowledge_source] 删除失败', {
      module: 'Tool:KnowledgeSourceOps',
      sourceId: params.sourceId,
      error: error.message,
    });
    return {
      success: false,
      sourceId: params.sourceId,
      message: `删除知识源失败: ${error.message}`,
    };
  }
}

// ==================== sync_knowledge_source（需人工确认） ====================

export const syncKnowledgeSourceParamsSchema = z.object({
  sourceIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(20)
    .describe('要同步的知识源ID列表（来自 list_knowledge_sources）'),
});

export type SyncKnowledgeSourceParams = z.infer<
  typeof syncKnowledgeSourceParamsSchema
>;

export const syncKnowledgeSourceSchema = buildToolJsonSchema(
  'sync_knowledge_source',
  '触发知识源同步（爬取新内容并入库）。长任务：本工具只负责启动同步并立即返回，进度与结果用 list_knowledge_sources 查看同步状态。',
  syncKnowledgeSourceParamsSchema,
);

export interface SyncKnowledgeSourceResult {
  success: boolean;
  started: number[];
  skipped: { sourceId: number; reason: string }[];
  failed: { sourceId: number; reason: string }[];
  message: string;
}

export async function executeSyncKnowledgeSource(
  rawParams: unknown,
): Promise<SyncKnowledgeSourceResult> {
  const parsed = safeParseToolParams(
    syncKnowledgeSourceParamsSchema,
    rawParams,
  );
  if (!parsed.success) {
    return {
      success: false,
      started: [],
      skipped: [],
      failed: [],
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!knowledgeSourceService) {
    return {
      success: false,
      started: [],
      skipped: [],
      failed: [],
      message: '知识源服务未初始化',
    };
  }

  const started: number[] = [];
  const skipped: { sourceId: number; reason: string }[] = [];
  const failed: { sourceId: number; reason: string }[] = [];

  for (const sourceId of params.sourceIds) {
    try {
      // 预检同步状态：正在同步中的直接跳过，避免源内部的"正在同步"报错静默丢失
      const source = await knowledgeSourceService.findOne(sourceId);
      if (String(source.lastSyncStatus) === 'syncing') {
        skipped.push({
          sourceId,
          reason: `《${source.name}》正在同步中，跳过`,
        });
        continue;
      }

      // fire-and-forget：syncSource 是完整爬取（可能持续数分钟），
      // 工具调用不能干等。syncSource 内部已有完整的错误处理与状态落库，
      // 后台执行的结果通过 lastSyncStatus/lastSyncError 暴露
      void knowledgeSourceService.syncSource(sourceId).catch((err: any) => {
        logger.error('FC工具 [sync_knowledge_source] 后台同步失败', {
          module: 'Tool:KnowledgeSourceOps',
          sourceId,
          error: err?.message,
        });
      });
      started.push(sourceId);
      logger.info('FC工具 [sync_knowledge_source] 已启动后台同步', {
        module: 'Tool:KnowledgeSourceOps',
        sourceId,
        name: source.name,
      });
    } catch (error: any) {
      failed.push({ sourceId, reason: error.message });
    }
  }

  const parts: string[] = [];
  if (started.length > 0) parts.push(`已开始同步 ${started.length} 个源`);
  if (skipped.length > 0)
    parts.push(`跳过 ${skipped.length} 个（${skipped.map((s) => s.reason).join('；')}）`);
  if (failed.length > 0)
    parts.push(`失败 ${failed.length} 个（${failed.map((f) => f.reason).join('；')}）`);

  return {
    success: started.length > 0,
    started,
    skipped,
    failed,
    message:
      parts.length > 0
        ? `${parts.join('，')}。同步是长任务，稍后可用 list_knowledge_sources 查看同步状态`
        : '没有可同步的知识源',
  };
}

// ==================== get_knowledge_status（只读） ====================

export const getKnowledgeStatusParamsSchema = z.object({});

export const getKnowledgeStatusSchema = buildToolJsonSchema(
  'get_knowledge_status',
  '查看知识库整体状态与统计（文档数/知识源页面数/片段数/向量库状态/索引重建进度）。用户问知识库现状、健康状况时使用。',
  getKnowledgeStatusParamsSchema,
);

export interface KnowledgeStatusResult {
  success: boolean;
  status: {
    documentCount?: number;
    knowledgeSourcePageCount?: number;
    totalDocumentCount?: number;
    activeVersionCount?: number;
    totalChunkCount?: number;
    lastUpdatedAt?: string;
    vectorStore?: Record<string, unknown>;
    reindexProgress?: Record<string, unknown>;
  };
  message: string;
}

export async function executeGetKnowledgeStatus(): Promise<KnowledgeStatusResult> {
  if (!documentService || !knowledgeSourceService) {
    return {
      success: false,
      status: {},
      message: '文档/知识源服务未初始化',
    };
  }
  try {
    const stats = await documentService.getKnowledgeStats();
    const knowledgeSourcePageCount: number =
      await knowledgeSourceService.getTotalPageCount();

    // 向量库状态：与 GET /knowledge/status 端点同款动态 import（可选信息，失败不阻塞）
    let vectorStore: Record<string, unknown> = {};
    try {
      const { getKnowledgeBaseStatus } = await import('../rag-service.js');
      vectorStore = await getKnowledgeBaseStatus();
    } catch {
      // 向量库状态拿不到就降级为空，不影响统计主体
    }

    // 索引重建进度（同步方法；从未触发过重建时为 null，规范化为空对象）
    let reindexProgress: Record<string, unknown> = {};
    try {
      const progress = documentService.getReindexProgress();
      if (progress && typeof progress === 'object') {
        reindexProgress = progress as Record<string, unknown>;
      }
    } catch {
      // 同上，可选信息
    }

    return {
      success: true,
      status: {
        documentCount: stats.documentCount,
        knowledgeSourcePageCount,
        totalDocumentCount: stats.documentCount + knowledgeSourcePageCount,
        activeVersionCount: stats.activeVersionCount,
        totalChunkCount: stats.totalChunkCount,
        lastUpdatedAt: stats.lastUpdatedAt
          ? new Date(stats.lastUpdatedAt).toISOString()
          : undefined,
        vectorStore,
        reindexProgress,
      },
      message: `知识库共 ${stats.documentCount + knowledgeSourcePageCount} 个文档（上传 ${stats.documentCount} + 知识源页面 ${knowledgeSourcePageCount}），${stats.totalChunkCount} 个片段`,
    };
  } catch (error: any) {
    logger.error('FC工具 [get_knowledge_status] 查询失败', {
      module: 'Tool:KnowledgeSourceOps',
      error: error.message,
    });
    return {
      success: false,
      status: {},
      message: `查询知识库状态失败: ${error.message}`,
    };
  }
}

// ==================== rebuild_knowledge_index（高危：需人工确认） ====================

export const rebuildKnowledgeIndexParamsSchema = z.object({
  confirm: z
    .boolean()
    .describe(
      '确认执行全量重建。必须显式传 true，防止模型凭空调用重活',
    ),
});

export const rebuildKnowledgeIndexSchema = buildToolJsonSchema(
  'rebuild_knowledge_index',
  '全量重建知识库向量索引（把所有激活版本重新嵌入入库，后台长任务）。在检索质量异常或向量数据损坏时使用；日常不需要。进度用 get_knowledge_status 查看。',
  rebuildKnowledgeIndexParamsSchema,
);

export interface RebuildKnowledgeIndexResult {
  success: boolean;
  message: string;
}

export async function executeRebuildKnowledgeIndex(
  rawParams: unknown,
): Promise<RebuildKnowledgeIndexResult> {
  const parsed = safeParseToolParams(
    rebuildKnowledgeIndexParamsSchema,
    rawParams,
  );
  if (!parsed.success) {
    return { success: false, message: `参数校验失败: ${parsed.error}` };
  }
  if (parsed.data.confirm !== true) {
    return {
      success: false,
      message: '全量重建是重活，必须显式传 confirm: true 才会执行',
    };
  }

  if (!documentService) {
    return { success: false, message: '文档服务未初始化' };
  }

  try {
    // enqueueFullReindex 自带防重入：已有重建进行中时会抛错/拒绝
    await documentService.enqueueFullReindex();
    logger.info('FC工具 [rebuild_knowledge_index] 已启动全量重建', {
      module: 'Tool:KnowledgeSourceOps',
    });
    return {
      success: true,
      message: '全量索引重建已在后台启动。耗时较长（取决于文档量），进度可用 get_knowledge_status 查看',
    };
  } catch (error: any) {
    logger.error('FC工具 [rebuild_knowledge_index] 启动失败', {
      module: 'Tool:KnowledgeSourceOps',
      error: error.message,
    });
    return {
      success: false,
      message: `启动全量重建失败: ${error.message}`,
    };
  }
}
