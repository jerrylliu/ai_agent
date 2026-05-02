// 导入 ChatOllama 类，用于与 Ollama 本地大语言模型进行交互
import {ChatOllama} from "@langchain/ollama";
// 导入消息类型类，用于构建不同类型的对话消息
import {ChatMessage,HumanMessage,AIMessage,SystemMessage,FunctionMessage} from "@langchain/core/messages";
// import {Tool} from "@langchain/core/tools";
// 导入 PromptTemplate 类，用于创建和管理提示模板
import {PromptTemplate} from "@langchain/core/prompts";
import type { Response } from 'express';
// 创建 ChatOllama 实例，配置使用的本地模型为 qwen3.5-new

const llm = new ChatOllama({
  model: "qwen3.5-new",
});
export const promptTemplate =  async (promptText?: string, history?: Array<{ role: string, content: string }>, res?: Response) => {
    const conversions: Array<HumanMessage | AIMessage> = [];
    
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
        // console.log(content,666666);
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
