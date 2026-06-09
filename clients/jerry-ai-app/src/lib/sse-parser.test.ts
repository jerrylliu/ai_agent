/**
 * SSE 帧解析器单元测试
 *
 * 测试 sse-parser.ts 中的 parseSSEFrames 和 handleSSEEvents
 */

import { describe, it, expect, vi } from 'vitest';
import { parseSSEFrames, handleSSEEvents } from './sse-parser';

describe('sse-parser', () => {
  describe('parseSSEFrames', () => {
    it('应解析单个完整的 SSE 帧', () => {
      const input = 'event: metadata\ndata: {"usedKnowledgeBase":true,"contextCount":2}\n\n';
      const { events, remainingBuffer } = parseSSEFrames(input);

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('metadata');
      expect(events[0].eventData).toBe('{"usedKnowledgeBase":true,"contextCount":2}');
      expect(remainingBuffer).toBe('');
    });

    it('应解析多个连续 SSE 帧', () => {
      const input =
        'event: metadata\ndata: {"usedKnowledgeBase":true}\n\n' +
        'event: session_action\ndata: {"type":"switch_session"}\n\n' +
        'event: content\ndata: "你好"\n\n';

      const { events } = parseSSEFrames(input);
      expect(events).toHaveLength(3);
      expect(events[0].eventType).toBe('metadata');
      expect(events[1].eventType).toBe('session_action');
      expect(events[2].eventType).toBe('content');
    });

    it('不完整的帧应保留在 remainingBuffer 中', () => {
      const input = 'event: content\ndata: "你好"\n\nevent: metadata\ndata: {';
      const { events, remainingBuffer } = parseSSEFrames(input);

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('content');
      expect(remainingBuffer).toBe('event: metadata\ndata: {');
    });

    it('完全没有帧分隔符时应全部保留', () => {
      const input = 'event: content';
      const { events, remainingBuffer } = parseSSEFrames(input);

      expect(events).toHaveLength(0);
      expect(remainingBuffer).toBe('event: content');
    });

    it('应跳过空帧', () => {
      const input = '\n\nevent: content\ndata: "test"\n\n\n\n';
      const { events } = parseSSEFrames(input);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('content');
    });

    it('应跳过无 event 字段的帧', () => {
      const input = 'data: something\n\n';
      const { events } = parseSSEFrames(input);
      expect(events).toHaveLength(0);
    });

    it('应正确处理 content 事件中 JSON 编码的中文', () => {
      const input = 'event: content\ndata: "你好世界"\n\n';
      const { events } = parseSSEFrames(input);
      expect(events[0].eventData).toBe('"你好世界"');
    });

    it('应正确处理含换行的 content', () => {
      // JSON.stringify("第一行\n第二行") => "第一行\n第二行"
      // 在 SSE data 行中，换行需要用 \n 转义（因为 data: 行以 \n 结尾）
      // 但 JSON.stringify 已经将 \n 转为 \\n，所以 data 行不会真的换行
      const encoded = JSON.stringify('第一行\n第二行');
      const input = `event: content\ndata: ${encoded}\n\n`;
      const { events } = parseSSEFrames(input);
      expect(events[0].eventData).toBe(encoded);
    });

    it('应正确处理 tool_status 事件', () => {
      const data = JSON.stringify({ toolName: 'search_web', label: '搜索网页', status: 'calling' });
      const input = `event: tool_status\ndata: ${data}\n\n`;
      const { events } = parseSSEFrames(input);
      expect(events[0].eventType).toBe('tool_status');
      expect(events[0].eventData).toBe(data);
    });

    it('应正确处理 heartbeat 事件', () => {
      const input = 'event: heartbeat\ndata: {}\n\n';
      const { events } = parseSSEFrames(input);
      expect(events[0].eventType).toBe('heartbeat');
      expect(events[0].eventData).toBe('{}');
    });

    it('应正确处理嵌套 JSON 的 metadata', () => {
      const data = JSON.stringify({
        usedKnowledgeBase: true,
        contextCount: 3,
        toolCalls: ['search_web', 'get_weather'],
        nested: { key: 'value' },
      });
      const input = `event: metadata\ndata: ${data}\n\n`;
      const { events } = parseSSEFrames(input);
      expect(events[0].eventData).toBe(data);
    });

    it('应正确处理空字符串输入', () => {
      const { events, remainingBuffer } = parseSSEFrames('');
      expect(events).toHaveLength(0);
      expect(remainingBuffer).toBe('');
    });

    it('未知事件类型应被解析但不会在 handleSSEEvents 中触发回调', () => {
      const input = 'event: unknown_type\ndata: "test"\n\n';
      const { events } = parseSSEFrames(input);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('unknown_type');
    });
  });

  describe('handleSSEEvents', () => {
    it('应调用 onMetadata 回调', () => {
      const onMetadata = vi.fn();
      const events = [{ eventType: 'metadata', eventData: '{"usedKnowledgeBase":true,"contextCount":2}' }];

      handleSSEEvents(events, { onMetadata });

      expect(onMetadata).toHaveBeenCalledWith({ usedKnowledgeBase: true, contextCount: 2 });
    });

    it('应调用 onSessionAction 回调', () => {
      const onSessionAction = vi.fn();
      const events = [{ eventType: 'session_action', eventData: '{"type":"switch_session","payload":{"sessionId":"abc"}}' }];

      handleSSEEvents(events, { onSessionAction });

      expect(onSessionAction).toHaveBeenCalledWith({
        type: 'switch_session',
        payload: { sessionId: 'abc' },
      });
    });

    it('应调用 onToolStatus 回调', () => {
      const onToolStatus = vi.fn();
      const events = [{ eventType: 'tool_status', eventData: '{"toolName":"search_web","label":"搜索网页","status":"calling"}' }];

      handleSSEEvents(events, { onToolStatus });

      expect(onToolStatus).toHaveBeenCalledWith({
        toolName: 'search_web',
        label: '搜索网页',
        status: 'calling',
      });
    });

    it('应调用 onContent 回调', () => {
      const onContent = vi.fn();
      const events = [{ eventType: 'content', eventData: '"你好世界"' }];

      handleSSEEvents(events, { onContent });

      expect(onContent).toHaveBeenCalledWith('你好世界');
    });

    it('应调用 onHeartbeat 回调', () => {
      const onHeartbeat = vi.fn();
      const events = [{ eventType: 'heartbeat', eventData: '{}' }];

      handleSSEEvents(events, { onHeartbeat });

      expect(onHeartbeat).toHaveBeenCalled();
    });

    it('content 事件 JSON 解析失败时应使用原始 data', () => {
      const onContent = vi.fn();
      const events = [{ eventType: 'content', eventData: '{invalid json' }];

      handleSSEEvents(events, { onContent });

      expect(onContent).toHaveBeenCalledWith('{invalid json');
    });

    it('metadata 事件 JSON 解析失败时不应崩溃', () => {
      const onMetadata = vi.fn();
      const events = [{ eventType: 'metadata', eventData: '{invalid' }];

      // 不应抛错
      expect(() => handleSSEEvents(events, { onMetadata })).not.toThrow();
      expect(onMetadata).not.toHaveBeenCalled();
    });

    it('未提供回调时不应崩溃', () => {
      const events = [
        { eventType: 'metadata', eventData: '{"usedKnowledgeBase":true}' },
        { eventType: 'content', eventData: '"test"' },
        { eventType: 'heartbeat', eventData: '{}' },
      ];

      expect(() => handleSSEEvents(events, {})).not.toThrow();
    });

    it('应按顺序处理多个事件', () => {
      const order: string[] = [];
      const events = [
        { eventType: 'metadata', eventData: '{"usedKnowledgeBase":true}' },
        { eventType: 'content', eventData: '"你好"' },
        { eventType: 'content', eventData: '"世界"' },
      ];

      handleSSEEvents(events, {
        onMetadata: () => order.push('metadata'),
        onContent: (text) => order.push(`content:${text}`),
      });

      expect(order).toEqual(['metadata', 'content:你好', 'content:世界']);
    });

    it('session_action JSON 解析失败时不应崩溃', () => {
      const onSessionAction = vi.fn();
      const events = [{ eventType: 'session_action', eventData: '{invalid' }];

      expect(() => handleSSEEvents(events, { onSessionAction })).not.toThrow();
      expect(onSessionAction).not.toHaveBeenCalled();
    });

    it('tool_status JSON 解析失败时不应崩溃', () => {
      const onToolStatus = vi.fn();
      const events = [{ eventType: 'tool_status', eventData: '{invalid' }];

      expect(() => handleSSEEvents(events, { onToolStatus })).not.toThrow();
      expect(onToolStatus).not.toHaveBeenCalled();
    });

    it('未知事件类型应被忽略', () => {
      const onContent = vi.fn();
      const events = [{ eventType: 'unknown_event', eventData: '"test"' }];

      handleSSEEvents(events, { onContent });
      expect(onContent).not.toHaveBeenCalled();
    });

    it('空事件数组不应触发任何回调', () => {
      const onMetadata = vi.fn();
      const onContent = vi.fn();

      handleSSEEvents([], { onMetadata, onContent });

      expect(onMetadata).not.toHaveBeenCalled();
      expect(onContent).not.toHaveBeenCalled();
    });
  });
});
