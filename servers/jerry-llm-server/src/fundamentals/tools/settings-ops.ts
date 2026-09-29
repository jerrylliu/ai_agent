/**
 * 设置域操作工具
 *
 * 让 Agent 可以操作设置界面：
 * - get_system_status: 查看当前模型/可用模型/Key 配置状态/功能开关/MinerU 状态
 * - switch_model: 切换当前对话模型
 * - toggle_feature: 开/关功能开关（记忆/摘要/新会话注入记忆/MinerU 解析）
 *
 * 密钥边界（设计文档"永远不开放给 AI 的"）：
 * - 本模块只暴露 Key 的"是否已配置"布尔状态，绝不返回任何 Key 内容
 * - 不提供任何设置/修改 API Key 的工具，Key 填写只能人工在设置界面操作
 */

import { z } from 'zod';
import { logger } from '../logger';
import {
  AVAILABLE_MODELS,
  getCurrentModelId,
  getDeepseekApiKey,
  getZhipuApiKey,
  switchModel,
} from '../model-provider';
import {
  getFeatureDefaults,
  getMineruConfigStatus,
  updateRuntimeConfig,
} from '../runtime-config';
import { getRedis } from '../redis-client';
import { publishSettingsChangedEvent } from '../chat-event-bus';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== get_system_status（只读） ====================

export const getSystemStatusParamsSchema = z.object({});

export const getSystemStatusSchema = buildToolJsonSchema(
  'get_system_status',
  '查看系统设置状态：当前对话模型、可用模型清单、API Key 是否已配置（只看是/否，看不到内容）、功能开关全局默认、MinerU 解析状态。用户问"现在用的什么模型/某某功能开着吗"时使用。',
  getSystemStatusParamsSchema,
);

export interface SystemStatusResult {
  success: boolean;
  status: {
    currentModel?: { id: string; name: string };
    availableModels: { id: string; name: string; requiresApiKey: boolean }[];
    apiKeyConfigured: { deepseek: boolean; zhipu: boolean };
    featureDefaults: {
      memoryEnabled: boolean;
      summaryEnabled: boolean;
      injectMemoryOnNewSession: boolean;
    };
    mineru?: {
      enabled: boolean;
      modelVersion: string;
      source: string;
      hasToken: boolean;
    };
    redisConnected: boolean;
  };
  message: string;
}

export async function executeGetSystemStatus(): Promise<SystemStatusResult> {
  try {
    const currentId = getCurrentModelId();
    const currentAvailable = AVAILABLE_MODELS.find((m) => m.id === currentId);

    // Key 只暴露"是否已配置"布尔，绝不返回内容（密钥边界）
    const apiKeyConfigured = {
      deepseek: !!getDeepseekApiKey(),
      zhipu: !!getZhipuApiKey(),
    };

    const featureDefaults = getFeatureDefaults();

    // MinerU 状态：getMineruConfigStatus 只回 hasToken+source，不含明文 Token
    let mineru: SystemStatusResult['status']['mineru'];
    try {
      mineru = getMineruConfigStatus();
    } catch {
      // MinerU 状态读取失败不阻塞主体
    }

    // Redis 可选组件：连接可用才为 true（REDIS_ENABLED=false 时为 false，不算故障）
    const redis = getRedis();
    const redisConnected = !!redis && redis.status === 'ready';

    return {
      success: true,
      status: {
        currentModel: {
          id: currentId,
          name: currentAvailable?.name ?? currentId,
        },
        availableModels: AVAILABLE_MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          requiresApiKey: m.requiresApiKey,
        })),
        apiKeyConfigured,
        featureDefaults,
        mineru,
        redisConnected,
      },
      message: `当前模型：${currentAvailable?.name ?? currentId}。Key 配置：DeepSeek ${apiKeyConfigured.deepseek ? '已配置' : '未配置'}，智谱 ${apiKeyConfigured.zhipu ? '已配置' : '未配置'}。记忆 ${featureDefaults.memoryEnabled ? '开' : '关'}，摘要 ${featureDefaults.summaryEnabled ? '开' : '关'}${mineru ? `，MinerU ${mineru.enabled ? '开' : '关'}` : ''}`,
    };
  } catch (error: any) {
    logger.error('FC工具 [get_system_status] 查询失败', {
      module: 'Tool:SettingsOps',
      error: error.message,
    });
    return {
      success: false,
      status: { availableModels: [], apiKeyConfigured: { deepseek: false, zhipu: false }, featureDefaults: { memoryEnabled: false, summaryEnabled: false, injectMemoryOnNewSession: false }, redisConnected: false },
      message: `查询系统状态失败: ${error.message}`,
    };
  }
}

// ==================== switch_model（需人工确认） ====================

export const switchModelParamsSchema = z.object({
  modelId: z
    .string()
    .min(1)
    .describe(
      '目标模型ID（来自 get_system_status 的 availableModels，如 deepseek:deepseek-chat、zhipu:glm-4.7、ollama:minicpm）',
    ),
});

export type SwitchModelParams = z.infer<typeof switchModelParamsSchema>;

export const switchModelSchema = buildToolJsonSchema(
  'switch_model',
  '切换当前对话模型（全局生效，所有端同步）。模型对所需的 API Key 未配置时会切换失败。',
  switchModelParamsSchema,
);

export interface SwitchModelResult {
  success: boolean;
  currentModelId?: string;
  message: string;
}

export async function executeSwitchModel(
  rawParams: unknown,
): Promise<SwitchModelResult> {
  const parsed = safeParseToolParams(switchModelParamsSchema, rawParams);
  if (!parsed.success) {
    return {
      success: false,
      message: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  try {
    // switchModel 内部完成：模型存在性校验 → Key 校验（getter 口径带 .env 兜底）→ 写 currentModelId
    switchModel(params.modelId);
    // 广播设置变更：在线端刷新模型显示
    publishSettingsChangedEvent({ section: 'model' });
    logger.info('FC工具 [switch_model] 切换成功', {
      module: 'Tool:SettingsOps',
      modelId: params.modelId,
    });
    return {
      success: true,
      currentModelId: params.modelId,
      message: `已切换到模型 ${params.modelId}（全局生效）`,
    };
  } catch (error: any) {
    logger.warn('FC工具 [switch_model] 切换失败', {
      module: 'Tool:SettingsOps',
      modelId: params.modelId,
      error: error.message,
    });
    return {
      success: false,
      message: `切换模型失败: ${error.message}。可用 get_system_status 查看可用模型与 Key 配置状态`,
    };
  }
}

// ==================== toggle_feature（需人工确认） ====================

export const toggleFeatureParamsSchema = z.object({
  feature: z
    .enum(['memoryEnabled', 'summaryEnabled', 'injectMemoryOnNewSession', 'mineruEnabled'])
    .describe(
      '功能开关：memoryEnabled=用户记忆提取；summaryEnabled=会话摘要；injectMemoryOnNewSession=新会话注入历史记忆；mineruEnabled=PDF 智能解析（MinerU）',
    ),
  enabled: z.boolean().describe('目标状态：true=开启，false=关闭'),
});

export type ToggleFeatureParams = z.infer<typeof toggleFeatureParamsSchema>;

export const toggleFeatureSchema = buildToolJsonSchema(
  'toggle_feature',
  '开/关功能开关（记忆/摘要/新会话注入记忆/MinerU PDF 解析）。改动全局默认并广播：所有未自定义过该开关的设备自动跟随；已手动改过开关的设备保持本地值。',
  toggleFeatureParamsSchema,
);

export interface ToggleFeatureResult {
  success: boolean;
  feature?: string;
  enabled?: boolean;
  message: string;
}

const FEATURE_LABELS: Record<string, string> = {
  memoryEnabled: '用户记忆提取',
  summaryEnabled: '会话摘要',
  injectMemoryOnNewSession: '新会话注入历史记忆',
  mineruEnabled: 'PDF 智能解析（MinerU）',
};

export async function executeToggleFeature(
  rawParams: unknown,
): Promise<ToggleFeatureResult> {
  const parsed = safeParseToolParams(toggleFeatureParamsSchema, rawParams);
  if (!parsed.success) {
    return { success: false, message: `参数校验失败: ${parsed.error}` };
  }
  const params = parsed.data;
  const label = FEATURE_LABELS[params.feature] ?? params.feature;

  try {
    if (params.feature === 'mineruEnabled') {
      // MinerU 走 mineru 区块：显式 true/false 覆盖 .env 的 MINERU_ENABLED
      updateRuntimeConfig({ mineru: { enabled: params.enabled } });
    } else {
      // 记忆/摘要走 features 区块（全局默认，前端未自定义设备跟随）
      updateRuntimeConfig({
        features: { [params.feature]: params.enabled },
      });
    }
    publishSettingsChangedEvent({ section: 'features' });
    logger.info('FC工具 [toggle_feature] 切换成功', {
      module: 'Tool:SettingsOps',
      feature: params.feature,
      enabled: params.enabled,
    });
    return {
      success: true,
      feature: params.feature,
      enabled: params.enabled,
      message: `已${params.enabled ? '开启' : '关闭'}${label}（全局默认，未自定义的设备自动跟随）`,
    };
  } catch (error: any) {
    logger.error('FC工具 [toggle_feature] 切换失败', {
      module: 'Tool:SettingsOps',
      feature: params.feature,
      error: error.message,
    });
    return {
      success: false,
      feature: params.feature,
      message: `切换${label}失败: ${error.message}`,
    };
  }
}
