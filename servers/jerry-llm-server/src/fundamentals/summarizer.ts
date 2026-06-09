/**
 * 对话摘要服务
 *
 * 核心功能：将长对话压缩为摘要，解决上下文窗口有限的问题
 *
 * 设计决策：
 * - 使用 DeepSeek-Flash（线上模型）生成摘要，而非本地模型
 *   原因：摘要质量直接影响后续所有对话，本地小模型容易遗漏关键信息
 * - 支持增量更新：将旧摘要 + 新消息合并生成新摘要，避免每次重新处理全部历史
 * - 异步执行：摘要生成不阻塞用户操作，后台静默完成
 *
 * 触发策略：
 * - 首次生成：消息数 > SUMMARY_THRESHOLD（30条）
 * - 增量更新：每新增 INCREMENTAL_THRESHOLD（20条）消息后更新
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getDeepseekApiKey } from './model-provider';
import { logger } from './logger';
import { config } from './config';

// ==================== 配置常量 ====================

/** 首次生成摘要的消息数阈值 */
const SUMMARY_THRESHOLD = 10;

/** 增量更新的消息数间隔 */
const INCREMENTAL_THRESHOLD = 10;

/** DeepSeek API 基础 URL */
const DEEPSEEK_BASE_URL = config.deepseekBaseUrl;

/** 摘要生成的系统提示词 */
const SUMMARIZER_SYSTEM_PROMPT = `你是一个对话摘要专家。你的任务是将对话历史压缩为简洁但完整的摘要。

摘要规则：
1. 保留所有关键信息：用户的需求、问题、偏好、重要决策
2. 保留具体的技术细节：代码片段、配置参数、文件路径
3. 保留对话的结论和最终结果
4. 忽略寒暄、重复、无关紧要的细节
5. 按主题组织摘要，使用清晰的标题和要点
6. 如果有旧摘要，将旧摘要与新消息合并，不要丢失旧摘要中的任何信息
7. 摘要长度控制在 300-500 字

输出格式：
## 主要话题
- [话题1]: [关键信息]
- [话题2]: [关键信息]

## 用户需求
- [需求1]
- [需求2]

## 关键决策与结论
- [决策1]
- [结论1]

## 重要细节
- [技术细节/配置/代码等]`;

// ==================== 核心函数 ====================

/**
 * 判断是否需要生成或更新摘要
 * @param currentCoveredCount 当前摘要已覆盖的消息数（0 表示还没有摘要）
 * @param totalMessageCount 会话总消息数
 * @returns 是否需要生成/更新摘要
 */
export function shouldGenerateSummary(
  currentCoveredCount: number,
  totalMessageCount: number,
): boolean {
  // 还没有摘要，且消息数达到首次阈值
  if (currentCoveredCount === 0 && totalMessageCount >= SUMMARY_THRESHOLD) {
    return true;
  }

  // 已有摘要，且新增消息数达到增量更新阈值
  if (
    currentCoveredCount > 0 &&
    totalMessageCount - currentCoveredCount >= INCREMENTAL_THRESHOLD
  ) {
    return true;
  }

  return false;
}

/**
 * 生成对话摘要
 *
 * @param messages 对话消息列表（按时间正序）
 * @param existingSummary 已有的旧摘要（增量更新时传入，首次生成传空字符串）
 * @returns 生成的摘要文本
 *
 * 两种模式：
 * 1. 首次生成：直接对全部消息生成摘要
 * 2. 增量更新：将旧摘要 + 新增消息合并生成新摘要
 */
export async function generateSummary(
  messages: Array<{ role: string; content: string }>,
  existingSummary: string = '',
): Promise<string> {
  const apiKey = getDeepseekApiKey();

  if (!apiKey || apiKey.trim() === '') {
    logger.warn('未配置 DeepSeek API Key，使用本地摘要（质量较低）', { module: 'Summarizer' });
    return generateLocalSummary(messages, existingSummary);
  }

  try {
    const llm = new ChatOpenAI({
      model: 'deepseek-chat',
      temperature: 0.3,
      apiKey,
      configuration: {
        baseURL: DEEPSEEK_BASE_URL,
      },
    });

    // 构建用户消息
    let userContent: string;

    if (existingSummary) {
      // 增量更新模式：旧摘要 + 新增消息
      const newMessages = messages
        .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`)
        .join('\n');

      userContent = `以下是之前的对话摘要：\n${existingSummary}\n\n以下是新增的对话内容：\n${newMessages}\n\n请将旧摘要与新对话合并，生成更新后的完整摘要。`;
    } else {
      // 首次生成模式：全部消息
      const conversationText = messages
        .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`)
        .join('\n');

      userContent = `请为以下对话生成摘要：\n${conversationText}`;
    }

    logger.info('摘要生成', { module: 'Summarizer', type: existingSummary ? '增量更新' : '首次生成', messageCount: messages.length });

    const result = await llm.invoke([
      new SystemMessage(SUMMARIZER_SYSTEM_PROMPT),
      new HumanMessage(userContent),
    ]);

    const summary = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

    logger.info('摘要生成完成', { module: 'Summarizer', summaryLength: summary.length });

    return summary;
  } catch (error: any) {
    logger.error('DeepSeek 摘要生成失败，降级为本地摘要', { module: 'Summarizer', error: error.message });
    return generateLocalSummary(messages, existingSummary);
  }
}

/**
 * 本地摘要生成（降级方案）
 * 当 DeepSeek API 不可用时，使用简单的截断拼接作为摘要
 * 质量较低，但至少保留了部分信息
 */
function generateLocalSummary(
  messages: Array<{ role: string; content: string }>,
  existingSummary: string = '',
): string {
  const MAX_LOCAL_SUMMARY_LENGTH = 500;

  const conversationText = messages
    .slice(-20) // 只取最近20条
    .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content.substring(0, 100)}`)
    .join('\n');

  let summary = '';
  if (existingSummary) {
    summary = `${existingSummary}\n\n[续] ${conversationText}`;
  } else {
    summary = `[对话摘要-本地生成]\n${conversationText}`;
  }

  // 截断到最大长度
  if (summary.length > MAX_LOCAL_SUMMARY_LENGTH) {
    summary = summary.substring(0, MAX_LOCAL_SUMMARY_LENGTH) + '...';
  }

  return summary;
}

// 导出常量供外部使用
export { SUMMARY_THRESHOLD, INCREMENTAL_THRESHOLD };
