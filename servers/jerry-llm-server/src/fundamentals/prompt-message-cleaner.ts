// ============================================================================
// 文件作用：为 prompt.ts 的"达到最大轮数强制总结"与"取消路径 headless 交代"场景
//          提供消息清理纯函数。单独提取成文件是为了可测试性——避免测试时加载
//          整个 prompt.ts 的重依赖（LLM 客户端、工具注册、SSE、缓存等）。
//
// 设计背景：prompt.ts 在两个场景需要清理 messages 后再调用 LLM：
//   1. FC 工具循环跑满 MAX_TOOL_ITERATIONS 后强制总结
//   2. 用户中途断开连接后，headless 生成执行结果交代文本（2026-11-19 新增）
//
// 2026-11-20 重大修复（生产事故复盘）：
//   旧实现"移除所有带 tool_calls 的 AIMessage，但保留最后一轮 ToolMessage"
//   → 清理后的数组里 ToolMessage 前面没有 tool_calls 配对（孤儿 ToolMessage）
//   → DeepSeek 等严格校验的 provider 直接 400：
//     "Messages with role 'tool' must be a response to a preceding message
//      with 'tool_calls'"
//   → 取消路径交代文本永远生成失败，用户回来后看不到任何执行结果
//
//   新实现：把保留的 ToolMessage 转换成一条 HumanMessage 摘要。
//   - 信息不丢：模型仍能看到最近一轮工具结果（保留原修复的核心诉求）
//   - 协议绝对合法：数组中不存在任何 ToolMessage / tool_calls 结构，
//     任何 provider（含严格校验的 DeepSeek）都不会拒
//   - 不怕模型模仿：摘要以"用户补充信息"的口吻呈现，模型不会把它当作
//     自己该继续调工具的信号（原注释担心的"死循环"问题同样解决）
// ============================================================================

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';

/** 摘要中每条工具结果的最大长度：防止单个超长工具输出撑爆强制总结的 context */
const MAX_TOOL_RESULT_CHARS = 1500;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…(已截断)';
}

/**
 * 为"强制总结 / 取消路径 headless 交代"场景清理消息列表。
 *
 * 规则：
 * - 保留 SystemMessage（系统规则不能丢）
 * - 移除所有带 tool_calls 的 AIMessage（防止本地模型模仿工具调用格式继续死循环）
 * - 最后一轮 ToolMessage 的**内容**保留，但载体从 ToolMessage 转为一条
 *   HumanMessage 摘要（修复孤儿 ToolMessage 导致的 provider 400）
 * - 早期轮次的 ToolMessage 移除（避免历史工具格式干扰 + 控制 context 长度）
 * - 保留普通 HumanMessage / 不带 tool_calls 的 AIMessage（用户问题和模型中间回答）
 *
 * 边界情况：
 * - 没有 tool_calls 历史（lastToolCallAiIdx === -1）：所有 ToolMessage 都被移除
 *   （含取消路径下工具调用被 abort、只登记了 ToolMessage 的场景）
 * - 最后一轮是被熔断的 ToolMessage：内容保留，模型看到"次数已达上限"能理解该收尾
 *
 * @param messages FC 工具循环中途/结束时的完整消息列表（约定索引 0 是 SystemMessage）
 * @returns 清理后的消息列表（不修改原数组；保证不含任何 ToolMessage 与 tool_calls）
 */
export function cleanMessagesForFinalSummary(
  messages: Array<SystemMessage | HumanMessage | AIMessage | ToolMessage>,
): Array<SystemMessage | HumanMessage | AIMessage | ToolMessage> {
  // 倒序找到最后一个带 tool_calls 的 AIMessage 索引
  // 这条 AIMessage 之后的 ToolMessage 即"最后一轮工具结果"
  let lastToolCallAiIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg instanceof AIMessage &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      lastToolCallAiIdx = i;
      break;
    }
  }

  // 预先建立 tool_call_id → 工具名 的映射：
  // prompt.ts 的去重/熔断路径构造 ToolMessage 时不带 name 字段，
  // 摘要若显示"工具"会让模型无法判断结果来源，这里从 AIMessage 的
  // tool_calls 里反查兜底（主路径带 name 时以 name 为准）
  const toolCallIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg instanceof AIMessage && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (call.id && call.name) toolCallIdToName.set(call.id, call.name);
      }
    }
  }

  // 第一遍过滤：与旧版相同的选择逻辑
  const filtered = messages.filter((msg, idx) => {
    // 保留 SystemMessage（约定为数组第一个）
    if (idx === 0 && msg instanceof SystemMessage) return true;
    // 移除所有带 tool_calls 的 AIMessage（防止模型模仿工具调用格式）
    if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0)
      return false;
    // ToolMessage：先收集后转换（见下），此处全部移除出主体
    if (msg instanceof ToolMessage) {
      return false;
    }
    // 普通 HumanMessage / 不带 tool_calls 的 AIMessage 保留
    return true;
  });

  // 收集"最后一轮"的 ToolMessage 内容（最后一个带 tool_calls 的 AIMessage 之后的）
  const lastRoundResults: string[] = [];
  if (lastToolCallAiIdx !== -1) {
    for (let i = lastToolCallAiIdx + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (!(msg instanceof ToolMessage)) continue;
      const toolName =
        (typeof msg.name === 'string' && msg.name) ||
        (msg.tool_call_id ? toolCallIdToName.get(msg.tool_call_id) : undefined) ||
        '工具';
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content) {
        lastRoundResults.push(`- [${toolName}] ${truncate(content, MAX_TOOL_RESULT_CHARS)}`);
      }
    }
  }

  // 把最后一轮工具结果转成一条 HumanMessage 摘要，插回原 ToolMessage 的首位置附近
  //（直接 append 到 filtered 末尾亦可——调用方随后都会再追加一条 HumanMessage 指令，
  //  但按原顺序插入语义更清晰：结果出现在用户问题之后、总结指令之前）
  if (lastRoundResults.length > 0) {
    filtered.push(
      new HumanMessage({
        content:
          '【系统注：以下是最近一次工具调用的结果记录，供你参考作答】\n' +
          lastRoundResults.join('\n'),
      }),
    );
  }

  return filtered;
}
