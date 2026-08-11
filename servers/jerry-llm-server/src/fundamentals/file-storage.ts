/**
 * 文件存储服务
 * 负责文档版本化文件管理：上传目录结构、文件校验、checksum 计算、文件清理
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from './logger';
import { config } from './config.js';

// 基础上传目录
const BASE_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'documents');

// 文件大小限制：50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// 允许的文件类型白名单
const ALLOWED_FILE_TYPES = new Set([
  'pdf', 'docx', 'txt', 'md', 'csv',
  'doc', 'xlsx', 'xls', 'pptx', 'ppt',
  'json', 'html', 'htm', 'xml',
]);

// MIME 类型到扩展名的映射
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/html': 'html',
};

/**
 * 确保基础目录存在
 */
function ensureBaseDir(): void {
  if (!fs.existsSync(BASE_UPLOAD_DIR)) {
    fs.mkdirSync(BASE_UPLOAD_DIR, { recursive: true });
  }
}

/**
 * 获取文档版本的存储目录
 * 格式：uploads/documents/{documentId}/v{versionNumber}/
 */
export function getVersionDir(documentId: number, versionNumber: number): string {
  ensureBaseDir();
  const dir = path.join(BASE_UPLOAD_DIR, String(documentId), `v${versionNumber}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 保存上传文件到版本目录
 * @returns 保存后的文件相对路径（用于存储到数据库）
 */
export function saveVersionFile(
  documentId: number,
  versionNumber: number,
  fileBuffer: Buffer,
  originalName: string,
): { fileUrl: string; fileSize: number; fileType: string; checksum: string } {
  const versionDir = getVersionDir(documentId, versionNumber);
  const ext = path.extname(originalName).toLowerCase().replace('.', '');
  const safeName = `document.${ext || 'bin'}`;
  const filePath = path.join(versionDir, safeName);

  fs.writeFileSync(filePath, fileBuffer);

  const checksum = calculateChecksum(fileBuffer);
  const fileSize = fileBuffer.length;

  // 相对路径：documents/{documentId}/v{versionNumber}/document.{ext}
  const fileUrl = `documents/${documentId}/v${versionNumber}/${safeName}`;

  logger.info('版本文件已保存', { module: 'FileStorageService', documentId, versionNumber, fileSize, checksum });

  return { fileUrl, fileSize, fileType: ext, checksum };
}

/**
 * 计算文件内容的 SHA-256 checksum
 */
export function calculateChecksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 校验文件大小
 */
export function validateFileSize(fileSize: number): { valid: boolean; message?: string } {
  if (fileSize > MAX_FILE_SIZE) {
    return { valid: false, message: `文件过大，最大支持 ${MAX_FILE_SIZE / 1024 / 1024}MB` };
  }
  return { valid: true };
}

/**
 * 校验文件类型
 */
export function validateFileType(fileName: string): { valid: boolean; message?: string } {
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  if (!ALLOWED_FILE_TYPES.has(ext)) {
    return { valid: false, message: `不支持的文件类型: .${ext}，允许的类型: ${Array.from(ALLOWED_FILE_TYPES).join(', ')}` };
  }
  return { valid: true };
}

/**
 * 获取文件的绝对路径
 */
export function getAbsoluteFilePath(fileUrl: string): string {
  return path.join(__dirname, '..', '..', 'uploads', fileUrl);
}

/**
 * 删除版本文件
 */
export function deleteVersionFile(fileUrl: string): boolean {
  try {
    const absPath = getAbsoluteFilePath(fileUrl);
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      // 尝试删除空目录
      const dir = path.dirname(absPath);
      const files = fs.readdirSync(dir);
      if (files.length === 0) {
        fs.rmdirSync(dir);
        // 尝试删除文档目录（如果也为空）
        const parentDir = path.dirname(dir);
        const parentFiles = fs.readdirSync(parentDir);
        if (parentFiles.length === 0) {
          fs.rmdirSync(parentDir);
        }
      }
      logger.info('版本文件已删除', { module: 'FileStorageService', fileUrl });
      return true;
    }
    return false;
  } catch (error: any) {
    logger.error('删除版本文件失败', { module: 'FileStorageService', fileUrl, error: error.message });
    return false;
  }
}

/**
 * 删除文档所有版本文件
 */
export function deleteDocumentFiles(documentId: number): boolean {
  try {
    const docDir = path.join(BASE_UPLOAD_DIR, String(documentId));
    if (fs.existsSync(docDir)) {
      fs.rmSync(docDir, { recursive: true, force: true });
      logger.info('文档所有版本文件已删除', { module: 'FileStorageService', documentId });
      return true;
    }
    return false;
  } catch (error: any) {
    logger.error('删除文档文件失败', { module: 'FileStorageService', documentId, error: error.message });
    return false;
  }
}

/**
 * 删除文档图片目录
 *
 * 多模态入库时原图存储在 storage/images/{docId}/ 下，删除文档时需要同步清理，
 * 否则 image_description 表记录删除后图片文件会变成无引用的孤儿文件。
 */
export function deleteDocumentImageFiles(documentId: number): boolean {
  try {
    // 使用 config.imageStorage.dir 与 persistImage / loadImageBuffer 保持一致，
    // 避免用户通过环境变量修改存储目录后删除路径不匹配导致孤儿文件
    const imageDir = path.resolve(
      process.cwd(),
      config.imageStorage.dir,
      String(documentId),
    );
    if (fs.existsSync(imageDir)) {
      fs.rmSync(imageDir, { recursive: true, force: true });
      logger.info('文档图片目录已删除', {
        module: 'FileStorageService',
        documentId,
        imageDir,
      });
      return true;
    }
    return false;
  } catch (error: any) {
    logger.error('删除文档图片目录失败', {
      module: 'FileStorageService',
      documentId,
      error: error.message,
    });
    return false;
  }
}

/**
 * 读取版本文件内容
 */
export function readVersionFile(fileUrl: string): Buffer | null {
  try {
    const absPath = getAbsoluteFilePath(fileUrl);
    if (fs.existsSync(absPath)) {
      return fs.readFileSync(absPath);
    }
    return null;
  } catch (error: any) {
    logger.error('读取版本文件失败', { module: 'FileStorageService', fileUrl, error: error.message });
    return null;
  }
}

/**
 * 清理 archived 超过指定天数的版本文件
 * @returns 清理的文件数量
 */
export function cleanArchivedFiles(documentId: number, versionNumber: number): boolean {
  try {
    const versionDir = path.join(BASE_UPLOAD_DIR, String(documentId), `v${versionNumber}`);
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
      logger.info('已清理 archived 版本文件', { module: 'FileStorageService', documentId, versionNumber });
      return true;
    }
    return false;
  } catch (error: any) {
    logger.error('清理 archived 文件失败', { module: 'FileStorageService', documentId, versionNumber, error: error.message });
    return false;
  }
}
