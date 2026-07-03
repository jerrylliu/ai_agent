// ============================================================================
// 文件作用：为 prompt.ts 的"达到最大轮数强制总结"场景提供消息清理纯函数。
//          单独提取成文件是为了可测试性——避免测试时加载整个 prompt.ts 的重依赖
//          （LLM 客户端、工具注册、SSE、缓存等）。
//
// 设计背景：prompt.ts 在 FC 工具循环跑满 MAX_TOOL_ITERATIONS 后，会清理 messages
//          再让模型生成最终回答。清理逻辑有 bug（注释说"只保留最后一轮工具结果"
//          但代码移除了所有 ToolMessage），本模块是修复后的实现。
// ============================================================================

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

/**
 * 为"达到最大轮数强制总结"场景清理消息列表。
 *
 * 设计意图（对应 prompt.ts 原注释的真实诉求）：
 * - 保留 SystemMessage（系统规则不能丢）
 * - 移除所有带 tool_calls 的 AIMessage（防止本地模型模仿工具调用格式继续死循环）
 * - 只保留最后一轮 ToolMessage（让模型能基于最近的工具输出收尾，而不是凭空编造）
 * - 移除早期轮次的 ToolMessage（避免历史工具格式干扰 + 控制 context 长度）
 * - 保留普通 HumanMessage / AIMessage（用户问题和模型中间回答）
 *
 * 为什么是"最后一轮"而不是"全部保留"：
 *   保留全部 ToolMessage 会让 context 过长，且多个 ToolMessage 紧挨着
 *   没有对应 AIMessage 会破坏 FC 协议的成对结构，让模型困惑。
 *   最后一轮通常是模型最近一次决策的产物，最相关；早期结果已被模型
 *   "消化"进后续 tool_calls 决策里。
 *
 * 边界情况：
 * - 没有 tool_calls 历史（lastToolCallAiIdx === -1）：所有 ToolMessage 都被移除
 *   （理论上不会走到强制总结分支，但作为防御性处理）
 * - 最后一轮是被熔断的 ToolMessage：保留，模型看到"次数已达上限"能理解该收尾
 *
 * @param messages FC 工具循环跑满后的完整消息列表（约定索引 0 是 SystemMessage）
 * @returns 清理后的消息列表（不修改原数组）
 */
export function cleanMessagesForFinalSummary(
  messages: Array<SystemMessage | HumanMessage | AIMessage | ToolMessage>,
): Array<SystemMessage | HumanMessage | AIMessage | ToolMessage> {
  // 倒序找到最后一个带 tool_calls 的 AIMessage 索引
  // 这条 AIMessage 之后的 ToolMessage 即"最后一轮工具结果"
  let lastToolCallAiIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) {
      lastToolCallAiIdx = i;
      break;
    }
  }

  return messages.filter((msg, idx) => {
    // 保留 SystemMessage（约定为数组第一个）
    if (idx === 0 && msg instanceof SystemMessage) return true;
    // 移除所有带 tool_calls 的 AIMessage（防止模型模仿工具调用格式）
    if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) return false;
    // ToolMessage：只保留最后一轮（最后一个带 tool_calls 的 AIMessage 之后的）
    // lastToolCallAiIdx === -1 时（无工具调用历史）移除所有 ToolMessage
    if (msg instanceof ToolMessage) {
      return lastToolCallAiIdx !== -1 && idx > lastToolCallAiIdx;
    }
    // 普通 HumanMessage / 不带 tool_calls 的 AIMessage 保留
    return true;
  });
}
