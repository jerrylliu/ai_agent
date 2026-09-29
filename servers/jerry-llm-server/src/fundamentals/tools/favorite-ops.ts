/**
 * 收藏操作工具
 *
 * 让 Agent 可以操作 AI 生成文档的收藏夹：
 * - list_favorite_documents: 列出当前用户收藏的生成文档
 * - toggle_document_favorite: 收藏/取消收藏指定生成文档
 *
 * 按当前用户隔离：收藏属于用户数据，严格使用 ToolContext.userId，
 * 与 GeneratedDocumentService 的 userId 校验双重保险。
 */

import { z } from 'zod';
import { logger } from '../logger';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== GeneratedDocumentService 注入 ====================

let generatedDocumentService: any = null;

/**
 * 注入 GeneratedDocumentService 实例（AppModule 初始化时调用）
 */
export function initFavoriteOps(service: any): void {
  generatedDocumentService = service;
  logger.info('收藏操作工具：GeneratedDocumentService 已注入', {
    module: 'Tool:FavoriteOps',
  });
}

// ==================== list_favorite_documents（只读） ====================

export const listFavoriteDocumentsParamsSchema = z.object({});

export const listFavoriteDocumentsSchema = buildToolJsonSchema(
  'list_favorite_documents',
  '列出当前用户收藏的 AI 生成文档（标题/格式/生成时间）。用户要查看收藏夹时使用。',
  listFavoriteDocumentsParamsSchema,
);

export interface FavoriteDocumentItem {
  key: string;
  title: string;
  format: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface ListFavoriteDocumentsResult {
  success: boolean;
  total: number;
  documents: FavoriteDocumentItem[];
  message: string;
}

export async function executeListFavoriteDocuments(
  _rawParams: unknown,
  context?: { userId?: string },
): Promise<ListFavoriteDocumentsResult> {
  if (!generatedDocumentService) {
    return { success: false, total: 0, documents: [], message: '收藏服务未初始化' };
  }
  try {
    const userId = context?.userId || 'default';
    const docs: any[] = await generatedDocumentService.listFavorites(userId);
    const items: FavoriteDocumentItem[] = docs.map((d) => ({
      key: d.key,
      title: d.title,
      format: String(d.format),
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
      expiresAt: d.expiresAt ? new Date(d.expiresAt).toISOString() : undefined,
    }));
    return {
      success: true,
      total: items.length,
      documents: items,
      message:
        items.length > 0
          ? `共 ${items.length} 个收藏文档`
          : '收藏夹是空的',
    };
  } catch (error: any) {
    logger.error('FC工具 [list_favorite_documents] 查询失败', {
      module: 'Tool:FavoriteOps',
      error: error.message,
    });
    return {
      success: false,
      total: 0,
      documents: [],
      message: `查询收藏列表失败: ${error.message}`,
    };
  }
}

// ==================== toggle_document_favorite（需人工确认） ====================

export const toggleDocumentFavoriteParamsSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe('文档 key（来自 list_favorite_documents 或生成文档时的返回）'),
  favorited: z
    .boolean()
    .describe('目标状态：true=收藏，false=取消收藏'),
  title: z
    .string()
    .optional()
    .describe(
      '文档标题（建议填写，用于核对目标：与实际标题不符将拒绝执行，防止操作错对象）',
    ),
});

export type ToggleDocumentFavoriteParams = z.infer<
  typeof toggleDocumentFavoriteParamsSchema
>;

export const toggleDocumentFavoriteSchema = buildToolJsonSchema(
  'toggle_document_favorite',
  '收藏或取消收藏 AI 生成文档（收藏后不参与自动清理）。文档 key 需先通过 list_favorite_documents 确认。',
  toggleDocumentFavoriteParamsSchema,
);

export interface ToggleDocumentFavoriteResult {
  success: boolean;
  key?: string;
  favorited?: boolean;
  message: string;
}

export async function executeToggleDocumentFavorite(
  rawParams: unknown,
  context?: { userId?: string },
): Promise<ToggleDocumentFavoriteResult> {
  const parsed = safeParseToolParams(
    toggleDocumentFavoriteParamsSchema,
    rawParams,
  );
  if (!parsed.success) {
    return { success: false, message: `参数校验失败: ${parsed.error}` };
  }
  const params = parsed.data;

  if (!generatedDocumentService) {
    return { success: false, message: '收藏服务未初始化' };
  }

  try {
    const userId = context?.userId || 'default';

    // 先取文档做标题核对：LLM 传参张冠李戴时拒绝执行
    // findByKey 不带 userId（按 key 全局查），归属校验在此显式做，与 setFavorite 内部口径一致
    const entity: any = await generatedDocumentService.findByKey(params.key);
    if (!entity) {
      return {
        success: false,
        key: params.key,
        message: `文档 ${params.key} 不存在`,
      };
    }
    if (entity.userId !== null && entity.userId !== userId) {
      return {
        success: false,
        key: params.key,
        message: `文档 ${params.key} 不属于当前用户，操作被拒绝`,
      };
    }
    if (
      params.title?.trim() &&
      entity.title?.trim() &&
      params.title.trim() !== entity.title.trim()
    ) {
      return {
        success: false,
        key: params.key,
        favorited: params.favorited,
        message: `标题核对失败：文档 ${params.key} 的实际标题是《${entity.title}》，与传入的《${params.title}》不符。请先用 list_favorite_documents 核实`,
      };
    }

    const updated = await generatedDocumentService.setFavorite(
      params.key,
      userId,
      params.favorited,
    );
    if (!updated) {
      return {
        success: false,
        key: params.key,
        message: `文档 ${params.key} 不存在或不属于当前用户，操作被拒绝`,
      };
    }

    logger.info('FC工具 [toggle_document_favorite] 操作成功', {
      module: 'Tool:FavoriteOps',
      key: params.key,
      userId,
      favorited: params.favorited,
    });
    return {
      success: true,
      key: params.key,
      favorited: updated.favorited,
      message: `《${updated.title}》已${updated.favorited ? '收藏' : '取消收藏'}`,
    };
  } catch (error: any) {
    logger.error('FC工具 [toggle_document_favorite] 操作失败', {
      module: 'Tool:FavoriteOps',
      key: params.key,
      error: error.message,
    });
    return {
      success: false,
      key: params.key,
      message: `收藏操作失败: ${error.message}`,
    };
  }
}
