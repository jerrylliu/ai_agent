/**
 * fundamentals/prompt-message-cleaner.spec.ts
 *
 * 测试 cleanMessagesForFinalSummary：达到最大轮数强制总结时的消息清理逻辑。
 *
 * 覆盖场景：
 *   1. 正常多轮工具调用 → 只保留最后一轮 ToolMessage
 *   2. 单轮工具调用 → 保留该轮 ToolMessage
 *   3. 最后一轮是被熔断的 ToolMessage → 保留（模型能理解该收尾）
 *   4. 无工具调用历史 → 移除所有 ToolMessage（防御性）
 *   5. 不带 tool_calls 的 AIMessage → 保留（模型中间回答）
 *   6. SystemMessage 始终保留
 *   7. 不修改原数组（纯函数）
 *   8. 回归测试：修复前的 bug 行为不会重现（模型能看到最后一轮工具结果）
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { cleanMessagesForFinalSummary } from './prompt-message-cleaner';

// 辅助构造函数：减少测试用例的样板代码
const sys = (text = '系统规则') => new SystemMessage(text);
const human = (text = '用户问题') => new HumanMessage(text);
const ai = (text = 'AI回答') => new AIMessage(text);
const aiWithToolCalls = (text = '', toolName = 'search_knowledge_base') =>
  new AIMessage({ content: text, tool_calls: [{ id: 'tc_1', name: toolName, args: {} }] });
const tool = (text = '工具结果', toolCallId = 'tc_1') =>
  new ToolMessage({ content: text, tool_call_id: toolCallId });

describe('cleanMessagesForFinalSummary', () => {
  describe('核心清理逻辑', () => {
    it('正常多轮工具调用：只保留最后一轮 ToolMessage，移除早期轮次和所有带 tool_calls 的 AIMessage', () => {
      // 场景：模型调了 3 轮工具，第 3 轮结果应该被保留
      const messages = [
        sys(),
        human('查一下武器室规范'),
        aiWithToolCalls('', 'search_knowledge_base'), // 第1轮 AI 调用
        tool('第1轮结果A'),
        tool('第1轮结果B'),
        aiWithToolCalls('', 'search_knowledge_base'), // 第2轮 AI 调用
        tool('第2轮结果'),
        aiWithToolCalls('', 'calculate'), // 第3轮 AI 调用（最后一轮）
        tool('第3轮结果'),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      // SystemMessage + 用户问题 保留
      expect(result[0]).toBeInstanceOf(SystemMessage);
      expect(result[1]).toBeInstanceOf(HumanMessage);
      expect((result[1] as HumanMessage).content).toBe('查一下武器室规范');

      // 所有带 tool_calls 的 AIMessage 都被移除
      const aiMsgs = result.filter(m => m instanceof AIMessage);
      expect(aiMsgs).toHaveLength(0);

      // 只保留最后一轮的 ToolMessage（第3轮结果）
      const toolMsgs = result.filter(m => m instanceof ToolMessage);
      expect(toolMsgs).toHaveLength(1);
      expect((toolMsgs[0] as ToolMessage).content).toBe('第3轮结果');

      // 早期轮次的 ToolMessage 被移除
      const contents = result.map(m => (m as { content: string }).content);
      expect(contents).not.toContain('第1轮结果A');
      expect(contents).not.toContain('第1轮结果B');
      expect(contents).not.toContain('第2轮结果');
    });

    it('单轮工具调用：保留该轮 ToolMessage', () => {
      const messages = [
        sys(),
        human(),
        aiWithToolCalls(),
        tool('唯一一轮结果'),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      const toolMsgs = result.filter(m => m instanceof ToolMessage);
      expect(toolMsgs).toHaveLength(1);
      expect((toolMsgs[0] as ToolMessage).content).toBe('唯一一轮结果');

      // 带 tool_calls 的 AIMessage 被移除
      expect(result.filter(m => m instanceof AIMessage)).toHaveLength(0);
    });

    it('最后一轮是被熔断的 ToolMessage：保留（模型能理解该收尾）', () => {
      // 场景：工具调用次数超限，最后一轮 ToolMessage 是"次数已达上限"提示
      const circuitBrokenContent = JSON.stringify({
        error: true,
        message: '工具调用总次数已达上限，请基于已有信息直接回答用户问题，不要再调用任何工具。',
      });
      const messages = [
        sys(),
        human(),
        aiWithToolCalls(),
        tool('正常结果'),
        aiWithToolCalls(),
        tool(circuitBrokenContent), // 最后一轮是熔断提示
      ];

      const result = cleanMessagesForFinalSummary(messages);

      const toolMsgs = result.filter(m => m instanceof ToolMessage);
      expect(toolMsgs).toHaveLength(1);
      expect((toolMsgs[0] as ToolMessage).content).toBe(circuitBrokenContent);
    });
  });

  describe('边界情况', () => {
    it('无工具调用历史：移除所有 ToolMessage（防御性处理）', () => {
      // 理论上不会走到强制总结分支，但要保证不会异常
      const messages = [
        sys(),
        human(),
        tool('孤儿 ToolMessage'), // 没有 AIMessage(tool_calls) 配对
      ];

      const result = cleanMessagesForFinalSummary(messages);

      // 没有 tool_calls 历史，所有 ToolMessage 被移除
      expect(result.filter(m => m instanceof ToolMessage)).toHaveLength(0);
      // SystemMessage 和 HumanMessage 保留
      expect(result[0]).toBeInstanceOf(SystemMessage);
      expect(result[1]).toBeInstanceOf(HumanMessage);
    });

    it('不带 tool_calls 的 AIMessage：保留（模型的中间回答）', () => {
      // 场景：模型某轮返回了纯文本回答（没调工具），后又继续调工具
      const messages = [
        sys(),
        human(),
        ai('我先理解一下你的问题'), // 不带 tool_calls 的 AIMessage，应保留
        aiWithToolCalls(),
        tool('工具结果'),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      // 不带 tool_calls 的 AIMessage 保留
      const aiMsgs = result.filter(m => m instanceof AIMessage);
      expect(aiMsgs).toHaveLength(1);
      expect((aiMsgs[0] as AIMessage).content).toBe('我先理解一下你的问题');
      // tool_calls 为空或 undefined（没有实际工具调用，所以不被移除）
      expect(((aiMsgs[0] as AIMessage).tool_calls?.length ?? 0)).toBe(0);
    });

    it('SystemMessage 始终保留（约定在索引 0）', () => {
      const messages = [
        sys('系统规则不能丢'),
        human(),
        aiWithToolCalls(),
        tool(),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      expect(result[0]).toBeInstanceOf(SystemMessage);
      expect((result[0] as SystemMessage).content).toBe('系统规则不能丢');
    });

    it('纯函数：不修改原数组', () => {
      const messages = [
        sys(),
        human(),
        aiWithToolCalls(),
        tool(),
      ];
      const originalLength = messages.length;
      const originalContents = messages.map(m => (m as { content: string }).content);

      cleanMessagesForFinalSummary(messages);

      // 原数组不变
      expect(messages.length).toBe(originalLength);
      expect(messages.map(m => (m as { content: string }).content)).toEqual(originalContents);
    });

    it('空数组：返回空数组（不异常）', () => {
      expect(cleanMessagesForFinalSummary([])).toEqual([]);
    });
  });

  describe('回归测试：修复前的 bug 不重现', () => {
    it('bug 复现场景：模型能看到最后一轮工具结果，而不是完全看不到', () => {
      // 这是修复前的核心问题：
      //   用户问知识库 → 模型调了 search_knowledge_base 多次 → 跑满 10 轮
      //   旧代码移除所有 ToolMessage → 模型完全看不到资料 → 凭训练数据编造
      // 修复后：模型应能看到最后一轮的 search_knowledge_base 结果
      const lastRoundKBResult = '武器室管理规范第3.2.4条：钥匙交接需双人核对';
      const messages = [
        sys(),
        human('武器室规范里钥匙交接要求是什么'),
        aiWithToolCalls('', 'search_knowledge_base'),
        tool('第1轮：钥匙交接基本要求'),
        aiWithToolCalls('', 'search_knowledge_base'),
        tool('第2轮：双人核对制度'),
        aiWithToolCalls('', 'search_knowledge_base'),
        tool(lastRoundKBResult), // 最后一轮的关键资料
      ];

      const result = cleanMessagesForFinalSummary(messages);

      // 关键断言：模型能看到最后一轮工具结果
      const contents = result.map(m => (m as { content: string }).content);
      expect(contents).toContain(lastRoundKBResult);

      // 早期轮次结果被移除（避免 context 过长 + 协议混乱）
      expect(contents).not.toContain('第1轮：钥匙交接基本要求');
      expect(contents).not.toContain('第2轮：双人核对制度');
    });

    it('bug 复现场景：用户原始问题保留，模型有上下文可回答', () => {
      const userQuestion = '武器室规范里钥匙交接要求是什么';
      const messages = [
        sys(),
        human(userQuestion),
        aiWithToolCalls(),
        tool('工具结果'),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      // 用户原始问题必须保留（否则模型不知道要回答什么）
      const contents = result.map(m => (m as { content: string }).content);
      expect(contents).toContain(userQuestion);
    });
  });
});
