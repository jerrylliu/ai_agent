import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

import { retrieveFromKnowledgeBase } from './rag-service';
import { getKnowledgeBaseStats } from './vector-store';
import { createLLM, getCurrentModelId, getModelInfo } from './model-provider';
import { getAllToolSchemas, executeTool, hasTool, getAvailableToolNames } from './tools';
import { logger } from './logger';

// 系统提示词 - 定义模型的角色和任务
// ### 注意事项
// 1. **代码必须可直接运行**：复制粘贴到浏览器即可运行
// 2. **包含完整样式**：不要让用户补充任何 CSS
// 3. **颜色值精确**：使用从设计图中分析出的准确 hex 值
// 4. **布局还原度高**：尽可能还原设计稿的视觉效果`;
const SYSTEM_PROMPT = `你是一个全能助手`;

const FC_SYSTEM_PROMPT = `你是一个全能助手，你可以使用工具来帮助回答用户问题。

当前可用工具：
- search_knowledge_base：搜索知识库中与查询相关的文档内容
- search_web：联网搜索实时信息

工具使用规则：
1. 当用户的问题可能涉及已上传的文档、知识库中的信息时，优先调用 search_knowledge_base 工具
2. 当用户的问题涉及最新新闻、实时数据、当前事件或知识库中没有的实时信息时，调用 search_web 工具
3. 如果不确定知识库中是否有相关信息，可以同时调用 search_knowledge_base 和 search_web 两个工具
4. 当你能够直接回答问题（如通用知识、闲聊、数学计算等）时，不需要调用任何工具
5. 调用工具时，构造精确的搜索查询语句，以提高搜索结果的相关性
6. 基于工具返回的结果回答用户问题，在回答中标注信息来源
7. 如果工具返回的结果与用户问题无关，请说明并基于自身知识回答

搜索引擎选择规则（仅在使用 search_web 时）：
- 默认使用 search_std（速度快、成本低），除非用户明确要求深度搜索
- 需要深度全面的结果：使用 search_pro
- 中文内容优先：使用 search_pro_sogou
- 国内内容覆盖：使用 search_pro_quark

时间过滤规则（仅在使用 search_web 时）：
- 用户问"今天"的新闻/信息：设置 recency_filter 为 oneDay
- 用户问"最近"的新闻/信息：设置 recency_filter 为 oneWeek
- 用户问"本月"的新闻/信息：设置 recency_filter 为 oneMonth
- 其他无时效性要求的搜索：不设置 recency_filter（默认 noLimit）`;
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
  if (imageUrl.startsWith('http://localhost:3000/files/') ||
      imageUrl.startsWith('https://localhost:3000/files/')) {
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

    // 检查是否是本地服务器的图片（http://localhost:3000/files/）
    if (imageUrl.startsWith('http://localhost:3000/files/') ||
        imageUrl.startsWith('https://localhost:3000/files/')) {
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
) {
  const modelInfo = getModelInfo();
  const supportsVision = modelInfo.supportsVision;

  let fcSystemPrompt = FC_SYSTEM_PROMPT;

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

  const MAX_HISTORY = (effectiveImages && effectiveImages.length > 0) ? 0 : 10;
  const recentHistory = history && MAX_HISTORY > 0 ? history.slice(-MAX_HISTORY) : [];

  if (recentHistory.length > 0) {
    logger.info('FC模式：添加历史消息', { module: 'PromptService', historyCount: recentHistory.length });
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

  const llm = createLLM();
  const toolSchemas = getAllToolSchemas();
  if (!llm.bindTools) {
    throw new Error('当前模型不支持 bindTools');
  }
  const llmWithTools = llm.bindTools(toolSchemas);

  const MAX_TOOL_ITERATIONS = 5;
  let toolCallsMade: Array<{ name: string; args: any }> = [];
  let usedKnowledgeBase = false;
  let usedWebSearch = false;

  logger.info('FC模式：开始工具调用循环', { module: 'PromptService', modelId: getCurrentModelId() });

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (isCancelled && isCancelled()) {
      logger.info('FC模式：检测到取消信号', { module: 'PromptService' });
      if (res && !res.writableEnded) res.end();
      return;
    }

    logger.info('FC模式：调用模型', { module: 'PromptService', iteration: iteration + 1, messageCount: messages.length });

    let response: any;
    try {
      response = await llmWithTools.invoke(messages, {
        signal: abortController?.signal,
      });
    } catch (invokeError: any) {
      if (invokeError.name === 'AbortError' || invokeError.code === 'ABORT_ERR') {
        logger.info('FC模式：LLM调用被中断', { module: 'PromptService' });
        if (res && !res.writableEnded) res.end();
        return;
      }
      logger.error('FC模式：LLM调用失败，降级到RAG注入模式', { module: 'PromptService', error: invokeError.message });
      throw invokeError;
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

      for (const toolCall of aiMessage.tool_calls!) {
        const toolCallId = toolCall.id || `tc_${Date.now()}_${iteration}`;
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
          messages.push(new ToolMessage({
            content: JSON.stringify({
              error: true,
              message: `工具 "${toolCall.name}" 不存在。可用工具: ${availableTools}。请仅使用上述可用工具。`,
            }),
            tool_call_id: toolCallId,
            name: toolCall.name,
          }));
          toolCallsMade.push({ name: toolCall.name, args: toolCall.args });
          continue;
        }

        if (toolCall.name === 'search_knowledge_base') {
          usedKnowledgeBase = true;
        }
        if (toolCall.name === 'search_web') {
          usedWebSearch = true;
        }
        toolCallsMade.push({ name: toolCall.name, args: toolCall.args });

        try {
          const result = await executeTool(toolCall.name, toolCall.args);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          logger.info('FC模式：工具执行成功，构造 ToolMessage', {
            module: 'PromptService',
            toolName: toolCall.name,
            toolCallId,
            resultLength: resultStr.length,
            resultPreview: resultStr.substring(0, 300),
          });
          messages.push(new ToolMessage({
            content: resultStr,
            tool_call_id: toolCallId,
            name: toolCall.name,
          }));
        } catch (toolError: any) {
          logger.error('FC模式：工具执行失败，构造错误 ToolMessage', {
            module: 'PromptService',
            toolName: toolCall.name,
            toolCallId,
            error: toolError.message,
          });
          messages.push(new ToolMessage({
            content: JSON.stringify({ error: true, message: `工具执行失败: ${toolError.message}` }),
            tool_call_id: toolCallId,
            name: toolCall.name,
          }));
        }
      }

      logger.info('FC模式：本轮工具调用完成，继续下一轮模型调用', {
        module: 'PromptService',
        iteration: iteration + 1,
        totalToolCallsSoFar: toolCallsMade.length,
        messagesLength: messages.length,
      });
    } else {
      logger.info('FC模式：获得最终回答，切换流式输出', { module: 'PromptService', toolCallCount: toolCallsMade.length });

      if (res) {
        const ragMetadata = {
          usedKnowledgeBase,
          usedWebSearch,
          contextCount: toolCallsMade.filter(tc => tc.name === 'search_knowledge_base').length,
          webSearchCount: toolCallsMade.filter(tc => tc.name === 'search_web').length,
          toolCalls: toolCallsMade.map(tc => tc.name),
        };
        const metadataPrefix = `[RAG_METADATA:${JSON.stringify(ragMetadata)}]`;

        try {
          const stream = await llmWithTools.stream(messages, {
            signal: abortController?.signal,
          });
          let isFirstChunk = true;
          let chunkCount = 0;
          for await (const chunk of stream) {
            if (isCancelled && isCancelled()) {
              logger.info('FC模式流式：检测到取消信号，停止生成', { module: 'PromptService' });
              break;
            }
            chunkCount++;
            const content = chunk.content?.toString() || '';
            const cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gs, "");
            if (cleanContent) {
              if (isFirstChunk) {
                res.write(metadataPrefix + cleanContent);
                isFirstChunk = false;
              } else {
                res.write(cleanContent);
              }
              process.stdout.write(cleanContent);
            }
          }
          logger.info('FC模式流式响应完成', { module: 'PromptService', chunkCount });
          res.end();
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
              res.write(metadataPrefix + fallbackContent);
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

  logger.warn('FC模式：达到最大工具调用次数', { module: 'PromptService', maxIterations: MAX_TOOL_ITERATIONS });
  if (res && !res.writableEnded) {
    res.write('[RAG_METADATA:{"usedKnowledgeBase":false,"usedWebSearch":false,"contextCount":0,"webSearchCount":0,"toolCalls":[]}]');
    res.write('抱歉，工具调用次数已达上限，请简化您的问题后重试。');
    res.end();
  } else if (!res) {
    return new AIMessage('抱歉，工具调用次数已达上限，请简化您的问题后重试。');
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
) => {
  const modelInfo = getModelInfo();

  if (modelInfo.supportsFunctionCalling) {
    logger.info('当前模型支持Function Calling，使用FC模式', { module: 'PromptService', modelId: getCurrentModelId() });
    try {
      return await promptWithFunctionCalling(
        promptText, images, history, res, sessionSummary, userMemories, isCancelled, abortController,
      );
    } catch (fcError: any) {
      logger.warn('FC模式失败，降级到RAG注入模式', { module: 'PromptService', error: fcError.message });
    }
  } else {
    logger.info('当前模型不支持Function Calling，使用RAG注入模式', { module: 'PromptService', modelId: getCurrentModelId() });
  }

  const conversions: Array<SystemMessage | HumanMessage | AIMessage> = [];

  // ==================== 步骤1: 从知识库检索相关文档 ====================
  let retrievedContext = '';
  let hasRetrievedContent = false;
  let ragContextCount = 0;
  let retrievalResults: Array<{ content: string; metadata: any; score: number; vectorScore?: number }> = [];
  
  if (promptText && promptText.trim()) {
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

  const MAX_HISTORY = hasRetrievedContent ? 0 : ((images && images.length > 0) ? 0 : 10);
  const recentHistory = history && MAX_HISTORY > 0 ? history.slice(-MAX_HISTORY) : [];

  if (recentHistory.length > 0) {
    logger.info('添加历史消息', { module: 'PromptService', historyCount: recentHistory.length, maxHistory: MAX_HISTORY });
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

    const ragMetadata = {
      usedKnowledgeBase: hasRetrievedContent,
      contextCount: hasRetrievedContent ? ragContextCount : 0,
    };
    logger.debug('发送 RAG 元数据', { module: 'PromptService', usedKnowledgeBase: hasRetrievedContent, contextCount: ragMetadata.contextCount });
    const metadataPrefix = `[RAG_METADATA:${JSON.stringify(ragMetadata)}]`;
    
    try {
      // 将 AbortController 的 signal 传递给 LLM 的 stream 方法
      // 当客户端断开连接时，调用 abortController.abort() 会：
      // 1. 中断 LLM 底层到 Ollama/DeepSeek 的 HTTP 连接
      // 2. Ollama 服务端检测到连接断开后自动停止推理，释放 GPU 资源
      // 3. for await 循环会抛出 AbortError，被下方的 catch 捕获
      const stream = await llm.stream(conversions, {
        signal: abortController?.signal, // 绑定 abort 信号，中断时自动销毁底层 HTTP 请求
      });
      let chunkCount = 0;
      let isFirstChunk = true;
      for await (const chunk of stream) {
        // 检查客户端是否已断开连接（双重保险：即使 abort 信号未生效，也能通过标志位退出循环）
        if (isCancelled && isCancelled()) {
          logger.info('检测到取消信号，停止生成', { module: 'PromptService' });
          break;
        }
        chunkCount++;
        const content = chunk.content?.toString() || '';
        const cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gs, "");
        if (cleanContent) {
          if (isFirstChunk) {
            res.write(metadataPrefix + cleanContent);
            isFirstChunk = false;
          } else {
            res.write(cleanContent);
          }
          process.stdout.write(cleanContent);
        }
      }
      logger.info('流式响应完成', { module: 'PromptService', chunkCount });
      res.end();
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
    const llm = createLLM();
    const result = await llm.invoke(conversions);
    // 去除 <think> 标签
    if (typeof result.content === 'string') {
      result.content = result.content.replace(/<think>[\s\S]*?<\/think>/gs, "");
    }
    logger.debug('非流式调用完成', { module: 'PromptService' });
    return result;
  }
}
