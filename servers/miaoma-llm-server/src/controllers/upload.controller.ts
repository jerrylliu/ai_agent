// ==================== 文件上传控制器 ====================
// 负责处理文件上传请求，将文件保存到服务器本地目录
// 主要用于聊天中上传图片等多模态内容
// 路由前缀：/upload

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Post, UseInterceptors, UploadedFile } from '@nestjs/common';
// 导入 Multer 文件拦截器，用于解析 multipart/form-data 格式的文件上传
import { FileInterceptor } from '@nestjs/platform-express';
// 导入 Node.js path 模块，用于处理文件路径
import * as path from 'path';
// 导入 Node.js fs 模块，用于文件系统操作（创建目录、写入文件）
import * as fs from 'fs';

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
    return { url: `http://localhost:3000/files/${safeFilename}` };
  }
}
