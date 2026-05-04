// 导入 ChatOllama 类，用于与 Ollama 本地大语言模型进行交互
import { ChatOllama } from "@langchain/ollama";
// 导入消息类型类，用于构建不同类型的对话消息
import { ChatMessage, HumanMessage, AIMessage, SystemMessage, FunctionMessage } from "@langchain/core/messages";
// import {Tool} from "@langchain/core/tools";
// 导入 PromptTemplate 类，用于创建和管理提示模板
import { PromptTemplate } from "@langchain/core/prompts";
import type { Response } from 'express';
// 创建 ChatOllama 实例，配置使用的本地模型为 minicpm1

const llm = new ChatOllama({
  model: "minicpm1",
  temperature: 0.7,           // 温度参数
  numCtx: 2048,               // 上下文长度
  numThread: 20,              // 线程数
  // 移除 numGpu 参数，让 Ollama 自动选择（CPU/GPU）
  repeatPenalty: 1.1,         // 重复惩罚
  topK: 40,                   // 采样候选数
  topP: 0.9,                  // 核采样
});

// 系统提示词 - 定义模型的角色和任务
const SYSTEM_PROMPT = `你是一个专业的UI/UX设计师和前端开发助手。
你的任务是：1,分析用户上传的界面设计图，用中文详细、结构化地描述其中的布局、组件、颜色、文字内容和视觉层次。
描述要精确到像素级细节，为后续代码生成提供完整依据。2,根据用户的描述，生成对应的前端组件代码，对于前端组件设计，提供完整的代码实现。`;

export const promptTemplate = async (promptText?: string, history?: Array<{ role: string, content: string }>, res?: Response) => {
  const conversions: Array<SystemMessage | HumanMessage | AIMessage> = [];

  // 添加系统提示词（必须放在最前面）
  conversions.push(new SystemMessage(SYSTEM_PROMPT));

  // 添加历史消息
  if (history && history.length > 0) {
    history.forEach(msg => {
      if (msg.role === 'user') {
        conversions.push(new HumanMessage(msg.content));
      } else if (msg.role === 'assistant') {
        conversions.push(new AIMessage(msg.content));
      }
    });
  }

  // 添加当前消息
  conversions.push(new HumanMessage(promptText || ''));

  if (res) {
    // 流式调用
    const stream = await llm.stream(conversions);
    for await (const chunk of stream) {
      const content = chunk.content?.toString() || '';
      const cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gs, "");
      // console.log(content,666);
      res.write(cleanContent);
      console.log(cleanContent);
    }
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
