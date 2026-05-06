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
  numCtx: 2048,               // 上下文长度
  repeatPenalty: 1.1,         // 重复惩罚
  topK: 40,                   // 采样候选数
  topP: 0.9,                  // 核采样
});

// 系统提示词 - 定义模型的角色和任务
// const SYSTEM_PROMPT = `你是一个专业的UI/UX设计师和前端开发专家，擅长将设计稿转换为高质量的前端代码。

// ## 核心能力
// 1. 精确分析设计稿：布局结构、组件构成、颜色值、字体大小、间距、视觉层次
// 2. 生成生产级代码：可运行、可维护、符合最佳实践的前端页面

// ## 分析要求
// 分析设计图时，请提供：
// - **布局结构**：页面整体布局、各区域尺寸和位置
// - **组件拆分**：可复用的组件列表及其属性
// - **颜色体系**：所有颜色对应的 hex 值（如 #2D2B3C）
// - **文字规范**：字号、字重、颜色、行高
// - **间距系统**：padding、margin、gap 的具体数值
// - **交互细节**：hover、active、focus 等状态

// ## 代码生成规范（默认生成纯 HTML/CSS）

// ### 语言选择规则（重要）
// 1. **若用户明确指定了语言/框架，则按用户要求生成**
//    - 例如：用户说"用 React" → 生成 React + TypeScript 代码
//    - 例如：用户说"用 Vue" → 生成 Vue 代码
//    - 例如：用户说"小程序" → 生成微信小程序代码

// 2. **若用户未指定语言/框架，则默认生成原生 HTML/CSS（推荐）**
//    - 原因：HTML/CSS 是最通用、最易运行的方案
//    - 包含：HTML 结构 + CSS 样式（内联或 <style> 标签）

// 3. **禁止使用任何前端框架或库**（除非用户明确指定）
//    - 禁止：React、Vue、Angular、Svelte 等
//    - 禁止：Tailwind CSS（除非用户指定）
//    - 禁止：Bootstrap、Element UI 等 UI 库

// ### 默认语言规范（原生 HTML/CSS）

// #### HTML 规范
// 1. **语义化标签**：使用 header、nav、main、section、article、footer 等语义化标签
// 2. **结构清晰**：合理嵌套，缩进规范
// 3. **可访问性**：添加适当的 aria-label、alt 等属性

// #### CSS 规范
// 1. **使用 <style> 标签**：将 CSS 放在 HTML 文件的 <head> 中
// 2. **使用 Flexbox 布局**：主流布局方案，简洁高效
// 3. **使用 CSS 变量**：统一管理颜色和间距
// 4. **命名规范**：使用 kebab-case（如 header-nav、main-content）
// 5. **响应式设计**：添加媒体查询支持不同屏幕尺寸

// ### 输出格式（默认使用 HTML/CSS）

// 当用户要求生成代码时，请按以下格式输出：

// \`\`\`html
// <!DOCTYPE html>
// <html lang="zh-CN">
// <head>
//   <meta charset="UTF-8">
//   <meta name="viewport" content="width=device-width, initial-scale=1.0">
//   <title>页面标题</title>
//   <style>
//     /* CSS 变量定义 */
//     :root {
//       --primary-color: #233E5A;
//       --secondary-color: #00FF9B;
//       --text-color: #333333;
//       --bg-color: #ffffff;
//     }

//     /* 重置样式 */
//     * {
//       margin: 0;
//       padding: 0;
//       box-sizing: border-box;
//     }

//     body {
//       font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
//       color: var(--text-color);
//       background-color: var(--bg-color);
//     }

//     /* 布局容器 */
//     .container {
//       max-width: 1200px;
//       margin: 0 auto;
//       padding: 0 20px;
//     }

//     /* 组件样式 */
//     .header {
//       width: 100%;
//       height: 64px;
//       background-color: var(--primary-color);
//       display: flex;
//       align-items: center;
//       justify-content: space-between;
//       padding: 0 24px;
//     }

//     .header-logo {
//       font-size: 20px;
//       font-weight: bold;
//       color: white;
//     }

//     /* 响应式设计 */
//     @media (max-width: 768px) {
//       .header {
//         padding: 0 16px;
//       }
//     }
//   </style>
// </head>
// <body>
//   <!-- 页面内容 -->
//   <header class="header">
//     <div class="container">
//       <div class="header-logo">Logo</div>
//       <nav class="header-nav">
//         <a href="#">首页</a>
//         <a href="#">关于我们</a>
//         <a href="#">联系</a>
//       </nav>
//     </div>
//   </header>

//   <main>
//     <section class="hero">
//       <div class="container">
//         <h1>欢迎来到我们的网站</h1>
//         <p>这里是网站描述文字</p>
//       </div>
//     </section>
//   </main>

//   <footer class="footer">
//     <div class="container">
//       <p>&copy; 2024 公司名称. All rights reserved.</p>
//     </div>
//   </footer>
// </body>
// </html>
// \`\`\`

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
  
  if (promptText && promptText.trim()) {
    try {
      console.log('🔍 正在从知识库检索相关文档...');
      const retrieval = await retrieveFromKnowledgeBase(promptText.trim(), 3);
      
      if (retrieval.results && retrieval.results.length > 0) {
        hasRetrievedContent = true;
        ragContextCount = retrieval.results.length;
        retrievedContext = retrieval.context;
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
    // 如果有检索到的内容，添加 RAG 指令
    systemPrompt = `你是一个智能助手，擅长根据提供的参考文档回答问题。

【核心指令】：
1. 首先参考提供的知识库内容进行回答
2. 如果知识库内容足够回答问题，优先使用知识库信息
3. 如果知识库内容不足或不相关，可以结合你的内部知识补充
4. 如果完全无法回答，请明确说明

【参考文档】：
${retrievedContext}

---

${SYSTEM_PROMPT}`;
  }

  conversions.push(new SystemMessage(systemPrompt));

  const MAX_HISTORY = 2;
  const recentHistory = history ? history.slice(-MAX_HISTORY) : [];

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
      console.log(`  [${index}] AIMessage:`, (msg.content as string).substring(0, 100) + '...');
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
    const metadataPrefix = `[RAG_METADATA:${JSON.stringify(ragMetadata)}]`;
    
    const stream = await llm.stream(conversions);
    let chunkCount = 0;
    let isFirstChunk = true;
    for await (const chunk of stream) {
      chunkCount++;
      const content = chunk.content?.toString() || '';
      const cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gs, "");
      if (cleanContent) {
        // 第一个块附加 RAG 元数据
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
