/**
 * 服务端统一配置
 * 所有配置项从环境变量读取，提供默认值用于本地开发
 * 必需配置项（JWT_SECRET）未设置时将抛出错误，拒绝启动
 */

/** 启动前校验必需配置 */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`❌ 环境变量 ${name} 未设置，服务无法启动。请在 .env 文件中配置 ${name}。`);
  }
  return value;
}

export const config = {
  /** 服务端口 */
  port: parseInt(process.env.PORT || '3000', 10),

  /** JWT 密钥（必需，未设置时拒绝启动） */
  jwtSecret: requireEnv('JWT_SECRET', process.env.JWT_SECRET),

  /** 数据库配置 */
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '123456',
    database: process.env.DB_DATABASE || 'cyberpunk',
    synchronize: (process.env.TYPEORM_SYNCHRONIZE || 'false').toLowerCase() === 'true',
  },

  /** Ollama 服务地址 */
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',

  /** ChromaDB 服务地址 */
  chromaUrl: process.env.CHROMA_URL || 'http://localhost:8000',

  /** ChromaDB 主机（从 CHROMA_URL 解析） */
  get chromaHost() {
    try { return new URL(this.chromaUrl).hostname; } catch { return 'localhost'; }
  },

  /** ChromaDB 端口（从 CHROMA_URL 解析） */
  get chromaPort() {
    try { return parseInt(new URL(this.chromaUrl).port || '8000', 10); } catch { return 8000; }
  },

  /** 服务基础 URL（用于生成文件访问地址） */
  serverBaseUrl: process.env.SERVER_BASE_URL || 'http://localhost:3000',

  /** DeepSeek API 基础 URL */
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',

  /** 智谱 API 基础 URL */
  zhipuBaseUrl: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',

  /** DashScope API 基础 URL（用于 qwen3-vl-rerank 等） */
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com',

  /** DashScope API Key（用于 Reranker 等服务） */
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY || '',

  /** 日志级别 */
  logLevel: process.env.LOG_LEVEL || 'info',

  /** 搜索 API 地址（可选，未配置时联网搜索不可用） */
  searchApiUrl: process.env.SEARCH_API_URL || '',

  /** 搜索 API 密钥（可选，未配置时联网搜索不可用） */
  searchApiKey: process.env.SEARCH_API_KEY || '',

  /** 和风天气 API 密钥（可选，未配置时天气查询不可用） */
  qweatherApiKey: process.env.QWEATHER_API_KEY || '',

  /** 和风天气 API 地址 */
  qweatherApiBase: process.env.QWEATHER_API_BASE || 'https://devapi.qweather.com',

  /** Loki 日志服务地址（可选，未配置则不输出到 Loki） */
  lokiHost: process.env.LOKI_HOST || '',

  /** CORS 允许的来源列表（逗号分隔，默认仅允许 localhost） */
  get corsOrigins(): string[] {
    const raw = process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  },

  /**
   * send_notification / mcp_proxy 工具相关配置
   * 这些配置项均为可选，未配置时对应通道/工具会被自动跳过
   */
  notify: {
    /** 飞书消息：独立的 AppID（与知识库同步用的飞书可分离） */
    feishuAppId: process.env.NOTIFY_FEISHU_APP_ID || '',
    feishuAppSecret: process.env.NOTIFY_FEISHU_APP_SECRET || '',
    /** 飞书域名，海外版填 larksuite.com */
    feishuDomain: process.env.NOTIFY_FEISHU_DOMAIN || '',
    /** SMTP 邮件 */
    smtpHost: process.env.NOTIFY_SMTP_HOST || '',
    smtpPort: parseInt(process.env.NOTIFY_SMTP_PORT || '465', 10),
    smtpUser: process.env.NOTIFY_SMTP_USER || '',
    smtpPass: process.env.NOTIFY_SMTP_PASS || '',
    /** 发件人地址，未设置则使用 smtpUser */
    smtpFrom: process.env.NOTIFY_SMTP_FROM || '',
    /** MCP Server 配置：JSON 数组字符串，例如 '[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]' */
    mcpServers: process.env.NOTIFY_MCP_SERVERS || '',
  },

  /**
   * query_database 工具：外部业务库连接配置
   * 与主业务库（DB_*）完全隔离；强烈建议使用只读账号
   */
  queryDb: {
    host: process.env.NOTIFY_DB_HOST || '',
    port: parseInt(process.env.NOTIFY_DB_PORT || '3306', 10),
    user: process.env.NOTIFY_DB_USER || '',
    password: process.env.NOTIFY_DB_PASSWORD || '',
    database: process.env.NOTIFY_DB_DATABASE || '',
    /** 表名白名单：逗号分隔；为空时允许查询所有表（不推荐） */
    get allowedTables(): string[] {
      const raw = process.env.NOTIFY_DB_ALLOWED_TABLES || '';
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    },
  },

  /**
   * generate_document 工具：AI 生成 PDF / Word / HTML 文档
   */
  document: {
    /** 生成文档的存储目录（落盘根目录） */
    storageDir: process.env.DOCUMENT_STORAGE_DIR || './tmp/documents',
    /** 硬过期天数：从生成时间起，超过此天数自动删除 */
    ttlDays: parseFloat(process.env.DOCUMENT_TTL_DAYS || '7'),
    /** 闲置天数：超过此天数未访问自动删除 */
    idleDays: parseFloat(process.env.DOCUMENT_IDLE_DAYS || '3'),
    /** 后台清理任务间隔（分钟） */
    cleanupIntervalMin: parseInt(process.env.DOCUMENT_CLEANUP_INTERVAL_MIN || '60', 10),
    /** 单个文档最大尺寸（MB），超过会拒绝生成 */
    maxDocSizeMB: parseInt(process.env.DOCUMENT_MAX_SIZE_MB || '20', 10),
    /** 默认 PDF 纸张尺寸 */
    pdfFormat: process.env.DOCUMENT_PDF_FORMAT || 'A4',
  },

  /**
   * Redis 配置 —— 多级缓存 L2 / 限流 / 分布式锁的共享存储
   *
   * 设计要点：
   * 1. enabled 默认 false，便于桌面端 / 个人开发机零依赖运行
   * 2. 任何 Redis 操作失败都必须降级到内存方案，不能影响主业务
   * 3. commandTimeout 必须够小（默认 300ms），避免 Redis 抖动拖垮 LLM 推理链路
   * 4. keyPrefix 由 ioredis 自动追加，业务代码内拼 key 时无需重复带前缀
   */
  redis: {
    /** 总开关：false / 未配置时全部走内存降级 */
    enabled: (process.env.REDIS_ENABLED || '').toLowerCase() === 'true',
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    /** AUTH 密码；生产环境强制要求 */
    password: process.env.REDIS_PASSWORD || undefined,
    /** 库编号 0-15，不同业务建议分库 */
    db: parseInt(process.env.REDIS_DB || '0', 10),
    /** 全局 Key 前缀，业务代码内拼 key 时无需重复 */
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'jerry:',
    /** 单条命令超时（ms），防止 Redis 抖动阻塞主流程 */
    commandTimeoutMs: parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS || '300', 10),
  },

  /**
   * 火山引擎 ASR（语音识别）配置
   * 未配置时语音识别功能不可用，不影响其他功能
   * 使用 V3 大模型流式语音识别 API
   */
  volcAsr: {
    /** 应用 ID（对应 X-Api-App-Key） */
    appId: process.env.VOLC_ASR_APP_ID || '',
    /** API Key / Access Token（对应 X-Api-Access-Key） */
    accessToken: process.env.VOLC_ASR_ACCESS_TOKEN || '',
    /** V3 资源 ID（对应 X-Api-Resource-Id） */
    resourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration',
    /** 流式 ASR WebSocket 地址（V3 大模型） */
    wsUrl: process.env.VOLC_ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    /** 录音文件识别 HTTP 地址 */
    httpUrl: process.env.VOLC_ASR_HTTP_URL || 'https://openspeech.bytedance.com/api/v1/auc',
  },

  /**
   * 限流（Rate Limit）配置 —— 基于 Redis 的滑动窗口实现
   *
   * 默认 30 次/分钟，主要用于防止 AI 对话接口被恶意刷取（每次请求都会调用 LLM，
   * 直接消耗 Token 与算力，必须有兜底保护）。
   */
  rateLimit: {
    /** 单用户每分钟最多多少次 AI 对话请求；0 = 不限流 */
    chatPerMin: parseInt(process.env.RATE_LIMIT_CHAT_PER_MIN || '30', 10),
    /**
     * Redis 不可用时的兜底策略：
     * - true（fail-open）：直接放行，避免限流组件故障导致全员被拒，体验优先
     * - false（fail-close）：拒绝请求，安全优先（适合金融等强合规场景）
     */
    failOpen: (process.env.RATE_LIMIT_FAIL_OPEN || 'true').toLowerCase() === 'true',
  },
} as const;
