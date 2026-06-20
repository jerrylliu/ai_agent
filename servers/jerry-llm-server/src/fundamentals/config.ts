/**
 * 服务端统一配置
 *
 * 通过 zod 在启动阶段对所有环境变量做集中校验：
 * - 必需项缺失 / 类型错误时立即抛出，拒绝启动（fail-fast）
 * - 字符串到 number / boolean 的转换在 schema 内统一处理（z.coerce）
 * - 对外导出的 `config` 形状与原版本严格保持一致，所有调用点（含 getter
 *   语义如 chromaHost / chromaPort / corsOrigins / queryDb.allowedTables）
 *   均向后兼容，避免上游业务代码受影响
 *
 * 设计要点：
 * 1. 仅顶层与一级命名空间（db / redis / volcAsr / rateLimit / queryDb /
 *    document / notify）有意义，不做更深层嵌套，避免读侧调用变复杂
 * 2. 派生字段（chromaHost / chromaPort / corsOrigins / allowedTables）通过
 *    在解析后用 getter 注入，保留惰性求值与原行为一致
 * 3. 校验失败时输出哪一项不合规，便于运维定位
 */

import { z } from 'zod';

// ==================== 工具：字符串 → boolean ====================

/**
 * 把 'true' / 'false' / undefined 解析成布尔值
 * z.coerce.boolean() 默认会把 'false' 也当成 truthy，因此显式实现
 */
const zBoolFromString = (defaultValue: boolean) =>
  z
    .union([z.string(), z.boolean(), z.undefined()])
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      if (v == null || v === '') return defaultValue;
      return v.toLowerCase() === 'true';
    });

// ==================== 一级 Schema ====================

const DbSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.coerce.number().int().positive().default(3306),
  username: z.string().min(1).default('root'),
  password: z.string().default('123456'),
  database: z.string().min(1).default('cyberpunk'),
  synchronize: zBoolFromString(false),
});

const NotifySchema = z.object({
  feishuAppId: z.string().default(''),
  feishuAppSecret: z.string().default(''),
  feishuDomain: z.string().default(''),
  smtpHost: z.string().default(''),
  smtpPort: z.coerce.number().int().positive().default(465),
  smtpUser: z.string().default(''),
  smtpPass: z.string().default(''),
  smtpFrom: z.string().default(''),
  /** MCP Server 配置：JSON 数组字符串，原样存放，由消费侧解析 */
  mcpServers: z.string().default(''),
});

const QueryDbSchema = z.object({
  host: z.string().default(''),
  port: z.coerce.number().int().positive().default(3306),
  user: z.string().default(''),
  password: z.string().default(''),
  database: z.string().default(''),
  /** 表名白名单原始字符串，对外通过 allowedTables getter 暴露数组形态 */
  allowedTablesRaw: z.string().default(''),
});

const DocumentSchema = z.object({
  storageDir: z.string().min(1).default('./tmp/documents'),
  ttlDays: z.coerce.number().positive().default(7),
  idleDays: z.coerce.number().positive().default(3),
  cleanupIntervalMin: z.coerce.number().int().positive().default(60),
  maxDocSizeMB: z.coerce.number().int().positive().default(20),
  pdfFormat: z.string().min(1).default('A4'),
});

const RedisSchema = z.object({
  enabled: zBoolFromString(false),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.coerce.number().int().positive().default(6379),
  password: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  db: z.coerce.number().int().min(0).max(15).default(0),
  keyPrefix: z.string().default('jerry:'),
  commandTimeoutMs: z.coerce.number().int().positive().default(300),
});

const VolcAsrSchema = z.object({
  appId: z.string().default(''),
  accessToken: z.string().default(''),
  resourceId: z.string().default('volc.seedasr.sauc.duration'),
  wsUrl: z.string().default('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'),
  httpUrl: z.string().default('https://openspeech.bytedance.com/api/v1/auc'),
});

const RateLimitSchema = z.object({
  chatPerMin: z.coerce.number().int().min(0).default(30),
  failOpen: zBoolFromString(true),
});

// MinerU 在线 API 配置（PDF 精准解析，支持图片/代码块/表格/公式）
// 采用文件上传方式，无需内网穿透，本地文件直接上传给 MinerU
// 未配置 Token 时自动降级到本地 pdfjs-dist
const MineruSchema = z.object({
  enabled: zBoolFromString(false),
  apiToken: z.string().default(''),
  // API 超时（毫秒），大文件解析较慢
  timeoutMs: z.coerce.number().int().positive().default(120000),
  // 模型版本：pipeline（默认）/ vlm（推荐，效果更好）/ MinerU-HTML
  modelVersion: z.string().default('vlm'),
});

// ==================== 顶层 Schema ====================

const RootSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  /** JWT 必需，缺失时 fail-fast */
  jwtSecret: z.string().min(1, 'JWT_SECRET 未设置，服务无法启动'),

  ollamaBaseUrl: z.string().min(1).default('http://localhost:11434'),
  chromaUrl: z.string().min(1).default('http://localhost:8000'),
  serverBaseUrl: z.string().min(1).default('http://localhost:3000'),
  deepseekBaseUrl: z.string().min(1).default('https://api.deepseek.com'),
  zhipuBaseUrl: z.string().min(1).default('https://open.bigmodel.cn/api/paas/v4'),
  dashscopeBaseUrl: z.string().min(1).default('https://dashscope.aliyuncs.com'),
  dashscopeApiKey: z.string().default(''),

  logLevel: z.string().default('info'),

  searchApiUrl: z.string().default(''),
  searchApiKey: z.string().default(''),
  qweatherApiKey: z.string().default(''),
  qweatherApiBase: z.string().min(1).default('https://devapi.qweather.com'),

  lokiHost: z.string().default(''),

  /** CORS 来源原始字符串，对外通过 corsOrigins getter 暴露数组 */
  corsOriginsRaw: z.string().default('http://localhost:5173,http://localhost:3000'),

  db: DbSchema,
  notify: NotifySchema,
  queryDb: QueryDbSchema,
  document: DocumentSchema,
  redis: RedisSchema,
  volcAsr: VolcAsrSchema,
  rateLimit: RateLimitSchema,
  mineru: MineruSchema,
});

// ==================== 解析 process.env ====================

/**
 * 把扁平的 process.env 映射成 RootSchema 期望的层级对象
 * 这里只做"路径映射 + 透传"，所有类型转换交给 zod 完成
 */
function buildRawConfig() {
  const env = process.env;
  return {
    port: env.PORT,
    jwtSecret: env.JWT_SECRET,

    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    chromaUrl: env.CHROMA_URL,
    serverBaseUrl: env.SERVER_BASE_URL,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
    zhipuBaseUrl: env.ZHIPU_BASE_URL,
    dashscopeBaseUrl: env.DASHSCOPE_BASE_URL,
    dashscopeApiKey: env.DASHSCOPE_API_KEY,

    logLevel: env.LOG_LEVEL,

    searchApiUrl: env.SEARCH_API_URL,
    searchApiKey: env.SEARCH_API_KEY,
    qweatherApiKey: env.QWEATHER_API_KEY,
    qweatherApiBase: env.QWEATHER_API_BASE,

    lokiHost: env.LOKI_HOST,

    corsOriginsRaw: env.CORS_ORIGINS,

    db: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      username: env.DB_USERNAME,
      password: env.DB_PASSWORD,
      database: env.DB_DATABASE,
      synchronize: env.TYPEORM_SYNCHRONIZE,
    },
    notify: {
      feishuAppId: env.NOTIFY_FEISHU_APP_ID,
      feishuAppSecret: env.NOTIFY_FEISHU_APP_SECRET,
      feishuDomain: env.NOTIFY_FEISHU_DOMAIN,
      smtpHost: env.NOTIFY_SMTP_HOST,
      smtpPort: env.NOTIFY_SMTP_PORT,
      smtpUser: env.NOTIFY_SMTP_USER,
      smtpPass: env.NOTIFY_SMTP_PASS,
      smtpFrom: env.NOTIFY_SMTP_FROM,
      mcpServers: env.NOTIFY_MCP_SERVERS,
    },
    queryDb: {
      host: env.NOTIFY_DB_HOST,
      port: env.NOTIFY_DB_PORT,
      user: env.NOTIFY_DB_USER,
      password: env.NOTIFY_DB_PASSWORD,
      database: env.NOTIFY_DB_DATABASE,
      allowedTablesRaw: env.NOTIFY_DB_ALLOWED_TABLES,
    },
    document: {
      storageDir: env.DOCUMENT_STORAGE_DIR,
      ttlDays: env.DOCUMENT_TTL_DAYS,
      idleDays: env.DOCUMENT_IDLE_DAYS,
      cleanupIntervalMin: env.DOCUMENT_CLEANUP_INTERVAL_MIN,
      maxDocSizeMB: env.DOCUMENT_MAX_SIZE_MB,
      pdfFormat: env.DOCUMENT_PDF_FORMAT,
    },
    redis: {
      enabled: env.REDIS_ENABLED,
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
      keyPrefix: env.REDIS_KEY_PREFIX,
      commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
    },
    volcAsr: {
      appId: env.VOLC_ASR_APP_ID,
      accessToken: env.VOLC_ASR_ACCESS_TOKEN,
      resourceId: env.VOLC_ASR_RESOURCE_ID,
      wsUrl: env.VOLC_ASR_WS_URL,
      httpUrl: env.VOLC_ASR_HTTP_URL,
    },
    rateLimit: {
      chatPerMin: env.RATE_LIMIT_CHAT_PER_MIN,
      failOpen: env.RATE_LIMIT_FAIL_OPEN,
    },
    mineru: {
      enabled: env.MINERU_ENABLED,
      apiToken: env.MINERU_API_TOKEN,
      timeoutMs: env.MINERU_TIMEOUT_MS,
      modelVersion: env.MINERU_MODEL_VERSION,
    },
  };
}

/**
 * 启动时解析；失败立即抛错并打印每一个不合规字段
 */
function parseConfig() {
  const result = RootSchema.safeParse(buildRawConfig());
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`❌ 环境变量校验失败，服务拒绝启动：\n${detail}`);
  }
  return result.data;
}

const parsed = parseConfig();

// ==================== 派生字段 ====================

function parseList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function safeUrlPart<T>(url: string, fn: (u: URL) => T, fallback: T): T {
  try {
    return fn(new URL(url));
  } catch {
    return fallback;
  }
}

// ==================== 对外导出 ====================

/**
 * 注意：保留与历史版本一致的扁平 + 一级命名空间形状
 * 派生字段（chromaHost / chromaPort / corsOrigins / queryDb.allowedTables）
 * 维持 getter 语义，惰性求值，行为对调用方透明
 */
export const config = {
  port: parsed.port,
  jwtSecret: parsed.jwtSecret,

  db: parsed.db,

  ollamaBaseUrl: parsed.ollamaBaseUrl,
  chromaUrl: parsed.chromaUrl,
  get chromaHost() {
    return safeUrlPart(this.chromaUrl, (u) => u.hostname, 'localhost');
  },
  get chromaPort() {
    return safeUrlPart(
      this.chromaUrl,
      (u) => parseInt(u.port || '8000', 10),
      8000,
    );
  },

  serverBaseUrl: parsed.serverBaseUrl,
  deepseekBaseUrl: parsed.deepseekBaseUrl,
  zhipuBaseUrl: parsed.zhipuBaseUrl,
  dashscopeBaseUrl: parsed.dashscopeBaseUrl,
  dashscopeApiKey: parsed.dashscopeApiKey,

  logLevel: parsed.logLevel,

  searchApiUrl: parsed.searchApiUrl,
  searchApiKey: parsed.searchApiKey,
  qweatherApiKey: parsed.qweatherApiKey,
  qweatherApiBase: parsed.qweatherApiBase,

  lokiHost: parsed.lokiHost,

  get corsOrigins(): string[] {
    return parseList(parsed.corsOriginsRaw);
  },

  notify: parsed.notify,

  queryDb: {
    host: parsed.queryDb.host,
    port: parsed.queryDb.port,
    user: parsed.queryDb.user,
    password: parsed.queryDb.password,
    database: parsed.queryDb.database,
    get allowedTables(): string[] {
      return parseList(parsed.queryDb.allowedTablesRaw);
    },
  },

  document: parsed.document,
  redis: parsed.redis,
  volcAsr: parsed.volcAsr,
  rateLimit: parsed.rateLimit,
  mineru: parsed.mineru,
} as const;

export type AppConfig = typeof config;
