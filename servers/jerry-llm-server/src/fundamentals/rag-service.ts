/**
 * RAG（检索增强生成）服务
 * 完整流程：上传文档 → 解析 → 向量化 → 存储 → 检索 → 生成
 */

import {
  addDocuments,
  hybridSearchKnowledgeBase,
  getKnowledgeBaseStats,
} from './vector-store';
import { parseDocument, getMimeType } from './document-parser';
import * as path from 'path';
import * as fs from 'fs';
import type { Response } from 'express';
import { logger } from './logger';
import { config } from './config.js';
import { calculateChecksum, computeContentHash } from './file-storage.js';
import { SemanticCache } from './semantic-cache.js';
import { embeddings } from './vector-store/store-state.js';
import { UNTRUSTED_CONTEXT_INSTRUCTION } from './prompt-injection-guard.js';
import mysql from 'mysql2/promise';

// 配置
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ==================== L3 语义缓存 ====================
//
// 基于 embedding 相似度匹配的 RAG 检索结果缓存。
// 当用户查询与已缓存的查询语义相似时（如"今天天气" vs "今日天气"），直接返回缓存结果，
// 避免重复执行向量检索 + BM25 混合搜索的开销。
//
// 设计取舍：
//   - 仅缓存默认参数（topK=3, 无 filter）的检索结果，非默认参数跳过缓存
//   - 嵌入计算依赖 Ollama，不可用时降级为"始终 miss"
//   - 缓存条目上限 100，TTL 1 小时，相似度阈值 0.92
type RagSearchResult = Array<{ content: string; metadata: any; score: number; vectorScore?: number }>;

const ragSemanticCache = new SemanticCache<RagSearchResult>(
  {
    namespace: 'rag-retrieval',
    maxEntries: 100,
    ttlSec: 3600,
    similarityThreshold: 0.92,
    // v2：vectorScore 语义从 cosine 距离（越小越相似）改为相似度（= 1 - 距离，越大越相似）。
    // 版本号使旧语义条目在 get 时直接失效，避免新旧语义混存。
    // 当前为纯内存缓存（重启即清空），此防护面向未来引入持久化后端（如 Redis）的场景
    version: 2,
  },
  (text: string) => embeddings.embedQuery(text),
);

/**
 * 从检索结果构建 LLM 上下文
 *
 * 区分文本块和图片块：
 * - 文本块：`【文档 N】\n{content}`
/**
 * 把检索结果构建为 LLM 上下文
 *
 * 格式：
 * - 文档块：`【文档 N】\n{content}`
 * - 图片块：`【图片 N】\n{content}\n![图片 N](url)`
 *
 * 图片块的原图路径会转换为可访问的完整 URL（通过 /images 静态文件服务），
 * 并以 Markdown 图片语法附加在描述后面，LLM 可直接在回复中引用展示。
 */
export function buildContextFromResults(
  results: Array<{ content: string; metadata?: Record<string, any> | unknown }>,
): string {
  let docIdx = 0;
  let imgIdx = 0;

  const context = results
    .map((r) => {
      // 兼容 metadata 为 unknown 的类型（RagRetrievalResult 中 metadata: unknown）
      const meta = (r.metadata || {}) as Record<string, any>;
      if (meta.chunk_type === 'image' || meta.chunk_role === 'image') {
        imgIdx++;
        const imagePath = String(meta.image_path || '');
        // 拼接为可访问的完整 URL：http://localhost:3000/images/{docId}/img_{index}.png
        // 注意：image_path 存储时用 path.join，Windows 下为反斜杠（如 68\img_0.png），
        // 必须统一转为正斜杠，否则浏览器 URL 中 %5C 无法匹配静态文件路由
        const normalizedPath = imagePath.replace(/\\/g, '/');
        const imageUrl = normalizedPath
          ? `${config.serverBaseUrl}/images/${normalizedPath}`
          : '';
        const imageMarkdown = imageUrl
          ? `\n![图片 ${imgIdx}](${imageUrl})`
          : '';
        return `【图片 ${imgIdx}】\n${r.content}${imageMarkdown}`;
      }
      docIdx++;
      // 清理文本块中的 MinerU 残留图片引用（旧文档兼容）
      // 这些 ![](images/xxx.jpg) 是 MinerU 内部相对路径，前端无法访问
      const cleanedContent = r.content.replace(
        /!\[[^\]]*\]\((?!https?:\/\/)([^)]+)\)/g,
        '[图片]',
      );
      return `【文档 ${docIdx}】\n${cleanedContent}`;
    })
    .join('\n\n');

  // 检索内容属于不可信上下文：附加隔离指令，防止文档中的恶意指令覆盖系统规则（提示词注入纵深防御）
  if (context.trim().length > 0) {
    return context + UNTRUSTED_CONTEXT_INSTRUCTION;
  }
  return context;
}

/**
 * 处理文档上传
 * @param file 上传的文件对象（来自 multer）
 * @returns 上传结果
 */
export async function handleDocumentUpload(file: any): Promise<{
  success: boolean;
  message: string;
  documentCount?: number;
}> {
  try {
    // 检查文件大小
    if (file.size > MAX_FILE_SIZE) {
      return {
        success: false,
        message: `文件过大，最大支持 ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      };
    }

    const filePath = file.path;
    let mimeType = file.mimetype;
    const originalName = file.originalname;

    // 浏览器上传 .md 等文件时 MIME 类型常为 application/octet-stream，
    // 根据文件扩展名修正为正确的 MIME 类型
    if (mimeType === 'application/octet-stream' || !mimeType) {
      const correctedMime = getMimeType(originalName);
      if (correctedMime !== 'application/octet-stream') {
        mimeType = correctedMime;
        logger.info('修正 MIME 类型', {
          module: 'RagService',
          original: file.mimetype,
          corrected: mimeType,
        });
      }
    }

    logger.info('收到文档上传', {
      module: 'RagService',
      fileName: originalName,
      fileSizeKB: (file.size / 1024).toFixed(2),
    });

    let tempFilePath = filePath;

    if (!tempFilePath && file.buffer) {
      const timestamp = Date.now();
      const ext = path.extname(originalName) || '.tmp';
      tempFilePath = path.join(UPLOAD_DIR, `temp_${timestamp}${ext}`);
      fs.writeFileSync(tempFilePath, file.buffer);
      logger.debug('临时保存文件', {
        module: 'RagService',
        path: tempFilePath,
      });
    }

    // 解析文档内容
    logger.info('开始解析文档', { module: 'RagService' });
    const parsed = await parseDocument(tempFilePath, mimeType);
    const textContent = parsed.text;

    if (!textContent || textContent.trim().length === 0) {
      if (tempFilePath !== filePath) {
        fs.unlinkSync(tempFilePath);
      }
      return {
        success: false,
        message: '文档内容为空或无法提取文本',
      };
    }

    // ==================== 入库前查重（内容级文档去重） ====================
    // 本路径历史上无任何查重，是知识库重复内容的主要来源：
    //   1. 文件级命中（同一文件已在文档版本管理中）-> 拒绝，避免双路径重复入库
    //   2. 内容级命中（同内容不同格式）-> 放行但在结果中警告
    // 同文件重复上传（legacy 内部重复）由 addDocuments 的 chunk_hash 幂等去重兜底
    const fileChecksum = calculateChecksum(file.buffer);
    const contentHash = computeContentHash(textContent);
    const dupCheck = await checkLegacyUploadDuplicates(fileChecksum, contentHash);
    if (dupCheck.fileDuplicate) {
      if (tempFilePath !== filePath) {
        fs.unlinkSync(tempFilePath);
      }
      logger.warn('legacy 上传被文件级查重拦截', {
        module: 'RagService',
        fileName: originalName,
        duplicateDoc: dupCheck.fileDuplicate.docTitle,
        duplicateVersion: dupCheck.fileDuplicate.versionNumber,
      });
      return {
        success: false,
        message: `该文件已作为文档《${dupCheck.fileDuplicate.docTitle}》v${dupCheck.fileDuplicate.versionNumber} 上传过，请勿重复入库`,
      };
    }

    logger.info('文档解析完成', {
      module: 'RagService',
      charCount: textContent.length,
      imageCount: parsed.images.length,
    });

    // 添加到知识库（使用 Parent-Child 切分策略：小粒度检索 + 大粒度上下文）
    // 注意：旧上传路径（/knowledge/upload）不经过文档版本管理，
    // 补充 legacyUpload 标识以便与版本管理上传的文档区分，
    // 这些向量无法通过版本管理界面进行更新/归档/删除，只能通过 /knowledge/clear 全量清空
    const metadata = {
      documentTitle: originalName.replace(/\.[^/.]+$/, ''),
      source: originalName,
      uploadTime: new Date().toISOString(),
      mimeType: mimeType,
      versionStatus: 'active',
      legacyUpload: 'true',
      documentId: 'legacy',
      versionId: 'legacy',
    };

    logger.info('旧路径上传到知识库 metadata', {
      module: 'RagService',
      documentTitle: metadata.documentTitle,
      source: metadata.source,
      textLength: textContent.length,
    });

    const docCount = await addDocuments([textContent], [metadata], {
      chunkingStrategy: 'parent-child',
    });

    if (tempFilePath !== filePath) {
      fs.unlinkSync(tempFilePath);
    }

    if (docCount === 0) {
      return {
        success: false,
        message: `文档 "${originalName}" 切片失败，请检查 ChromaDB 服务是否正常运行`,
      };
    }

    // 内容级查重命中：放行但在结果消息中警告（用户可能有意重复入库不同格式文件）
    if (dupCheck.contentDuplicate) {
      logger.warn('legacy 上传内容与已有文档重复（已放行并警告）', {
        module: 'RagService',
        fileName: originalName,
        duplicateDoc: dupCheck.contentDuplicate,
      });
      return {
        success: true,
        message: `成功上传文档 "${originalName}"，已提取 ${docCount} 个文本块到知识库。⚠️ 警告：检测到文档《${dupCheck.contentDuplicate}》的内容与此文件相同（可能仅格式不同），请确认是否需要重复入库`,
        documentCount: docCount,
      };
    }

    return {
      success: true,
      message: `成功上传文档 "${originalName}"，已提取 ${docCount} 个文本块到知识库`,
      documentCount: docCount,
    };
  } catch (error: any) {
    logger.error('文档上传失败', {
      module: 'RagService',
      error: error.message,
    });
    return {
      success: false,
      message: `文档上传失败: ${error.message}`,
    };
  }
}

// ==================== 图片补查（解决文本块占位符无 URL 问题） ====================

/** MySQL 连接池（懒加载，供图片补查、上传查重等只读查询共用） */
let ragQueryPool: mysql.Pool | null = null;

/** 获取共享只读查询连接池（图片补查与上传查重共用，避免重复建池） */
function getRagQueryPool(): mysql.Pool {
  if (!ragQueryPool) {
    ragQueryPool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.username,
      password: config.db.password,
      database: config.db.database,
      connectionLimit: 2,
      waitForConnections: true,
      queueLimit: 10,
    });
  }
  return ragQueryPool;
}

/**
 * legacy 上传路径的入库前查重
 *
 * 背景：本路径（/knowledge/upload）不经过文档版本管理，历史上无任何查重，
 * 是知识库内容重复的主要来源。补两层检查：
 *   - 文件级：同一文件已作为文档版本上传过 -> 调用方应拒绝（知识库与文档管理双份入库）
 *   - 内容级：规范化内容与已有文档相同（可能仅格式不同）-> 调用方给警告
 *
 * 查询失败时不阻塞上传（打日志放行）：查重是增强能力，DB 抖动不应影响主流程
 */
async function checkLegacyUploadDuplicates(
  fileChecksum: string,
  contentHash: string | null,
): Promise<{
  fileDuplicate: { docTitle: string; versionNumber: number } | null;
  contentDuplicate: string | null;
}> {
  const result: {
    fileDuplicate: { docTitle: string; versionNumber: number } | null;
    contentDuplicate: string | null;
  } = { fileDuplicate: null, contentDuplicate: null };

  try {
    const pool = getRagQueryPool();

    // 文件级：document_versions.checksum 命中即视为重复（legacy 无版本记录，
    // 命中的一定来自文档版本管理路径，属于跨路径重复）
    const [versionRows] = await pool.execute(
      `SELECT dv.document_id, dv.version_number, d.title
       FROM document_versions dv
       LEFT JOIN documents d ON d.id = dv.document_id
       WHERE dv.checksum = ?
       LIMIT 1`,
      [fileChecksum],
    );
    if (Array.isArray(versionRows) && versionRows.length > 0) {
      const row = versionRows[0] as {
        document_id: number;
        version_number: number;
        title: string | null;
      };
      result.fileDuplicate = {
        docTitle: row.title ?? String(row.document_id ?? '未知文档'),
        versionNumber: row.version_number,
      };
    }

    // 内容级：documents.content_hash 命中说明已有相同内容的文档（可能仅格式不同）
    if (contentHash) {
      const [docRows] = await pool.execute(
        `SELECT title FROM documents WHERE content_hash = ? LIMIT 1`,
        [contentHash],
      );
      if (Array.isArray(docRows) && docRows.length > 0) {
        result.contentDuplicate = (docRows[0] as { title: string }).title;
      }
    }
  } catch (err: any) {
    logger.warn('legacy 上传查重查询失败（放行，不影响上传）', {
      module: 'RagService',
      error: err.message,
    });
  }

  return result;
}

/**
 * 查询指定文档的所有图片描述记录
 *
 * 场景：检索命中了含 `[图片]` 占位符的文本块，但没命中图片描述块时，
 * 通过 docId 补查图片信息，把可访问 URL 追加到上下文，让 LLM 能展示图片。
 */
async function queryImageDescriptionsByDocId(
  docIds: string[],
): Promise<
  Array<{
    docId: string;
    sourceIndex: number;
    imagePath: string;
    description: string;
    caption: string | null;
  }>
> {
  if (docIds.length === 0) return [];

  try {
    const pool = getRagQueryPool();

    const placeholders = docIds.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT doc_id, source_index, image_path, description, caption
       FROM image_description
       WHERE doc_id IN (${placeholders}) AND status = 'completed'
       ORDER BY doc_id, source_index`,
      docIds,
    );

    return (rows as any[]).map((r) => ({
      docId: r.doc_id,
      sourceIndex: r.source_index,
      imagePath: r.image_path,
      description: r.description || '',
      caption: r.caption,
    }));
  } catch (err: any) {
    logger.warn('补查图片描述失败', {
      module: 'RagService',
      error: err.message,
      docIds,
    });
    return [];
  }
}

/**
 * 检查结果中是否有含 `[图片]` 占位符的文本块
 */
function hasImagePlaceholder(results: Array<{ content: string }>): boolean {
  return results.some((r) => /\[图片(?:\s*\d+)?\]/.test(r.content));
}

/**
 * 图片补查：如果结果中含 [图片] 占位符的文本块但无图片块，
 * 通过 docId 补查 image_description 表，追加图片信息到结果。
 *
 * 补查策略：
 * 1. 提取原始查询关键词
 * 2. 用分层精确过滤匹配图片描述（AND → OR → 2-gram → 无过滤）
 * 3. 如果没有匹配的，不追加（避免把文档所有图片都塞进来导致 LLM 误判数量）
 * 4. 最多追加 10 张，避免上下文过长
 *
 * @param results 检索结果（会被原地修改）
 * @param query 原始查询（用于关键词匹配图片描述）
 * @returns 修改后的结果数组
 */
export async function enrichWithImageDescriptions(
  results: Array<{ content: string; metadata?: any; score?: number }>,
  query?: string,
): Promise<typeof results> {
  if (results.length === 0 || !hasImagePlaceholder(results)) {
    return results;
  }

  const docIds = collectDocIds(results);
  if (docIds.length === 0) return results;

  const imageRecords = await queryImageDescriptionsByDocId(docIds);
  if (imageRecords.length === 0) return results;

  // 检查结果中是否已有这些图片的描述块（避免重复）
  const existingImagePaths = new Set(
    results
      .map((r) => r.metadata?.image_path as string | undefined)
      .filter(Boolean),
  );
  const newImages = imageRecords.filter(
    (img) => !existingImagePaths.has(img.imagePath),
  );
  if (newImages.length === 0) return results;

  // 检测用户意图
  const isAllImagesQuery = query && detectAllImagesIntent(query);

  // 用分层精确过滤匹配图片
  let relevantImages = newImages;

  if (isAllImagesQuery) {
    // 用户明确要"所有图片"，直接返回该文档的所有图片
    logger.info('检测到"所有图片"意图，跳过关键词过滤', {
      module: 'RagService',
      query,
      totalImages: newImages.length,
    });
  } else if (query && query.trim().length > 0) {
    // 提取关键词并精确过滤
    const keywords = extractImageKeywords(query);
    if (keywords.length > 0) {
      // 过滤时匹配 description + caption
      relevantImages = filterImagesPrecise(
        newImages,
        (img) => `${img.description} ${img.caption || ''}`,
        keywords,
        query,
      );
    }
  }

  // 限制数量：所有图片查询放宽到 10 张，普通查询保持 3 张
  const MAX_IMAGES = isAllImagesQuery ? 10 : 3;
  relevantImages = relevantImages.slice(0, MAX_IMAGES);
  if (relevantImages.length === 0) return results;

  logger.info('补查图片描述，追加到检索结果', {
    module: 'RagService',
    docIds,
    newImageCount: relevantImages.length,
  });

  // 把补查的图片信息作为虚拟图片块追加到结果
  for (const img of relevantImages) {
    results.push({
      content: `${img.description}${img.caption ? `\n图注：${img.caption}` : ''}`,
      metadata: {
        chunk_type: 'image',
        image_path: img.imagePath,
        documentId: img.docId,
      },
      score: 0.5,
    });
  }

  return results;
}

/**
 * 收集结果中所有文本块的 docId（用于补查图片）
 */
function collectDocIds(
  results: Array<{ metadata?: any }>,
): string[] {
  const docIds = new Set<string>();
  for (const r of results) {
    const meta = r.metadata || {};
    const docId = meta.documentId || meta.doc_id || meta.docId;
    if (docId) docIds.add(String(docId));
  }
  return Array.from(docIds);
}

// ==================== 图片精确检索工具函数 ====================

/**
 * 同义词分组配置
 *
 * 每个子数组是一组同义词，匹配到其中任一个词时，自动扩展为组内所有词。
 * 扩展方式：用正则 `词1|词2|词3` 匹配，任一命中即算匹配成功。
 *
 * 新增同义词组只需在此数组中追加一个子数组即可，无需修改其他代码。
 * 建议按领域分组，便于维护和扩展。
 */
const SYNONYM_GROUPS: string[][] = [
  // 颜色
  ['红色', '红', '赤色', '大红'],
  ['蓝色', '蓝', '天蓝', '深蓝', '浅蓝'],
  ['绿色', '绿', '翠绿', '深绿', '浅绿'],
  ['黄色', '黄', '金黄', '橙黄'],
  ['黑色', '黑', '暗色', '深色'],
  ['白色', '白', '浅色', '银白'],
  // 图片/图像
  ['图片', '照片', '图像', '图', '截图', '插图'],
  // 人物/角色
  ['人物', '角色', '人', '英雄', '皮肤'],
  // 武器/装备
  ['武器', '装备', '道具', '兵器'],
  // 地图/场景
  ['地图', '场景', '地形', '区域', '全景'],
];

/**
 * 从用户查询中提取图片搜索关键词
 *
 * 去除意图词（"所有图片"等）和停用词，保留实体词和特征词。
 * 这些关键词用于精确过滤图片描述。
 */
function extractImageKeywords(query: string): string[] {
  // 先拆分连词（和/与/及）和连字符（-），再去除意图修饰词和停用词
  const cleaned = query
    .replace(/和|与|及/g, ' ') // 拆分连词
    .replace(/-/g, ' ') // 拆分连字符
    .replace(/所有图片|全部图片|所有图|全部图/g, '') // 去除"所有图片"短语
    .replace(/图片|照片|图像|截图|插图|原图/g, '') // 去除图片相关词
    .replace(/给我|拿出来|展示|显示|找到|查找|搜索|搜|看看|有没有|有吗|在哪|知识库/g, '')
    .replace(/所有|全部|有关|关于|的|了|是|在|有|和|或/g, '') // 去除常见停用词
    .replace(/[？?！!。，,.、\s]+/g, ' ')
    .trim();

  // 提取长度>=2的中文词组或英文单词
  const keywords = cleaned
    .split(/\s+/)
    .filter((k) => k.length >= 2)
    .map((k) => k.toLowerCase());

  return [...new Set(keywords)];
}

/**
 * 用同义词配置扩展关键词
 *
 * 对每个关键词，检查是否命中某个同义词组。命中时，将该组所有词作为扩展结果。
 * 未命中任何组的关键词保持原样。
 *
 * @returns 扩展后的关键词数组（已去重）
 */
function expandWithSynonyms(keywords: string[]): string[] {
  const expanded = new Set<string>();

  for (const kw of keywords) {
    let matched = false;
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(kw)) {
        for (const word of group) {
          expanded.add(word);
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      expanded.add(kw);
    }
  }

  return [...expanded];
}

/**
 * 检测查询是否包含图片意图
 */
function detectImageIntent(query: string): boolean {
  return /图片|照片|图像|截图|插图|原图/.test(query);
}

/**
 * 检测查询是否要求返回所有图片
 *
 * 仅当查询明确表示要"所有/全部图片"且没有具体实体时返回 true，
 * 如"所有图片""全部图片""所有有关的图片"。
 * 如果查询包含具体实体（如"所有妃寒的图片"），则返回 false，让关键词过滤生效。
 */
function detectAllImagesIntent(query: string): boolean {
  // 匹配"所有/全部...图片"的模式
  const match = query.match(/(所有|全部)(.*?)(图片|图|图像|截图|插图)/);
  if (!match) return false;

  // 提取中间的内容
  const middle = match[2].trim();

  // 如果中间没有内容，或者只有修饰词（有关、的），认为是"所有图片"意图
  if (!middle || /^[\s的有关]*$/.test(middle)) {
    return true;
  }

  // 如果中间有具体实体，不是"所有图片"意图
  return false;
}

/**
 * 对候选图片执行分层精确过滤
 *
 * 降级链：
 *   Layer 1: AND 匹配 — 图片描述必须包含所有关键词（精确匹配）
 *   Layer 2: OR 匹配 — 包含任一关键词即可（宽松匹配）
 *   Layer 3: 2-gram 匹配 — 长关键词拆成 2 字子串，任一命中即可
 *   Layer 4: 无过滤 — 返回全部候选（兜底，依赖向量检索排序）
 *
 * @param candidates 候选图片（来自向量检索结果或 MySQL 补查）
 * @param getText 从候选中提取待匹配文本的函数
 * @param keywords 提取出的关键词（已去重）
 * @param query 原始查询（用于日志）
 * @returns 过滤后的图片数组
 */
function filterImagesPrecise<T>(
  candidates: T[],
  getText: (item: T) => string,
  keywords: string[],
  query: string,
): T[] {
  if (candidates.length === 0 || keywords.length === 0) return candidates;

  // 同义词扩展
  const expandedKeywords = expandWithSynonyms(keywords);

  // Layer 1: AND 匹配 — 必须包含所有关键词（同义词组内任一命中即可）
  const andMatched = candidates.filter((img) => {
    const text = getText(img).toLowerCase();
    return expandedKeywords.every((kw) => text.includes(kw));
  });
  if (andMatched.length > 0) {
    logger.info('图片精确过滤：AND 匹配命中', {
      module: 'RagService',
      query: query.substring(0, 80),
      keywords: expandedKeywords,
      candidates: candidates.length,
      matched: andMatched.length,
    });
    return andMatched;
  }

  // Layer 2: OR 匹配 — 包含任一关键词即可
  const orMatched = candidates.filter((img) => {
    const text = getText(img).toLowerCase();
    return expandedKeywords.some((kw) => text.includes(kw));
  });
  if (orMatched.length > 0) {
    logger.info('图片精确过滤：OR 匹配命中', {
      module: 'RagService',
      query: query.substring(0, 80),
      keywords: expandedKeywords,
      candidates: candidates.length,
      matched: orMatched.length,
    });
    return orMatched;
  }

  // Layer 3: 2-gram 匹配 — 长关键词拆成 2 字子串
  const grams: string[] = [];
  for (const kw of expandedKeywords) {
    if (kw.length > 2) {
      for (let i = 0; i <= kw.length - 2; i++) {
        const gram = kw.slice(i, i + 2);
        if (!grams.includes(gram)) grams.push(gram);
      }
    }
  }
  if (grams.length > 0) {
    const gramMatched = candidates.filter((img) => {
      const text = getText(img).toLowerCase();
      return grams.some((g) => text.includes(g));
    });
    if (gramMatched.length > 0) {
      logger.info('图片精确过滤：2-gram 匹配命中', {
        module: 'RagService',
        query: query.substring(0, 80),
        grams,
        candidates: candidates.length,
        matched: gramMatched.length,
      });
      return gramMatched;
    }
  }

  // Layer 4: 无过滤，返回全部候选
  logger.info('图片精确过滤：全部降级，返回全部候选', {
    module: 'RagService',
    query: query.substring(0, 80),
    keywords: expandedKeywords,
    candidates: candidates.length,
  });
  return candidates;
}

/**
 * 图片描述块精确检索
 *
 * 用 chunk_type=image 过滤条件在向量库中检索图片描述块，
 * 然后对检索结果执行分层精确过滤（AND → OR → 2-gram → 无过滤）。
 *
 * 供 retrieveFromKnowledgeBase 和 hybridRetrieveFromKnowledgeBase 共用。
 */
async function searchImageChunksPrecise(
  query: string,
  filter: Record<string, any> | undefined,
  isAllImages: boolean,
  vectorWeight: number,
  bm25Weight: number,
): Promise<Array<{ content: string; metadata: any; score: number }>> {
  const imageTopK = isAllImages ? 50 : 20;
  const imageFilter = { ...filter, chunk_type: 'image' };

  // 图片检索使用更宽松的相似度阈值（0.95），避免过滤掉语义差异大的图片描述块
  // ChromaDB cosine distance: 0=完全相同, 1=完全不同, 值越小越相似
  const imageResults = await hybridSearchKnowledgeBase(
    query,
    imageTopK,
    vectorWeight,
    bm25Weight,
    imageFilter,
    undefined, // cacheKeyOverride
    0.95, // minSimilarity - 图片描述块语义差异大，需要更宽松
  );

  if (imageResults.length === 0 || isAllImages) {
    return imageResults.map((r) => ({
      content: r.content,
      metadata: r.metadata,
      score: r.score,
    }));
  }

  // 提取关键词并精确过滤
  const keywords = extractImageKeywords(query);
  if (keywords.length === 0) {
    return imageResults.map((r) => ({
      content: r.content,
      metadata: r.metadata,
      score: r.score,
    }));
  }

  const filtered = filterImagesPrecise(
    imageResults,
    (r) => `${r.content} ${r.metadata?.caption || ''}`,
    keywords,
    query,
  );

  return filtered.map((r) => ({
    content: r.content,
    metadata: r.metadata,
    score: r.score,
  }));
}

/**
 * RAG 检索与生成
 * @param query 用户查询
 * @param topK 检索的文档数量
 * @param filter 元数据过滤条件
 * @returns 检索到的相关文档内容
 */
export async function retrieveFromKnowledgeBase(
  query: string,
  topK: number = 3,
  filter?: Record<string, any>,
): Promise<{
  query: string;
  results: Array<{ content: string; metadata: any; score: number }>;
  context: string;
  hasResults: boolean;
}> {
  // 检测图片意图
  const isImageQuery = detectImageIntent(query);
  const isAllImagesQuery = isImageQuery && detectAllImagesIntent(query);

  if (isImageQuery) {
    logger.info('检测到图片意图，将并行检索图片描述块', {
      module: 'RagService',
      query: query.substring(0, 80),
      isAllImages: isAllImagesQuery,
    });
  }

  // L3 语义缓存：仅对默认参数（topK=3, 无 filter）启用
  const cacheable = topK === 3 && !filter;
  if (cacheable) {
    const cached = await ragSemanticCache.get(query);
    if (cached) {
      logger.info('RAG 语义缓存命中', {
        module: 'RagService',
        query: query.substring(0, 80),
      });
      const context = buildContextFromResults(cached);
      return { query, results: cached, context, hasResults: cached.length > 0 };
    }
    logger.info('RAG 语义缓存未命中，执行检索', {
      module: 'RagService',
      query: query.substring(0, 80),
    });
  }

  // 图片意图时放宽 topK，确保检索到足够的文本块和图片描述块
  const effectiveTopK = isAllImagesQuery ? Math.max(topK, 10) : topK;

  // 并行执行：常规检索 + 图片描述块精确检索（图片意图时）
  const searchPromises: Promise<Array<{ content: string; metadata: any; score: number }>>[] = [
    hybridSearchKnowledgeBase(query, effectiveTopK, 0.7, 0.3, filter),
  ];

  if (isImageQuery) {
    searchPromises.push(
      searchImageChunksPrecise(query, filter, isAllImagesQuery, 0.7, 0.3),
    );
  }

  const [textResults, imageResults] = await Promise.all(searchPromises);

  // 合并结果：文本结果 + 图片描述块结果（去重）
  const results = [...textResults];
  if (imageResults && imageResults.length > 0) {
    const existingPaths = new Set(
      results
        .filter((r) => r.metadata?.chunk_type === 'image' || r.metadata?.chunk_role === 'image')
        .map((r) => r.metadata?.image_path)
        .filter(Boolean),
    );
    for (const imgResult of imageResults) {
      const imgPath = imgResult.metadata?.image_path;
      if (!existingPaths.has(imgPath)) {
        results.push(imgResult);
        existingPaths.add(imgPath);
      }
    }
    logger.info('图片描述块检索完成，合并结果', {
      module: 'RagService',
      textResultCount: textResults.length,
      imageResultCount: imageResults.length,
      mergedCount: results.length,
    });
  }

  // 图片补查（兜底）：如果结果中仍有 [图片] 占位符但无对应图片描述块，
  // 通过 docId 补查 image_description 表
  await enrichWithImageDescriptions(results, query);

  // 写入语义缓存（仅有结果时缓存，避免空结果污染）
  if (cacheable && results.length > 0) {
    void ragSemanticCache.set(query, results);
  }

  const context = buildContextFromResults(results);

  return {
    query,
    results,
    context,
    hasResults: results.length > 0,
  };
}

/**
 * 混合检索（RAG 增强）
 * @param query 用户查询
 * @param topK 检索的文档数量
 * @param vectorWeight 向量检索权重
 * @param bm25Weight BM25 检索权重
 * @param filter 元数据过滤条件
 * @returns 检索到的相关文档内容
 */
export async function hybridRetrieveFromKnowledgeBase(
  query: string,
  topK: number = 3,
  vectorWeight: number = 0.7,
  bm25Weight: number = 0.3,
  filter?: Record<string, any>,
): Promise<{
  query: string;
  results: Array<{
    content: string;
    metadata: any;
    score: number;
    sources: string[];
  }>;
  context: string;
  hasResults: boolean;
}> {
  // 检测图片意图
  const isImageQuery = detectImageIntent(query);
  const isAllImagesQuery = isImageQuery && detectAllImagesIntent(query);

  if (isImageQuery) {
    logger.info('检测到图片意图（混合检索），将并行检索图片描述块', {
      module: 'RagService',
      query: query.substring(0, 80),
      isAllImages: isAllImagesQuery,
    });
  }

  // L3 语义缓存：仅对默认参数启用
  const cacheable =
    topK === 3 && vectorWeight === 0.7 && bm25Weight === 0.3 && !filter;
  if (cacheable) {
    const cached = await ragSemanticCache.get(query);
    if (cached) {
      logger.info('RAG 语义缓存命中（混合检索）', {
        module: 'RagService',
        query: query.substring(0, 80),
      });
      const context = buildContextFromResults(cached);
      return {
        query,
        results: cached.map((r) => ({ ...r, sources: [] })),
        context,
        hasResults: cached.length > 0,
      };
    }
  }

  // 图片意图时放宽 topK
  const effectiveTopK = isAllImagesQuery ? Math.max(topK, 10) : topK;

  // 并行执行：常规检索 + 图片描述块精确检索（图片意图时）
  const searchPromises: Promise<Array<{ content: string; metadata: any; score: number; sources?: string[] }>>[] = [
    hybridSearchKnowledgeBase(query, effectiveTopK, vectorWeight, bm25Weight, filter),
  ];

  if (isImageQuery) {
    searchPromises.push(
      searchImageChunksPrecise(query, filter, isAllImagesQuery, vectorWeight, bm25Weight),
    );
  }

  const [textResults, imageResults] = await Promise.all(searchPromises);

  // 合并结果：文本结果 + 图片描述块结果（去重）
  const merged: Array<{ content: string; metadata: any; score: number; sources: string[] }> = textResults.map((r) => ({
    content: r.content,
    metadata: r.metadata,
    score: r.score,
    sources: r.sources || [],
  }));
  if (imageResults && imageResults.length > 0) {
    const existingPaths = new Set(
      merged
        .filter((r) => r.metadata?.chunk_type === 'image' || r.metadata?.chunk_role === 'image')
        .map((r) => r.metadata?.image_path)
        .filter(Boolean),
    );
    for (const imgResult of imageResults) {
      const imgPath = imgResult.metadata?.image_path;
      if (!existingPaths.has(imgPath)) {
        merged.push({
          content: imgResult.content,
          metadata: imgResult.metadata,
          score: imgResult.score,
          sources: imgResult.sources || [],
        });
        existingPaths.add(imgPath);
      }
    }
    logger.info('图片描述块检索完成（混合检索），合并结果', {
      module: 'RagService',
      textResultCount: textResults.length,
      imageResultCount: imageResults.length,
      mergedCount: merged.length,
    });
  }

  // 图片补查（兜底）：如果结果中仍有 [图片] 占位符但无对应图片描述块，
  // 通过 docId 补查 image_description 表
  await enrichWithImageDescriptions(merged, query);

  // 写入语义缓存（仅有结果时缓存，避免空结果污染）
  if (cacheable && merged.length > 0) {
    void ragSemanticCache.set(query, merged);
  }

  const context = buildContextFromResults(merged);

  return {
    query,
    results: merged,
    context,
    hasResults: merged.length > 0,
  };
}
/**
 * 使用 RAG 进行问答
 * 结合检索到的文档和 LLM 生成回答
 */
export async function ragWithLLM(
  query: string,
  history: Array<{ role: string; content: string }> = [],
  res?: Response,
): Promise<any> {
  // 1. 检索相关文档
  logger.info('执行 RAG 检索', { module: 'RagService' });
  const retrieval = await retrieveFromKnowledgeBase(query, 3);

  if (retrieval.results.length === 0) {
    logger.warn('知识库中没有找到相关内容', { module: 'RagService' });
    return {
      success: false,
      message: '知识库中没有找到与您问题相关的内容，请先上传相关文档',
    };
  }

  logger.info('找到相关文档', {
    module: 'RagService',
    resultCount: retrieval.results.length,
  });

  // 2. 构建增强后的提示词
  const augmentedPrompt = `
你是一个智能知识库助手。你会优先依据【参考资料】回答，但在资料完全无关联时，会动用自身知识帮助用户。请严格遵守以下决策规则：

### 第一步：判断资料相关性
在回答前，先快速评估【参考资料】是否与用户问题有任何实质关联（哪怕只涉及部分关键词或侧面信息）。
- 如果存在**任何一点**关联，进入“基于资料模式”。
- 如果**完全无关**（连一个相关词、相关概念都没有），进入“自主回答模式”。

### 第二步：按模式回答
**基于资料模式**（资料有任一部分相关）：
- 必须100%扎根于资料，不添加任何外部知识。
- 穷尽资料中所有相关条目，逐条完整列出，不得省略、概括或缩减。
- 若资料只覆盖问题的一部分，请先列出已有信息，再明确说明：“资料中未涉及以下方面：[具体缺失点]”。
- 若资料存在矛盾，请将矛盾点并列陈述，不加主观评判。
- 格式纯净：不要有任何寒暄、自我评价或补充建议。

**自主回答模式**（资料完全无关）：
- 首先明确告知：“知识库中未找到相关信息，以下回答基于我的通用知识，请谨慎参考。”
- 然后使用你自己的知识尽量回答问题，力求准确、完整。
- 如果连通用知识也无法给出确定答案，请如实说明不确定性。

【参考文档】：
${retrieval.context}

【用户问题】：${query}
你的回答：
`;

  // 3. 这里可以调用 LLM 生成回答
  // 由于当前实现中，RAG 和 LLM 调用是分开的，
  // 这个函数返回增强后的提示词，实际的 LLM 调用在 prompt.ts 中进行

  return {
    success: true,
    augmentedPrompt,
    retrieval,
  };
}

/**
 * 获取知识库状态
 */
export async function getKnowledgeBaseStatus(): Promise<{
  status: 'ready' | 'empty' | 'error';
  message: string;
  stats?: {
    documentCount: number;
    collectionName: string;
  };
}> {
  try {
    const stats = await getKnowledgeBaseStats();
    return {
      status: 'ready',
      message: '知识库就绪',
      stats,
    };
  } catch (error: any) {
    return {
      status: 'error',
      message: `知识库错误: ${error.message}`,
    };
  }
}
