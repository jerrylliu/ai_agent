/**
 * 语音识别 HTTP 控制器
 *
 * 提供长音频文件转写接口：
 * - POST /api/speech/transcribe —— 上传音频文件，提交转写任务
 * - GET  /api/speech/transcribe/:taskId —— 查询转写结果
 *
 * 路由前缀：speech
 */

import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard.js';
import { SpeechService } from '../services/speech.service.js';
import { config } from '../fundamentals/config.js';
import * as path from 'path';
import * as fs from 'fs';

@Controller('speech')
@UseGuards(AuthGuard)
export class SpeechController {

  constructor(private readonly speechService: SpeechService) {}

  /**
   * POST /speech/transcribe
   * 上传音频文件并提交转写任务
   *
   * 音频文件先保存到服务器 tmp/audios/ 目录，
   * 然后通过 HTTP URL 提交给火山引擎录音文件识别服务。
   */
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  async transcribe(
    @Req() req: any,
    @UploadedFile() file: any,
    @Body('format') format?: string,
  ) {
    if (!file) {
      throw new BadRequestException('未提供音频文件');
    }

    const userId = req.user?.sub || 'system';

    // 保存到 tmp/audios/
    const audioDir = path.join(__dirname, '..', '..', 'tmp', 'audios');
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname) || `.${format || 'wav'}`;
    const safeFilename = `${timestamp}_${randomStr}${ext}`;
    const filePath = path.join(audioDir, safeFilename);
    fs.writeFileSync(filePath, file.buffer);

    // 构建可访问的 URL
    const audioUrl = `${config.serverBaseUrl}/audios/${safeFilename}`;
    const audioFormat = (format || ext.replace('.', '') || 'wav').toLowerCase();

    try {
      const result = await this.speechService.submitTranscribe(audioUrl, audioFormat, userId);
      return { taskId: result.taskId, status: 'pending' };
    } catch (e: any) {
      throw new BadRequestException(`提交转写任务失败: ${e.message}`);
    }
  }

  /**
   * GET /speech/transcribe/:taskId
   * 查询转写结果
   */
  @Get('transcribe/:taskId')
  async queryTranscribe(@Req() req: any, @Param('taskId') taskId: string) {
    const userId = req.user?.sub || 'system';
    const result = await this.speechService.queryTranscribe(taskId, userId);
    return result;
  }
}
