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
} as const;
