// ==================== 嵌入模型配置控制器 ====================
// 负责知识库嵌入模型的「本地总开关 + 云端」配置
// - 查询当前嵌入配置（GET /embedding/config）
// - 试嵌入验证（POST /embedding/test，可独立验证本地或云端某一条路径）
// - 保存配置（POST /embedding/config）
// - 切换本地总开关（POST /embedding/switch）
// - 全量重建当前生效集合的向量索引（POST /embedding/rebuild，后台异步执行）
// - 查询全量重建进度（GET /embedding/rebuild/status，供前端轮询）
//
// 总开关语义（localEnabled）：
// - true ：优先本地 Ollama；探测到本地不可用时自动降级云端
// - false：只使用云端嵌入
// 实际生效模式（ollama / cloud）是运行时解析结果，通过 config 接口回显，不持久化。
// 路由前缀：/embedding

import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { ZodValidationPipe } from '../fundamentals/zod-validation.pipe.js';
import { logger } from '../fundamentals/logger.js';
import { encrypt } from '../fundamentals/crypto.js';
import {
  getRuntimeConfig,
  updateRuntimeConfig,
  EmbeddingModeSchema,
  CloudEmbeddingProviderSchema,
  type EmbeddingRuntimeConfig,
  type CloudEmbeddingProvider,
} from '../fundamentals/runtime-config.js';
import {
  EMBEDDING_PROVIDER_PRESETS,
  testEmbedding,
  describeEmbeddingConfig,
} from '../fundamentals/vector-store/embedding-provider.js';
import {
  applyEmbeddingConfigChange,
  getActiveCollectionName,
  getActiveModelName,
  getEmbeddingMode,
  getLocalFallbackReason,
  resolveEffectiveMode,
} from '../fundamentals/vector-store/store-state.js';
import { DocumentService } from '../services/document.service.js';

// ==================== Zod Schema ====================

const OllamaConfigSchema = z.object({
  baseUrl: z
    .string()
    .max(500)
    .optional()
    .describe('Ollama 服务地址，如 http://localhost:11434'),
  model: z.string().max(200).optional().describe('嵌入模型名称，如 bge-m3'),
});

const CloudConfigSchema = z.object({
  provider: CloudEmbeddingProviderSchema.optional().describe('云端供应商'),
  baseUrl: z
    .string()
    .max(500)
    .optional()
    .describe('OpenAI 兼容端点地址（留空时使用供应商预设地址）'),
  // 明文 API Key，仅作为入参传递，服务端加密后存储，任何响应中都不返回
  apiKey: z.string().max(500).optional().describe('云端 API Key（明文，服务端加密存储）'),
  model: z
    .string()
    .max(200)
    .optional()
    .describe('嵌入模型名称（留空时使用供应商预设模型）'),
});

const SaveEmbeddingConfigSchema = z.object({
  localEnabled: z.boolean().optional().describe('本地嵌入总开关'),
  ollama: OllamaConfigSchema.optional().describe('本地 Ollama 配置'),
  cloud: CloudConfigSchema.optional().describe('云端嵌入配置'),
});
type SaveEmbeddingConfigDto = z.infer<typeof SaveEmbeddingConfigSchema>;

const TestEmbeddingConfigSchema = z.object({
  // 验证某一条具体路径（本地 / 云端），与当前生效模式无关
  mode: EmbeddingModeSchema.describe('要验证的嵌入模式'),
  ollama: OllamaConfigSchema.optional().describe('本地 Ollama 配置（缺省字段回退已保存配置）'),
  cloud: CloudConfigSchema.optional().describe('云端嵌入配置（缺省字段回退已保存配置）'),
});
type TestEmbeddingConfigDto = z.infer<typeof TestEmbeddingConfigSchema>;

const ToggleLocalEmbeddingSchema = z.object({
  localEnabled: z.boolean().describe('本地嵌入总开关目标值'),
});
type ToggleLocalEmbeddingDto = z.infer<typeof ToggleLocalEmbeddingSchema>;

/**
 * 把请求入参与已保存配置合并为完整的嵌入配置快照
 *
 * - 明文 apiKey 会先加密再参与验证 / 保存
 * - 未提供的字段回退到已保存的配置（支持部分更新）
 */
function buildCandidateConfig(body: {
  localEnabled?: boolean;
  ollama?: { baseUrl?: string; model?: string };
  cloud?: {
    provider?: CloudEmbeddingProvider;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}): EmbeddingRuntimeConfig {
  const saved = getRuntimeConfig().embedding;
  return {
    localEnabled: body.localEnabled ?? saved.localEnabled,
    ollama: { ...saved.ollama, ...body.ollama },
    cloud: {
      provider: body.cloud?.provider ?? saved.cloud.provider,
      baseUrl: body.cloud?.baseUrl ?? saved.cloud.baseUrl,
      model: body.cloud?.model ?? saved.cloud.model,
      // 传了新 apiKey 则加密后使用，否则沿用已保存的密文
      apiKeyEncrypted: body.cloud?.apiKey
        ? encrypt(body.cloud.apiKey)
        : saved.cloud.apiKeyEncrypted,
    },
  };
}

/**
 * 保存前验证候选配置：确定"可能生效"的路径并验证，避免存入完全不可用的配置
 *
 * - 关闭本地（localEnabled=false）：只有云端一条路，必须验证云端可用
 * - 开启本地（localEnabled=true）：优先验证本地；本地不可用时验证云端兜底，
 *   两条路都不可用才拒绝保存（此时生效模式会降级为云端）
 */
async function verifyCandidateConfig(
  cfg: EmbeddingRuntimeConfig,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (!cfg.localEnabled) {
    const cloud = await testEmbedding(cfg, 'cloud');
    return cloud.ok
      ? { ok: true }
      : { ok: false, message: `云端嵌入不可用：${cloud.error}`, error: cloud.error };
  }

  const local = await testEmbedding(cfg, 'ollama');
  if (local.ok) return { ok: true };

  // 本地不可用 → 生效模式会降级云端，验证云端是否兜得住
  const cloud = await testEmbedding(cfg, 'cloud');
  if (cloud.ok) return { ok: true };

  return {
    ok: false,
    message: `本地嵌入不可用（${local.error}），云端嵌入也不可用（${cloud.error}），请至少配置好其中一种`,
    error: cloud.error,
  };
}

/**
 * 构造对外的配置响应（apiKey 只暴露"是否已配置"，绝不返回密文或明文）
 *
 * mode / fallbackReason / activeModel / activeCollection 均为运行时生效状态，
 * 调用前应确保已执行 resolveEffectiveMode（GET 与切换/保存后都会刷新）。
 */
function buildConfigResponse(): Record<string, unknown> {
  const cfg = getRuntimeConfig().embedding;
  return {
    localEnabled: cfg.localEnabled,
    // 运行时解析出的生效模式（可能与 localEnabled 不同：本地不可用时降级云端）
    mode: getEmbeddingMode(),
    // 本地降级云端的原因（未降级为 null），前端据此提示用户
    fallbackReason: getLocalFallbackReason(),
    activeModel: getActiveModelName(),
    activeCollection: getActiveCollectionName(),
    ollama: { ...cfg.ollama },
    cloud: {
      provider: cfg.cloud.provider,
      baseUrl: cfg.cloud.baseUrl,
      model: cfg.cloud.model,
      hasApiKey: !!cfg.cloud.apiKeyEncrypted,
    },
    presets: EMBEDDING_PROVIDER_PRESETS,
  };
}

@Controller('embedding')
@UseGuards(OptionalAuthGuard)
export class EmbeddingController {
  constructor(private readonly documentService: DocumentService) {}

  /**
   * GET /embedding/config
   * 获取当前嵌入配置（总开关 / 生效模式 / Ollama / 云端 / 供应商预设）
   *
   * 会先解析一次生效模式（探测结果缓存 30 秒），保证回显的 mode / fallbackReason 准确。
   */
  @Get('config')
  async getConfig() {
    await resolveEffectiveMode();
    return { success: true, config: buildConfigResponse() };
  }

  /**
   * POST /embedding/test
   * 试嵌入验证：用给定配置真实生成一次向量，验证指定路径（本地 / 云端）是否可用
   * 不会保存任何配置
   */
  @Post('test')
  async testConfig(
    @Body(new ZodValidationPipe(TestEmbeddingConfigSchema, { label: 'TestEmbeddingConfig' }))
    body: TestEmbeddingConfigDto,
  ) {
    const candidate = buildCandidateConfig(body);
    logger.info('收到嵌入配置验证请求', {
      module: 'EmbeddingController',
      mode: body.mode,
      description: describeEmbeddingConfig(candidate, body.mode),
    });
    const result = await testEmbedding(candidate, body.mode);
    return { success: result.ok, ...result };
  }

  /**
   * POST /embedding/config
   * 保存嵌入配置（支持部分更新）
   *
   * - 保存前先验证候选配置（按总开关语义验证可能生效的路径），失败则不保存
   * - 保存成功后失效嵌入单例、重置向量存储并强制重新解析生效模式
   */
  @Post('config')
  async saveConfig(
    @Body(new ZodValidationPipe(SaveEmbeddingConfigSchema, { label: 'SaveEmbeddingConfig' }))
    body: SaveEmbeddingConfigDto,
  ) {
    try {
      const candidate = buildCandidateConfig(body);

      const verification = await verifyCandidateConfig(candidate);
      if (!verification.ok) {
        logger.warn('嵌入配置验证失败，拒绝保存', {
          module: 'EmbeddingController',
          localEnabled: candidate.localEnabled,
          error: verification.error,
        });
        return {
          success: false,
          message: verification.message,
          error: verification.error,
        };
      }

      updateRuntimeConfig({
        embedding: {
          localEnabled: body.localEnabled,
          ollama: body.ollama,
          cloud: body.cloud
            ? {
                provider: body.cloud.provider,
                baseUrl: body.cloud.baseUrl,
                model: body.cloud.model,
                // 明文 apiKey 加密后存储；未传则不动原密文
                apiKeyEncrypted: body.cloud.apiKey
                  ? encrypt(body.cloud.apiKey)
                  : undefined,
              }
            : undefined,
        },
      });

      applyEmbeddingConfigChange();
      // 强制重新探测本地并解析生效模式，保证回显状态与最新配置一致
      await resolveEffectiveMode(true);

      logger.info('嵌入配置已保存并生效', {
        module: 'EmbeddingController',
        localEnabled: getRuntimeConfig().embedding.localEnabled,
        mode: getEmbeddingMode(),
        description: describeEmbeddingConfig(getRuntimeConfig().embedding, getEmbeddingMode()),
      });

      return { success: true, config: buildConfigResponse() };
    } catch (error: any) {
      logger.error('保存嵌入配置失败', {
        module: 'EmbeddingController',
        error: error.message,
      });
      return { success: false, message: `保存嵌入配置失败: ${error.message}` };
    }
  }

  /**
   * POST /embedding/switch
   * 切换本地嵌入总开关（前端开关专用）
   *
   * - 开启：优先本地，本地不可用自动降级云端
   * - 关闭：只用云端
   * 切换前先验证目标开关下"可能生效"的路径，全部不可用则拒绝切换、保持原状态。
   */
  @Post('switch')
  async toggleLocal(
    @Body(new ZodValidationPipe(ToggleLocalEmbeddingSchema, { label: 'ToggleLocalEmbedding' }))
    body: ToggleLocalEmbeddingDto,
  ) {
    try {
      const current = getRuntimeConfig().embedding;
      if (body.localEnabled === current.localEnabled) {
        await resolveEffectiveMode();
        return {
          success: true,
          message: body.localEnabled ? '本地优先已开启' : '本地已关闭（仅云端）',
          config: buildConfigResponse(),
        };
      }

      const candidate: EmbeddingRuntimeConfig = {
        ...current,
        localEnabled: body.localEnabled,
      };
      const verification = await verifyCandidateConfig(candidate);
      if (!verification.ok) {
        logger.warn('嵌入总开关切换验证失败，保持原状态', {
          module: 'EmbeddingController',
          targetLocalEnabled: body.localEnabled,
          error: verification.error,
        });
        return {
          success: false,
          message: verification.message,
          error: verification.error,
        };
      }

      updateRuntimeConfig({ embedding: { localEnabled: body.localEnabled } });
      applyEmbeddingConfigChange();
      await resolveEffectiveMode(true);

      const mode = getEmbeddingMode();
      logger.info('本地嵌入总开关已切换', {
        module: 'EmbeddingController',
        localEnabled: body.localEnabled,
        mode,
        collection: getActiveCollectionName(),
      });

      return {
        success: true,
        message: body.localEnabled
          ? mode === 'ollama'
            ? '已开启本地优先（当前生效：本地 Ollama）'
            : '已开启本地优先，但本地暂不可用，当前生效：云端'
          : '已关闭本地，当前生效：云端',
        config: buildConfigResponse(),
      };
    } catch (error: any) {
      logger.error('切换本地嵌入总开关失败', {
        module: 'EmbeddingController',
        error: error.message,
      });
      return { success: false, message: `切换失败: ${error.message}` };
    }
  }

  /**
   * POST /embedding/rebuild
   * 全量重建当前生效集合的向量索引（可选操作）
   *
   * 集合按嵌入模型指纹隔离：本地 bge-m3 与云端 BAAI/bge-m3 同指纹共用集合，
   * 切换/降级无需重建；换成不同模型时集合变化，需重建把文档同步到新集合。
   * 此端点入队后**立即在进程内后台异步执行**，HTTP 请求不阻塞，
   * 返回初始进度快照；前端通过 GET /embedding/rebuild/status 轮询进度。
   */
  @Post('rebuild')
  async rebuild() {
    try {
      const { enqueued, progress } =
        await this.documentService.enqueueFullReindex();
      logger.info('全量重建向量索引任务已启动', {
        module: 'EmbeddingController',
        enqueued,
        collection: getActiveCollectionName(),
      });
      // enqueued=0 且已有进度：说明上一次重建仍在进行中（防重入命中）
      const alreadyRunning = enqueued === 0 && progress.running;
      return {
        success: true,
        message: alreadyRunning
          ? `已有重建任务进行中（${progress.done}/${progress.total}），请稍后查看进度`
          : `已启动 ${enqueued} 个文档版本的重建任务，正在后台执行`,
        enqueued,
        progress,
      };
    } catch (error: any) {
      logger.error('全量重建向量索引失败', {
        module: 'EmbeddingController',
        error: error.message,
      });
      return { success: false, message: `全量重建失败: ${error.message}` };
    }
  }

  /**
   * GET /embedding/rebuild/status
   * 查询全量重建进度（供前端轮询）
   *
   * 返回进程内进度快照：total/done/failed/retrying/round/errors 等。
   * 从未触发过重建时 progress 为 null。
   */
  @Get('rebuild/status')
  async rebuildStatus() {
    const progress = this.documentService.getReindexProgress();
    return { success: true, progress };
  }
}
