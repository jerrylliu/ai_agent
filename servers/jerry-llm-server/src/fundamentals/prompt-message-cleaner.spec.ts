/**
 * fundamentals/prompt-message-cleaner.spec.ts
 *
 * 测试 cleanMessagesForFinalSummary：强制总结 / 取消路径 headless 交代时的消息清理逻辑。
 *
 * 覆盖场景：
 *   1. 正常多轮工具调用 → 最后一轮工具结果转为 HumanMessage 摘要保留
 *   2. 单轮工具调用 → 结果保留
 *   3. 最后一轮是熔断 ToolMessage → 内容保留
 *   4. 无工具调用历史 → 无摘要（防御性）
 *   5. 不带 tool_calls 的 AIMessage → 保留（模型中间回答）
 *   6. SystemMessage 始终保留
 *   7. 不修改原数组（纯函数）
 *   8. 协议合法性回归：输出永远不含 ToolMessage 与 tool_calls（DeepSeek 400 修复）
 *   9. 信息保留回归：模型能看到最后一轮工具结果（旧 bug 不重现）
 */

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { cleanMessagesForFinalSummary } from './prompt-message-cleaner';

// 辅助构造函数：减少测试用例的样板代码
const sys = (text = '系统规则') => new SystemMessage(text);
const human = (text = '用户问题') => new HumanMessage(text);
const ai = (text = 'AI回答') => new AIMessage(text);
const aiWithToolCalls = (text = '', toolName = 'search_knowledge_base') =>
  new AIMessage({
    content: text,
    tool_calls: [{ id: 'tc_1', name: toolName, args: {} }],
  });
const tool = (
  text = '工具结果',
  toolCallId = 'tc_1',
  name?: string,
) => new ToolMessage({ content: text, tool_call_id: toolCallId, name });

describe('cleanMessagesForFinalSummary', () => {
  describe('核心清理逻辑', () => {
    it('正常多轮工具调用：只保留最后一轮结果（转为 HumanMessage 摘要），移除早期轮次和所有带 tool_calls 的 AIMessage', () => {
      // 场景：模型调了 3 轮工具，第 3 轮结果应该被保留
      const messages = [
        sys(),
        human('查一下武器室规范'),
        aiWithToolCalls('', 'search_knowledge_base'), // 第1轮 AI 调用
        tool('第1轮结果A', 'tc_1'),
        tool('第1轮结果B', 'tc_1b'),
        aiWithToolCalls('', 'search_knowledge_base'), // 第2轮 AI 调用
        tool('第2轮结果', 'tc_2'),
        aiWithToolCalls('', 'calculate'), // 第3轮 AI 调用（最后一轮）
        tool('第3轮结果', 'tc_3', 'calculate'),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      // SystemMessage + 用户问题 保留
      expect(result[0]).toBeInstanceOf(SystemMessage);
      expect(result[1]).toBeInstanceOf(HumanMessage);
      expect((result[1] as HumanMessage).content).toBe('查一下武器室规范');

      // 所有带 tool_calls 的 AIMessage 都被移除
      const aiMsgs = result.filter((m) => m instanceof AIMessage);
      expect(aiMsgs).toHaveLength(0);

      // 输出不含任何 ToolMessage（协议合法性）
      expect(result.filter((m) => m instanceof ToolMessage)).toHaveLength(0);

      // 最后一轮结果以 HumanMessage 摘要形式保留，且带工具名
      const digest = result.find(
        (m) =>
          m instanceof HumanMessage &&
          String((m as HumanMessage).content).includes('最近一次工具调用'),
      ) as HumanMessage | undefined;
      expect(digest).toBeDefined();
      const digestText = String(digest!.content);
      expect(digestText).toContain('第3轮结果');
      expect(digestText).toContain('[calculate]');

      // 早期轮次的工具结果被移除
      expect(digestText).not.toContain('第1轮结果A');
      expect(digestText).not.toContain('第1轮结果B');
      expect(digestText).not.toContain('第2轮结果');
    });

    it('单轮工具调用：结果保留在摘要中', () => {
      const messages = [
        sys(),
        human(),
        aiWithToolCalls(),
        tool('唯一一轮结果'),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      expect(result.filter((m) => m instanceof ToolMessage)).toHaveLength(0);
      const digestText = result
        .map((m) => String((m as { content: string }).content))
        .join('\n');
      expect(digestText).toContain('唯一一轮结果');

      // 带 tool_calls 的 AIMessage 被移除
      expect(result.filter((m) => m instanceof AIMessage)).toHaveLength(0);
    });

    it('最后一轮是被熔断的 ToolMessage：内容保留（模型能理解该收尾）', () => {
      // 场景：工具调用次数超限，最后一轮 ToolMessage 是"次数已达上限"提示
      const circuitBrokenContent = JSON.stringify({
        error: true,
        message:
          '工具调用总次数已达上限，请基于已有信息直接回答用户问题，不要再调用任何工具。',
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

      const digestText = result
        .map((m) => String((m as { content: string }).content))
        .join('\n');
      expect(digestText).toContain(circuitBrokenContent);
      expect(digestText).not.toContain('正常结果');
    });
  });

  describe('边界情况', () => {
    it('无工具调用历史：不产生摘要（防御性处理）', () => {
      const messages = [
        sys(),
        human(),
        tool('孤儿 ToolMessage'), // 没有 AIMessage(tool_calls) 配对
      ];

      const result = cleanMessagesForFinalSummary(messages);

      expect(result.filter((m) => m instanceof ToolMessage)).toHaveLength(0);
      const digestText = result
        .map((m) => String((m as { content: string }).content))
        .join('\n');
      expect(digestText).not.toContain('最近一次工具调用');
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
      const aiMsgs = result.filter((m) => m instanceof AIMessage);
      expect(aiMsgs).toHaveLength(1);
      expect(aiMsgs[0].content).toBe('我先理解一下你的问题');
      // tool_calls 为空或 undefined（没有实际工具调用，所以不被移除）
      expect(aiMsgs[0].tool_calls?.length ?? 0).toBe(0);
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

    it('超长工具结果被截断到上限', () => {
      const longResult = 'x'.repeat(3000);
      const messages = [sys(), human(), aiWithToolCalls(), tool(longResult)];

      const result = cleanMessagesForFinalSummary(messages);
      const digestText = result
        .map((m) => String((m as { content: string }).content))
        .join('\n');
      expect(digestText).toContain('…(已截断)');
      expect(digestText.length).toBeLessThan(2000);
    });

    it('纯函数：不修改原数组', () => {
      const messages = [sys(), human(), aiWithToolCalls(), tool()];
      const originalLength = messages.length;
      const originalContents = messages.map(
        (m) => (m as { content: string }).content,
      );

      cleanMessagesForFinalSummary(messages);

      // 原数组不变
      expect(messages.length).toBe(originalLength);
      expect(messages.map((m) => (m as { content: string }).content)).toEqual(
        originalContents,
      );
    });

    it('空数组：返回空数组（不异常）', () => {
      expect(cleanMessagesForFinalSummary([])).toEqual([]);
    });
  });

  describe('协议合法性回归（DeepSeek 400 修复，2026-11-20）', () => {
    it('生产事故复现：取消路径 messages（assistant tool_calls + ToolMessage）清理后不含任何孤儿 ToolMessage', () => {
      // 生产日志：
      //   "400 Messages with role 'tool' must be a response to a preceding
      //    message with 'tool_calls'"
      // 场景：FC 循环执行完工具 → 用户断开 → 取消路径 headless 交代调用 LLM
      const messages = [
        sys(),
        human('查天气并发邮件'),
        aiWithToolCalls('', 'search_web'),
        tool('北京今天晴，-2℃'),
        aiWithToolCalls('', 'send_notification'),
        tool(JSON.stringify({ success: true, delivered: 1 })),
      ];

      const result = cleanMessagesForFinalSummary(messages);

      // DeepSeek 严格校验的关键断言：数组中不存在任何 ToolMessage
      expect(result.filter((m) => m instanceof ToolMessage)).toHaveLength(0);
      // 也不存在带 tool_calls 的 AIMessage
      const orphanToolCalls = result.filter(
        (m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0,
      );
      expect(orphanToolCalls).toHaveLength(0);
      // 工具结果信息不丢：模型仍能知道邮件发送成功
      const digestText = result
        .map((m) => String((m as { content: string }).content))
        .join('\n');
      expect(digestText).toContain('delivered');
    });

    it('bug 复现场景：模型能看到最后一轮工具结果，而不是完全看不到', () => {
      // 这是更早的核心问题：旧实现曾移除所有 ToolMessage → 模型凭训练数据编造
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
      const contents = result.map((m) => (m as { content: string }).content);
      expect(contents.join('\n')).toContain(lastRoundKBResult);

      // 早期轮次结果被移除（避免 context 过长 + 协议混乱）
      expect(contents.join('\n')).not.toContain('第1轮：钥匙交接基本要求');
      expect(contents.join('\n')).not.toContain('第2轮：双人核对制度');
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

      const contents = result.map((m) => (m as { content: string }).content);
      expect(contents.join('\n')).toContain(userQuestion);
    });
  });
});
