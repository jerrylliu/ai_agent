/**
 * 用户记忆提取服务
 *
 * 核心功能：从对话中提取用户的关键信息，持久化到用户记忆库
 *
 * 设计决策：
 * - 优先使用 DeepSeek-Flash（线上模型）提取记忆
 *   原因：记忆提取需要理解语义和判断重要性，线上模型效果更好
 * - 当 DeepSeek API Key 未配置时，回退到本地 Ollama 模型
 *   原因：本地模型虽然效果稍弱，但比完全跳过记忆提取更好
 * - 提取结果为结构化的记忆条目（每条独立），而非一大段文本
 *   原因：独立条目便于去重、分类、按重要性排序和增量更新
 * - 支持去重：新提取的记忆与已有记忆比较，合并或跳过重复项
 *
 * 触发策略：
 * - 每次保存 assistant 消息后，异步检查是否需要提取记忆
 * - 只在对话轮次达到阈值时触发，避免频繁调用 API
 * - 每 5 轮对话（10 条消息）提取一次
 */

import { ChatOpenAI } from '@langchain/openai';
import { ChatOllama } from '@langchain/ollama';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getDeepseekApiKey } from './model-provider';
import { logger } from './logger';
import { config } from './config';

// ==================== 配置常量 ====================

/** 每隔多少条消息触发一次记忆提取 */
const MEMORY_EXTRACTION_INTERVAL = 10;

/** Ollama 基础 URL */
const OLLAMA_BASE_URL = config.ollamaBaseUrl;

/** DeepSeek API 基础 URL */
const DEEPSEEK_BASE_URL = config.deepseekBaseUrl;

/** 记忆提取使用的本地模型 */
const LOCAL_EXTRACTOR_MODEL = 'qwen3.5-new';

/**
 * 创建记忆提取用的 LLM 实例
 * 优先使用 DeepSeek（效果好），回退到本地 Ollama 模型
 */
function createExtractorLLM(): ChatOpenAI | ChatOllama | null {
  const apiKey = getDeepseekApiKey();

  if (apiKey && apiKey.trim() !== '') {
    return new ChatOpenAI({
      model: 'deepseek-chat',
      temperature: 0.1,
      apiKey,
      configuration: {
        baseURL: DEEPSEEK_BASE_URL,
      },
    });
  }

  // 回退到本地 Ollama 模型
  try {
    const llm = new ChatOllama({
      model: LOCAL_EXTRACTOR_MODEL,
      temperature: 0.1,
      numCtx: 4096,
      baseUrl: OLLAMA_BASE_URL,
      think: false,
    });
    logger.info('DeepSeek API Key 未配置，使用本地模型提取记忆', { module: 'MemoryExtractor', model: LOCAL_EXTRACTOR_MODEL });
    return llm;
  } catch (error: any) {
    logger.warn('本地模型创建失败，跳过记忆提取', { module: 'MemoryExtractor', error: error.message });
    return null;
  }
}

/** 记忆提取的系统提示词 */
const MEMORY_EXTRACTION_PROMPT = `你是一个用户画像分析专家。你的任务是从对话中提取用户希望记住的关键信息。

提取规则：
1. 提取用户明确要求记住的信息，以及关于用户自身的关键信息
2. 当用户说"记住"、"记下"、"别忘了"等指令时，必须提取其要求记住的内容，即使内容不是关于用户本人的（如虚构角色、项目设定等）
3. 每条记忆必须简洁明确，一条只包含一个信息点
4. 区分信息类别：
   - preference: 用户偏好（喜欢/不喜欢什么、习惯、风格偏好）
   - fact: 事实信息（姓名、职业、公司、技术栈、使用的工具、用户要求记住的设定）
   - decision: 重要决策（选择了方案A、决定使用某技术）
   - context: 上下文信息（当前项目背景、工作目标、团队情况、角色设定）
   - skill: 技能水平（对某技术熟悉/不熟悉）
5. 评估重要性（1-5）：
   - 1: 临时性信息（当前心情、临时问题）
   - 2: 次要信息（偶尔提到的细节）
   - 3: 一般信息（用户背景、常用工具）
   - 4: 重要信息（核心偏好、关键决策）
   - 5: 核心信息（身份、职业、主要技术栈、用户明确要求记住的信息）
6. 忽略寒暄、通用问题和一次性查询
7. 如果对话中没有可提取的信息，返回空数组

输出格式（严格 JSON）：
[
  {"content": "用户是前端开发者", "category": "fact", "importance": 5},
  {"content": "用户偏好使用 TypeScript 而非 JavaScript", "category": "preference", "importance": 4},
  {"content": "用户要求记住：v原名张三，25岁雇佣兵，现居夜之城，喜欢蓝色", "category": "fact", "importance": 5}
]

只输出 JSON 数组，不要输出其他内容。如果没有可提取的信息，输出 []`;

/** 记忆去重/合并的系统提示词 */
const MEMORY_MERGE_PROMPT = `你是一个信息去重专家。你的任务是比较新提取的记忆和已有记忆，判断它们之间的关系。

关系类型：
- duplicate: 新记忆与已有记忆表达相同的信息 → 保留已有记忆，跳过新记忆
- update: 新记忆是已有记忆的更新或更精确版本 → 用新记忆替换已有记忆
- new: 新记忆是全新的信息 → 添加新记忆

输出格式（严格 JSON）：
[
  {"newMemory": "用户是全栈开发者", "action": "update", "existingMemoryIndex": 0, "reason": "更精确的描述"},
  {"newMemory": "用户喜欢暗色主题", "action": "new", "reason": "全新偏好信息"},
  {"newMemory": "用户是开发者", "action": "duplicate", "existingMemoryIndex": 0, "reason": "与已有记忆重复"}
]

只输出 JSON 数组，不要输出其他内容。`;

// ==================== 类型定义 ====================

export interface ExtractedMemory {
  content: string;
  category: string;
  importance: number;
}

interface MergeAction {
  newMemory: string;
  action: 'duplicate' | 'update' | 'new';
  existingMemoryIndex: number;
  reason: string;
}

// ==================== 核心函数 ====================

/**
 * 判断是否需要提取记忆
 * @param lastExtractionCount 上次提取时的消息总数
 * @param currentMessageCount 当前消息总数
 * @returns 是否需要提取
 */
export function shouldExtractMemory(
  lastExtractionCount: number,
  currentMessageCount: number,
): boolean {
  if (currentMessageCount < MEMORY_EXTRACTION_INTERVAL) {
    return false;
  }
  return currentMessageCount - lastExtractionCount >= MEMORY_EXTRACTION_INTERVAL;
}

/**
 * 从对话中提取用户记忆
 *
 * @param messages 对话消息列表
 * @returns 提取出的记忆条目数组
 */
export async function extractMemories(
  messages: Array<{ role: string; content: string }>,
): Promise<ExtractedMemory[]> {
  const llm = createExtractorLLM();
  if (!llm) {
    return [];
  }

  try {
    const conversationText = messages
      .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`)
      .join('\n');

    logger.info('开始提取用户记忆', { module: 'MemoryExtractor', messageCount: messages.length });

    const result = await llm.invoke([
      new SystemMessage(MEMORY_EXTRACTION_PROMPT),
      new HumanMessage(`请从以下对话中提取关于用户的关键信息：\n${conversationText}`),
    ]);

    const content = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

    // 解析 JSON 结果
    const memories = parseJsonResponse<ExtractedMemory[]>(content, []);

    logger.info('提取到用户记忆', { module: 'MemoryExtractor', memoryCount: memories.length });
    return memories;
  } catch (error: any) {
    logger.error('记忆提取失败', { module: 'MemoryExtractor', error: error.message });
    return [];
  }
}

/**
 * 将新提取的记忆与已有记忆去重/合并
 *
 * @param newMemories 新提取的记忆
 * @param existingMemories 已有的记忆（content 字段数组）
 * @returns 合并后的操作列表
 */
export async function mergeMemories(
  newMemories: ExtractedMemory[],
  existingMemories: string[],
): Promise<MergeAction[]> {
  if (newMemories.length === 0) {
    return [];
  }

  if (existingMemories.length === 0) {
    // 没有已有记忆，全部作为新记忆
    return newMemories.map((m) => ({
      newMemory: m.content,
      action: 'new' as const,
      existingMemoryIndex: -1,
      reason: '无已有记忆',
    }));
  }

  const llm = createExtractorLLM();

  if (!llm) {
    // 无可用 LLM 时，简单去重：跳过与已有记忆完全相同的
    return newMemories
      .filter((m) => !existingMemories.some((e) => e === m.content))
      .map((m) => ({
        newMemory: m.content,
        action: 'new' as const,
        existingMemoryIndex: -1,
        reason: '简单去重',
      }));
  }

  try {
    const existingList = existingMemories
      .map((m, i) => `[${i}] ${m}`)
      .join('\n');

    const newList = newMemories
      .map((m) => m.content)
      .join('\n');

    const result = await llm.invoke([
      new SystemMessage(MEMORY_MERGE_PROMPT),
      new HumanMessage(`已有记忆：\n${existingList}\n\n新提取的记忆：\n${newList}`),
    ]);

    const content = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

    return parseJsonResponse<MergeAction[]>(content, []);
  } catch (error: any) {
    logger.error('记忆合并失败，降级为简单去重', { module: 'MemoryExtractor', error: error.message });
    return newMemories
      .filter((m) => !existingMemories.some((e) => e === m.content))
      .map((m) => ({
        newMemory: m.content,
        action: 'new' as const,
        existingMemoryIndex: -1,
        reason: '降级简单去重',
      }));
  }
}

// ==================== 工具函数 ====================

/**
 * 安全解析 LLM 返回的 JSON
 * 处理可能的 markdown 代码块包裹
 */
function parseJsonResponse<T>(text: string, fallback: T): T {
  try {
    // 去除可能的 markdown 代码块包裹
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    return JSON.parse(cleaned);
  } catch {
    logger.warn('JSON 解析失败', { module: 'MemoryExtractor', rawContent: text.substring(0, 200) });
    return fallback;
  }
}

// 导出常量
export { MEMORY_EXTRACTION_INTERVAL };
