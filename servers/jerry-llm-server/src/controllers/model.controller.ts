// ==================== 模型管理控制器 ====================
// 负责处理 AI 模型的查询、切换和 API Key 配置
// 支持的模型提供商：Ollama（本地）、DeepSeek（线上）
// 路由前缀：/models

// 从 @nestjs/common 导入控制器所需的装饰器
import { Controller, Get, Post, Body } from '@nestjs/common';
import { logger } from '../fundamentals/logger';

// 模块级锁：防止并发探测（探测会消耗 token 且写入同一文件）
let probingInProgress = false;

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
      const { getModelInfo } =
        await import('../fundamentals/model-provider.js');
      // 调用服务层获取模型信息，展开返回
      return { success: true, ...getModelInfo() };
    } catch (error: any) {
      logger.error('获取模型信息失败', {
        module: 'ModelController',
        error: error.message,
      });
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
      return {
        success: true,
        message: `已切换到模型: ${body.modelId}`,
        currentModel: config,
      };
    } catch (error: any) {
      logger.error('切换模型失败', {
        module: 'ModelController',
        error: error.message,
      });
      return { success: false, message: `切换模型失败: ${error.message}` };
    }
  }

  /**
   * POST /models/probe
   * 探测模型能力（vision / function calling / tool_choice）
   *
   * 使用应用内存中的 API Key 进行探测，无需命令行传参，Key 不落盘。
   * 探测结果写入 src/fundamentals/capabilities.json，并清空内存缓存。
   *
   * 返回：探测结果 + 各模型的 probeNotes
   */
  @Post('probe')
  async probeModelCapabilities() {
    // 并发锁：探测耗时较长且消耗 token，禁止并发执行
    if (probingInProgress) {
      logger.warn('探测请求被拒绝：已有探测正在进行', {
        module: 'ModelController',
      });
      return { success: false, message: '探测正在进行中，请稍后再试' };
    }
    probingInProgress = true;
    logger.info('收到模型能力探测请求', { module: 'ModelController' });
    try {
      // 动态导入，避免循环依赖
      const { probeAllModels, saveCapabilitiesFile } =
        await import('../fundamentals/model-capability-prober.js');
      const { getDeepseekApiKey, getZhipuApiKey, invalidateCapabilitiesCache } =
        await import('../fundamentals/model-provider.js');
      logger.info('探测模块加载完成', { module: 'ModelController' });

      // 从应用内存读取 API Key（用户通过前端 /models/apikey 设置的）
      const keys = {
        deepseek: getDeepseekApiKey() || undefined,
        zhipu: getZhipuApiKey() || undefined,
      };
      logger.info('API Key 状态', {
        module: 'ModelController',
        hasDeepseekKey: !!keys.deepseek,
        hasZhipuKey: !!keys.zhipu,
      });

      const probeLog: string[] = [];

      const result = await probeAllModels(keys, (modelId, status, detail) => {
        const line =
          status === 'probing'
            ? `探测 ${modelId}...`
            : status === 'done'
              ? `  ${modelId} → ${detail}`
              : status === 'skipped'
                ? `跳过 ${modelId}: ${detail}`
                : `  ${modelId} 探测失败: ${detail}`;
        probeLog.push(line);
        logger.info('模型能力探测进度', {
          module: 'ModelController',
          modelId,
          status,
          detail,
        });
      });

      // 写入 capabilities.json 并清空内存缓存
      saveCapabilitiesFile(result);
      invalidateCapabilitiesCache();
      logger.info('探测结果已写入 capabilities.json 并清空缓存', {
        module: 'ModelController',
        modelCount: Object.keys(result.models).length,
        lastProbedAt: result.lastProbedAt,
      });

      return {
        success: true,
        message: `探测完成，共 ${Object.keys(result.models).length} 个模型`,
        lastProbedAt: result.lastProbedAt,
        models: result.models,
        log: probeLog,
      };
    } catch (error: any) {
      logger.error('模型能力探测失败', {
        module: 'ModelController',
        error: error.message,
        stack: error.stack,
      });
      return { success: false, message: `模型能力探测失败: ${error.message}` };
    } finally {
      probingInProgress = false;
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
      const { setDeepseekApiKey, setZhipuApiKey } =
        await import('../fundamentals/model-provider.js');
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
      if (body.provider === 'zhipu') {
        // 设置智谱 API Key
        setZhipuApiKey(body.apiKey);
        return { success: true, message: '智谱 API Key 已设置' };
      }
      // 不支持的提供商类型
      return { success: false, message: `不支持的提供者: ${body.provider}` };
    } catch (error: any) {
      logger.error('设置 API Key 失败', {
        module: 'ModelController',
        error: error.message,
      });
      return { success: false, message: `设置 API Key 失败: ${error.message}` };
    }
  }
}
