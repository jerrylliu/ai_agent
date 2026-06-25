// ============================================================================
// 文件作用：Prompt 服务的核心入口，负责把用户输入 → 路由 → 调 LLM → 处理工具调用
//          → SSE 流式输出回客户端。是后端最重的一个模块（2200+ 行）。
//
// 引入资源说明（按下方 import 顺序）：
//   1) @langchain/core/messages —— LangChain 提供的消息类型（角色封装）。
//   2) express 的 Response 类型 —— SSE 写流时需要拿到原生 res 对象。
//   3) Node.js 内置模块：path / fs / https / http —— 文件路径、文件系统、HTTP(S) 客户端。
//   4) ./sse-writer —— 项目内 SSE 写流封装（统一 event 格式 + 心跳）。
//   5) ./rag-service / ./vector-store —— 知识库检索（RAG 链路）。
//   6) ./model-provider —— LLM 客户端工厂（含限流封装、能力查询）。
//   7) ./tools 及其子模块 —— LangChain Tool 注册中心 + plan-execute 调度。
//   8) ./router/agent-router —— Agent 智能路由（决定调哪类工具集）。
//   9) ./logger / ./config —— Winston 日志 + 全局配置。
//  10) ./multi-level-cache —— 多级缓存（L1 LRU + L2 Redis），用于跨轮资产缓存。
//  11) ./prompt-injection-guard —— 提示词注入防护（用户输入安全审查）。
// ============================================================================

// 【LangChain 消息类型】使用「具名导入（named imports）」语法，从同一模块批量解构出 4 个类。
// HumanMessage   —— 角色 user 的消息封装
// AIMessage      —— 角色 assistant 的消息封装（可携带 tool_calls）
// SystemMessage  —— 角色 system 的消息封装（系统级指令）
// ToolMessage    —— 角色 tool 的消息封装（工具调用结果回填给 LLM）
// 第三方包路径不带 .js 后缀，由 Node 的 package exports 解析。
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

// 【type-only 导入】`import type` 只拉取类型，不会出现在运行时产物中（被 TS 编译期擦除）。
// Response 是 Express 的响应对象类型，仅用于 SSE 流式响应的参数标注。
import type { Response } from 'express';

// 【命名空间导入】`import * as X from 'pkg'` 将整个模块作为对象导入，访问 X.method() 形式。
// 这里全部为 Node 内置模块（不需要安装）。
import * as path from 'path';   // 处理跨平台文件路径拼接（path.join、path.resolve）
import * as fs from 'fs';       // 同步/异步文件系统读写
import * as https from 'https'; // HTTPS 请求客户端（用于下载远程资源）

// 【相对路径导入】具名导入项目内部模块的若干工具函数。
// 注意：本项目运行在 NestJS 11 ESM 模式下，相对路径理论上需要带 .js 后缀，
//       但本文件历史上未带后缀（被 ts-node-dev 等工具兼容处理），保持现状。
// sse-writer 提供 SSE 协议层的统一事件写入函数。
import { sendToolStatus, startHeartbeat, stopHeartbeat, sendMetadata, sendSessionAction, sendContent, sendFileCard } from './sse-writer';

/**
 * 【自定义错误类】class 关键字 + extends Error 继承内置 Error。
 * 用途：FC（Function Calling）模式中检索知识库后若需要降级到 RAG 模式，
 *       通过抛出本错误把「已经检索到的知识库结果」一并带出来，
 *       避免外层重复检索浪费一次向量查询。
 *
 * 语法点：
 *   - constructor 中先 super(message) 触发 Error 父类初始化（必须先于 this 访问）
 *   - this.name 重写错误名，便于日志识别
 *   - 公开字段 knowledgeBaseResult 直接赋值（TS 严格模式要求声明类型）
 */
class FCFallbackError extends Error {
  knowledgeBaseResult: string;
  constructor(message: string, knowledgeBaseResult: string = '') {
    super(message);
    this.name = 'FCFallbackError';
    this.knowledgeBaseResult = knowledgeBaseResult;
  }
}

// 【Node 内置模块】HTTP 客户端，与上方 https 配对使用（视目标 URL 协议选择）。
import * as http from 'http';

// 【RAG 链路】retrieveFromKnowledgeBase：执行向量召回 + 重排，返回拼接好的上下文文本。
import { retrieveFromKnowledgeBase } from './rag-service';
// 【向量库统计】getKnowledgeBaseStats：返回当前知识库文档数等元信息（用于路由决策）。
import { getKnowledgeBaseStats } from './vector-store';
// 【模型工厂】批量解构 6 个函数：
//   createLLM            —— 创建普通 LLM 客户端实例
//   createRateLimitedLLM —— 创建带限流封装的 LLM 实例（防止打爆上游 API）
//   buildModelConfig     —— 根据模型 ID + 模式构建配置对象
//   getCurrentModelId    —— 读取当前活跃模型 ID（环境变量或运行时切换）
//   getModelInfo         —— 查询模型元信息（厂商、定价等）
//   getModelCapabilities —— 查询模型能力（context length / 是否支持 FC / 是否多模态）
import { createLLM, createRateLimitedLLM, buildModelConfig, getCurrentModelId, getModelInfo, getModelCapabilities } from './model-provider';
// 【工具中心】LangChain Tool 注册管理：
//   getToolSchemasForModel —— 拿到该模型可见的所有 tool JSON Schema（function calling 使用）
//   executeTool            —— 根据 tool 名 + 参数执行具体工具实现
//   hasTool                —— 校验某个 tool 名是否存在
//   getAvailableToolNames  —— 列出所有已注册的工具名
import { getToolSchemasForModel, executeTool, hasTool, getAvailableToolNames } from './tools';
// 【Plan-and-Execute 调度】把多步任务拆为 plan，逐步执行：
//   resolveDataBindings —— 解析步骤间数据绑定（${step1.output} 这类引用）
//   getSessionPlan      —— 读取会话当前的 plan 对象
//   storeStepOutput     —— 把某步骤产出存入会话上下文，供后续步骤引用
//   findMatchingStep    —— 根据 tool 调用反查所属 plan step
import { resolveDataBindings, getSessionPlan, storeStepOutput, findMatchingStep } from './tools/plan-execute';
// 【智能路由】根据用户输入判断走哪条链路（普通 chat / RAG / Agent）：
//   routeRequest             —— 给定 query，返回路由决策
//   applyAgentToolWhitelist  —— 按 Agent 类型筛掉禁用的工具
import { routeRequest, applyAgentToolWhitelist } from './router/agent-router';
// 【搜索结果格式化】把搜索引擎原始 JSON 转成模型友好的 Markdown 摘要。
import { formatSearchResultAsSummary } from './tools/search-web';
// 【日志器 & 配置】项目级单例：
//   logger 走 Winston + Loki，必须带 module 字段；
//   config 是从环境变量收敛后的强类型配置对象。
import { logger } from './logger';
import { config } from './config';
import { z } from 'zod';
import { parseLlmJson, parseToolResultJson } from './llm-json-parser';
import { searchWebResultSchema } from './tools/search-web';
import {
  generateImageResultSchema,
  createMindmapResultSchema,
  generateChartResultSchema,
} from './tools/multimodal-output';
import { generateDocumentResultSchema } from './tools/generate-document';
// 【多模态产出辅助】mindmapImageUrl：把 mermaid 源码转成可访问的图片 URL（懒渲染）。
import { mindmapImageUrl } from './tools/multimodal-output';
// 【泛型缓存类】MultiLevelCache<T>：T 为缓存值类型，支持 L1（内存 LRU）+ L2（Redis）。
import { MultiLevelCache } from './multi-level-cache';
// 【提示注入防护】这是本文件唯一带 .js 后缀的相对导入（符合 ESM 规范）：
//   buildPromptInjectionSafetyInstruction —— 生成防注入的系统提示
//   inspectPromptInjection                —— 检查输入是否包含可疑注入模式
//   UNTRUSTED_CONTEXT_INSTRUCTION         —— 标准化的「不可信上下文」提示常量
import { buildPromptInjectionSafetyInstruction, inspectPromptInjection, UNTRUSTED_CONTEXT_INSTRUCTION } from './prompt-injection-guard.js';
import { stripMarkdownImages } from './feishu/feishu-markdown-image.js';

/**
 * ========================================================================
 * 跨轮次资产缓存：保存上轮 FC 循环生成的图片/图表/思维导图/文档 URL，
 * 下一轮对话时注入到系统消息中，让 LLM 可以直接使用而非重新生成。
 *
 * 缓存架构：MultiLevelCache（L1 内存 LRU + L2 Redis）
 *   - L1：进程内 Map（< 0.1ms）
 *   - L2：Redis（跨实例共享 + 重启不丢）
 *   - Redis 不可用时自动降级为纯 L1，与改造前行为一致
 *
 * TTL（TTL = Time To Live,中文叫「生存时间 / 存活时间」） 1 小时：覆盖"生成 → 切走 → 回来要求发邮件"等较长间隔
 * 业务效果：用户第 1 轮生成了图片，1 小时内回来说「发到我邮箱」，模型还能从缓存读到上轮 URL 直接用；超过 1 小时再回来，缓存已过期，模型会重新生成。
 * - TTL 抖动（jitter） ：ttlJitterRatio: 0.1 —— 让每条 key 的实际 TTL 在 ±10% 范围内随机浮动。这是防止「缓存雪崩」（大量 key 同一秒过期，瞬间打爆数据库）的标准做法。
 * - TTL 续期（touch） ： saveSessionAssets 里有 sessionAssetCache.touch(sessionId) —— 当本轮没有新资产时，只刷新过期时间不覆盖内容，避免被空数据替换。
 * （与 ChatGPT/Claude 主流对话连贯感时长一致）
 * 文档实体本身 TTL 是 7 天（DB），这里仅控制"提示注入"的持续时间。
 * ========================================================================
 */
interface SessionAssetEntry {
  // 【interface 语法】TS 接口，用于描述对象结构（运行时不存在，编译期擦除）。
  // 【Array<T> 与 T[] 等价】这里用 Array<{...}> 是为了在内嵌对象类型时更可读。
  // images：上一轮 generate_image 工具产出的图片列表（url + 描述文本 alt）。
  images: Array<{ url: string; alt: string }>;
  // charts：上一轮 generate_chart 工具产出的图表（已渲染为图片 URL）。
  // chartType?: 用 ? 声明可选属性（line/bar/pie 等）。
  charts: Array<{ imageUrl: string; chartType?: string }>;
  // mindmaps：上一轮 create_mindmap 产出，imageUrl 由 mermaid 源码懒渲染得到。
  mindmaps: Array<{ imageUrl: string; title?: string }>;
  // fileCards：上一轮 generate_document 产出的文档卡（PDF/Word/HTML 等）。
  fileCards: Array<{ fileUrl: string; filename: string; format: string }>;
}

// 【常量声明】const + 命名采用 UPPER_SNAKE_CASE 表示编译期常量。
// 60 * 60 = 3600 秒，即 1 小时。让数字保留计算式比直接写 3600 更易读，
// TS 编译会做常量折叠，无运行时开销。
const ASSET_CACHE_TTL_SEC = 60 * 60; // 1 小时

// 【泛型实例化】new MultiLevelCache<SessionAssetEntry>({...})
//   <SessionAssetEntry> 显式指定泛型参数 T，使后续 cache.get/set 自带类型推断。
//   构造参数为对象字面量（options pattern），含 4 个字段：
//     namespace      —— Redis key 前缀，用于区分不同业务的缓存
//     ttlSec         —— 缓存生存期（秒），到期自动失效
//     l1MaxSize      —— L1 内存中最大条目数，溢出按 LRU 策略淘汰
//     ttlJitterRatio —— TTL 抖动比例（±10%），避免大量 key 同时过期造成「缓存雪崩」
const sessionAssetCache = new MultiLevelCache<SessionAssetEntry>({
  namespace: 'session-asset',
  ttlSec: ASSET_CACHE_TTL_SEC,
  l1MaxSize: 1000, // 假设并发会话数 < 1000，超过会 LRU 淘汰
  ttlJitterRatio: 0.1, // ±10% 抖动，防雪崩
});

/** 保存会话资产 */
async function saveSessionAssets(
  sessionId: string | undefined,
  collectedImages: Array<{ url: string; alt: string }>,
  collectedChartOptions: Array<{ option: any; chartType?: string; imageUrl?: string }>,
  collectedMindmaps: Array<{ mermaidCode: string; title: string; imageUrl?: string }>,
  collectedFileCards: Array<{ key: string; filename: string; format: string }> = [],
) {
  if (!sessionId) {
    logger.debug('FC资产缓存：跳过保存（sessionId 为空）', { module: 'PromptService' });
    return;
  }
  const charts = collectedChartOptions
    .filter(c => c.imageUrl)
    .map(c => ({ imageUrl: c.imageUrl!, chartType: c.chartType }));
  // 思维导图：优先用工具返回的 imageUrl，否则通过 mindmapImageUrl() 生成
  // mindmapImageUrl 现在是 async（L2 Redis 写入需要 await），用 Promise.all 并发处理
  const mindmaps = await Promise.all(
    collectedMindmaps.map(async (m) => ({
      imageUrl: m.imageUrl || (await mindmapImageUrl(m.mermaidCode)),
      title: m.title,
    })),
  );
  // 文档：把 key 转为 fc://document/{key} 内部协议（与 send_notification.attachments 链路一致）
  const fileCards = collectedFileCards.map(f => ({
    fileUrl: `fc://document/${f.key}`,
    filename: f.filename,
    format: f.format,
  }));

  // 本轮无任何新资产时，保留上一轮缓存（仅刷新 TTL），避免被空数据覆盖
  // 场景：第 1 轮生成内容 → 第 2 轮发邮件（无新资产）→ 第 3 轮再次发邮件
  // 若直接覆盖，第 3 轮会读到空数组，导致模型重新生成
  const hasNewAssets =
    collectedImages.length > 0 || charts.length > 0 || mindmaps.length > 0 || fileCards.length > 0;
  if (!hasNewAssets) {
    // touch：仅续期，不覆盖内容；若 key 已不存在则什么都不做（多级缓存内部保证降级安全）
    await sessionAssetCache.touch(sessionId);
    logger.debug('FC资产缓存：本轮无新资产，已尝试续期', {
      module: 'PromptService',
      sessionId,
    });
    return;
  }

  await sessionAssetCache.set(sessionId, {
    images: collectedImages,
    charts,
    mindmaps,
    fileCards,
  });
  logger.info('FC资产缓存：已保存本轮生成的多媒体 URL', {
    module: 'PromptService',
    sessionId,
    imageCount: collectedImages.length,
    chartCount: charts.length,
    mindmapCount: mindmaps.length,
    fileCardCount: fileCards.length,
  });
}

/** 获取会话资产并清理过期项 */
async function getSessionAssets(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const entry = await sessionAssetCache.get(sessionId);
  if (!entry) return null;

  const parts: string[] = [];
  if (entry.images.length > 0) {
    parts.push('图片：\n' + entry.images.map((img, i) => `  ${i + 1}. ${img.url}`).join('\n'));
  }
  if (entry.charts.length > 0) {
    parts.push('图表：\n' + entry.charts.map((ch, i) => `  ${i + 1}. imageUrl: ${ch.imageUrl}`).join('\n'));
  }
  if (entry.mindmaps.length > 0) {
    parts.push('思维导图：\n' + entry.mindmaps.map((mm, i) => `  ${i + 1}. imageUrl: ${mm.imageUrl}`).join('\n'));
  }
  if (entry.fileCards.length > 0) {
    parts.push(
      '文档（PDF/Word/HTML）：\n' +
      entry.fileCards
        .map((f, i) => `  ${i + 1}. filename: "${f.filename}"，format: ${f.format}，fileUrl: ${f.fileUrl}`)
        .join('\n'),
    );
  }
  if (parts.length === 0) return null;
  // 强化版提示词：短 + 直接 + 放在前面
  // LLM 看到"发邮件"等词时容易重新生成内容，必须强硬告知已有 URL 可直接用
  return `\n\n⚠️ 上一轮对话中已生成以下多媒体内容，URL 仍然有效：\n${parts.join('\n\n')}\n\n【重要】以上 URL 可以直接作为 send_notification 的 attachments[].url 参数。如果用户说"发到邮箱""把这些发给我""把刚才的文档发给我"等，只需调 send_notification，填入上面对应的 URL（图片用 url，文档用 fileUrl），绝对不要再调 generate_image / generate_chart / create_mindmap / generate_document 重新生成。`;
}

// ==================== FC 模式进度通知辅助函数 ====================
// SSE 写入函数已提取到 sse-writer.ts

// ==================== 防嘴炮·工具意图检测 ====================
/**
 * 用户意图检测结果
 */
interface ToolIntentDetection {
  /** 是否需要强制 LLM 必须调用工具（true 时 tool_choice 不能用 auto） */
  shouldForce: boolean;
  /** 锁定到的具体工具名（如能精准识别），为空则用 'required' 让模型自选 */
  specificTool?: string;
  /** 命中的判断依据（用于日志和调试） */
  reason: string;
}

/**
 * 根据用户消息检测是否表达了"必须调用工具"的意图。
 *
 * 设计哲学（参考 OpenAI Cookbook / Anthropic Tool Use Guide）：
 * - 不试图覆盖所有 NLU 场景，而是用"高置信度白名单"覆盖最常见的
 *   多媒体生成场景，因为这类场景模型最容易"嘴炮"（输出文字而不调工具）。
 * - 查询类（搜索/天气/计算）保留 auto，让模型自己决定（这些工具不调
 *   也能用知识回答，强制反而可能影响体验）。
 * - 无法判断时返回 shouldForce=false，由 LLM 自行决定。
 *
 * 命中示例：
 *   "生成一张星空图片"      → specificTool='generate_image'
 *   "画一个西安天气图表"    → specificTool='generate_chart'
 *   "做一个前端学习思维导图" → specificTool='create_mindmap'
 *   "帮我做点什么"           → shouldForce=false（太模糊）
 */
function detectToolIntent(userMessage: string): ToolIntentDetection {
  if (!userMessage || userMessage.trim().length === 0) {
    return { shouldForce: false, reason: '空消息' };
  }
  const text = userMessage.toLowerCase();

  // ---- 动词集合：表示"创造、产出某物"的所有常见说法 ----
  // 中英文混合，覆盖正式/口语/敬语/祈使
  const createVerbs = '生成|创建|制作|做(?:一|个|出)?|画|绘制|帮我.{0,5}(?:做|画|生成|搞|弄|来)|给我.{0,5}(?:做|画|生成|来)|来.{0,3}个|来.{0,3}张|输出|产出|create|generate|make|draw|build|design';

  // ---- 1. generate_image：图片/图像/照片/海报/封面/插画 ----
  // 兼容 "XX图"（风景图、星空图、海报图等任意 N 字定语 + 图）
  // 兼容英文 image/photo/picture/poster/illustration
  const imagePattern = new RegExp(
    `(?:${createVerbs}).{0,20}(?:图片|图像|照片|海报|封面|插画|插图|画作|画|壁纸|头像|logo|图$|图[，。、；！？\\s]|image|photo|picture|poster|illustration|wallpaper|avatar)`,
    'i'
  );
  if (imagePattern.test(text)) {
    return { shouldForce: true, specificTool: 'generate_image', reason: '匹配图片生成关键词' };
  }

  // ---- 2. create_mindmap：思维导图/脑图/知识图谱（结构化） ----
  const mindmapPattern = new RegExp(
    `(?:${createVerbs}).{0,20}(?:思维导图|脑图|知识图谱|结构图|大纲图|mindmap|mind map)`,
    'i'
  );
  if (mindmapPattern.test(text)) {
    return { shouldForce: true, specificTool: 'create_mindmap', reason: '匹配思维导图关键词' };
  }

  // ---- 3. generate_chart：图表/折线图/柱状图/饼图/雷达图/趋势图 ----
  const chartPattern = new RegExp(
    `(?:${createVerbs}).{0,20}(?:图表|折线图|柱状图|条形图|饼图|雷达图|散点图|趋势图|分布图|占比图|chart|line chart|bar chart|pie chart|radar chart)`,
    'i'
  );
  if (chartPattern.test(text)) {
    return { shouldForce: true, specificTool: 'generate_chart', reason: '匹配图表生成关键词' };
  }

  // ---- 4. send_notification：发邮件/发送到邮箱（明确动作 + 邮箱实体） ----
  // 仅当同时出现"发/发送"和"邮箱/邮件/email"才触发，避免误判"我邮箱是 xxx"
  const sendEmailPattern = /(?:发送?|寄|email).{0,30}(?:邮箱|邮件|email|@)/i;
  const hasEmailAction = sendEmailPattern.test(text);
  if (hasEmailAction) {
    return { shouldForce: true, specificTool: 'send_notification', reason: '匹配邮件发送关键词' };
  }

  // ---- 兜底：用户明确说"调用工具"等元描述（罕见但存在） ----
  if (/调用.{0,5}工具|use.{0,5}tool|call.{0,5}function/i.test(text)) {
    return { shouldForce: true, reason: '用户明确要求调用工具' };
  }

  return { shouldForce: false, reason: '未识别强烈工具意图' };
}

/**
 * 判断用户消息是否是"实质性问题"（需要查询知识库的候选）。
 *
 * 用于决定是否强制调用 search_knowledge_base：
 * - 问候/闲聊（"你好""谢谢"）→ 不强制，直接回答
 * - 纯指令（"生成图片""画图表"）→ 不强制，已有 detectToolIntent 处理
 * - 实质性问题（"武器室规范是什么""怎么申请""3.2.4条说了什么"）→ 强制查知识库
 *
 * 判断标准：消息长度足够（>=4字）且不是纯问候/感谢/确认。
 */
/**
 * 判断用户消息是否是"纯问候/感谢/确认/告别"等寒暄客套。
 *
 * 这类消息按定义不需要任何工具——既不查知识库，也不生成多媒体。
 * 用于在 FC 首轮把 tool_choice 确定性设为 'none'，根治 auto 模式下
 * 模型"手痒"乱调 list_knowledge_base 等无参工具的问题（不依赖模型遵守提示词）。
 */
const GREETING_PATTERNS: RegExp[] = [
  /^(你好|您好|hi|hello|hey|嗨|哈喽|哈啰|早上好|中午好|下午好|晚上好|早安|晚安)[\s!！.。?？呀啊哦~]*$/i,
  /^(谢谢|感谢|多谢|thx|thanks|thank you|3q)[\s!！.。你您~]*$/i,
  /^(好的|明白|了解|收到|ok|okay|好|嗯|哦|嗯嗯|行|可以)[\s!！.。~]*$/i,
  /^(再见|拜拜|bye|goodbye|88)[\s!！.。~]*$/i,
  /^(在吗|在么|在不在)[\s!！.。?？~]*$/i,
];

function isPureGreeting(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return GREETING_PATTERNS.some(p => p.test(trimmed));
}

function isSubstantiveQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;

  // 纯问候/感谢/确认/闲聊 → 不需要查知识库
  if (isPureGreeting(trimmed)) return false;

  return true;
}

/**
 * LLM-as-Judge：用一个轻量 LLM 调用判断 AI 输出是否是"嘴炮"
 * （即口头答应了工具调用但没真的调用）
 *
 * 业内主流做法（参考 Microsoft Semantic Kernel / LangChain ReflectionAgent）：
 * - 把 user 原始请求 + AI 文本回复，作为输入交给一个轻量 LLM
 * - 让其判断"这个 AI 回复到底是真的回答完了，还是嘴炮"
 * - 输出严格 JSON 结构（is_mouth_cannon + reason）
 *
 * 设计取舍：
 * - 复用主 LLM 客户端（带 rate limit），不引入新依赖
 * - 短超时（5 秒），失败时 fail-open（不重试，保留原回复）
 * - 仅在前两道正则防线都没命中时调用，所以总开销很低
 */
async function llmAsToolIntentJudge(
  userMessage: string,
  aiResponse: string,
  abortController?: AbortController,
): Promise<{ isMouthCannon: boolean; reason: string }> {
  // 截断输入，避免长上下文影响 judge LLM 的判断
  const truncatedUser = userMessage.length > 400 ? userMessage.slice(0, 400) + '...' : userMessage;
  const truncatedAi = aiResponse.length > 400 ? aiResponse.slice(0, 400) + '...' : aiResponse;

  const judgePrompt = `你是一个对话质量审核员。请判断下面的"AI回复"是否属于"嘴炮"。

判断标准：
- AI 回复中明确说要"做某事"（如生成图片、画图表、发邮件等需要实际操作才能完成的事），但回复中并没有给出实际成果（图片URL/数据/结果），只是文字承诺，那就是嘴炮。
- AI 回复只是询问用户更多信息（如"请提供邮箱"）、纯文本回答问题、或者已经给出了结果（如分析结论、代码、文字描述），那就不是嘴炮。

用户请求：
"""${truncatedUser}"""

AI 回复：
"""${truncatedAi}"""

请严格按以下 JSON 格式输出，不要有任何额外文字：
{"is_mouth_cannon": true/false, "reason": "一句话理由"}`;

  try {
    // 复用主 LLM（无 tools 绑定，纯文本判断）
    // 不用 isFCMode=true，避免 tools schema 干扰；temperature 留默认值
    const llm = createLLM(buildModelConfig(getCurrentModelId(), { isFCMode: false }));
    const judgePromise = llm.invoke([new HumanMessage(judgePrompt)], {
      signal: abortController?.signal,
    });
    // 5 秒超时：avoid 阻塞主流程
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('LLM-as-Judge timeout')), 5000),
    );
    const judgeResp = await Promise.race([judgePromise, timeoutPromise]);
    const judgeText = typeof (judgeResp as any).content === 'string'
      ? (judgeResp as any).content
      : JSON.stringify((judgeResp as any).content);

    // zod schema 校验 LLM 输出，替代裸 JSON.parse
    const judgeSchema = z.object({
      is_mouth_cannon: z.boolean(),
      reason: z.string().optional(),
    });
    const parsed = parseLlmJson(judgeText, judgeSchema, {
      module: 'PromptService:MouthCannonJudge',
    });
    if (!parsed.success) {
      // fail-open：判断失败不阻塞主回复
      return { isMouthCannon: false, reason: `判断器输出无法解析: ${parsed.reason}` };
    }
    return {
      isMouthCannon: parsed.data.is_mouth_cannon === true,
      reason: parsed.data.reason || '未提供理由',
    };
  } catch (err: any) {
    // 失败时 fail-open，让原回复正常返回（避免误杀）
    logger.warn('LLM-as-Judge：调用失败，fail-open', {
      module: 'PromptService',
      error: err.message,
    });
    return { isMouthCannon: false, reason: '判断器异常' };
  }
}

// ==================== Token 预算策略 ====================

/**
 * 流式输出中跨 chunk 过滤 <think...</think 标签
 * 推理模型（如 DeepSeek-R1）会输出 <think 块，需要正确过滤掉
 * 简单的正则替换无法处理标签跨 chunk 的情况
 */
function filterThinkTags(content: string, inThinkBlock: boolean): { text: string; inThinkBlock: boolean } {
  let remaining = content;
  let result = '';
  let inThink = inThinkBlock;

  while (remaining.length > 0) {
    if (inThink) {
      const endIdx = remaining.indexOf('</think');
      if (endIdx !== -1) {
        const closeEnd = remaining.indexOf('>', endIdx);
        if (closeEnd !== -1) {
          inThink = false;
          remaining = remaining.substring(closeEnd + 1);
        } else {
          // </think 未闭合，继续缓冲
          remaining = '';
        }
      } else {
        // 还在 think 块中，全部丢弃
        remaining = '';
      }
    } else {
      const thinkIdx = remaining.indexOf('<think');
      if (thinkIdx !== -1) {
        result += remaining.substring(0, thinkIdx);
        const afterThink = remaining.substring(thinkIdx);
        const openEnd = afterThink.indexOf('>');
        if (openEnd !== -1) {
          const afterOpenTag = afterThink.substring(openEnd + 1);
          const endIdx = afterOpenTag.indexOf('</think');
          if (endIdx !== -1) {
            const closeEnd = afterOpenTag.indexOf('>', endIdx);
            if (closeEnd !== -1) {
              remaining = afterOpenTag.substring(closeEnd + 1);
            } else {
              inThink = true;
              remaining = '';
            }
          } else {
            inThink = true;
            remaining = '';
          }
        } else {
          inThink = true;
          remaining = '';
        }
      } else {
        result += remaining;
        remaining = '';
      }
    }
  }

  return { text: result, inThinkBlock: inThink };
}

/**
 * 过滤模型输出的原始工具调用格式文本
 * 当模型的 function calling 失败时，可能将工具调用格式作为文本输出，
 * 例如 DeepSeek 的 <｜｜DSML｜｜tool_calls> 格式
 * 这些内容不应展示给用户
 *
 * 注意：检测用正则不带 /g 标志（避免 lastIndex 问题），
 *       过滤用正则带 /g 标志（需要全局替换）
 */

// 检测用正则（不带 /g，避免 .test() 的 lastIndex 副作用）
const RAW_TOOL_CALL_DETECT_PATTERNS = [
  /<｜｜DSML｜｜[^>]*>/,                     // DeepSeek DSML 标签
  /<\/｜｜DSML｜｜[^>]*>/,                    // DeepSeek DSML 闭合标签
  /<\|\|DSML\|\|[^>]*>/,                     // DeepSeek DSML 标签（ASCII 编码）
  /<\/\|\|DSML\|\|[^>]*>/,                   // DeepSeek DSML 闭合标签（ASCII 编码）
  /<tool_calls>[\s\S]*?<\/tool_calls>/,      // 通用 tool_calls 标签
  /<function_call>[\s\S]*?<\/function_call>/, // 通用 function_call 标签
];

// 过滤用正则（带 /g，用于全局替换）
const RAW_TOOL_CALL_REPLACE_PATTERNS = [
  /<｜｜DSML｜｜[^>]*>/g,
  /<\/｜｜DSML｜｜[^>]*>/g,
  /<\|\|DSML\|\|[^>]*>/g,
  /<\/\|\|DSML\|\|[^>]*>/g,
  /<tool_calls>[\s\S]*?<\/tool_calls>/g,
  /<function_call>[\s\S]*?<\/function_call>/g,
];

/**
 * 检测文本是否包含原始工具调用格式
 */
function containsRawToolCallFormat(text: string): boolean {
  return RAW_TOOL_CALL_DETECT_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * 过滤文本中的原始工具调用格式标签
 */
function filterRawToolCalls(text: string): string {
  let result = text;
  for (const pattern of RAW_TOOL_CALL_REPLACE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

/**
 * 判断文本是否可能是原始工具调用格式的开头（用于流式缓冲决策）
 * 只检查常见的起始标记，避免对正常文本过度缓冲
 */
function isPossibleRawToolCallStart(text: string): boolean {
  // 检查是否以 < 开头且可能是工具调用标签的起始
  return /^[<｜]/.test(text) || text.includes('<|') || text.includes('<｜');
}

/**
 * 估算字符串占用的 token 数（粗略，用于历史裁剪和预算计算）。
 * 经验值：中文每 1.5 字 ≈ 1 token；英文/数字/符号每 4 字符 ≈ 1 token。
 * 真实计费请用厂商提供的 tokenizer，本函数仅用于上下文窗口预算（误差可接受）。
 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 格式化工具结果为模型友好的内容
 * search_web：使用结构化摘要（保留url，去掉engine/total，snippet完整，Top-K限制）
 * 其他工具：保持原始内容不变
 */
function formatToolResult(toolName: string, content: string, modelId: string): string {
  if (toolName === 'search_web') {
    const parsed = parseToolResultJson(content, searchWebResultSchema, {
      module: 'PromptService:formatToolResult',
      toolName,
    });
    if (!parsed.success) {
      return content;
    }
    const caps = getModelCapabilities(modelId);
    const isSmallContext = caps.contextLength < 8192;
    const maxResults = isSmallContext ? 3 : 5;
    return formatSearchResultAsSummary(parsed.data, maxResults);
  }

  if (toolName === 'generate_image') {
    const parsed = parseToolResultJson(content, generateImageResultSchema, {
      module: 'PromptService:formatToolResult',
      toolName,
    });
    if (!parsed.success) {
      return content;
    }
    const data = parsed.data;
    if (data.type === 'image' && data.images && data.images.length > 0) {
      // 图片已在流式输出前由服务端注入，LLM 只需用文字描述结果
      const imageCount = data.images.length;
      // 保留图片 URL，LLM 可传给 send_notification.attachments
      const imageUrlLines = data.images
        .map((img, i: number) => `图片${imageCount > 1 ? ` ${i + 1}` : ''} URL：${img.url}`)
        .join('\n');
      return `图片生成成功！共生成 ${imageCount} 张图片，实际使用模型：${data.model || '未知'}。\n${imageUrlLines}\n\n请用文字描述图片内容，并告知用户实际使用的模型名称。如果用户要求发邮件，把上面的图片 URL 传给 send_notification 的 attachments 字段即可。重要：图片已自动展示给用户，不要在回答中再输出任何 ![...](...) 格式的图片 Markdown，只需文字描述即可。`;
    }
    return data.message || content;
  }

  if (toolName === 'create_mindmap') {
    const parsed = parseToolResultJson(content, createMindmapResultSchema, {
      module: 'PromptService:formatToolResult',
      toolName,
    });
    if (!parsed.success) {
      return content;
    }
    const data = parsed.data;
    if (data.type === 'mindmap' && data.mermaidCode) {
      // 把 imageUrl 放在最前面，LLM 必须看到并传给 send_notification.attachments
      const imageUrlLine = data.imageUrl
        ? `**静态图片链接**（传给 send_notification.attachments 用）：${data.imageUrl}\n\n`
        : '';
      return `思维导图生成成功！${imageUrlLine}思维导图已自动展示给用户，请用文字简要描述内容即可，不要再输出任何 \`\`\`mermaid 代码块（前端会自动渲染）。如果用户要求发邮件，把 imageUrl 传给 send_notification.attachments 字段。`;
    }
    return data.message || content;
  }

  if (toolName === 'generate_chart') {
    const parsed = parseToolResultJson(content, generateChartResultSchema, {
      module: 'PromptService:formatToolResult',
      toolName,
    });
    if (!parsed.success) {
      return content;
    }
    const data = parsed.data;
    if (data.type === 'chart' && data.echartsOption) {
      // 把 imageUrl 放在最前面，LLM 必须看到并传给 send_notification.attachments
      const imageUrlLine = data.imageUrl
        ? `**静态图片链接**（传给 send_notification.attachments 用）：${data.imageUrl}\n\n`
        : '';
      return `图表生成成功！${data.chartType ? `类型：${data.chartType}。` : ''}${imageUrlLine}图表已自动以交互式形式展示给用户，请用文字简要描述图表内容即可，不要再输出任何 \`\`\`echarts 代码块（前端会自动渲染）。如果用户要求发邮件，把 imageUrl 传给 send_notification.attachments 字段。`;
    }
    return data.message || content;
  }

  if (toolName === 'generate_document') {
    const parsed = parseToolResultJson(content, generateDocumentResultSchema, {
      module: 'PromptService:formatToolResult',
      toolName,
    });
    if (!parsed.success) {
      return content;
    }
    const data = parsed.data;
    if (data.success && data.type === 'document') {
      // fileUrl 必须保留：用户要求邮件发送时，LLM 需要把它填入 send_notification.attachments
      return `文档"${data.filename}"（${data.format?.toUpperCase()}，${((data.sizeBytes ?? 0) / 1024).toFixed(1)} KB）已生成成功。\n**fileUrl**（发邮件用）：${data.fileUrl}\n\n文件卡片已自动展示给用户，包含下载和预览按钮，请用一两句话简要说明文档内容即可，不要再列出文档结构或重复描述章节。如果用户要求发邮件，把上面的 fileUrl 传给 send_notification.attachments[].url 字段。`;
    }
    return data.message || content;
  }

  // 其他工具保持原始内容
  return content;
}

/**
 * 根据模型上下文窗口大小计算历史消息的 token 总预算
 * FC 模式下需要扣除工具 Schema 占用的 token
 */
function computeTotalBudgetForModel(isFCMode: boolean): number {
  const modelId = getCurrentModelId();
  const caps = getModelCapabilities(modelId);
  const modelConfig = buildModelConfig(modelId, { isFCMode });
  const modelCtx = modelConfig.numCtx ?? caps.contextLength;
  const isSmallContext = caps.contextLength < 8192;
  // 预留 System Prompt + 工具 Schema + 输出空间
  const systemPromptTokens = isSmallContext ? 800 : 1500;
  const toolSchemaTokens = isFCMode ? (isSmallContext ? 600 : 1500) : 0;
  const outputReserve = isSmallContext ? 800 : 2000;
  const budget = modelCtx - systemPromptTokens - toolSchemaTokens - outputReserve;
  return Math.max(budget, 500); // 至少保留 500
}

interface HistoryBudget {
  maxRounds: number;        // 允许传入的历史轮数（1轮 = user + assistant）
  budgetUsed: number;       // 已被知识库/图片占用的预算
  budgetRemaining: number;  // 剩余可用于历史的预算
}

/**
 * 基于模型上下文计算可传入的历史轮数
 * 策略：保留最近 N 轮对话，更早的由摘要替代
 * 小上下文模型（<8192）：N=3 轮
 * 大上下文模型（≥8192）：N=5 轮
 */
function computeHistoryBudget(params: {
  totalBudget: number;
  knowledgeContextLength: number;
  imageCount: number;
  history: Array<{ role: string; content: string }>;
}): HistoryBudget {
  const { totalBudget, knowledgeContextLength, imageCount } = params;

  let budgetUsed = 0;

  // 知识库结果占用预算
  if (knowledgeContextLength > 0) {
    budgetUsed += estimateTokens(knowledgeContextLength.toString());
  }

  // 图片占用预算（每张约 1000 tokens）
  budgetUsed += imageCount * 1000;

  const budgetRemaining = Math.max(0, totalBudget - budgetUsed);

  // 基于模型上下文决定保留轮数
  const modelId = getCurrentModelId();
  const caps = getModelCapabilities(modelId);
  const maxRounds = caps.contextLength < 8192 ? 3 : 5;

  return { maxRounds, budgetUsed, budgetRemaining };
}

/**
 * 按轮次切片历史消息
 * 1轮 = 1个 user 消息 + 紧随其后的 assistant 消息
 * 保留最近 maxRounds 轮，更早的由摘要替代
 */
function sliceHistoryByRounds(
  history: Array<{ role: string; content: string; images?: string[] }>,
  maxRounds: number,
): Array<{ role: string; content: string; images?: string[] }> {
  if (!history || history.length === 0 || maxRounds <= 0) return [];

  // 从后往前数轮次
  let roundsFound = 0;
  let sliceStart = history.length;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      roundsFound++;
      if (roundsFound > maxRounds) break;
      sliceStart = i;
    }
  }

  return history.slice(sliceStart);
}

// ==================== Token 用量记录 ====================

export interface UsageData {
  userId: string;
  sessionId?: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  historyCount: number;
  usedKnowledgeBase: boolean;
  imageCount: number;
  responseTimeMs: number;
  userMessage: string;
  assistantMessage?: string;
}

/**
 * 把 LangChain Message 数组的 input 估算为 token 数。
 * 用于流式结束后回调 onUsageComplete 上报"输入 token 数"。
 * - 字符串内容直接走 estimateTokens
 * - 多模态数组内容（多模态消息）：text 部分按字符估，每张图片固定计 1000 tokens
 *   （这是 OpenAI / Anthropic 公开的 tile-based 图片计费下限的近似值）
 */
function estimateTokensFromMessages(messages: Array<any>): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'string') {
          total += estimateTokens(part);
        } else if (part.text) {
          total += estimateTokens(part.text);
        } else if (part.type === 'image_url') {
          total += 1000; // 图片约 1000 tokens
        }
      }
    }
  }
  return total;
}

// 系统提示词 - 定义模型的角色和任务
// ### 注意事项
// 1. **代码必须可直接运行**：复制粘贴到浏览器即可运行
// 2. **包含完整样式**：不要让用户补充任何 CSS
// 3. **颜色值精确**：使用从设计图中分析出的准确 hex 值
// 4. **布局还原度高**：尽可能还原设计稿的视觉效果`;
const SYSTEM_PROMPT = `你是一个全能助手`;

/**
 * 根据当前注册的工具动态构建 FC 模式 System Prompt。
 *
 * 【为什么动态构建】
 *   不同部署环境注册的工具集不同（如本地小模型可能只开 search/calculate，
 *   云端大模型才开 generate_image / send_notification）。如果硬编码完整规则，
 *   小模型会被无关工具描述污染上下文，浪费有限的 context 长度。
 *
 * 【构建步骤】
 *   1) 读取 getAvailableToolNames()——从工具注册中心拿到当前已启用的工具名。
 *   2) 在 toolDescriptions 字典里找到每个工具的中文描述，拼成 toolList 列表。
 *   3) 拼通用规则（始终包含的 6 条："不调用工具的场景 / 重复调用 / 引用结果" 等）。
 *   4) 按工具按需追加专属规则（只有该工具被注册时才追加）。
 *   5) 最后追加兜底声明："不存在的工具不要编造、上下文截断时不要假设"等。
 *
 * 【返回】拼好的多行字符串，作为 SystemMessage 的 content。
 * 【调用方】promptWithFunctionCalling 在每次请求开头都会调用一次（因工具集可能热更新）。
 */
function buildFCSystemPrompt(): string {
  const availableTools = getAvailableToolNames();

  // 工具描述映射
  const toolDescriptions: Record<string, string> = {
    search_knowledge_base: '搜索知识库中与查询相关的文档内容',
    search_web: '联网搜索实时信息',
    get_weather: '查询指定城市的天气信息（实时天气、7天预报、24小时逐小时预报）',
    calculate: '执行精确的数学计算（支持大数运算、科学计算、三角函数、对数等）',
    manage_session: '管理用户的会话（对话），包括创建、删除、重命名、置顶/取消置顶、切换、查询列表等',
    create_plan: '为复杂多步骤任务创建执行计划',
    update_plan_step: '更新计划中某个步骤的状态（完成/失败/跳过）',
    get_plan: '查看当前执行计划的进度',
    crawl_webpage: '深度抓取指定网页的完整内容（当搜索摘要不够详细时使用）',
    create_document: '在知识库中创建新文档',
    update_document: '更新知识库中已有文档的内容',
    summarize_document: '对指定文档生成摘要',
    compare_documents: '对比两个文档的差异',
    generate_chart: '根据数据生成图表（折线图、柱状图、饼图等），返回 imageUrl 可嵌入邮件',
    generate_image: '根据文字描述生成图片（文生图）',
    create_mindmap: '生成思维导图，返回 imageUrl 可嵌入邮件',
    generate_document: '把 Markdown 内容生成为 PDF / Word(docx) / HTML / Markdown(md) 文件，返回 fileUrl 可作为邮件附件发送',
    // ---------------- 外部 API 集成工具（方案 A） ----------------
    send_notification: '发送通知到飞书消息、邮件、Webhook（钉钉/企业微信群机器人），用于把任务结果主动推送给用户或团队',
    query_database: '查询外部业务数据库（仅支持 SELECT 语句），自动经过 SQL 安全网关校验，可用于统计订单/用户/销售等业务数据',
    mcp_proxy: '通过 MCP（Model Context Protocol）调用外部生态工具（如 GitHub、文件系统、Slack、Notion 等），用于扩展能力',
  };

  // 工具列表
  const toolList = availableTools
    .filter(name => toolDescriptions[name])
    .map(name => `- ${name}：${toolDescriptions[name]}`)
    .join('\n');

  // 通用规则（始终包含）
  let prompt = `你是一个全能助手，你可以使用工具来帮助回答用户问题。

当前可用工具：
${toolList}

工具使用规则：
1. 当你能够直接回答问题（如通用知识、闲聊、简单的加减乘除等）时，不需要调用任何工具
2. 调用工具时，构造精确的查询语句，以提高搜索结果的相关性
3. 基于工具返回的结果回答用户问题，在回答中标注信息来源
4. 如果工具返回的结果与用户问题无关：
   - 对于通用知识问题（如"什么是光合作用"），可以说明后基于自身知识回答
   - 对于涉及用户文档/知识库的问题（如用户提到"文档""规范""规定"等），必须明确告知"知识库中未找到相关内容"，严禁基于自身知识编造文档中不存在的内容
5. 每个工具在一次对话中最多调用一次，不要对同一个工具重复调用相同的参数
6. 收到工具返回结果后，必须直接基于结果生成最终回答，不要再调用其他工具`;

  // 按工具追加专属规则
  if (availableTools.includes('search_knowledge_base')) {
    prompt += `\n\n知识库搜索规则：
- 当用户的问题可能涉及已上传的文档、知识库中的信息时，优先调用 search_knowledge_base
- 如果 search_knowledge_base 返回空结果或结果与问题无关，必须如实告知用户"知识库中未找到相关内容"
- 严禁在知识库没有相关内容时，凭自身知识编造文档中的具体条款、规范、数据等内容
- 可以建议用户：检查文档是否已发布到知识库，或换一种关键词重新提问`;
  }

  if (availableTools.includes('search_web')) {
    prompt += `\n\n联网搜索规则：
- 当用户的问题涉及最新新闻、实时数据、当前事件时，调用 search_web
- 如果不确定知识库中是否有相关信息，可以同时调用 search_knowledge_base 和 search_web
- 默认使用 search_std，需要深度搜索时使用 search_pro
- 用户问"今天"的新闻：设置 recency_filter 为 oneDay；"最近"：oneWeek；"本月"：oneMonth`;
  }

  if (availableTools.includes('get_weather')) {
    prompt += `\n\n天气查询规则：
- 当用户询问天气、温度、湿度等问题时，必须使用 get_weather，不要用 search_web
- 当前/现在天气：type=now（默认）；未来几天：type=daily；逐小时：type=hourly
- city 参数支持中文城市名（如"北京"）或城市ID`;
  }

  if (availableTools.includes('calculate')) {
    prompt += `\n\n计算规则：
- 当用户需要进行复杂的数学运算时，调用 calculate 确保结果精确`;
  }

  if (availableTools.includes('manage_session')) {
    prompt += `\n\n会话管理规则：
- 新建对话：action=create，可选提供 title
- 删除对话：action=delete，需要 session_id
- 重命名：action=rename，需要 session_id 和 title
- 置顶/取消置顶：action=pin/unpin，需要 session_id
- 切换对话：action=switch，需要 session_id
- 查看会话：action=list；搜索：action=search，提供 keyword
- 添加标签：action=add_tag，需要 session_id 和 tag
- 移除标签：action=remove_tag，需要 session_id 和 tag
- 设置分类：action=set_category，需要 session_id 和 category
- 查看所有标签：action=list_tags`;
  }

  if (availableTools.includes('create_plan')) {
    prompt += `\n\n规划规则：
- 对于需要3个以上步骤的复杂任务，先调用 create_plan 创建执行计划
- 每完成一个步骤，调用 update_plan_step 更新状态，并在 output 字段中传递结构化数据供后续步骤引用
- 用户询问进度时，调用 get_plan 查看
- 简单问题不需要创建计划，直接回答即可

数据绑定（步骤间数据传递）：
- 当后续步骤需要使用前序步骤的输出时，在 create_plan 的 step 中声明 inputMapping
- inputMapping 格式：{ "参数名": "$stepN.output" } 或 { "参数名": "$stepN.output.字段路径" }
- 例：第2步需要使用第1步搜索结果的 results 字段：inputMapping={ "data": "$step1.output.results" }
- 系统会在执行第2步前自动解析 $stepN.output 表达式，把实际值填入参数
- 你不需要在第2步的工具调用参数里手动复制第1步的结果，只需在 create_plan 时声明 inputMapping`;
  }

  if (availableTools.includes('crawl_webpage')) {
    prompt += `\n\n网页抓取规则：
- 当 search_web 返回的摘要信息不够详细，需要获取网页全文时，调用 crawl_webpage
- 需要提供完整的网页 URL
- 如果网页是动态渲染的（如 SPA），可设置 enable_js_rendering=true（较慢，仅在必要时使用）`;
  }

  if (availableTools.includes('create_document')) {
    prompt += `\n\n文档操作规则：
- 创建文档：create_document，需要提供 title 和 content
- 更新文档：update_document，需要提供 documentId 和新 content
- 生成摘要：summarize_document，需要提供 documentId
- 对比文档：compare_documents，需要提供两个文档的 documentId1 和 documentId2
- 文档内容支持 Markdown 格式`;
  }

  if (availableTools.includes('generate_chart')) {
    prompt += `\n\n图表生成规则：
- 当用户要求生成图表、数据可视化时，必须调用 generate_chart 工具，不要仅用文字描述
- 支持图表类型：line（折线图）、bar（柱状图）、pie（饼图）、scatter（散点图）、radar（雷达图）、heatmap（热力图）、funnel（漏斗图）
- 可以直接提供 echartsOption（完整 ECharts 配置），也可以提供 chartType + data 让工具自动构建
- data 格式：line/bar 为 { labels: string[], series: Array<{name, values}> }；pie 为 { items: Array<{name, value}> }
- 工具返回 imageUrl 字段（图表的静态 PNG 图片 URL），如果用户要求发图表邮件，把 imageUrl 传给 send_notification 的 attachments 字段即可`;
  }

  if (availableTools.includes('generate_image')) {
    prompt += `\n\n文生图规则：
- 当用户要求生成图片、画图、绘图时，必须调用 generate_image 工具，不要仅用文字描述
- 模型选择：wan2.7-image-pro（高质量，细节丰富，适合精细图片）和 wan2.7-image（快速生成，适合简单图片）
- 用户未指定模型时默认使用 wan2.7-image-pro；用户要求快速生成时使用 wan2.7-image
- 回答时请根据工具返回结果中标注的实际模型名称来描述，不要自行推测使用的模型
- prompt 描述越详细，生成效果越好，建议包含主体、风格、颜色、构图等要素
- 支持尺寸：512*512、768*768、1024*1024、1024*1536、1536*1024
- 图片只需展示一次，使用 ![描述](URL) 格式，不要重复输出同一张图片`;
  }

  if (availableTools.includes('create_mindmap')) {
    prompt += `\n\n思维导图规则：
- 当用户要求生成思维导图时，必须调用 create_mindmap 工具，不要仅用文字描述
- 需要提供 title（中心主题）和 content（Mermaid mindmap 语法的内容）
- content 格式示例：root((中心主题))\\n  分支1\\n    子分支1-1\\n  分支2\\n    子分支2-1
- 适用于整理知识结构、梳理逻辑关系、总结归纳等场景
- 工具返回 imageUrl 字段（Mermaid Ink 渲染的静态 PNG 图片），如果用户要求发思维导图邮件，把 imageUrl 传给 send_notification 的 attachments 字段即可`;
  }

  if (availableTools.includes('generate_document')) {
    prompt += `\n\n文档生成规则（PDF / Word / HTML / Markdown）：
- 当用户要求"生成 PDF/Word/docx/HTML/Markdown/md 文档"、"导出为文件"、"做一份报告/手册"等场景时，调用 generate_document
- 必须提供 title（文档标题）、content（Markdown 格式正文）、format（'pdf' / 'docx' / 'html' / 'md' 四选一）
- content 必须是 Markdown：用 # 表示标题、- 表示列表、**xx** 加粗、\`\`\` 代码块、> 引用
- 用户未指定格式时，默认选 pdf（最通用、可直接打印）；要求"可编辑"时选 docx；只在网页查看选 html；用户明确要"Markdown / md / 源文件"时选 md
- 工具返回 fileUrl 字段（内部协议 fc://document/xxx），如果用户要求邮件发送，把 fileUrl 直接填入 send_notification.attachments[].url 即可。示例：先 generate_document({title:"周报",content:"...",format:"pdf"}) 得到 { fileUrl }，再 send_notification({channel:"email", title:"本周周报", content:"详见附件", recipients:["x@x.com"], attachments:[{filename:"周报.pdf", url: fileUrl}]})
- 不要把整段 Markdown 内容塞进 send_notification.content 当邮件正文——文档必须作为附件发送`;
  }

  if (availableTools.includes('execute_workflow')) {
    prompt += `\n\n工作流（流水线）规则：
- 当用户的需求涉及多个工具组合（如"搜索并画图"、"搜索并整理为文档"）且匹配某个预置流水线时，优先调用 execute_workflow，比手动调用多个工具更稳定
- templateId 必须从工具描述中列出的可用流水线 ID 中选择
- userInput 传入用户的原始问题或主题
- 如果没有匹配的预置流水线，请改用 create_plan 创建自定义计划，并通过 inputMapping 实现步骤间数据传递`;
  }

  // ---------------- 外部 API 集成工具（方案 A） ----------------
  if (availableTools.includes('send_notification')) {
    prompt += `\n\n通知发送规则：
- 当用户要求"通知/提醒/告诉/发邮件/发消息/推送/告知"等场景时，调用 send_notification
- 如果用户的请求中缺少必要参数（收件人、主题等），请一次性列出所有缺失信息让用户补充，不要逐条追问
- channel 必须从 'feishu'（飞书）、'email'（邮件）、'webhook'（钉钉/企业微信群机器人）三选一
- title 是通知标题（邮件主题/卡片标题），content 是通知正文（支持 Markdown）
- recipients 是接收人列表：feishu 通道传 open_id 或邮箱地址；email 通道传邮箱地址；webhook 通道无需此字段
- webhookUrl 仅 channel=webhook 时必填，必须是 https 开头的外网地址
- 也可作为工作流末尾步骤，把搜索/分析结果主动推送出去
- 如果用户要求发图表/思维导图邮件：先调用 generate_chart 或 create_mindmap，拿到返回的 imageUrl 字段，再将 imageUrl 填入 send_notification.attachments。示例：先 generate_chart(...) 得到 { imageUrl: "<chart-url>" }，再 send_notification({ channel:"email", content:"分析结果", attachments:[{filename:"chart.png", url: imageUrl}] })。绝对不要把 ECharts 配置代码或 Mermaid 文本当正文发出去——图表必须作为附件图片嵌入邮件
- 如果用户要求发图片邮件：先调用 generate_image 生成图片，拿到返回的 images[].url 后，再调用 send_notification，把图片 URL 填入 attachments 字段。示例：send_notification({channel:"email", title:"星空图片", content:"这是自动生成的星空图片", recipients:["用户邮箱"], attachments:[{filename:"star-sky.png", url:"<generate_image返回的url>", cid:"img1"}]})
- attachments 支持所有常见文件格式：图片(png/jpg/gif/webp)自动内嵌正文，PDF/Word/Excel/Markdown/txt/zip 等作为附件附在邮件中。系统自动根据文件扩展名识别 MIME 类型`;
  }

  if (availableTools.includes('query_database')) {
    prompt += `\n\n数据库查询规则：
- 当用户询问业务数据（订单、销售额、用户数、统计、报表等需要查表的问题）时，调用 query_database
- sql 参数必须是 SELECT 语句（INSERT/UPDATE/DELETE 等会被安全网关拒绝）
- 自动经过 AST 校验：表名白名单 + 强制 LIMIT，无需手动添加 LIMIT
- purpose 参数描述本次查询的业务目的，会展示在用户确认弹窗中
- 查询结果可后续传给 generate_chart 进行可视化（建议主动询问用户是否需要画图）`;
  }

  if (availableTools.includes('mcp_proxy')) {
    prompt += `\n\nMCP 工具调用规则：
- 当需要使用 MCP（Model Context Protocol）生态工具（如 GitHub、文件系统、Slack、Notion 等）时，调用 mcp_proxy
- 必须从工具描述中列出的"已接入工具"里选择具体的 server 和 tool
- arguments 是传给具体 MCP 工具的参数对象，结构由该工具的 inputSchema 决定
- 此调用属于高风险操作，会弹出用户确认弹窗，请在调用前清楚地向用户说明你将要做什么`;
  }

  // 兜底声明：工具不可用时的处理 + 上下文策略
  prompt += `\n\n重要规则：
- 如果你需要的工具不在上述可用列表中，请直接告知用户该功能当前不可用，并建议切换到云端模型获取完整功能
- 不要编造工具调用，不要猜测工具的参数格式
- 如果之前的对话内容被截断或存在摘要，请基于当前可见的信息回答，不要假设或编造已丢失的内容
- 如果工具返回的结果标注为"部分结果"，请基于已有信息直接回答，不要重复调用该工具`;

  return prompt;
}
/**
 * 从 URL 下载图片并转换为 base64 格式
 * @param imageUrl 图片的 URL 地址
 * @returns base64 格式的数据 URL（如：data:image/png;base64,xxxxx）
 */
async function downloadImageAsBase64(imageUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // 判断使用 http 还是 https 模块
    const protocol = imageUrl.startsWith('https') ? https : http;

    const request = protocol.get(imageUrl, (response) => {
      // 检查响应状态码
      if (response.statusCode !== 200) {
        reject(new Error(`无法下载图片，状态码: ${response.statusCode}`));
        return;
      }

      // 获取内容类型
      const contentType = response.headers['content-type'] || 'image/jpeg';

      // 收集图片数据
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        // 合并所有数据块
        const buffer = Buffer.concat(chunks);
        // 转换为 base64 字符串
        const base64 = buffer.toString('base64');
        // 构建数据 URL：data:image/jpeg;base64,xxxxx
        const dataUrl = `data:${contentType};base64,${base64}`;
        resolve(dataUrl);
      });

      response.on('error', (error) => {
        reject(new Error(`下载图片失败: ${error.message}`));
      });
    });

    request.on('error', (error) => {
      reject(new Error(`请求图片失败: ${error.message}`));
    });

    // 设置超时
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('下载图片超时'));
    });
  });
}

/**
 * 处理图片 URL，转换为适合多模态模型的数据格式
 * 本地图片会下载并转为 base64，远程图片保持原 URL
 * @param imageUrl 图片的 URL 地址
 * @returns 处理后的图片 URL（base64 或原始 URL）
 */
async function processImageUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith(`${config.serverBaseUrl}/files/`) ||
    imageUrl.startsWith(config.serverBaseUrl.replace('http://', 'https://') + '/files/')) {
    logger.info('检测到本地图片，开始下载', { module: 'PromptService', imageUrl });
    try {
      const base64DataUrl = await downloadImageAsBase64(imageUrl);
      logger.info('本地图片转换成功', { module: 'PromptService' });
      return base64DataUrl;
    } catch (error) {
      logger.error('本地图片下载失败，使用原始 URL', { module: 'PromptService', error: String(error) });
      return imageUrl;
    }
  }
  return imageUrl;
}

/**
 * 将 Markdown 格式的消息转换为 LangChain 多模态消息格式
 * 支持的图片格式：
 * - Markdown 图片：![alt](url)
 * - 普通链接：[text](url)
 *
 * @param text 用户输入的文本（可能包含 Markdown 图片语法）
 * @returns LangChain 消息内容格式（数组，包含文本和图片）
 */
async function convertToMultimodalContent(text: string): Promise<Array<{ type: string; text?: string; image_url?: string }>> {
  logger.debug('开始转换多模态内容', { module: 'PromptService', textLength: text.length });

  // 正则表达式匹配 Markdown 图片语法：![alt](url)
  const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

  // 如果没有匹配到图片，返回纯文本格式
  if (!markdownImageRegex.test(text)) {
    logger.debug('未检测到 Markdown 图片语法，返回纯文本', { module: 'PromptService' });
    return [{ type: "text", text }];
  }

  // 重置正则表达式的 lastIndex
  markdownImageRegex.lastIndex = 0;

  logger.info('检测到 Markdown 图片语法', { module: 'PromptService' });

  // 用于存储转换后的内容块
  const contentBlocks: Array<{ type: string; text?: string; image_url?: string }> = [];

  // 用于追踪已处理的文本位置
  let lastIndex = 0;
  let match;

  // 遍历所有匹配的图片
  while ((match = markdownImageRegex.exec(text)) !== null) {
    // 获取匹配前的文本
    const beforeText = text.substring(lastIndex, match.index);

    // 如果有文本内容，添加为文本块
    if (beforeText.trim()) {
      contentBlocks.push({ type: "text", text: beforeText });
    }

    // 获取图片 URL
    const imageUrl = match[2];
    logger.debug('检测到图片 URL', { module: 'PromptService', imageUrl });

    // 检查是否是本地服务器的图片
    if (imageUrl.startsWith(`${config.serverBaseUrl}/files/`) ||
      imageUrl.startsWith(config.serverBaseUrl.replace('http://', 'https://') + '/files/')) {
      try {
        // 下载图片并转换为 base64 格式
        logger.info('开始下载图片并转换为 base64', { module: 'PromptService' });
        const base64DataUrl = await downloadImageAsBase64(imageUrl);
        logger.info('图片下载并转换成功', { module: 'PromptService', base64Length: base64DataUrl.length });
        contentBlocks.push({
          type: "image_url",
          image_url: base64DataUrl  // 使用 base64 数据 URL
        });
      } catch (error) {
        // 如果下载失败，记录错误但仍然添加原始 URL
        logger.error('下载图片失败', { module: 'PromptService', error: String(error) });
        contentBlocks.push({
          type: "image_url",
          image_url: imageUrl  // 降级使用原始 URL
        });
      }
    } else {
      // 对于外部 URL，直接使用原始 URL
      logger.debug('使用外部图片 URL', { module: 'PromptService' });
      contentBlocks.push({
        type: "image_url",
        image_url: imageUrl
      });
    }

    // 更新位置
    lastIndex = match.index + match[0].length;
  }

  // 处理最后剩余的文本
  const remainingText = text.substring(lastIndex);
  if (remainingText.trim()) {
    contentBlocks.push({ type: "text", text: remainingText });
  }

  logger.debug('多模态内容转换完成', { module: 'PromptService', blockCount: contentBlocks.length });

  return contentBlocks;
}

/**
 * 处理用户消息，生成适合多模态模型的输入格式
 * @param promptText 用户输入的文本
 * @returns HumanMessage 对象，支持文本和图片混合内容
 */
async function createUserMessage(promptText: string): Promise<HumanMessage> {
  const content = await convertToMultimodalContent(promptText);

  return new HumanMessage({
    content: content
  });
}

/**
 * ============================================================================
 * Function Calling 模式的主调度函数（本文件最核心的方法，约 900 行）。
 *
 * 【作用】
 *   当模型支持 Function Calling（如 OpenAI / DeepSeek / Qwen 等）时使用此路径。
 *   它把"用户输入 → LLM 调工具 → 工具执行 → 结果回填 LLM → 流式输出"整个链路串起来，
 *   并在中间穿插：意图检测、工具熔断、嘴炮防御、思考标签过滤、SSE 推流、token 计费等。
 *
 * 【参数说明】
 *   - promptText        当前用户输入的文本（可能为空，例如纯图片消息）。
 *   - images            随当前消息上传的图片 URL 列表（多模态模型才使用）。
 *   - history           历史对话数组，每项 { role, content, images }。
 *                       role 取值：'user' / 'assistant'。
 *   - res               Express 原生 Response 对象。SSE 流式响应必须用它，
 *                       不传则返回完整 AIMessage（非流式调用方使用）。
 *   - sessionSummary    早期对话的压缩摘要（控制上下文 token 占用）。
 *   - userMemories      跨会话累积的用户画像（口味、习惯、背景等长期记忆）。
 *   - isCancelled       由调用方传入的取消信号判断函数，每个轮次都会检查。
 *   - abortController   AbortController.signal 透传给底层 fetch / LLM SDK。
 *   - userId / sessionId 用户与会话标识（计费、缓存键、计划匹配都用得到）。
 *   - onUsageComplete   流式输出完成回调，传出 token 用量供 Service 写入 DB。
 *   - imageModel        用户在前端选择的图片生成模型（透传给 generate_image 工具）。
 *
 * 【返回值】
 *   - 当传入 res（流式模式）：直接通过 SSE 写回客户端，函数返回 undefined。
 *   - 当不传 res（非流式模式）：返回 AIMessage（一次性结果）。
 *   - 抛出 FCFallbackError：表示 FC 路径走不通，外层 promptTemplate 会捕获并降级到 RAG 模式。
 *
 * 【核心流程总览】
 *   1) 构建 FC System Prompt（动态根据已注册工具 + Agent 路由 + 摘要 + 记忆 + 上一轮资产）。
 *   2) 拼装历史消息 + 当前用户消息（含多模态图片）。
 *   3) bindTools 绑定工具 schema 到 LLM 客户端，根据意图设置 tool_choice（防嘴炮·防线 1）。
 *   4) 进入工具调用循环（最多 MAX_TOOL_ITERATIONS 次）：
 *        a. 调 LLM 拿到响应，判断是否含 tool_calls。
 *        b. 含工具调用 → 去重 / 熔断 / 数据绑定 / 并行执行 / 收集多媒体资产 → 回填 ToolMessage。
 *        c. 不含工具调用 → 三道嘴炮防线（显式/隐式正则 + LLM-as-Judge）→ 通过则进入流式输出。
 *   5) 流式输出阶段：先注入图片/思维导图/图表/文件卡，再 stream LLM 文字（带 think 过滤 + 图片去重）。
 *   6) 异常路径：达到最大轮数 → 清空工具上下文，强制让模型用自然语言总结。
 * ============================================================================
 */
async function promptWithFunctionCalling(
  promptText?: string,
  images?: string[],
  history?: Array<{ role: string; content: string; images?: string[] }>,
  res?: Response,
  sessionSummary?: string,
  userMemories?: string[],
  isCancelled?: () => boolean,
  abortController?: AbortController,
  userId?: string,
  sessionId?: string,
  onUsageComplete?: (usage: UsageData) => void,
  imageModel?: string,
) {
  // 读取当前激活模型的元信息（厂商、是否支持多模态/FC、上下文长度等）
  const modelInfo = getModelInfo();
  // supportsVision：是否支持图片输入。若 false 则丢弃所有上传图片，避免 LLM 报错
  const supportsVision = modelInfo.supportsVision;

  // 1) 动态构建 FC 模式的系统提示词（按当前已注册工具列表）
  let fcSystemPrompt = buildFCSystemPrompt();
  // 2) 检查用户输入是否疑似 prompt injection（如"忽略以上指令"等攻击模式）
  //    suspicious 等级时，追加一段安全防护说明到系统提示词
  const injectionDetection = inspectPromptInjection(promptText);
  if (injectionDetection.level === 'suspicious') {
    fcSystemPrompt += buildPromptInjectionSafetyInstruction(injectionDetection);
  }

  // ==================== Agent Router：意图路由 ====================
  // 根据用户输入选择最合适的 Agent，决定 system prompt 增量和工具白名单
  // 路由失败时回落到 general Agent，不阻断主流程
  const routing = routeRequest(promptText);
  if (routing.agent.extraPrompt) {
    fcSystemPrompt += routing.agent.extraPrompt;
  }
  if (routing.suggestedWorkflow) {
    fcSystemPrompt += `\n\n用户输入匹配预置流水线 "${routing.suggestedWorkflow.templateId}"（${routing.suggestedWorkflow.reason}）。如果该流水线符合用户需求，请优先调用 execute_workflow 工具触发。`;
  }
  logger.info('FC模式：Agent 路由决策', {
    module: 'PromptService',
    agentRole: routing.agent.role,
    agentName: routing.agent.name,
    matchedBy: routing.matchedBy,
    score: routing.score,
    suggestedWorkflow: routing.suggestedWorkflow?.templateId,
  });

  const currentDate = new Date();
  const dateStr = `${currentDate.getFullYear()}年${currentDate.getMonth() + 1}月${currentDate.getDate()}日`;
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][currentDate.getDay()];
  fcSystemPrompt += `\n\n当前日期：${dateStr} 星期${weekDay}`;

  if (sessionSummary && sessionSummary.trim()) {
    fcSystemPrompt += `\n\n=== 之前对话的摘要 ===\n${sessionSummary}\n=== 摘要结束 ===\n\n请注意：以上摘要是之前对话的压缩版本，请结合摘要和最近的对话来理解用户的意图。`;
    logger.info('FC模式：已注入对话摘要', { module: 'PromptService', summaryLength: sessionSummary.length });
  }

  if (userMemories && userMemories.length > 0) {
    const memoryText = userMemories.map((m, i) => `${i + 1}. ${m}`).join('\n');
    fcSystemPrompt += `\n\n=== 关于用户的记忆 ===\n以下是从历史对话中了解到的关于用户的信息，请在回答时参考：\n${memoryText}\n=== 用户记忆结束 ===`;
    logger.info('FC模式：已注入用户记忆', { module: 'PromptService', memoryCount: userMemories.length });
  }

  // 注入上一轮 FC 循环中已生成的多媒体资源 URL（图片/图表/思维导图）
  // 这样模型在后续轮次中可以直接引用，无需重新生成
  // 多级缓存（L1 内存 + L2 Redis）异步读取，单次开销 ~1-3ms（L1 命中 < 0.1ms）
  const sessionAssets = await getSessionAssets(sessionId);
  if (sessionAssets) {
    fcSystemPrompt += sessionAssets;
    logger.info('FC模式：已注入上一轮的多媒体资源 URL', { module: 'PromptService', sessionId });
  }

  const messages: Array<SystemMessage | HumanMessage | AIMessage | ToolMessage> = [
    new SystemMessage(fcSystemPrompt),
  ];

  let effectiveImages = images;
  if (effectiveImages && effectiveImages.length > 0 && !supportsVision) {
    logger.warn('当前模型不支持图片输入，已忽略图片', { module: 'PromptService', modelId: getCurrentModelId(), imageCount: effectiveImages.length });
    effectiveImages = undefined;
  }

  const { maxRounds: MAX_ROUNDS } = computeHistoryBudget({
    totalBudget: computeTotalBudgetForModel(true),
    knowledgeContextLength: 0,  // FC 模式知识库通过工具调用，不走 RAG 注入
    imageCount: effectiveImages?.length || 0,
    history: history || [],
  });

  // 按轮次切片历史：1轮 = 连续的 user + assistant 消息对
  // 保留最近 MAX_ROUNDS 轮，更早的由 sessionSummary 替代
  const recentHistory = sliceHistoryByRounds(history || [], MAX_ROUNDS);

  if (recentHistory.length > 0) {
    logger.info('FC模式：添加历史消息', { module: 'PromptService', historyCount: recentHistory.length, maxRounds: MAX_ROUNDS });
    for (const msg of recentHistory) {
      if (msg.role === 'user') {
        let content: any;
        if (msg.images && msg.images.length > 0 && supportsVision) {
          content = [];
          for (const imgUrl of msg.images) {
            const processedUrl = await processImageUrl(imgUrl);
            content.push({ type: 'image_url', image_url: { url: processedUrl } });
          }
          if (msg.content) {
            content.unshift({ type: 'text', text: msg.content });
          }
        } else {
          content = await convertToMultimodalContent(msg.content);
        }
        messages.push(new HumanMessage({ content }));
      } else if (msg.role === 'assistant') {
        messages.push(new AIMessage(msg.content));
      }
    }
  }

  let userContent: any;
  if (effectiveImages && effectiveImages.length > 0) {
    userContent = [];
    if (promptText) {
      userContent.push({ type: 'text', text: promptText });
    }
    for (const imgUrl of effectiveImages) {
      const processedUrl = await processImageUrl(imgUrl);
      userContent.push({ type: 'image_url', image_url: { url: processedUrl } });
    }
  } else {
    userContent = await convertToMultimodalContent(promptText || '');
  }
  messages.push(new HumanMessage({ content: userContent }));

  const llm = createRateLimitedLLM(buildModelConfig(getCurrentModelId(), { isFCMode: true }), 'streaming');
  const currentModelId = getCurrentModelId();
  const caps = getModelCapabilities(currentModelId);
  const toolSchemas = await getToolSchemasForModel(currentModelId, { contextLength: caps.contextLength, supportsFC: caps.supportsFC, query: promptText });
  // 应用 Agent 工具白名单：在 general Agent 下不过滤，专业 Agent 下只暴露其专长工具
  const filteredToolSchemas = applyAgentToolWhitelist(toolSchemas, routing.agent);
  if (!llm.bindTools) {
    throw new FCFallbackError('当前模型不支持 bindTools', '');
  }
  // ==================== 防嘴炮·防线 1：tool_choice 自适应 ====================
  // 当用户消息明确表达了"创造性多媒体生成"意图（如生成图片/图表/思维导图），
  // 强制 LLM 必须返回 tool_calls，禁止它只输出"我来生成..."的嘴炮文字。
  // 这是 OpenAI / Anthropic 官方推荐的最稳做法。
  // 注意：only 仅锁定我们能确定的工具，避免误锁查询型场景（搜索/天气/计算）。
  // 注意：DeepSeek Thinking mode 等模型不支持 tool_choice 参数（会报 400），
  //       必须用 caps.supportsToolChoice 守卫，否则整个 FC 调用会失败降级到 RAG。
  const intentDetection = detectToolIntent(promptText || '');
  let toolChoiceParam: any = 'auto';
  if (intentDetection.shouldForce && caps.supportsFC && caps.supportsToolChoice && filteredToolSchemas.length > 0) {
    // 检查锁定的具体工具是否在白名单内（防止 Agent 路由删掉了该工具）
    const targetToolAvailable = intentDetection.specificTool
      ? filteredToolSchemas.some(s => s?.function?.name === intentDetection.specificTool)
      : false;
    if (intentDetection.specificTool && targetToolAvailable) {
      // 用户意图非常明确（如"生成一张图片"），且工具确实可用，锁定到具体工具
      toolChoiceParam = { type: 'function', function: { name: intentDetection.specificTool } };
      logger.info('FC模式：检测到强烈工具意图，锁定 tool_choice 到具体工具', {
        module: 'PromptService',
        tool: intentDetection.specificTool,
        reason: intentDetection.reason,
      });
    } else {
      // 用户表达了工具意图但具体工具不可用 / 意图不够精确，强制必须调用某个工具
      // 注意：'required' 在工具列表为空时会报错，所以前面已经判断 length>0
      toolChoiceParam = 'required';
      logger.info('FC模式：检测到工具意图，设置 tool_choice = required', {
        module: 'PromptService',
        reason: intentDetection.reason,
        specificToolUnavailable: !!intentDetection.specificTool && !targetToolAvailable,
      });
    }
  } else if (intentDetection.shouldForce && !caps.supportsToolChoice) {
    // 模型不支持 tool_choice，但仍记录意图，由防线 2/3 兜底
    logger.info('FC模式：检测到工具意图但当前模型不支持 tool_choice，跳过强制（依赖防线 2/3 兜底）', {
      module: 'PromptService',
      reason: intentDetection.reason,
      modelId: getCurrentModelId(),
    });
  }

  // ==================== 知识库强制调用：防止 LLM 跳过知识库直接编造 ====================
  // 问题：LLM 经常把涉及用户文档的问题（如"武器室规范是什么"）判定为"通用知识"，
  //       不调 search_knowledge_base 就直接用训练数据回答 → 幻觉。
  // 方案：当 search_knowledge_base 可用且用户消息是实质问题时，强制首轮调用它。
  //       LLM 必须先查知识库，拿到结果后再回答——有结果就基于结果，没结果就说"未找到"。
  if (toolChoiceParam === 'auto' && caps.supportsFC && caps.supportsToolChoice && filteredToolSchemas.length > 0) {
    const hasKBTool = filteredToolSchemas.some(s => s?.function?.name === 'search_knowledge_base');
    if (hasKBTool && isSubstantiveQuery(promptText || '')) {
      toolChoiceParam = { type: 'function', function: { name: 'search_knowledge_base' } };
      logger.info('FC模式：强制首轮调用 search_knowledge_base（防止跳过知识库编造）', {
        module: 'PromptService',
        reason: '用户消息是实质性问题，且知识库工具可用',
      });
    }
  }

  // ==================== 纯寒暄：确定性禁用工具调用 ====================
  // 问题：auto 模式下，模型首轮偶发"手痒"调用无参工具（如 list_knowledge_base），
  //       对"你好啊"这类纯客套回出工具语气的怪异回复，下一轮才恢复正常。
  // 根治：纯问候/感谢/确认/告别按定义不需要任何工具，直接 tool_choice='none'，
  //       不依赖模型遵守"闲聊不调工具"的提示词。
  if (toolChoiceParam === 'auto' && caps.supportsFC && caps.supportsToolChoice && isPureGreeting(promptText || '')) {
    toolChoiceParam = 'none';
    logger.info('FC模式：检测到纯寒暄，禁用首轮工具调用（tool_choice=none）', {
      module: 'PromptService',
      preview: (promptText || '').slice(0, 30),
    });
  }

  // FC 能力弱的模型对 tool_choice 参数支持不佳，不传该参数
  // bindTools 失败时静默降级到 RAG 模式
  // 注意：tool_choice='required' 或锁定具体工具，仅应在"首轮模型调用"生效，
  //   否则后续轮次模型也被强制反复调工具，会死循环。
  //   因此我们额外维护一个 'auto' 版本的 llmWithToolsAuto，从第二轮起切换。
  let llmWithTools;       // 首轮用（可能带 required / 锁定工具）
  let llmWithToolsAuto;   // 第二轮起用（始终 auto），避免死循环
  try {
    if (!caps.supportsFC) {
      llmWithTools = llm.bindTools(filteredToolSchemas);
      llmWithToolsAuto = llmWithTools;
    } else if (!caps.supportsToolChoice) {
      // 模型不支持 tool_choice，绑定时不传该参数
      llmWithTools = llm.bindTools(filteredToolSchemas);
      llmWithToolsAuto = llmWithTools;
    } else {
      llmWithTools = llm.bindTools(filteredToolSchemas, { tool_choice: toolChoiceParam });
      // 仅当首轮真的设置了非 auto 的 toolChoiceParam 时才需要单独的 auto 版本
      llmWithToolsAuto = toolChoiceParam === 'auto'
        ? llmWithTools
        : llm.bindTools(filteredToolSchemas, { tool_choice: 'auto' });
    }
  } catch (bindError: any) {
    logger.warn('FC模式：bindTools 失败，降级到RAG注入模式', {
      module: 'PromptService',
      error: bindError.message,
      modelId: getCurrentModelId(),
    });
    throw new FCFallbackError(`bindTools 失败: ${bindError.message}`, '');
  }

  const MAX_TOOL_ITERATIONS = 10;
  const MAX_NO_PROGRESS_ROUNDS = 2; // 连续无进展轮数上限
  let noProgressCount = 0;          // 连续无进展计数器
  let stoppedByNoProgress = false;  // 是否由无进展检测触发退出
  let toolCallsMade: Array<{ name: string; args: any }> = [];
  let usedKnowledgeBase = false;
  let usedWebSearch = false;
  let usedWeather = false;
  let usedCalculate = false;
  let sessionAction: any = null;
  let fcKnowledgeBaseResult = ''; // 收集 FC 模式下已获取的知识库结果，降级时复用
  let collectedImages: Array<{ url: string; alt: string }> = []; // 收集工具生成的图片
  let collectedMindmaps: Array<{ mermaidCode: string; title: string; imageUrl?: string }> = []; // 收集工具生成的思维导图
  let collectedChartOptions: Array<{ option: any; chartType?: string; imageUrl?: string }> = []; // 收集工具生成的图表 ECharts option
  let collectedFileCards: Array<{ key: string; filename: string; format: string; sizeBytes: number; downloadUrl: string; previewUrl: string; expiresAt: number; favorited: boolean }> = []; // 收集 generate_document 生成的文件卡片

  // 启动心跳，在工具调用循环期间保持连接活跃
  const heartbeatTimer = startHeartbeat(res);

  logger.info('FC模式：开始工具调用循环', { module: 'PromptService', modelId: getCurrentModelId() });

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (isCancelled && isCancelled()) {
      logger.info('FC模式：检测到取消信号', { module: 'PromptService' });
      stopHeartbeat(heartbeatTimer);
      if (res && !res.writableEnded) res.end();
      return;
    }

    // 连续无进展检测：如果在第 0 轮之后连续 MAX_NO_PROGRESS_ROUNDS 轮无进展，强制退出
    if (iteration > 0 && noProgressCount >= MAX_NO_PROGRESS_ROUNDS) {
      logger.warn('FC模式：连续无进展，提前退出工具调用循环', {
        module: 'PromptService',
        iteration: iteration + 1,
        noProgressCount,
        toolCallsMade: toolCallsMade.map(tc => tc.name),
      });
      stoppedByNoProgress = true;
      break;
    }

    let iterationHadProgress = false; // 本轮工具调用是否有任何进展

    logger.info('FC模式：调用模型', { module: 'PromptService', iteration: iteration + 1, messageCount: messages.length });

    // 通知客户端：模型正在思考
    sendToolStatus(res, 'thinking', 'calling', { iteration: iteration + 1 });

    let response: any;
    try {
      // 首轮使用 llmWithTools（可能带 tool_choice=required/锁定工具）
      // 第二轮起切换到 llmWithToolsAuto，让模型自由决定是继续调工具还是给最终答案
      const activeLlm = iteration === 0 ? llmWithTools : llmWithToolsAuto;
      response = await activeLlm.invoke(messages, {
        signal: abortController?.signal,
      });
    } catch (invokeError: any) {
      if (invokeError.name === 'AbortError' || invokeError.code === 'ABORT_ERR') {
        logger.info('FC模式：LLM调用被中断', { module: 'PromptService' });
        stopHeartbeat(heartbeatTimer);
        if (res && !res.writableEnded) res.end();
        return;
      }

      // 终极安全网：如果 provider 不支持 tool_choice（如 DeepSeek Thinking mode 报 400），
      // 自动创建无 tool_choice 绑定重试一次，覆盖所有未知模型
      const isToolChoiceError = /tool_choice/i.test(invokeError.message || invokeError.toString());
      if (isToolChoiceError) {
        logger.warn('FC模式：LLM 调用报 tool_choice 错误，自动重试无 tool_choice', {
          module: 'PromptService',
          error: invokeError.message,
          modelId: getCurrentModelId(),
        });
        try {
          const llmNoToolChoice = llm.bindTools(filteredToolSchemas);
          response = await llmNoToolChoice.invoke(messages, {
            signal: abortController?.signal,
          });
          // 同时修正常驻绑定，避免后续迭代再次失败
          llmWithTools = llmNoToolChoice;
          llmWithToolsAuto = llmNoToolChoice;
          logger.info('FC模式：无 tool_choice 重试成功', { module: 'PromptService' });
        } catch (retryError: any) {
          logger.error('FC模式：无 tool_choice 重试也失败，降级到 RAG', {
            module: 'PromptService',
            error: retryError.message,
          });
          throw new FCFallbackError(retryError.message, fcKnowledgeBaseResult);
        }
      } else {
        logger.error('FC模式：LLM调用失败，降级到RAG注入模式', { module: 'PromptService', error: invokeError.message });
        throw new FCFallbackError(invokeError.message, fcKnowledgeBaseResult);
      }
    }

    const aiMessage = response as AIMessage;
    const hasToolCalls = aiMessage.tool_calls && aiMessage.tool_calls.length > 0;

    logger.info('FC模式：模型响应分析', {
      module: 'PromptService',
      iteration: iteration + 1,
      hasToolCalls,
      toolCallCount: aiMessage.tool_calls?.length || 0,
      contentType: typeof aiMessage.content,
      contentLength: typeof aiMessage.content === 'string' ? aiMessage.content.length : -1,
      responseKeys: Object.keys(response || {}),
    });

    if (hasToolCalls) {
      messages.push(aiMessage);

      // 工具调用去重：同一工具+相同参数只执行一次
      const seenCalls = new Set<string>();
      const deduplicatedCalls = aiMessage.tool_calls!.filter((toolCall) => {
        const key = `${toolCall.name}:${JSON.stringify(toolCall.args)}`;
        if (seenCalls.has(key)) {
          logger.info('FC模式：跳过重复的工具调用', {
            module: 'PromptService',
            toolName: toolCall.name,
            args: JSON.stringify(toolCall.args).substring(0, 200),
          });
          return false;
        }
        seenCalls.add(key);
        return true;
      });

      // 工具调用熔断：根据模型能力分级设定限制
      // 线上模型上下文大、指令遵循强，允许稍多调用；本地模型严格限制防循环
      const caps = getModelCapabilities(getCurrentModelId());
      const isSmallContext = caps.contextLength < 8192;
      const MAX_PER_TOOL = isSmallContext ? 2 : 5;
      const MAX_TOTAL_TOOL_CALLS = isSmallContext ? 8 : 15;
      const toolCallCounts: Record<string, number> = {};
      for (const tc of toolCallsMade) {
        toolCallCounts[tc.name] = (toolCallCounts[tc.name] || 0) + 1;
      }

      // 全局熔断：总调用次数超限，返回失败 ToolMessage 让模型转向最终回答
      if (toolCallsMade.length >= MAX_TOTAL_TOOL_CALLS) {
        logger.warn('FC模式：全局熔断触发，所有工具调用返回限制提示', {
          module: 'PromptService',
          totalCalls: toolCallsMade.length,
          maxTotal: MAX_TOTAL_TOOL_CALLS,
        });
        for (const toolCall of deduplicatedCalls) {
          messages.push(new ToolMessage({
            content: JSON.stringify({ error: true, message: '工具调用总次数已达上限，请基于已有信息直接回答用户问题，不要再调用任何工具。' }),
            tool_call_id: toolCall.id || `tc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            name: toolCall.name,
          }));
        }
        continue; // 继续下一轮迭代，模型会看到失败结果后生成最终回答
      }

      // 单工具熔断：过滤掉超过调用次数限制的工具
      const circuitBrokenCalls = deduplicatedCalls.filter((toolCall) => {
        const currentCount = toolCallCounts[toolCall.name] || 0;
        if (currentCount >= MAX_PER_TOOL) {
          logger.warn('FC模式：单工具熔断触发，返回限制提示', {
            module: 'PromptService',
            toolName: toolCall.name,
            currentCount,
            maxPerTool: MAX_PER_TOOL,
          });
          // 为被熔断的工具调用添加失败 ToolMessage
          messages.push(new ToolMessage({
            content: JSON.stringify({ error: true, message: `工具 ${toolCall.name} 调用次数已达上限，请基于已有信息回答。` }),
            tool_call_id: toolCall.id || `tc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            name: toolCall.name,
          }));
          return false;
        }
        return true;
      });

      // 如果所有工具调用都被熔断过滤，直接进入下一轮迭代
      if (circuitBrokenCalls.length === 0) {
        continue;
      }

      // 并行执行所有工具调用，减少总等待时间
      const toolCallPromises = circuitBrokenCalls.map(async (toolCall) => {
        const toolCallId = toolCall.id || `tc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        logger.info('FC模式：执行工具调用', {
          module: 'PromptService',
          iteration: iteration + 1,
          toolName: toolCall.name,
          toolCallId,
          args: JSON.stringify(toolCall.args).substring(0, 500),
        });

        if (!hasTool(toolCall.name)) {
          const availableTools = getAvailableToolNames().join(', ');
          logger.warn('FC模式：LLM调用了不存在的工具，返回引导信息', {
            module: 'PromptService',
            requestedTool: toolCall.name,
            availableTools,
          });
          sendToolStatus(res, toolCall.name, 'done', { error: true });
          return {
            toolCall,
            toolCallId,
            success: false,
            content: JSON.stringify({
              error: true,
              message: `工具 "${toolCall.name}" 不存在。可用工具: ${availableTools}。请仅使用上述可用工具。`,
            }),
            result: null,
          };
        }

        if (toolCall.name === 'search_knowledge_base') usedKnowledgeBase = true;
        if (toolCall.name === 'search_web') usedWebSearch = true;
        if (toolCall.name === 'get_weather') usedWeather = true;
        if (toolCall.name === 'calculate') usedCalculate = true;

        // 通知客户端：工具开始执行
        sendToolStatus(res, toolCall.name, 'executing');

        // 数据绑定解析：如果该工具调用对应计划中的某个步骤，且步骤声明了 inputMapping，
        // 则将参数中的 $stepN.output.xxx 表达式替换为实际值
        let effectiveArgs = toolCall.args;
        let matchedStepId: number | undefined;
        if (sessionId) {
          const plan = getSessionPlan(sessionId);
          if (plan) {
            const matchingStep = findMatchingStep(sessionId, toolCall.name);
            if (matchingStep) {
              matchedStepId = matchingStep.id;
              // 合并 inputMapping 到原始参数（inputMapping 优先级高于 LLM 输出）
              const argsWithMapping = matchingStep.inputMapping
                ? { ...toolCall.args, ...matchingStep.inputMapping }
                : toolCall.args;
              effectiveArgs = resolveDataBindings(argsWithMapping, plan);
              if (effectiveArgs !== toolCall.args) {
                logger.info('FC模式：数据绑定已应用', {
                  module: 'PromptService',
                  toolName: toolCall.name,
                  stepId: matchedStepId,
                  hasInputMapping: !!matchingStep.inputMapping,
                });
              }
            }
          }
        }

        try {
          const result = await executeTool(toolCall.name, effectiveArgs, { userId, sessionId, res, imageModel, originalQuery: promptText });
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

          // 数据绑定：将工具结果存入匹配的计划步骤的 output 字段，供后续步骤引用
          if (matchedStepId !== undefined && sessionId) {
            storeStepOutput(sessionId, matchedStepId, result);
          }

          logger.info('FC模式：工具执行成功，构造 ToolMessage', {
            module: 'PromptService',
            toolName: toolCall.name,
            toolCallId,
            resultLength: resultStr.length,
            resultPreview: resultStr.substring(0, 300),
          });

          // 通知客户端：工具执行完成
          sendToolStatus(res, toolCall.name, 'done');

          return { toolCall, toolCallId, success: true, content: resultStr, result };
        } catch (toolError: any) {
          logger.error('FC模式：工具执行失败，构造错误 ToolMessage', {
            module: 'PromptService',
            toolName: toolCall.name,
            toolCallId,
            error: toolError.message,
          });
          sendToolStatus(res, toolCall.name, 'done', { error: true });
          return {
            toolCall,
            toolCallId,
            success: false,
            content: JSON.stringify({ error: true, message: `工具执行失败: ${toolError.message}` }),
            result: null,
          };
        }
      });

      const toolResults = await Promise.all(toolCallPromises);

      // 按顺序处理结果，构造 ToolMessage 和收集元数据
      for (const { toolCall, toolCallId, success, content, result } of toolResults) {
        // 只在工具实际执行成功时记录到 metadata
        if (success) {
          toolCallsMade.push({ name: toolCall.name, args: toolCall.args });
          iterationHadProgress = true; // 本轮有工具调用成功
        }

        if (success && result) {
          // 收集 manage_session 返回的前端操作指令
          if (toolCall.name === 'manage_session' && result?.frontend_action && !sessionAction) {
            sessionAction = result.frontend_action;
            logger.info('FC模式：收集到前端会话操作指令', {
              module: 'PromptService',
              actionType: sessionAction.type,
              payload: JSON.stringify(sessionAction.payload),
            });
          }

          // 收集知识库结果，降级 RAG 时可复用
          if (toolCall.name === 'search_knowledge_base' && content) {
            fcKnowledgeBaseResult = content;
          }

          // 收集图片生成结果，流式输出时直接注入到前端
          if (toolCall.name === 'generate_image' && result?.type === 'image' && result?.images) {
            for (const img of result.images) {
              if (img.url) {
                collectedImages.push({ url: img.url, alt: '生成的图片' });
              }
            }
          }

          // 收集图表 echartsOption：稍后注入 ```echarts 代码块给前端渲染（交互式图表）
          if (toolCall.name === 'generate_chart' && result?.echartsOption) {
            collectedChartOptions.push({ option: result.echartsOption, chartType: result.chartType, imageUrl: result?.imageUrl });
          }

          // 收集思维导图结果，流式输出时直接注入到前端
          if (toolCall.name === 'create_mindmap' && result?.type === 'mindmap' && result?.mermaidCode) {
            collectedMindmaps.push({ mermaidCode: result.mermaidCode, title: result.title, imageUrl: result?.imageUrl });
          }

          // 收集 generate_document 生成的文件卡片：稍后通过 SSE file_card 事件推送
          if (toolCall.name === 'generate_document' && result?.success && result?.type === 'document') {
            collectedFileCards.push({
              key: result.key,
              filename: result.filename,
              format: result.format,
              sizeBytes: result.sizeBytes,
              downloadUrl: result.downloadUrl,
              previewUrl: result.previewUrl,
              expiresAt: result.expiresAt,
              favorited: false,
            });
          }
        }

        messages.push(new ToolMessage({
          content: success ? formatToolResult(toolCall.name, content, getCurrentModelId()) : content,
          tool_call_id: toolCallId,
          name: toolCall.name,
        }));
      }

      logger.info('FC模式：本轮工具调用完成，继续下一轮模型调用', {
        module: 'PromptService',
        iteration: iteration + 1,
        totalToolCallsSoFar: toolCallsMade.length,
        messagesLength: messages.length,
      });

      // 无进展计数器：本轮有成功 → 重置；本轮全失败 → 累加
      if (iterationHadProgress) {
        noProgressCount = 0;
      } else {
        noProgressCount++;
      }
    } else {
      // 检测模型输出疑似工具调用意图的文本（如"调用 search_web"）
      // 策略：只检测"明确说要调用工具但没调"的情况，不检测"描述已有结果"的情况
      const textContent = typeof aiMessage.content === 'string' ? aiMessage.content : '';
      const toolNamePattern = getAvailableToolNames().join('|');

      // 第一类：模型明确说要调用某个工具但没实际调用（始终检测）
      // 例如："调用 search_web 工具"、"使用 generate_image 来生成"
      const explicitIntent = toolNamePattern
        ? new RegExp(`(?:调用|使用|执行|运行)\\s*(?:工具)?\\s*(?:${toolNamePattern})`, 'i').test(textContent)
        : false;

      // ==================== 防嘴炮·防线 2：宽松正则 + 复用意图检测 ====================
      // 第二类：模型表达了工具意图但没实际调用（仅在未执行过任何工具时检测）
      // 注意：如果已经执行过工具，LLM 回复中自然会包含"图片"等词汇，这是对结果的描述，不应误判
      const alreadyUsedTools = toolCallsMade.length > 0;
      // 反问保护：如果 AI 回复以问号结尾（"你想生成什么样的图片？"），说明它在向用户索取信息
      // 这种情况不算嘴炮，应放行让前端展示给用户
      const isAskingUser = /[?？]\s*$/.test(textContent.trim());
      // 复用 detectToolIntent（防线 1 同款逻辑），保证两处判断口径一致
      const aiTextIntent = !alreadyUsedTools && !isAskingUser ? detectToolIntent(textContent) : null;
      // 兜底正则：捕捉 detectToolIntent 漏掉的"自我宣言"模式
      // 这些是 LLM"嘴炮"的典型话术，覆盖 90% 中文 LLM 行为
      const selfDeclarationPattern = !alreadyUsedTools && !isAskingUser && (
        // 1. "我(来|会|将|马上|这就|这便|稍等)... 生成/画/创建/做"
        /(?:我(?:来|会|将|马上|这就|这便|稍等|帮你|给你|为你|来给你|来帮你)).{0,30}(?:生成|画|绘制|创建|制作|做|输出|展示|展现|设计|准备)/i.test(textContent)
        // 2. "让我... 先/来 + 调用/试试/帮你/给你"
        || /(?:让我|请允许我|稍等).{0,15}(?:先|来|帮你|给你|尝试|试试|调用)/i.test(textContent)
        // 3. "下面(是|为你|给你)..."、"接下来(我会)..."、"现在(开始)..."（嘴炮但还没动）
        || /(?:下面|接下来|现在|马上).{0,10}(?:是|为|给|开始|就).{0,20}(?:生成|创建|制作|画|绘制|展示|输出|演示)/i.test(textContent)
        // 4. "需要/可以... 工具/调用 + 帮你..."
        || /(?:需要|可以|能够).{0,10}(?:调用|使用).{0,10}(?:工具|功能|api|插件)/i.test(textContent)
        // 5. 英文兜底
        || /\b(?:i(?:'ll| will| am going to| can| shall)|let me|i'm going to)\b.{0,30}(?:generate|create|make|draw|design|build|use.{0,5}tool|call.{0,5}function)/i.test(textContent)
      );
      const implicitIntent = (aiTextIntent?.shouldForce ?? false) || selfDeclarationPattern;

      const suspectedIntent = explicitIntent || implicitIntent;

      if (suspectedIntent && iteration < MAX_TOOL_ITERATIONS - 1) {
        logger.info('FC模式：检测到疑似工具调用意图文本，添加提示重试', {
          module: 'PromptService',
          textPreview: textContent.substring(0, 200),
        });
        messages.push(aiMessage);
        messages.push(new HumanMessage({
          content: '请直接使用工具调用功能来执行上述操作，而不是用文字描述。如果你需要调用工具，请使用正确的工具调用格式。',
        }));
        continue; // 继续下一轮迭代
      }

      // ==================== 防嘴炮·防线 3：LLM-as-Judge ====================
      // 如果前两道防线都没命中，但模型既没调用工具又输出了较长内容（>30 字符）
      // 且当前对话开头还没动过任何工具，可能是被前面正则漏掉的嘴炮形式。
      // 用一个轻量 LLM 调用来兜底判断（成本约 0.001¥/次，只在前两层都漏判时触发）。
      // isAskingUser 时跳过：反问句几乎不会是嘴炮，省一次 LLM 调用
      const shouldRunJudge = !alreadyUsedTools
        && !isAskingUser
        && textContent.length > 30
        && iteration < MAX_TOOL_ITERATIONS - 1;
      if (shouldRunJudge) {
        // 检查是否已被取消，避免在用户中断后还跑 judge
        if (isCancelled && isCancelled()) {
          logger.info('FC模式：LLM-as-Judge 跳过（已取消）', { module: 'PromptService' });
        } else {
          const judgeResult = await llmAsToolIntentJudge(promptText || '', textContent, abortController);
          if (judgeResult.isMouthCannon) {
            logger.warn('FC模式：LLM-as-Judge 判定为嘴炮，强制重试', {
              module: 'PromptService',
              judgeReason: judgeResult.reason,
              textPreview: textContent.substring(0, 200),
            });
            messages.push(aiMessage);
            messages.push(new HumanMessage({
              content: `用户的请求需要你实际调用工具来完成（${judgeResult.reason}）。请立即使用 function calling 调用对应的工具，不要再用文字描述要做什么。`,
            }));
            continue; // 继续下一轮迭代
          }
        }
      }
      // 检测模型输出了原始工具调用格式（如 DeepSeek 的 DSML 标签）
      // 这说明模型的 function calling 失败了，需要重试
      const hasRawToolCallFormat = containsRawToolCallFormat(textContent);
      if (hasRawToolCallFormat && iteration < MAX_TOOL_ITERATIONS - 1) {
        logger.warn('FC模式：检测到原始工具调用格式文本，function calling 可能失败，添加提示重试', {
          module: 'PromptService',
          textPreview: textContent.substring(0, 300),
        });
        // 不推送原始格式文本，直接要求重试
        messages.push(new HumanMessage({
          content: '你上一次的回复包含了工具调用的原始格式文本，这不是正确的工具调用方式。请使用工具调用功能（function calling）来执行操作，或者直接用自然语言回答用户问题。不要输出任何工具调用格式的文本。',
        }));
        continue; // 继续下一轮迭代
      }

      logger.info('FC模式：获得最终回答，切换流式输出', { module: 'PromptService', toolCallCount: toolCallsMade.length });

      // 流式输出阶段不再需要心跳，停止定时器
      stopHeartbeat(heartbeatTimer);

      const fcStartTime = Date.now();

      if (res) {
        const ragMetadata = {
          usedKnowledgeBase,
          usedWebSearch,
          usedWeather,
          usedCalculate,
          contextCount: toolCallsMade.filter(tc => tc.name === 'search_knowledge_base').length,
          webSearchCount: toolCallsMade.filter(tc => tc.name === 'search_web').length,
          weatherCount: toolCallsMade.filter(tc => tc.name === 'get_weather').length,
          calculateCount: toolCallsMade.filter(tc => tc.name === 'calculate').length,
          toolCalls: toolCallsMade.map(tc => tc.name),
        };
        try {
          // 先发送 metadata 和 session_action 事件
          sendMetadata(res, ragMetadata);
          if (sessionAction) {
            sendSessionAction(res, sessionAction);
          }

          // 在 LLM 回答之前，直接注入工具生成的图片和思维导图
          // 这样无论 LLM 如何回答，用户都能看到可视化内容
          let fcFullResponse = '';

          if (collectedImages.length > 0) {
            const imageContent = collectedImages
              .map((img, i) => `![${img.alt}${collectedImages.length > 1 ? ` ${i + 1}` : ''}](${img.url})`)
              .join('\n');
            sendContent(res, imageContent + '\n\n');
            process.stdout.write(imageContent + '\n\n');
            fcFullResponse = imageContent + '\n\n';
          }
          if (collectedMindmaps.length > 0) {
            for (const mm of collectedMindmaps) {
              const mermaidContent = '```mermaid\n' + mm.mermaidCode + '\n```\n\n';
              sendContent(res, mermaidContent);
              process.stdout.write(mermaidContent);
              fcFullResponse += mermaidContent;
            }
          }
          if (collectedChartOptions.length > 0) {
            for (const ch of collectedChartOptions) {
              const optionJson = JSON.stringify(ch.option, null, 2);
              const chartContent = '```echarts\n' + optionJson + '\n```\n\n';
              sendContent(res, chartContent);
              process.stdout.write(chartContent);
              fcFullResponse += chartContent;
            }
          }
          // 推送文件卡片：通过独立 SSE 事件，不污染正文
          if (collectedFileCards.length > 0) {
            for (const card of collectedFileCards) {
              sendFileCard(res, card);
            }
          }

          // 保存本轮生成的资产 URL 到跨轮次缓存，下一轮对话可直接引用
          // 用 fire-and-forget：缓存写入失败不应阻塞 LLM 流式响应（业务核心路径）
          // L1 内存写是同步完成的，仅 L2 Redis 写为异步；最坏情况 Redis 失败也只丢 L2，L1 已生效
          saveSessionAssets(sessionId, collectedImages, collectedChartOptions, collectedMindmaps, collectedFileCards)
            .catch((e) => logger.warn('saveSessionAssets 失败（已忽略）', {
              module: 'PromptService',
              err: e?.message || String(e),
            }));

          const stream = await llm.stream(messages, {
            signal: abortController?.signal,
          });
          let chunkCount = 0;
          // fcFullResponse 已在上方初始化（可能包含注入的图片/思维导图内容）
          let inThinkBlock = false;
          let rawToolCallBuffer = ''; // 缓冲可能的原始工具调用格式
          let rawToolCallDetected = false; // 是否已检测到原始格式
          let imageMarkdownBuffer = ''; // 缓冲可能跨 chunk 的图片 Markdown，闭合后统一剥离
          // 仅当服务端注入过图片时，才剥离 LLM 重复输出的图片，避免误删 AI 主动引用的合法图片
          const hasInjectedImages = collectedImages.length > 0;
          for await (const chunk of stream) {
            if (isCancelled && isCancelled()) {
              logger.info('FC模式流式：检测到取消信号，停止生成', { module: 'PromptService' });
              break;
            }
            chunkCount++;
            const filtered = filterThinkTags(chunk.content?.toString() || '', inThinkBlock);
            inThinkBlock = filtered.inThinkBlock;
            if (filtered.text) {
              // 智能缓冲策略：
              // 1. 如果已确认包含原始工具调用格式，持续缓冲并过滤
              // 2. 如果文本以 < 或 ｜ 开头（可能是标签起始），短暂缓冲等待判断
              // 3. 其他情况立即输出，不引入延迟
              if (rawToolCallDetected) {
                // 已确认有原始格式，持续缓冲过滤
                rawToolCallBuffer += filtered.text;
                if (containsRawToolCallFormat(rawToolCallBuffer)) {
                  const cleaned = filterRawToolCalls(rawToolCallBuffer);
                  if (cleaned) {
                    fcFullResponse += cleaned;
                    sendContent(res, cleaned);
                    process.stdout.write(cleaned);
                  }
                  rawToolCallBuffer = '';
                }
              } else if (isPossibleRawToolCallStart(filtered.text) && rawToolCallBuffer.length < 50) {
                // 可能是标签起始，短暂缓冲等待更多数据
                rawToolCallBuffer += filtered.text;
                if (containsRawToolCallFormat(rawToolCallBuffer)) {
                  // 确认是原始格式，切换到过滤模式
                  rawToolCallDetected = true;
                  const cleaned = filterRawToolCalls(rawToolCallBuffer);
                  if (cleaned) {
                    fcFullResponse += cleaned;
                    sendContent(res, cleaned);
                    process.stdout.write(cleaned);
                  }
                  rawToolCallBuffer = '';
                } else if (rawToolCallBuffer.length >= 50) {
                  // 缓冲足够长且不是原始格式，安全输出
                  fcFullResponse += rawToolCallBuffer;
                  sendContent(res, rawToolCallBuffer);
                  process.stdout.write(rawToolCallBuffer);
                  rawToolCallBuffer = '';
                }
              } else {
                // 正常文本，立即输出
                if (rawToolCallBuffer) {
                  // 先输出缓冲区内容
                  fcFullResponse += rawToolCallBuffer;
                  sendContent(res, rawToolCallBuffer);
                  process.stdout.write(rawToolCallBuffer);
                  rawToolCallBuffer = '';
                }
                // 图片唯一来源是服务端注入：仅当本轮注入过图片时，才剥离 LLM 重复输出的图片。
                // 未注入图片时直接输出，既不误删 AI 引用的合法图片，也不引入缓冲延迟。
                if (!hasInjectedImages) {
                  fcFullResponse += filtered.text;
                  sendContent(res, filtered.text);
                  process.stdout.write(filtered.text);
                } else {
                  // 图片 Markdown 可能跨 chunk，遇到未闭合的 `![` 时先缓冲，等闭合再剥离。
                  imageMarkdownBuffer += filtered.text;
                  const lastOpen = imageMarkdownBuffer.lastIndexOf('![');
                  const hasUnclosedImage =
                    lastOpen !== -1 && imageMarkdownBuffer.indexOf(')', lastOpen) === -1;
                  if (hasUnclosedImage && imageMarkdownBuffer.length < 2000) {
                    // 可能是半截图片语法，继续缓冲等待闭合
                    continue;
                  }
                  const cleaned = stripMarkdownImages(imageMarkdownBuffer);
                  imageMarkdownBuffer = '';
                  if (cleaned) {
                    fcFullResponse += cleaned;
                    sendContent(res, cleaned);
                    process.stdout.write(cleaned);
                  }
                }
              }
            }
          }
          // 输出缓冲区剩余内容
          if (rawToolCallBuffer) {
            const cleaned = filterRawToolCalls(rawToolCallBuffer);
            if (cleaned) {
              fcFullResponse += cleaned;
              sendContent(res, cleaned);
              process.stdout.write(cleaned);
            }
          }
          // 输出图片 Markdown 缓冲区残留内容（统一剥离图片后再输出）
          if (imageMarkdownBuffer) {
            const cleaned = stripMarkdownImages(imageMarkdownBuffer);
            if (cleaned) {
              fcFullResponse += cleaned;
              sendContent(res, cleaned);
              process.stdout.write(cleaned);
            }
            imageMarkdownBuffer = '';
          }
          logger.info('FC模式流式响应完成', { module: 'PromptService', chunkCount, fcFullResponseLength: fcFullResponse.length, estimatedOutputTokens: estimateTokens(fcFullResponse) });
          res.end();

          // 记录 token 用量
          if (onUsageComplete) {
            onUsageComplete({
              userId: userId || 'default',
              sessionId,
              modelId: getCurrentModelId(),
              inputTokens: estimateTokensFromMessages(messages),
              outputTokens: estimateTokens(fcFullResponse),
              historyCount: recentHistory.length,
              usedKnowledgeBase,
              imageCount: images?.length || 0,
              responseTimeMs: Date.now() - fcStartTime,
              userMessage: promptText || '',
              assistantMessage: fcFullResponse,
            });
          }
        } catch (streamError: any) {
          if (streamError.name === 'AbortError' || streamError.code === 'ABORT_ERR') {
            logger.info('FC模式流式：LLM推理已被中断', { module: 'PromptService' });
            if (!res.writableEnded) res.end();
          } else {
            logger.error('FC模式流式输出失败，回退一次性输出', { module: 'PromptService', error: streamError.message });
            let fallbackContent = typeof aiMessage.content === 'string'
              ? aiMessage.content
              : JSON.stringify(aiMessage.content);
            fallbackContent = fallbackContent.replace(/<think[\s\S]*?<\/think>/gs, "");
            // 过滤原始工具调用格式
            fallbackContent = filterRawToolCalls(fallbackContent);
            // 图片唯一来源是服务端注入，回退路径同样剥离 LLM 输出的图片 Markdown
            if (collectedImages.length > 0) {
              fallbackContent = stripMarkdownImages(fallbackContent);
            }
            if (!res.writableEnded) {
              // fallback 时也需要发送 metadata，否则客户端收不到
              sendMetadata(res, ragMetadata);
              if (sessionAction) {
                sendSessionAction(res, sessionAction);
              }
              sendContent(res, fallbackContent);
              process.stdout.write(fallbackContent);
              res.end();
            }
          }
        }
      } else {
        if (typeof aiMessage.content === 'string') {
          aiMessage.content = aiMessage.content.replace(/<think>[\s\S]*?<\/think>/gs, "");
        }
        return aiMessage;
      }
      return;
    }
  }

  if (stoppedByNoProgress) {
    logger.warn('FC模式：无进展检测退出，强制生成最终回答', {
      module: 'PromptService',
      iterations: toolCallsMade.length,
      toolCalls: toolCallsMade.map(tc => tc.name),
    });
  } else {
    logger.warn('FC模式：达到最大工具调用次数，强制生成最终回答', {
      module: 'PromptService',
      maxIterations: MAX_TOOL_ITERATIONS,
    });
  }

  // 停止心跳
  stopHeartbeat(heartbeatTimer);

  const maxIterStartTime = Date.now();

  // 达到最大迭代次数时，不再绑定工具，强制让模型基于已有信息生成最终回答
  // 清理消息中的工具调用上下文，防止本地模型继续尝试工具调用格式
  const cleanedMessages = messages.filter((msg, idx) => {
    // 保留 SystemMessage
    if (idx === 0 && msg instanceof SystemMessage) return true;
    // 移除早期的 ToolMessage（只保留最后一轮工具结果）
    if (msg instanceof ToolMessage) return false;
    // 移除包含 tool_calls 的 AIMessage（早期轮次的工具调用记录）
    if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) return false;
    return true;
  });

  cleanedMessages.push(new HumanMessage({
    content: '请根据以上信息，直接用自然语言给出最终回答。注意：不要输出任何工具调用格式，不要提及工具名称，只需直接回答问题。',
  }));

  const ragMetadata = {
    usedKnowledgeBase,
    usedWebSearch,
    usedWeather,
    usedCalculate,
    contextCount: toolCallsMade.filter(tc => tc.name === 'search_knowledge_base').length,
    webSearchCount: toolCallsMade.filter(tc => tc.name === 'search_web').length,
    weatherCount: toolCallsMade.filter(tc => tc.name === 'get_weather').length,
    calculateCount: toolCallsMade.filter(tc => tc.name === 'calculate').length,
    toolCalls: toolCallsMade.map(tc => tc.name),
  };
  if (res) {
    try {
      // 先发送 metadata 和 session_action 事件
      sendMetadata(res, ragMetadata);
      if (sessionAction) {
        sendSessionAction(res, sessionAction);
      }

      const stream = await llm.stream(cleanedMessages, {
        signal: abortController?.signal,
      });
      let chunkCount = 0;
      let fullResponse = '';
      let inThinkBlock = false;
      let rawToolCallBuffer = '';
      let rawToolCallDetected = false;
      for await (const chunk of stream) {
        if (isCancelled && isCancelled()) {
          break;
        }
        chunkCount++;
        const filtered = filterThinkTags(chunk.content?.toString() || '', inThinkBlock);
        inThinkBlock = filtered.inThinkBlock;
        if (filtered.text) {
          if (rawToolCallDetected) {
            rawToolCallBuffer += filtered.text;
            if (containsRawToolCallFormat(rawToolCallBuffer)) {
              const cleaned = filterRawToolCalls(rawToolCallBuffer);
              if (cleaned) {
                fullResponse += cleaned;
                sendContent(res, cleaned);
                process.stdout.write(cleaned);
              }
              rawToolCallBuffer = '';
            }
          } else if (isPossibleRawToolCallStart(filtered.text) && rawToolCallBuffer.length < 50) {
            rawToolCallBuffer += filtered.text;
            if (containsRawToolCallFormat(rawToolCallBuffer)) {
              rawToolCallDetected = true;
              const cleaned = filterRawToolCalls(rawToolCallBuffer);
              if (cleaned) {
                fullResponse += cleaned;
                sendContent(res, cleaned);
                process.stdout.write(cleaned);
              }
              rawToolCallBuffer = '';
            } else if (rawToolCallBuffer.length >= 50) {
              fullResponse += rawToolCallBuffer;
              sendContent(res, rawToolCallBuffer);
              process.stdout.write(rawToolCallBuffer);
              rawToolCallBuffer = '';
            }
          } else {
            if (rawToolCallBuffer) {
              fullResponse += rawToolCallBuffer;
              sendContent(res, rawToolCallBuffer);
              process.stdout.write(rawToolCallBuffer);
              rawToolCallBuffer = '';
            }
            fullResponse += filtered.text;
            sendContent(res, filtered.text);
            process.stdout.write(filtered.text);
          }
        }
      }
      if (rawToolCallBuffer) {
        const cleaned = filterRawToolCalls(rawToolCallBuffer);
        if (cleaned) {
          fullResponse += cleaned;
          sendContent(res, cleaned);
          process.stdout.write(cleaned);
        }
      }
      logger.info('FC模式：达到最大迭代后强制生成回答完成', { module: 'PromptService', chunkCount, fullResponseLength: fullResponse.length });
      res.end();

      // 记录 token 用量
      if (onUsageComplete) {
        onUsageComplete({
          userId: userId || 'default',
          sessionId,
          modelId: getCurrentModelId(),
          inputTokens: estimateTokensFromMessages(messages),
          outputTokens: estimateTokens(fullResponse),
          historyCount: recentHistory.length,
          usedKnowledgeBase,
          imageCount: images?.length || 0,
          responseTimeMs: Date.now() - maxIterStartTime,
          userMessage: promptText || '',
          assistantMessage: fullResponse,
        });
      }
    } catch (streamError: any) {
      if (streamError.name === 'AbortError' || streamError.code === 'ABORT_ERR') {
        if (!res.writableEnded) res.end();
      } else {
        logger.error('FC模式：达到最大迭代后流式输出失败', { module: 'PromptService', error: streamError.message });
        if (!res.writableEnded) {
          // fallback 时也需要发送 metadata
          sendMetadata(res, ragMetadata);
          if (sessionAction) {
            sendSessionAction(res, sessionAction);
          }
          sendContent(res, '抱歉，工具调用次数已达上限，请简化您的问题后重试。');
          res.end();
        }
      }
    }
  } else {
    try {
      const finalResponse = await llm.invoke(messages, {
        signal: abortController?.signal,
      });
      if (typeof finalResponse.content === 'string') {
        finalResponse.content = finalResponse.content.replace(/<tool_call>[\s\S]*?<\/think>/gs, "");
      }
      return finalResponse;
    } catch (invokeError: any) {
      return new AIMessage('抱歉，工具调用次数已达上限，请简化您的问题后重试。');
    }
  }
}

/**
 * ============================================================================
 * 【对外导出主入口】把用户消息转换为最终回复（流式或一次性）。
 *
 * 这是整个 prompt 模块对 Service 层暴露的唯一入口（除少量辅助导出外）。
 * Controller 收到 /chat 请求后，会经 Service 层组装 history / summary / memories
 * 等上下文，然后调用本函数。
 *
 * 【两条主路径】
 *   1) FC 模式：当前模型支持 Function Calling 时（modelInfo.supportsFunctionCalling===true），
 *      调 promptWithFunctionCalling，让模型自主决定何时调工具。
 *   2) RAG 注入模式：模型不支持 FC，或 FC 路径抛出 FCFallbackError 时降级至本路径。
 *      策略是先用向量库检索拼上下文（RAG），再让模型基于上下文回答。
 *
 * 【降级复用】
 *   FC 模式失败时，如果它已经在内部检索过知识库（fcError.knowledgeBaseResult），
 *   会复用结果跳过 RAG 模式的重复检索，避免一次额外的向量查询开销。
 *
 * 【参数】与 promptWithFunctionCalling 完全一致，参考其 JSDoc。
 * 【返回】与 promptWithFunctionCalling 一致：流式时直接写 res；非流式时返回 AIMessage。
 * ============================================================================
 */
export const promptTemplate = async (
  promptText?: string,
  images?: string[],
  history?: Array<{ role: string, content: string, images?: string[] }>,
  res?: Response,
  sessionSummary?: string,
  userMemories?: string[],
  isCancelled?: () => boolean,
  abortController?: AbortController,
  userId?: string,
  sessionId?: string,
  onUsageComplete?: (usage: UsageData) => void,
  imageModel?: string,
) => {
  const modelInfo = getModelInfo();
  let fcError: any = null;

  if (modelInfo.supportsFunctionCalling) {
    logger.info('当前模型支持Function Calling，使用FC模式', { module: 'PromptService', modelId: getCurrentModelId() });
    try {
      return await promptWithFunctionCalling(
        promptText, images, history, res, sessionSummary, userMemories, isCancelled, abortController, userId, sessionId, onUsageComplete, imageModel,
      );
    } catch (err: any) {
      fcError = err;
      logger.warn('FC模式失败，降级到RAG注入模式', { module: 'PromptService', error: err.message });
    }
  } else {
    logger.info('当前模型不支持Function Calling，使用RAG注入模式', { module: 'PromptService', modelId: getCurrentModelId() });
  }

  // 检查 FC 降级时是否已获取知识库结果，避免重复检索
  const fcFallbackKBResult = (fcError instanceof FCFallbackError && fcError.knowledgeBaseResult) ? fcError.knowledgeBaseResult : '';

  const conversions: Array<SystemMessage | HumanMessage | AIMessage> = [];

  // ==================== 步骤1: 从知识库检索相关文档 ====================
  let retrievedContext = '';
  let hasRetrievedContent = false;
  let ragContextCount = 0;
  let retrievalResults: Array<{ content: string; metadata: any; score: number; vectorScore?: number }> = [];

  if (fcFallbackKBResult) {
    // FC 模式已检索过知识库，直接复用结果，跳过重复检索
    logger.info('RAG模式：复用FC模式已获取的知识库结果，跳过重复检索', { module: 'PromptService' });
    retrievedContext = fcFallbackKBResult;
    hasRetrievedContent = true;
    ragContextCount = 1;
  } else if (promptText && promptText.trim()) {
    try {
      logger.info('正在从知识库检索相关文档', { module: 'PromptService' });
      const retrieval = await retrieveFromKnowledgeBase(promptText.trim(), 3);

      if (retrieval.results && retrieval.results.length > 0) {
        const relevantResults = retrieval.results.filter((r: any) => {
          const vecScore = r.vectorScore ?? r.score;
          if (vecScore > 0 && vecScore > 0.55) {
            logger.debug('过滤不相关结果', { module: 'PromptService', vectorScore: vecScore.toFixed(4), content: r.content.substring(0, 40) });
            return false;
          }
          return true;
        });

        if (relevantResults.length > 0) {
          hasRetrievedContent = true;
          ragContextCount = relevantResults.length;
          retrievedContext = relevantResults
            .map((r: any, i: number) => `【文档 ${i + 1}】\n${r.content}`)
            .join('\n\n') + UNTRUSTED_CONTEXT_INSTRUCTION;
          retrievalResults = relevantResults;
          logger.info('知识库检索完成', { module: 'PromptService', resultCount: relevantResults.length });
        } else {
          logger.info('知识库检索到结果但均不相关，将使用模型自身知识回答', { module: 'PromptService' });
        }
      } else {
        logger.info('知识库中没有找到相关内容', { module: 'PromptService' });
      }
    } catch (error) {
      logger.warn('知识库检索失败（可能未启动）', { module: 'PromptService', error: error.message });
    }
  }

  // ==================== 步骤2: 构建系统提示词 ====================
  let systemPrompt = SYSTEM_PROMPT;
  const injectionDetection = inspectPromptInjection(promptText);
  if (injectionDetection.level === 'suspicious') {
    systemPrompt += buildPromptInjectionSafetyInstruction(injectionDetection);
  }

  if (hasRetrievedContent) {
    const docList = retrievalResults
      .map((r, i) => `【文档 ${i + 1}】\n${r.content}`)
      .join('\n\n');

    let kbStatsInfo = '';
    try {
      const stats = await getKnowledgeBaseStats();
      kbStatsInfo = `\n知识库统计：共 ${stats.documentCount} 个文档块`;
    } catch { }

    systemPrompt = `你是一个问答助手。请仔细阅读以下参考资料，然后回答用户问题。
${kbStatsInfo}
=== 参考资料（以下仅为与问题最相关的部分片段，非完整内容）===
${docList}
=== 参考资料结束 ===

回答规则：
1. 优先使用参考资料中的信息回答，回答时在括号内标注来源，格式为：（【文档 X】）
2. 如果参考资料只覆盖问题的一部分，先列出资料中的信息，再说明"资料中未涉及以下方面：[缺失点]"
3. 如果参考资料与用户问题完全无关：
   - 对于通用知识问题（如"什么是光合作用"），可以回复"知识库中未找到相关信息，以下基于通用知识回答："后用自己的知识回答
   - 对于涉及用户文档/知识库的问题（如用户提到"文档""规范""规定"等），必须回复"知识库中未找到相关内容，请检查文档是否已发布到知识库"，严禁凭自身知识编造文档中的具体条款、规范、数据等内容
4. 当用户问知识库有多少文档时，请根据"知识库统计"信息回答，不要只数参考资料的条数${UNTRUSTED_CONTEXT_INSTRUCTION}`;
  } else {
    // 知识库未检索到任何内容时的 fallback 提示
    // 防止 AI 在用户询问文档内容时凭空编造
    systemPrompt += `\n\n注意：已搜索知识库但未找到与用户问题相关的内容。如果用户的问题涉及具体文档、规范、规定等（如提到"文档""规范""条款"等），必须如实告知"知识库中未找到相关内容，请检查文档是否已发布到知识库"，严禁凭自身知识编造文档中的具体条款、规范、数据等内容。`;
  }

  // ==================== 步骤2.5: 注入对话摘要 ====================
  // 如果有摘要，将其追加到系统提示词中
  // 摘要覆盖了早期对话的关键信息，使 AI 即使不看完整历史也能理解上下文
  if (sessionSummary && sessionSummary.trim()) {
    systemPrompt += `\n\n=== 之前对话的摘要 ===\n${sessionSummary}\n=== 摘要结束 ===\n\n请注意：以上摘要是之前对话的压缩版本，请结合摘要和最近的对话来理解用户的意图。`;
    logger.info('已注入对话摘要', { module: 'PromptService', summaryLength: sessionSummary.length });
  }

  // ==================== 步骤2.6: 注入用户记忆（长期记忆） ====================
  // 用户记忆是跨会话积累的用户画像，帮助 AI 了解用户的偏好、背景和习惯
  if (userMemories && userMemories.length > 0) {
    const memoryText = userMemories.map((m, i) => `${i + 1}. ${m}`).join('\n');
    systemPrompt += `\n\n=== 关于用户的记忆 ===\n以下是从历史对话中了解到的关于用户的信息，请在回答时参考：\n${memoryText}\n=== 用户记忆结束 ===`;
    logger.info('已注入用户记忆', { module: 'PromptService', memoryCount: userMemories.length });
  }

  conversions.push(new SystemMessage(systemPrompt));

  const supportsVision = modelInfo.supportsVision;

  if (images && images.length > 0 && !supportsVision) {
    logger.warn('当前模型不支持图片输入，已忽略图片', { module: 'PromptService', modelId: getCurrentModelId(), imageCount: images.length });
    images = undefined;
  }

  const { maxRounds: MAX_ROUNDS } = computeHistoryBudget({
    totalBudget: computeTotalBudgetForModel(false),
    knowledgeContextLength: hasRetrievedContent ? retrievedContext.length : 0,
    imageCount: images?.length || 0,
    history: history || [],
  });
  const recentHistory = sliceHistoryByRounds(history || [], MAX_ROUNDS);

  if (recentHistory.length > 0) {
    logger.info('添加历史消息', { module: 'PromptService', historyCount: recentHistory.length, maxRounds: MAX_ROUNDS });
    for (const msg of recentHistory) {
      if (msg.role === 'user') {
        let content: any;
        if (msg.images && msg.images.length > 0 && supportsVision) {
          content = [];
          for (const imgUrl of msg.images) {
            const processedUrl = await processImageUrl(imgUrl);
            content.push({ type: 'image_url', image_url: { url: processedUrl } });
          }
          if (msg.content) {
            content.unshift({ type: 'text', text: msg.content });
          }
        } else {
          content = await convertToMultimodalContent(msg.content);
        }
        conversions.push(new HumanMessage({ content }));
      } else if (msg.role === 'assistant') {
        conversions.push(new AIMessage(msg.content));
      }
    }
  }

  let userContent: any;
  if (images && images.length > 0) {
    userContent = [];
    if (promptText) {
      userContent.push({ type: 'text', text: promptText });
    }
    for (const imgUrl of images) {
      const processedUrl = await processImageUrl(imgUrl);
      userContent.push({ type: 'image_url', image_url: { url: processedUrl } });
    }
  } else {
    userContent = await convertToMultimodalContent(promptText || '');
  }

  conversions.push(new HumanMessage({ content: userContent }));

  logger.debug('对话消息列表构建完成', { module: 'PromptService', messageCount: conversions.length });

  if (res) {
    // 流式调用
    logger.info('开始流式调用模型', { module: 'PromptService', modelId: getCurrentModelId() });

    const llm = createRateLimitedLLM(undefined, 'streaming');
    const ragStartTime = Date.now();

    const ragMetadata = {
      usedKnowledgeBase: hasRetrievedContent,
      contextCount: hasRetrievedContent ? ragContextCount : 0,
    };
    logger.debug('发送 RAG 元数据', { module: 'PromptService', usedKnowledgeBase: hasRetrievedContent, contextCount: ragMetadata.contextCount });

    try {
      // 先发送 metadata 事件
      sendMetadata(res, ragMetadata);

      // 将 AbortController 的 signal 传递给 LLM 的 stream 方法
      // 当客户端断开连接时，调用 abortController.abort() 会：
      // 1. 中断 LLM 底层到 Ollama/DeepSeek 的 HTTP 连接
      // 2. Ollama 服务端检测到连接断开后自动停止推理，释放 GPU 资源
      // 3. for await 循环会抛出 AbortError，被下方的 catch 捕获
      const stream = await llm.stream(conversions, {
        signal: abortController?.signal, // 绑定 abort 信号，中断时自动销毁底层 HTTP 请求
      });
      let chunkCount = 0;
      let fullResponse = '';
      let inThinkBlock = false;
      let rawToolCallBuffer = '';
      let rawToolCallDetected = false;
      for await (const chunk of stream) {
        // 检查客户端是否已断开连接（双重保险：即使 abort 信号未生效，也能通过标志位退出循环）
        if (isCancelled && isCancelled()) {
          logger.info('检测到取消信号，停止生成', { module: 'PromptService' });
          break;
        }
        chunkCount++;
        const filtered = filterThinkTags(chunk.content?.toString() || '', inThinkBlock);
        inThinkBlock = filtered.inThinkBlock;
        if (filtered.text) {
          if (rawToolCallDetected) {
            rawToolCallBuffer += filtered.text;
            if (containsRawToolCallFormat(rawToolCallBuffer)) {
              const cleaned = filterRawToolCalls(rawToolCallBuffer);
              if (cleaned) {
                fullResponse += cleaned;
                sendContent(res, cleaned);
                process.stdout.write(cleaned);
              }
              rawToolCallBuffer = '';
            }
          } else if (isPossibleRawToolCallStart(filtered.text) && rawToolCallBuffer.length < 50) {
            rawToolCallBuffer += filtered.text;
            if (containsRawToolCallFormat(rawToolCallBuffer)) {
              rawToolCallDetected = true;
              const cleaned = filterRawToolCalls(rawToolCallBuffer);
              if (cleaned) {
                fullResponse += cleaned;
                sendContent(res, cleaned);
                process.stdout.write(cleaned);
              }
              rawToolCallBuffer = '';
            } else if (rawToolCallBuffer.length >= 50) {
              fullResponse += rawToolCallBuffer;
              sendContent(res, rawToolCallBuffer);
              process.stdout.write(rawToolCallBuffer);
              rawToolCallBuffer = '';
            }
          } else {
            if (rawToolCallBuffer) {
              fullResponse += rawToolCallBuffer;
              sendContent(res, rawToolCallBuffer);
              process.stdout.write(rawToolCallBuffer);
              rawToolCallBuffer = '';
            }
            fullResponse += filtered.text;
            sendContent(res, filtered.text);
            process.stdout.write(filtered.text);
          }
        }
      }
      if (rawToolCallBuffer) {
        const cleaned = filterRawToolCalls(rawToolCallBuffer);
        if (cleaned) {
          fullResponse += cleaned;
          sendContent(res, cleaned);
          process.stdout.write(cleaned);
        }
      }
      logger.info('流式响应完成', { module: 'PromptService', chunkCount, fullResponseLength: fullResponse.length, estimatedOutputTokens: estimateTokens(fullResponse) });
      res.end();

      // 记录 token 用量
      if (onUsageComplete) {
        onUsageComplete({
          userId: userId || 'default',
          sessionId,
          modelId: getCurrentModelId(),
          inputTokens: estimateTokensFromMessages(conversions),
          outputTokens: estimateTokens(fullResponse),
          historyCount: recentHistory.length,
          usedKnowledgeBase: hasRetrievedContent,
          imageCount: images?.length || 0,
          responseTimeMs: Date.now() - ragStartTime,
          userMessage: promptText || '',
          assistantMessage: fullResponse,
        });
      }
    } catch (streamError: any) {
      // AbortError 是用户主动取消导致的，属于正常流程，不需要报错
      if (streamError.name === 'AbortError' || streamError.code === 'ABORT_ERR') {
        logger.info('LLM 推理已被中断（客户端断开连接），底层 HTTP 连接已销毁', { module: 'PromptService' });
        res.end();
      } else {
        logger.error('流式调用失败', { module: 'PromptService', error: streamError.message });
        if (!res.headersSent) {
          res.status(500).json({
            error: '模型调用失败',
            message: streamError.message
          });
        } else {
          res.end();
        }
      }
    }
  } else {
    const nonStreamStartTime = Date.now();
    const llm = createRateLimitedLLM(undefined, 'streaming');
    const result = await llm.invoke(conversions);
    // 去除 think 标签
    if (typeof result.content === 'string') {
      result.content = result.content.replace(/<think>[\s\S]*?<\/think>/gs, "");
    }
    logger.debug('非流式调用完成', { module: 'PromptService' });

    // 记录 token 用量
    if (onUsageComplete) {
      const assistantContent = typeof result.content === 'string' ? result.content : '';
      onUsageComplete({
        userId: userId || 'default',
        sessionId,
        modelId: getCurrentModelId(),
        inputTokens: estimateTokensFromMessages(conversions),
        outputTokens: estimateTokens(assistantContent),
        historyCount: recentHistory.length,
        usedKnowledgeBase: hasRetrievedContent,
        imageCount: images?.length || 0,
        responseTimeMs: Date.now() - nonStreamStartTime,
        userMessage: promptText || '',
        assistantMessage: assistantContent,
      });
    }

    return result;
  }
}
