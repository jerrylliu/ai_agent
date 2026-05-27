// ==================== 模型管理控制器 ====================
// 负责处理 AI 模型的查询、切换和 API Key 配置
// 支持的模型提供商：Ollama（本地）、DeepSeek（线上）
// 路由前缀：/models

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Get, Post, Body } from '@nestjs/common';
import { logger } from '../fundamentals/logger';

// @Controller('models') 声明该类为 NestJS 控制器，路由前缀为 /models
// 即该控制器下所有路由都以 /models 开头
@Controller('models')
export class ModelController {

  /**
   * GET /models
   * 获取当前模型配置信息
   * 返回：当前使用的模型ID、可用模型列表、是否已配置 DeepSeek API Key、是否支持视觉
   */
  @Get() // 映射 GET 请求到 /models
  async getModelInfo() {
    try {
      // 动态导入 model-provider，避免循环依赖
      const { getModelInfo } = await import('../fundamentals/model-provider.js');
      // 调用服务层获取模型信息，展开返回
      return { success: true, ...getModelInfo() };
    } catch (error: any) {
      logger.error('获取模型信息失败', { module: 'ModelController', error: error.message });
      return { success: false, message: `获取模型信息失败: ${error.message}` };
    }
  }

  /**
   * POST /models/switch
   * 切换当前使用的 AI 模型
   * 请求体：{ modelId（模型标识，如 'deepseek-chat'、'qwen2.5:7b'） }
   */
  @Post('switch') // 映射 POST 请求到 /models/switch
  async switchModel(
    // @Body() 从请求体提取模型 ID
    @Body() body: { modelId: string },
  ) {
    try {
      // 动态导入 model-provider
      const { switchModel } = await import('../fundamentals/model-provider.js');
      // 校验必填参数：modelId 不能为空
      if (!body.modelId) {
        return { success: false, message: '请提供 modelId 参数' };
      }
      // 调用服务层切换模型，返回新模型的配置信息
      const config = switchModel(body.modelId);
      // 返回切换结果：成功标志、提示消息、当前模型配置
      return { success: true, message: `已切换到模型: ${body.modelId}`, currentModel: config };
    } catch (error: any) {
      logger.error('切换模型失败', { module: 'ModelController', error: error.message });
      return { success: false, message: `切换模型失败: ${error.message}` };
    }
  }

  /**
   * POST /models/apikey
   * 设置模型提供商的 API Key（目前仅支持 DeepSeek）
   * 请求体：{ provider（提供商名称，如 'deepseek'）, apiKey（API密钥） }
   */
  @Post('apikey') // 映射 POST 请求到 /models/apikey
  async setApiKey(
    // @Body() 从请求体提取提供商和 API Key
    @Body() body: { provider: string; apiKey: string },
  ) {
    try {
      // 动态导入 model-provider
      const { setDeepseekApiKey } = await import('../fundamentals/model-provider.js');
      // 校验必填参数：apiKey 不能为空
      if (!body.apiKey) {
        return { success: false, message: '请提供 apiKey 参数' };
      }
      // 根据提供商类型执行对应的 API Key 设置逻辑
      if (body.provider === 'deepseek') {
        // 设置 DeepSeek API Key
        setDeepseekApiKey(body.apiKey);
        return { success: true, message: 'DeepSeek API Key 已设置' };
      }
      // 不支持的提供商类型
      return { success: false, message: `不支持的提供者: ${body.provider}` };
    } catch (error: any) {
      logger.error('设置 API Key 失败', { module: 'ModelController', error: error.message });
      return { success: false, message: `设置 API Key 失败: ${error.message}` };
    }
  }
}
