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
import * as path from 'path';

// ==================== 工具：字符串 → boolean ====================

/**
 * 把 'true' / 'false' / undefined 解析成布尔值
 * z.coerce.boolean() 默认会把 'false' 也当成 truthy，因此显式实现
 */
const zBoolFromString = (defaultValue: boolean) =>
  z.union([z.string(), z.boolean(), z.undefined()]).transform((v) => {
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
  /**
   * 飞书事件订阅模式：
   * - 'ws'（默认）：通过 WebSocket 长连接接收事件，无需公网回调地址，开发期间首选
   * - 'http'：传统回调模式，需要公网可访问的回调地址（上线后启用）
   */
  feishuEventMode: z.enum(['ws', 'http']).default('ws'),
  /**
   * 飞书机器人的 open_id（D1 群聊精确 @ 判定用）
   *
   * 用法：群聊里只有 @ 到这个 open_id 才会触发 AI 回复，避免误处理
   * "@ 张三 帮 @AI 看看" 中"张三"被误判为 bot。
   *
   * 获取方式：发一条带 @ 机器人的消息到群里，看 webhook event.message.mentions
   * 数组里 bot 对应那一项的 id.open_id；或者用 contact.v3.app/v3 API 查。
   *
   * 未配置时退化为"群里只要有 @ 就处理"（宽松模式）。
   */
  feishuBotOpenId: z.string().default(''),
  /**
   * 飞书 D1/D2 聊天记录归属的项目用户 ID。
   * 默认 default，便于未登录 Web 端直接看到飞书会话；
   * 如果你主要用登录态 Web 端查看，请改成该账号的 user.id。
   */
  feishuChatUserId: z.string().default('default'),
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
  wsUrl: z
    .string()
    .default('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'),
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

// VLM 视觉语言模型配置（图片翻译为文字描述，用于多模态入库）
// 默认关闭，启用后需要配置 API Key
// 走 OpenAI 兼容协议，可接入 Qwen3-VL / GLM-4.6V / SiliconFlow 等任何兼容服务
const VlmSchema = z.object({
  enabled: zBoolFromString(false),
  // OpenAI 兼容 API Base URL
  apiBase: z.string().default(''),
  // API Key
  apiKey: z.string().default(''),
  // 主模型名称（如 qwen3-vl-32b）
  primaryModel: z.string().default('qwen3-vl-32b'),
  // 单次调用超时（毫秒）- 单张图片的 VLM 调用超时
  timeoutMs: z.coerce.number().int().positive().default(60000),
  // 并发上限（同时处理的图片数）
  concurrency: z.coerce.number().int().positive().default(3),
  // 单文档 VLM 调用上限（超过则走元数据兜底，避免成本失控）
  maxCallsPerDoc: z.coerce.number().int().positive().default(50),
  // 备用模型名称（主模型连续失败时降级，如 glm-4.6v）
  fallbackModel: z.string().default(''),
  // 备用模型 API Base（为空则复用主模型 apiBase）
  fallbackApiBase: z.string().default(''),
  // 备用模型 API Key（为空则复用主模型 apiKey）
  fallbackApiKey: z.string().default(''),
  // 文档级总超时容错时间（毫秒）
  // 文档总超时 = timeoutMs × 图片数 + docTimeoutToleranceMs
  // 超过总超时后，未处理的图片直接走 Layer 4 元数据兜底
  docTimeoutToleranceMs: z.coerce.number().int().positive().default(30000),
});

// 图片存储配置（多模态入库的原图落盘）
const ImageStorageSchema = z.object({
  // 原图存储根目录（相对项目根）
  dir: z.string().default('./storage/images'),
  // 单图最大尺寸（字节，超过则跳过，避免异常大文件）
  maxSizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
});

// OCR 配置（Layer 3 降级：VLM 全部不可用时用 tesseract.js 提取图片文字）
// 需要安装 tesseract.js：pnpm --filter jerry-llm-server add tesseract.js
// 未安装时自动跳过 OCR 降级，直接走 Layer 4 元数据兜底
const OcrSchema = z.object({
  enabled: zBoolFromString(false),
  // OCR 语言（如 chi_sim+eng）
  lang: z.string().default('chi_sim+eng'),
});

// 图片异步重试配置（定时任务扫描 failed 记录重试）
const ImageRetrySchema = z.object({
  // 重试间隔（分钟），默认 10 分钟
  intervalMin: z.coerce.number().int().positive().default(10),
  // 最大重试次数（超过则标记为 skipped）
  maxRetry: z.coerce.number().int().positive().default(3),
});

// 公式解释配置（LaTeX → 自然语言描述，提高公式检索质量）
const FormulaSchema = z.object({
  enabled: zBoolFromString(false),
  // 用于生成解释的 LLM 模型 ID（复用 model-provider 的 AVAILABLE_MODELS）
  modelId: z.string().default('ollama:qwen3.5-2b'),
  // 单次调用超时（毫秒）
  timeoutMs: z.coerce.number().int().positive().default(30000),
  // 单文档公式解释调用上限
  maxCallsPerDoc: z.coerce.number().int().positive().default(30),
});

// 扫描件检测配置（pdfjs 降级路径）
const ScannedPdfSchema = z.object({
  // 启用扫描件检测
  enabled: zBoolFromString(true),
  // 每页字符数阈值：低于此值认为是扫描件页面
  charsPerPageThreshold: z.coerce.number().int().positive().default(50),
  // 扫描件页面渲染的 DPI
  // 注意：当前 pdfjs 降级路径使用 getOperatorList 提取嵌入图片，未使用 canvas 渲染方案，
  // 此配置项暂未生效。保留供未来 canvas 渲染方案使用。
  renderDpi: z.coerce.number().int().positive().default(150),
});

// 文档入库注入扫描配置（发布门禁：静态签名 + LLM chunk 级判定 + 人工复核）
// 默认关闭；关闭时发布链路完全透传原有逻辑，扫描相关字段保持初始值
const DocScanSchema = z.object({
  // 是否启用注入扫描门禁
  enabled: zBoolFromString(false),
  // 是否启用 LLM chunk 级判定（捕捉静态签名之外的语义注入）；关闭时仅用静态签名裁决
  llmJudgeEnabled: zBoolFromString(true),
  // 单文档最大扫描 chunk 数，超出部分截断，防止超大文档拖垮模型调用成本
  maxChunksPerDocument: z.coerce.number().int().positive().default(100),
  // suspicious 级别处置方式：'review' = 转人工复核（默认）；'block' = 直接拒绝
  suspiciousAction: z.enum(['review', 'block']).default('review'),
});

// 知识图谱（KG）实体链接与图补充位配置
// 总开关默认关闭（灰度）：关闭时离线抽取管道不消费、在线链路完全透传基线检索结果。
// 数值默认值 = 30 题门闩验证（kg-link-spike v2）使用的同一组口径，
// ⚠️ 修改召回/链接类参数会使门闩结论失效，调整后必须重跑门闩复核。
const KgSchema = z.object({
  // 总开关：离线抽取管道 + 在线图补充位（false = 全链路关闭，基线行为零变化）
  enabled: zBoolFromString(false),
  // 图补充位数量：基线保留 topK - slots 条，图补充不重复的 slots 条（门闩验证值 = 1）
  supplementSlots: z.coerce.number().int().min(0).max(3).default(1),
  // LLM 链接确认置信度阈值（主口径；matchType != related 且 confidence >= 阈值才计入链接）
  linkConfThreshold: z.coerce.number().min(0).max(1).default(0.6),
  // 单文档抽取的正文截断长度（控制离线抽取的 token 成本）
  extractDocChars: z.coerce.number().int().positive().default(8000),
  // 单文档最大抽取实体数（prompt 内声明 + schema 上限 = 2 倍冗余）
  maxEntitiesPerDoc: z.coerce.number().int().positive().default(20),
  // 离线抽取 LLM 并发数（照抄 document-scan judge 的保守并发）
  extractConcurrency: z.coerce.number().int().positive().default(2),
  // 单次抽取 LLM 调用超时（AbortSignal.timeout 真正取消在途请求，避免幽灵调用消耗 token）
  // 默认 180000：抽取已固定用 deepseek-v4-flash（thinking 模型，见 kg-extract.service.ts
  // 的 KG_EXTRACT_MODEL），单次 8000 字符抽取实测会超过旧的 60s 默认值而被 abort。
  // ⚠️ 此值是请求生命周期护栏，非门闩锁定的召回/链接口径（kg-link-spike 本身无此超时），
  // 调整它不会使门闩结论失效；但与 linkTimeoutMs 保持同源模型时延口径。
  extractTimeoutMs: z.coerce.number().int().positive().default(180000),
  // 在线实体链接单次 LLM 调用超时（mention 抽取 / 链接确认各一次）；超时即静默降级纯基线检索。
  // 默认 180000：6 题在线链路复验实测单题全程 42~170s（deepseek-v4-flash 两次调用 + 嵌入），
  // 若沿用 20s 默认值，生产环境 KG 在线链路几乎必然超时降级（等效不生效）。
  // ⚠️ 调小此值前必须确认所用模型的实测时延，否则等于关闭 KG 在线补充位。
  linkTimeoutMs: z.coerce.number().int().positive().default(180000),
  // 单文档抽取失败最大重试次数（超限置 failed，留 errorMessage 供排查）
  maxRetries: z.coerce.number().int().min(0).default(3),
  // 单批最多消费的 op 数（防止存量回填时一次性占用过多连接与内存）
  // 抽取已改为人工触发（图谱面板单篇 / 全量按钮），无自动调度间隔配置
  maxOpsPerTick: z.coerce.number().int().positive().default(10),
  // 词汇召回候选 top-K（v1 同口径，不得改动）
  candidateTopK: z.coerce.number().int().positive().default(8),
  // 词汇召回最低分（v1 同口径，不得改动）
  candidateMinScore: z.coerce.number().min(0).max(1).default(0.3),
  // 通用 token 倒排剪枝上限（posting 超过此长度的 token 不参与召回，避免候选爆炸）
  tokenPostingCap: z.coerce.number().int().positive().default(200),
  // 语义补充通道最低余弦相似度（刻意宽松：召回只负责送候选进池，链接由 LLM 确认把关）
  embedMinSim: z.coerce.number().min(0).max(1).default(0.5),
  // 语义补充通道最多补充的候选槽位数
  embedSupplementSlots: z.coerce.number().int().min(0).default(4),
  // 嵌入批量大小（getEmbeddings().embedDocuments 分批）
  embedBatchSize: z.coerce.number().int().positive().default(32),
  // 1 跳邻居实体扩展权重（链接实体本身 = 1.0）
  hopNeighborWeight: z.coerce.number().min(0).max(1).default(0.5),
});

// ==================== 顶层 Schema ====================

const RootSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  /** JWT 必需，缺失时 fail-fast */
  jwtSecret: z.string().min(1, 'JWT_SECRET 未设置，服务无法启动'),

  /**
   * BM25 引擎选型（永久双引擎，进程级全局单例）
   * - minisearch：默认，落盘单文件 bm25_index.json，受 V8 单字符串 ~512MB 上限
   * - tantivy：目录落盘，解除规模上限（适配器落地后可用）
   * 禁止同一进程内按场景混用两种引擎（会破坏 RRF 融合键=content 的语义一致性）
   */
  bm25Engine: z.enum(['minisearch', 'tantivy']).default('minisearch'),

  /**
   * RAG 语义缓存（L3）总开关，默认 true（生产保持开启，行为与开关引入前完全一致）
   * 设为 false 时 rag-service 两处 cacheable 判定同时短路 get/set，
   * 用途：ERB benchmark 评测必须关闭缓存，避免同义题命中缓存导致检索链路被短路、
   * 结果失真（方案 §5.2 坑 4 / 红线 #4）；禁止用 topK≠3 之类的隐式参数绕过
   */
  semanticCacheEnabled: zBoolFromString(true),

  /**
   * 二段式检索：宽召回候选池宽度（rerank 精排前的召回数量上限）
   * - 工具层按 max(LLM top_k, 此值) 宽召回 → rerank 精排 → 按 LLM top_k 截断返回，
   *   最终返回条数与默认口径一致（top_k 默认 6），只扩大精排的候选面
   * - 攻击点：top-10 → top-3 的排序截断损失（2026-09-17 ERB 诊断：
   *   Recall@10 0.806 → Recall@3 0.632，17pp 损失发生在截断而非召回）
   * - 默认 50：qwen3-vl-rerank 单次支持 100 文档，50 候选重排延迟约 +0.8s；
   *   2026-09-19 评测验证池 50 对冲统一 RRF 的池口挤出效应（30 题联验 R@3 +13.3pp）
   */
  rerankCandidatePool: z.coerce.number().int().positive().default(50),

  /**
   * 向量检索最小相似度阈值（ChromaDB cosine 距离上限；score > 阈值的结果被过滤）
   * - ⚠️ 方向注意：score 是 cosine 距离（越小越相似），本值是"距离上限"——
   *   调高（0.55→0.65→0.70）= 放宽 = 召回↑噪声↑（由 rerank 兜底）；调低 = 更严格 = 召回↓
   * - 默认 0.55（经验值）：2026-09-18 内部评测实测 Recall@10 = 0.84，
   *   约 16% 的 gold 文档（主要是 semantic 题型，gold 距离分布偏远）被该阈值挡在候选池外——
   *   阈值分档实验向放宽方向（0.65/0.70）寻找"召回天花板更高且 Precision 不崩"的平衡档
   * - 影响面：纯向量检索、混合检索（含 HyDE 双向量路）、多跳、子查询、RAG 注入路径
   */
  retrievalMinSimilarity: z.coerce.number().min(0).max(1).default(0.55),

  ollamaBaseUrl: z.string().min(1).default('http://localhost:11434'),
  chromaUrl: z.string().min(1).default('http://localhost:8000'),
  /**
   * 持久化目录覆盖（ChromaDB 数据目录 + BM25 索引落盘目录，两者同源）
   *
   * 未设置时由 store-state.ts 回退到代码内默认值（项目根 `chromadb_data`），
   * 因此生产环境不配置此项 → 行为与改造前完全一致。
   * 设置场景：benchmark 等需要与生产数据物理隔离的旁路（见方案 §4.6 D5=方案 A）。
   * 默认值不写在这里，是因为它依赖 store-state.ts 的文件位置（__dirname 相对推导）。
   */
  chromaPersistDir: z.string().min(1).optional(),
  serverBaseUrl: z.string().min(1).default('http://localhost:3000'),
  deepseekBaseUrl: z.string().min(1).default('https://api.deepseek.com'),
  zhipuBaseUrl: z
    .string()
    .min(1)
    .default('https://open.bigmodel.cn/api/paas/v4'),
  dashscopeBaseUrl: z.string().min(1).default('https://dashscope.aliyuncs.com'),
  dashscopeApiKey: z.string().default(''),

  logLevel: z.string().default('info'),

  searchApiUrl: z.string().default(''),
  searchApiKey: z.string().default(''),
  qweatherApiKey: z.string().default(''),
  qweatherApiBase: z.string().min(1).default('https://devapi.qweather.com'),

  lokiHost: z.string().default(''),

  /** CORS 来源原始字符串，对外通过 corsOrigins getter 暴露数组 */
  corsOriginsRaw: z
    .string()
    .default('http://localhost:5173,http://localhost:3000'),

  db: DbSchema,
  notify: NotifySchema,
  queryDb: QueryDbSchema,
  document: DocumentSchema,
  redis: RedisSchema,
  volcAsr: VolcAsrSchema,
  rateLimit: RateLimitSchema,
  mineru: MineruSchema,
  vlm: VlmSchema,
  imageStorage: ImageStorageSchema,
  ocr: OcrSchema,
  imageRetry: ImageRetrySchema,
  formula: FormulaSchema,
  scannedPdf: ScannedPdfSchema,
  docScan: DocScanSchema,
  kg: KgSchema,
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

    bm25Engine: env.BM25_ENGINE,
    semanticCacheEnabled: env.SEMANTIC_CACHE_ENABLED,
    rerankCandidatePool: env.RETRIEVAL_CANDIDATE_POOL,
    retrievalMinSimilarity: env.RETRIEVAL_MIN_SIMILARITY,

    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    chromaUrl: env.CHROMA_URL,
    chromaPersistDir: env.CHROMA_PERSIST_DIR,
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
      feishuEventMode: env.NOTIFY_FEISHU_EVENT_MODE,
      feishuBotOpenId: env.NOTIFY_FEISHU_BOT_OPEN_ID,
      feishuChatUserId: env.NOTIFY_FEISHU_CHAT_USER_ID,
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
    vlm: {
      enabled: env.VLM_ENABLED,
      apiBase: env.VLM_API_BASE,
      apiKey: env.VLM_API_KEY,
      primaryModel: env.VLM_PRIMARY_MODEL,
      timeoutMs: env.VLM_TIMEOUT_MS,
      concurrency: env.VLM_CONCURRENCY,
      maxCallsPerDoc: env.VLM_MAX_CALLS_PER_DOC,
      fallbackModel: env.VLM_FALLBACK_MODEL,
      fallbackApiBase: env.VLM_FALLBACK_API_BASE,
      fallbackApiKey: env.VLM_FALLBACK_API_KEY,
      docTimeoutToleranceMs: env.VLM_DOC_TIMEOUT_TOLERANCE_MS,
    },
    imageStorage: {
      dir: env.IMAGE_STORAGE_DIR,
      maxSizeBytes: env.IMAGE_MAX_SIZE_BYTES,
    },
    ocr: {
      enabled: env.OCR_ENABLED,
      lang: env.OCR_LANG,
    },
    imageRetry: {
      intervalMin: env.IMAGE_RETRY_INTERVAL_MIN,
      maxRetry: env.IMAGE_RETRY_MAX_RETRY,
    },
    formula: {
      enabled: env.FORMULA_ENABLED,
      modelId: env.FORMULA_MODEL_ID,
      timeoutMs: env.FORMULA_TIMEOUT_MS,
      maxCallsPerDoc: env.FORMULA_MAX_CALLS_PER_DOC,
    },
    scannedPdf: {
      enabled: env.SCANNED_PDF_ENABLED,
      charsPerPageThreshold: env.SCANNED_PDF_CHARS_THRESHOLD,
      renderDpi: env.SCANNED_PDF_RENDER_DPI,
    },
    docScan: {
      enabled: env.DOC_SCAN_ENABLED,
      llmJudgeEnabled: env.DOC_SCAN_LLM_JUDGE_ENABLED,
      maxChunksPerDocument: env.DOC_SCAN_MAX_CHUNKS_PER_DOC,
      suspiciousAction: env.DOC_SCAN_SUSPICIOUS_ACTION,
    },
    kg: {
      enabled: env.KG_ENABLED,
      supplementSlots: env.KG_SUPPLEMENT_SLOTS,
      linkConfThreshold: env.KG_LINK_CONF_THRESHOLD,
      extractDocChars: env.KG_EXTRACT_DOC_CHARS,
      maxEntitiesPerDoc: env.KG_MAX_ENTITIES_PER_DOC,
      extractConcurrency: env.KG_EXTRACT_CONCURRENCY,
      extractTimeoutMs: env.KG_EXTRACT_TIMEOUT_MS,
      linkTimeoutMs: env.KG_LINK_TIMEOUT_MS,
      maxRetries: env.KG_MAX_RETRIES,
      maxOpsPerTick: env.KG_MAX_OPS_PER_TICK,
      candidateTopK: env.KG_CANDIDATE_TOP_K,
      candidateMinScore: env.KG_CANDIDATE_MIN_SCORE,
      tokenPostingCap: env.KG_TOKEN_POSTING_CAP,
      embedMinSim: env.KG_EMBED_MIN_SIM,
      embedSupplementSlots: env.KG_EMBED_SUPPLEMENT_SLOTS,
      embedBatchSize: env.KG_EMBED_BATCH_SIZE,
      hopNeighborWeight: env.KG_HOP_NEIGHBOR_WEIGHT,
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
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

  /** BM25 引擎选型：'minisearch' | 'tantivy'（进程级全局单例，启动时确定） */
  bm25Engine: parsed.bm25Engine,

  /** RAG 语义缓存总开关（默认 true；benchmark 评测设 false，见 .env.example 说明） */
  semanticCacheEnabled: parsed.semanticCacheEnabled,

  /** 二段式检索：宽召回候选池宽度（rerank 精排前的召回数量上限，默认 30） */
  rerankCandidatePool: parsed.rerankCandidatePool,

  /** 向量检索最小相似度阈值（cosine 距离，默认 0.55；阈值分档实验用 env 覆盖） */
  retrievalMinSimilarity: parsed.retrievalMinSimilarity,

  db: parsed.db,

  ollamaBaseUrl: parsed.ollamaBaseUrl,
  chromaUrl: parsed.chromaUrl,
  /**
   * 持久化目录覆盖（未设置时为 undefined，由 store-state.ts 回退代码内默认值）
   * 同时决定 ChromaDB 数据目录与 BM25 索引落盘目录，生产不配置即零影响
   */
  chromaPersistDir: parsed.chromaPersistDir,
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
  vlm: parsed.vlm,
  imageStorage: parsed.imageStorage,
  ocr: parsed.ocr,
  imageRetry: parsed.imageRetry,
  formula: parsed.formula,
  scannedPdf: parsed.scannedPdf,
  docScan: parsed.docScan,
  kg: parsed.kg,
} as const;

export type AppConfig = typeof config;

// ==================== 运行时数据目录 ====================

/**
 * 运行时数据目录（统一以「项目根 = process.cwd()」为基准）
 *
 * 为什么不用 __dirname 相对路径：
 * 编译产物是 dist/src/**（入口 dist/src/main.js），`__dirname` 指向 dist/src/...，
 * 各控制器再往上跳若干级得到的目录会落到 dist/ 下，与 docker-compose 挂载到
 * 项目根的 uploads 目录（./data/uploads:/app/servers/jerry-llm-server/uploads）
 * 不一致，导致三类问题：
 *   1. 写入目录与 express.static 服务的目录不是同一个（上传成功但访问 404，头像即此问题）
 *   2. 文件落在容器镜像层，容器重建后丢失（挂载卷形同虚设）
 *   3. 不同文件跳级数不统一时，写入方与读取方指向不同目录
 *
 * 统一用 process.cwd() 锚定后，本地开发（cwd = servers/jerry-llm-server）与
 * 生产容器（WORKDIR = /app/servers/jerry-llm-server）解析结果一致，且与挂载卷对齐。
 */
export const runtimePaths = {
  /** 上传文件根目录：由 main.ts 以 /files 前缀对外提供静态访问 */
  uploads: path.resolve(process.cwd(), 'uploads'),
};
