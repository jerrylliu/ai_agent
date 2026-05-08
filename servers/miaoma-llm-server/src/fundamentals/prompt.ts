// 导入 ChatOllama 类，用于与 Ollama 本地大语言模型进行交互
import { ChatOllama } from "@langchain/ollama";
// 导入消息类型类，用于构建不同类型的对话消息
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import type { Response } from 'express';
// 导入 Node.js 模块，用于处理文件路径和 HTTP 请求
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

// 导入 RAG 服务
import { retrieveFromKnowledgeBase } from './rag-service';

// 创建 ChatOllama 实例，配置使用的本地模型为 minicpm1

const llm = new ChatOllama({
  model: "minicpm",
  temperature: 0.7,           // 温度参数
  numCtx: 1024,              // 上下文长度（减小以避免内存溢出）
  repeatPenalty: 1.1,        // 重复惩罚
  topK: 20,                  // 采样候选数（减小）
  topP: 0.9,                 // 核采样
  numGpu: 0,                 // 禁用 GPU（如果适用）
});

// 系统提示词 - 定义模型的角色和任务
// ### 注意事项
// 1. **代码必须可直接运行**：复制粘贴到浏览器即可运行
// 2. **包含完整样式**：不要让用户补充任何 CSS
// 3. **颜色值精确**：使用从设计图中分析出的准确 hex 值
// 4. **布局还原度高**：尽可能还原设计稿的视觉效果`;
const SYSTEM_PROMPT = `你是一个全能助手`;
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
    console.log('📷 检测到本地图片，开始下载:', imageUrl);
    try {
      const base64DataUrl = await downloadImageAsBase64(imageUrl);
      console.log('✅ 本地图片转换成功');
      return base64DataUrl;
    } catch (error) {
      console.error('❌ 本地图片下载失败，使用原始 URL:', error);
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
  console.log('========== 开始转换多模态内容 ==========');
  console.log('原始文本:', text);

  // 正则表达式匹配 Markdown 图片语法：![alt](url)
  const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

  // 如果没有匹配到图片，返回纯文本格式
  if (!markdownImageRegex.test(text)) {
    console.log('⚠️ 未检测到 Markdown 图片语法，返回纯文本');
    return [{ type: "text", text }];
  }

  // 重置正则表达式的 lastIndex
  markdownImageRegex.lastIndex = 0;

  console.log('✅ 检测到 Markdown 图片语法');

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
    console.log('📷 检测到图片 URL:', imageUrl);

    // 检查是否是本地服务器的图片（http://localhost:3000/files/）
    if (imageUrl.startsWith('http://localhost:3000/files/') ||
        imageUrl.startsWith('https://localhost:3000/files/')) {
      try {
        // 下载图片并转换为 base64 格式
        console.log('📥 开始下载图片并转换为 base64...');
        const base64DataUrl = await downloadImageAsBase64(imageUrl);
        console.log('✅ 图片下载并转换成功，base64 长度:', base64DataUrl.length);
        contentBlocks.push({
          type: "image_url",
          image_url: base64DataUrl  // 使用 base64 数据 URL
        });
      } catch (error) {
        // 如果下载失败，记录错误但仍然添加原始 URL
        console.error('❌ 下载图片失败:', error);
        contentBlocks.push({
          type: "image_url",
          image_url: imageUrl  // 降级使用原始 URL
        });
      }
    } else {
      // 对于外部 URL，直接使用原始 URL
      console.log('🌐 使用外部图片 URL（未转换）');
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

  console.log('========== 多模态内容转换完成 ==========');
  console.log('内容块数量:', contentBlocks.length);
  // console.log('内容块详情:', JSON.stringify(contentBlocks, null, 2));

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

export const promptTemplate = async (
  promptText?: string,
  images?: string[],
  history?: Array<{ role: string, content: string, images?: string[] }>,
  res?: Response
) => {
  const conversions: Array<SystemMessage | HumanMessage | AIMessage> = [];

  // ==================== 步骤1: 从知识库检索相关文档 ====================
  let retrievedContext = '';
  let hasRetrievedContent = false;
  let ragContextCount = 0;
  let retrievalResults: Array<{ content: string; metadata: any; score: number }> = [];
  
  // 有图片时不检索知识库，避免上下文超限（图片已经包含大量信息）
  if (promptText && promptText.trim() && (!images || images.length === 0)) {
    try {
      console.log('🔍 正在从知识库检索相关文档...');
      // 检索最多 3 个最相关的文档
      const retrieval = await retrieveFromKnowledgeBase(promptText.trim(), 3);
      
      if (retrieval.results && retrieval.results.length > 0) {
        hasRetrievedContent = true;
        ragContextCount = retrieval.results.length;
        retrievedContext = retrieval.context;
        retrievalResults = retrieval.results;
        console.log(`✅ 知识库检索完成，找到 ${retrieval.results.length} 个相关文档`);
      } else {
        console.log('ℹ️ 知识库中没有找到相关内容');
      }
    } catch (error) {
      console.warn('⚠️ 知识库检索失败（可能未启动）:', error.message);
    }
  }

  // ==================== 步骤2: 构建系统提示词 ====================
  let systemPrompt = SYSTEM_PROMPT;

  if (hasRetrievedContent) {
    const docList = retrievalResults
      .map((r, i) => `【文档 ${i + 1}】\n${r.content}`)
      .join('\n\n');

    systemPrompt = `你是一个问答助手。请仔细阅读以下参考资料，然后回答用户问题。

=== 参考资料 ===
${docList}
=== 参考资料结束 ===

回答要求：
1. 只使用参考资料中的信息回答，不要编造内容
2. 回答时在括号内标注参考来源，格式为：（【文档 X】）
3. 如果参考资料中没有任何相关信息，请回复"抱歉，知识库中没有找到相关内容"

【用户问题】：${promptText}
【回答】：`;
  }

  conversions.push(new SystemMessage(systemPrompt));

  // 有知识库检索结果时不用 history，避免历史 hallucinated 内容干扰
  // 无检索结果时最多用 1 条 history
  const MAX_HISTORY = hasRetrievedContent ? 0 : ((images && images.length > 0) ? 0 : 1);
  const recentHistory = history && MAX_HISTORY > 0 ? history.slice(-MAX_HISTORY) : [];

  if (recentHistory.length > 0) {
    console.log(`📜 添加最近 ${recentHistory.length} 条历史消息（总共限制 ${MAX_HISTORY} 条）`);
    for (const msg of recentHistory) {
      if (msg.role === 'user') {
        let content: any;
        if (msg.images && msg.images.length > 0) {
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

  // ==================== 步骤3: 构建用户消息 ====================
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

  console.log('📋 完整的对话消息列表:');
  console.log('消息数量:', conversions.length);
  conversions.forEach((msg, index) => {
    if (msg instanceof SystemMessage) {
      console.log(`  [${index}] SystemMessage:`, (msg.content as string).substring(0, 100) + '...');
    } else if (msg instanceof HumanMessage) {
      const content = msg.content;
      if (Array.isArray(content)) {
        console.log(`  [${index}] HumanMessage (多模态):`, content.length, '个内容块');
        content.forEach((block: any, i: number) => {
          if (block.type === 'text') {
            console.log(`    块[${i}]: 文本 - "${block.text?.substring(0, 50)}..."`);
          } else if (block.type === 'image_url') {
            console.log(`    块[${i}]: 图片 - ${block.image_url?.url?.substring(0, 50)}...`);
          }
        });
      } else {
        console.log(`  [${index}] HumanMessage:`, content);
      }
    } else if (msg instanceof AIMessage) {
      console.log(`  [${index}] AIMessage:`, (msg.content as string).substring(0, 200) + '...');
    }
  });

  if (res) {
    // 流式调用
    console.log('🚀 开始流式调用模型...');
    
    // RAG 元数据
    const ragMetadata = {
      usedKnowledgeBase: hasRetrievedContent,
      contextCount: hasRetrievedContent ? ragContextCount : 0,
    };
    console.log(`📤 发送 RAG 元数据: usedKnowledgeBase=${hasRetrievedContent}, contextCount=${ragMetadata.contextCount}`);
    const metadataPrefix = `[RAG_METADATA:${JSON.stringify(ragMetadata)}]`;
    
    try {
      const stream = await llm.stream(conversions);
      let chunkCount = 0;
      let isFirstChunk = true;
      for await (const chunk of stream) {
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
      console.log(`\n✅ 流式响应完成，共 ${chunkCount} 个 chunk`);
      res.end();
    } catch (streamError: any) {
      console.error('❌ 流式调用失败:', streamError.message);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: '模型调用失败', 
          message: streamError.message 
        });
      } else {
        res.end();
      }
    }
  } else {
    // 非流式调用（保持兼容性）
    const result = await llm.invoke(conversions);
    // 去除 <think> 标签
    if (typeof result.content === 'string') {
      result.content = result.content.replace(/<think>[\s\S]*?<\/think>/gs, "");
    }
    console.log(result);
    return result;
  }
}
