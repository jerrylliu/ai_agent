/**
 * 设置控制器
 *
 * 职责：功能开关全局默认值（记忆/摘要/新会话注入记忆）的读写。
 *
 * 背景说明：这些开关原本只存于各前端设备的 localStorage（每设备独立），
 * 服务端没有持久化，AI 工具（跑在服务器）无法触达。本控制器把它们升级为
 * 「服务端全局默认」：runtime-config.json 的 features 区块持久化，
 * 前端未自定义过的设备跟随全局默认（自定义过的设备仍用本地值）。
 *
 * 注意边界：API Key 类配置绝不经过本控制器（密钥对 AI 物理不可达），
 * Key 管理仍走 /models/apikey 与 MinerU 专属端点。
 */

import { Body, Controller, Get, Put } from '@nestjs/common';
import { logger } from '../fundamentals/logger';
import {
  FeaturesConfigUpdateSchema,
  getFeatureDefaults,
  updateRuntimeConfig,
} from '../fundamentals/runtime-config';
import { publishSettingsChangedEvent } from '../fundamentals/chat-event-bus';

@Controller('settings')
export class SettingsController {
  /**
   * GET /settings/features
   * 获取功能开关当前生效的全局默认值
   */
  @Get('features')
  async getFeatures() {
    try {
      return { success: true, data: { defaults: getFeatureDefaults() } };
    } catch (error: any) {
      logger.error('获取功能开关默认值失败', {
        module: 'SettingsController',
        error: error.message,
      });
      return { success: false, message: `获取失败: ${error.message}` };
    }
  }

  /**
   * PUT /settings/features
   * 更新功能开关全局默认值（整体替换传入字段；未传字段保持不变）
   * 成功后广播 settings_changed 事件，在线端未自定义的设备自动跟随。
   */
  @Put('features')
  async updateFeatures(@Body() body: unknown) {
    try {
      const parsed = FeaturesConfigUpdateSchema.safeParse(body);
      if (!parsed.success) {
        const messages = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        return { success: false, message: `参数校验失败: ${messages}` };
      }

      // 全部字段都未传 = 无事可做，直接拒绝，避免无意义的写盘
      if (
        parsed.data.memoryEnabled === undefined &&
        parsed.data.summaryEnabled === undefined &&
        parsed.data.injectMemoryOnNewSession === undefined
      ) {
        return {
          success: false,
          message: 'memoryEnabled / summaryEnabled / injectMemoryOnNewSession 至少提供一个',
        };
      }

      updateRuntimeConfig({ features: parsed.data });
      publishSettingsChangedEvent({ section: 'features' });
      logger.info('功能开关全局默认已更新', {
        module: 'SettingsController',
        features: parsed.data,
      });
      return { success: true, data: { defaults: getFeatureDefaults() } };
    } catch (error: any) {
      logger.error('更新功能开关默认值失败', {
        module: 'SettingsController',
        error: error.message,
      });
      return { success: false, message: `更新失败: ${error.message}` };
    }
  }
}
