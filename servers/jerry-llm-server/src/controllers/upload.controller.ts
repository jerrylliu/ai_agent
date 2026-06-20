// ==================== 文件上传控制器 ====================
// 负责处理文件上传请求，将文件保存到服务器本地目录
// 主要用于聊天中上传图片等多模态内容
// 路由前缀：/upload

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Post, UseInterceptors, UploadedFile, HttpException } from '@nestjs/common';
// 导入 Multer 文件拦截器，用于解析 multipart/form-data 格式的文件上传
import { FileInterceptor } from '@nestjs/platform-express';
// 导入 Node.js path 模块，用于处理文件路径
import * as path from 'path';
// 导入 Node.js fs 模块，用于文件系统操作（创建目录、写入文件）
import * as fs from 'fs';
import { config } from '../fundamentals/config';
import { parseDocument, getMimeType } from '../fundamentals/document-parser';
import { logger } from '../fundamentals/logger';

// @Controller('upload') 声明该类为 NestJS 控制器，路由前缀为 /upload
@Controller('upload')
export class UploadController {

  /**
   * POST /upload
   * 上传文件到服务器
   * 使用 Multer 中间件解析上传的文件，保存到 uploads 目录
   * 文件名格式：{时间戳}_{随机字符串}{原始扩展名}，避免文件名冲突
   */
  @Post() // 映射 POST 请求到 /upload
  // @UseInterceptors(FileInterceptor('file')) 使用 Multer 文件拦截器
  // 'file' 是前端表单中文件字段的名称（FormData 的 key）
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    // @UploadedFile() 注入 Multer 解析后的文件对象
    // 包含：originalname（原始文件名）、buffer（文件二进制数据）、mimetype（MIME类型）等
    @UploadedFile() file: any,
  ) {
    // 构建上传目录的绝对路径：项目根目录/uploads
    const uploadDir = path.join(__dirname, '..', '..', 'uploads');

    // 检查上传目录是否存在，不存在则递归创建
    if (!fs.existsSync(uploadDir)) {
      // { recursive: true } 允许创建多级目录
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // 生成安全的文件名，避免文件名冲突和特殊字符问题
    const timestamp = Date.now(); // 当前时间戳，保证时间唯一性
    const randomStr = Math.random().toString(36).substring(2, 8); // 6位随机字符串，增强唯一性
    const ext = path.extname(file.originalname); // 提取原始文件的扩展名（如 .png、.jpg）
    // 组合最终文件名：时间戳_随机字符串.扩展名
    const safeFilename = `${timestamp}_${randomStr}${ext}`;

    // 构建文件的完整存储路径
    const filePath = path.join(uploadDir, safeFilename);
    // 将文件二进制数据写入磁盘
    fs.writeFileSync(filePath, file.buffer);

    // 返回文件的访问 URL，前端通过此 URL 引用上传的文件
    // 注意：需要配合静态文件服务中间件（如 ServeStaticModule）才能通过 URL 访问
    return { url: `${config.serverBaseUrl}/files/${safeFilename}` };
  }

  /**
   * POST /upload/extract
   * 上传文档并提取纯文本内容，用于聊天中让 AI 能真正读到文档内容
   *
   * 返回：
   *   - text: 提取的纯文本
   *   - contentJson: 转换为 Tiptap JSONContent 格式（可直接喂给编辑器）
   *   - fileName: 原始文件名
   *   - sizeBytes: 文件大小
   *
   * 与 POST /upload 的区别：
   *   - /upload 只存文件返回 URL，AI 读不到内容
   *   - /upload/extract 会解析文件内容，让 AI 能基于内容回答问题
   */
  @Post('extract')
  @UseInterceptors(FileInterceptor('file'))
  async extractDocument(@UploadedFile() file: any) {
    if (!file) {
      throw new HttpException('未收到文件', 400);
    }

    // multer 默认用 latin1 解码 originalname，中文会乱码
    // 转回 utf8 才能正确显示中文文件名
    const fileName: string = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const sizeBytes: number = file.size;
    const mimeType: string = file.mimetype || getMimeType(fileName);

    // 写入临时文件供解析器读取（pdf-parse / mammoth 需要文件路径）
    const uploadDir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(fileName);
    const safeFilename = `${timestamp}_${randomStr}${ext}`;
    const tempFilePath = path.join(uploadDir, safeFilename);
    fs.writeFileSync(tempFilePath, file.buffer);

    try {
      const text = await parseDocument(tempFilePath, mimeType);

      // 超长文档截断（避免 token 爆炸），保留前 5 万字符
      const MAX_CHARS = 50000;
      const truncated = text.length > MAX_CHARS;
      const safeText = truncated ? text.slice(0, MAX_CHARS) : text;

      // 将纯文本转换为 Tiptap JSONContent 结构
      // 按段落拆分，每段一个 paragraph 节点
      const paragraphs = safeText
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .slice(0, 500); // 最多 500 段，防止恶意大文档

      const contentJson = {
        type: 'doc',
        content: paragraphs.length > 0
          ? paragraphs.map(p => ({
              type: 'paragraph',
              content: [{ type: 'text', text: p }],
            }))
          : [{ type: 'paragraph' }],
      };

      // 同时保留文件 URL 供下载
      const fileUrl = `${config.serverBaseUrl}/files/${safeFilename}`;

      // 输入框上传仅解析内容不入库，文档记录在编辑器保存时按文件名创建/新增版本
      logger.info('文档内容提取成功', {
        module: 'UploadController',
        fileName,
        mimeType,
        sizeBytes,
        textLength: safeText.length,
        truncated,
        paragraphs: paragraphs.length,
      });

      return {
        text: safeText,
        contentJson,
        fileName,
        sizeBytes,
        fileUrl,
        truncated,
        maxChars: MAX_CHARS,
        totalChars: text.length,
      };
    } catch (err: any) {
      logger.error('文档内容提取失败', {
        module: 'UploadController',
        fileName,
        mimeType,
        error: err.message,
      });
      throw new HttpException(`文档解析失败: ${err.message}`, 422);
    }
    // 注意：不删除临时文件，保留供下载（fileUrl 指向它）
  }
}
