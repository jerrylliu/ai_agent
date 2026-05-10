import { Controller, Post, Body, Get, Put, UseGuards, Req, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import * as path from 'path';
import * as fs from 'fs';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(
    @Body() body: {
      email?: string;
      phone?: string;
      password: string;
      username?: string;
    },
  ) {
    return this.authService.register(body);
  }

  @Post('login')
  async login(
    @Body() body: {
      account: string;
      password: string;
    },
  ) {
    return this.authService.login(body);
  }

  @Get('profile')
  @UseGuards(AuthGuard)
  async getProfile(@Req() req: any) {
    return this.authService.getUserById(req.user.sub);
  }

  @Put('profile')
  @UseGuards(AuthGuard)
  async updateProfile(
    @Req() req: any,
    @Body() body: { username?: string; avatar?: string },
  ) {
    return this.authService.updateProfile(req.user.sub, body);
  }

  @Post('avatar')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(@Req() req: any, @UploadedFile() file: any) {
    if (!file) {
      throw new BadRequestException('请选择头像文件');
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 JPG、PNG、GIF、WebP 格式的图片');
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('头像文件大小不能超过 20MB');
    }

    const uploadDir = path.join(__dirname, '..', '..', '..', 'uploads', 'avatars');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname) || '.png';
    const safeFilename = `${timestamp}_${randomStr}${ext}`;

    const filePath = path.join(uploadDir, safeFilename);
    fs.writeFileSync(filePath, file.buffer);

    const avatarUrl = `http://localhost:3000/files/avatars/${safeFilename}`;

    return this.authService.updateProfile(req.user.sub, { avatar: avatarUrl });
  }

  @Put('password')
  @UseGuards(AuthGuard)
  async changePassword(
    @Req() req: any,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(req.user.sub, body.oldPassword, body.newPassword);
  }

  @Get('verify')
  @UseGuards(AuthGuard)
  async verifyToken(@Req() req: any) {
    const user = await this.authService.getUserById(req.user.sub);
    return {
      success: true,
      valid: true,
      user,
    };
  }
}
