import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

import { sendToolStatus, startHeartbeat, stopHeartbeat, sendMetadata, sendSessionAction, sendContent } from './sse-writer';

/**
 * FC 模式降级到 RAG 模式时携带已获取的知识库结果
 */
class FCFallbackError extends Error {
  knowledgeBaseResult: string;
  constructor(message: string, knowledgeBaseResult: string = '') {
    super(message);
    this.name = 'FCFallbackError';
    this.knowledgeBaseResult = knowledgeBaseResult;
  }
}
import * as http from 'http';

import { retrieveFromKnowledgeBase } from './rag-service';
import { getKnowledgeBaseStats } from './vector-store';
import { createLLM, buildModelConfig, getCurrentModelId, getModelInfo, getModelCapabilities } from './model-provider';
import { getToolSchemasForModel, executeTool, hasTool, getAvailableToolNames } from './tools';
import { formatSearchResultAsSummary } from './tools/search-web';
import { logger } from './logger';
import { config } from './config';

// ==================== FC 模式进度通知辅助函数 ====================
// SSE 写入函数已提取到 sse-writer.ts

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

// Token 估算：中文约 1.5 字符/token，英文约 4 字符/token
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
    try {
      const parsed = JSON.parse(content);
      const caps = getModelCapabilities(modelId);
      const isSmallContext = caps.contextLength < 8192;
      const maxResults = isSmallContext ? 3 : 5;
      return formatSearchResultAsSummary(parsed, maxResults);
    } catch {
      // JSON 解析失败，返回原始内容
      return content;
    }
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

// 从消息列表估算 input tokens
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
 * 根据当前注册的工具动态构建 FC 模式 System Prompt
 * 只包含已注册工具的描述和规则，避免本地小模型上下文浪费
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
4. 如果工具返回的结果与用户问题无关，请说明并基于自身知识回答
5. 每个工具在一次对话中最多调用一次，不要对同一个工具重复调用相同的参数
6. 收到工具返回结果后，必须直接基于结果生成最终回答，不要再调用其他工具`;

  // 按工具追加专属规则
  if (availableTools.includes('search_knowledge_base')) {
    prompt += `\n\n知识库搜索规则：
- 当用户的问题可能涉及已上传的文档、知识库中的信息时，优先调用 search_knowledge_base`;
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
- 查看会话：action=list；搜索：action=search，提供 keyword`;
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
) {
  const modelInfo = getModelInfo();
  const supportsVision = modelInfo.supportsVision;

  let fcSystemPrompt = buildFCSystemPrompt();

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

  const llm = createLLM(buildModelConfig(getCurrentModelId(), { isFCMode: true }));
  const currentModelId = getCurrentModelId();
  const caps = getModelCapabilities(currentModelId);
  const toolSchemas = await getToolSchemasForModel(currentModelId, { contextLength: caps.contextLength, supportsFC: caps.supportsFC, query: promptText });
  if (!llm.bindTools) {
    throw new FCFallbackError('当前模型不支持 bindTools', '');
  }
  // FC 能力弱的模型对 tool_choice 参数支持不佳，不传该参数
  // bindTools 失败时静默降级到 RAG 模式
  let llmWithTools;
  try {
    llmWithTools = !caps.supportsFC
      ? llm.bindTools(toolSchemas)
      : llm.bindTools(toolSchemas, { tool_choice: 'auto' });
  } catch (bindError: any) {
    logger.warn('FC模式：bindTools 失败，降级到RAG注入模式', {
      module: 'PromptService',
      error: bindError.message,
      modelId: getCurrentModelId(),
    });
    throw new FCFallbackError(`bindTools 失败: ${bindError.message}`, '');
  }

  const MAX_TOOL_ITERATIONS = 5;
  let toolCallsMade: Array<{ name: string; args: any }> = [];
  let usedKnowledgeBase = false;
  let usedWebSearch = false;
  let usedWeather = false;
  let usedCalculate = false;
  let sessionAction: any = null;
  let fcKnowledgeBaseResult = ''; // 收集 FC 模式下已获取的知识库结果，降级时复用

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

    logger.info('FC模式：调用模型', { module: 'PromptService', iteration: iteration + 1, messageCount: messages.length });

    // 通知客户端：模型正在思考
    sendToolStatus(res, 'thinking', 'calling', { iteration: iteration + 1 });

    let response: any;
    try {
      response = await llmWithTools.invoke(messages, {
        signal: abortController?.signal,
      });
    } catch (invokeError: any) {
      if (invokeError.name === 'AbortError' || invokeError.code === 'ABORT_ERR') {
        logger.info('FC模式：LLM调用被中断', { module: 'PromptService' });
        stopHeartbeat(heartbeatTimer);
        if (res && !res.writableEnded) res.end();
        return;
      }
      logger.error('FC模式：LLM调用失败，降级到RAG注入模式', { module: 'PromptService', error: invokeError.message });
      throw new FCFallbackError(invokeError.message, fcKnowledgeBaseResult);
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

        try {
          const result = await executeTool(toolCall.name, toolCall.args, { userId });
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
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
    } else {
      // 检测本地模型可能输出疑似工具调用意图的文本（如"调用 search_web"）
      const textContent = typeof aiMessage.content === 'string' ? aiMessage.content : '';
      const toolNamePattern = getAvailableToolNames().join('|');
      const suspectedIntent = toolNamePattern
        ? new RegExp(`(?:调用|使用|执行|运行)\\s*(?:工具)?\\s*(${toolNamePattern})`, 'i').test(textContent)
        : false;

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

          const stream = await llm.stream(messages, {
            signal: abortController?.signal,
          });
          let chunkCount = 0;
          let fcFullResponse = '';
          let inThinkBlock = false;
          for await (const chunk of stream) {
            if (isCancelled && isCancelled()) {
              logger.info('FC模式流式：检测到取消信号，停止生成', { module: 'PromptService' });
              break;
            }
            chunkCount++;
            const filtered = filterThinkTags(chunk.content?.toString() || '', inThinkBlock);
            inThinkBlock = filtered.inThinkBlock;
            if (filtered.text) {
              fcFullResponse += filtered.text;
              sendContent(res, filtered.text);
              process.stdout.write(filtered.text);
            }
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
            fallbackContent = fallbackContent.replace(/<think>[\s\S]*?<\/think>/gs, "");
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

  logger.warn('FC模式：达到最大工具调用次数，强制生成最终回答', { module: 'PromptService', maxIterations: MAX_TOOL_ITERATIONS });

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
      for await (const chunk of stream) {
        if (isCancelled && isCancelled()) {
          break;
        }
        chunkCount++;
        const filtered = filterThinkTags(chunk.content?.toString() || '', inThinkBlock);
        inThinkBlock = filtered.inThinkBlock;
        if (filtered.text) {
          fullResponse += filtered.text;
          sendContent(res, filtered.text);
          process.stdout.write(filtered.text);
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
) => {
  const modelInfo = getModelInfo();
  let fcError: any = null;

  if (modelInfo.supportsFunctionCalling) {
    logger.info('当前模型支持Function Calling，使用FC模式', { module: 'PromptService', modelId: getCurrentModelId() });
    try {
      return await promptWithFunctionCalling(
        promptText, images, history, res, sessionSummary, userMemories, isCancelled, abortController, userId, sessionId, onUsageComplete,
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
            .join('\n\n');
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

  if (hasRetrievedContent) {
    const docList = retrievalResults
      .map((r, i) => `【文档 ${i + 1}】\n${r.content}`)
      .join('\n\n');

    let kbStatsInfo = '';
    try {
      const stats = await getKnowledgeBaseStats();
      kbStatsInfo = `\n知识库统计：共 ${stats.documentCount} 个文档块`;
    } catch {}

    systemPrompt = `你是一个问答助手。请仔细阅读以下参考资料，然后回答用户问题。
${kbStatsInfo}
=== 参考资料（以下仅为与问题最相关的部分片段，非完整内容）===
${docList}
=== 参考资料结束 ===

回答规则：
1. 优先使用参考资料中的信息回答，回答时在括号内标注来源，格式为：（【文档 X】）
2. 如果参考资料只覆盖问题的一部分，先列出资料中的信息，再说明"资料中未涉及以下方面：[缺失点]"
3. 如果参考资料与用户问题完全无关，请回复"知识库中未找到相关信息，以下基于通用知识回答："，然后用自己的知识回答
4. 当用户问知识库有多少文档时，请根据"知识库统计"信息回答，不要只数参考资料的条数`;
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
    
    const llm = createLLM();
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
          fullResponse += filtered.text;
          sendContent(res, filtered.text);
          process.stdout.write(filtered.text);
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
    const llm = createLLM();
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
