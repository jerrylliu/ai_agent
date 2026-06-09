/**
 * SSE 写入函数单元测试
 *
 * 测试 sse-writer.ts 中所有导出函数的输出格式是否符合 SSE 规范
 */

import {
  sendToolStatus,
  startHeartbeat,
  stopHeartbeat,
  sendMetadata,
  sendSessionAction,
  sendContent,
  parseSSEFrame,
} from './sse-writer';

// Mock Express Response
function createMockResponse(): { write: jest.Mock; writableEnded: boolean } {
  return {
    write: jest.fn(),
    writableEnded: false,
  };
}

describe('sse-writer', () => {
  describe('sendToolStatus', () => {
    it('应发送标准 SSE tool_status 帧', () => {
      const res = createMockResponse();
      sendToolStatus(res as any, 'search_web', 'calling');

      expect(res.write).toHaveBeenCalledTimes(1);
      const output = res.write.mock.calls[0][0];

      const frames = parseSSEFrame(output);
      expect(frames).toHaveLength(1);
      expect(frames[0].eventType).toBe('tool_status');

      const data = JSON.parse(frames[0].eventData);
      expect(data.toolName).toBe('search_web');
      expect(data.label).toBe('搜索网页');
      expect(data.status).toBe('calling');
    });

    it('应使用中文标签映射', () => {
      const res = createMockResponse();
      sendToolStatus(res as any, 'get_weather', 'executing');

      const output = res.write.mock.calls[0][0];
      const data = JSON.parse(parseSSEFrame(output)[0].eventData);
      expect(data.label).toBe('查询天气');
    });

    it('未知工具名应使用原始名称作为标签', () => {
      const res = createMockResponse();
      sendToolStatus(res as any, 'unknown_tool', 'done');

      const output = res.write.mock.calls[0][0];
      const data = JSON.parse(parseSSEFrame(output)[0].eventData);
      expect(data.label).toBe('unknown_tool');
    });

    it('应合并 extra 字段', () => {
      const res = createMockResponse();
      sendToolStatus(res as any, 'search_web', 'done', { iteration: 2, error: true });

      const output = res.write.mock.calls[0][0];
      const data = JSON.parse(parseSSEFrame(output)[0].eventData);
      expect(data.iteration).toBe(2);
      expect(data.error).toBe(true);
    });

    it('res 为 undefined 时不应写入', () => {
      expect(() => sendToolStatus(undefined, 'search_web', 'calling')).not.toThrow();
    });

    it('res.writableEnded 为 true 时不应写入', () => {
      const res = createMockResponse();
      res.writableEnded = true;
      sendToolStatus(res as any, 'search_web', 'calling');
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('sendMetadata', () => {
    it('应发送标准 SSE metadata 帧', () => {
      const res = createMockResponse();
      const metadata = { usedKnowledgeBase: true, contextCount: 3 };

      sendMetadata(res as any, metadata);

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      expect(frames).toHaveLength(1);
      expect(frames[0].eventType).toBe('metadata');

      const data = JSON.parse(frames[0].eventData);
      expect(data.usedKnowledgeBase).toBe(true);
      expect(data.contextCount).toBe(3);
    });

    it('应正确处理嵌套对象', () => {
      const res = createMockResponse();
      const metadata = { usedKnowledgeBase: false, toolCalls: ['search_web', 'get_weather'] };

      sendMetadata(res as any, metadata);

      const output = res.write.mock.calls[0][0];
      const data = JSON.parse(parseSSEFrame(output)[0].eventData);
      expect(data.toolCalls).toEqual(['search_web', 'get_weather']);
    });

    it('res 为 undefined 时不应写入', () => {
      expect(() => sendMetadata(undefined, { usedKnowledgeBase: true })).not.toThrow();
    });

    it('res.writableEnded 为 true 时不应写入', () => {
      const res = createMockResponse();
      res.writableEnded = true;
      sendMetadata(res as any, { usedKnowledgeBase: true });
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('sendSessionAction', () => {
    it('应发送标准 SSE session_action 帧', () => {
      const res = createMockResponse();
      const action = { type: 'switch_session', payload: { sessionId: 'abc123' } };

      sendSessionAction(res as any, action);

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      expect(frames).toHaveLength(1);
      expect(frames[0].eventType).toBe('session_action');

      const data = JSON.parse(frames[0].eventData);
      expect(data.type).toBe('switch_session');
      expect(data.payload.sessionId).toBe('abc123');
    });

    it('res 为 undefined 时不应写入', () => {
      expect(() => sendSessionAction(undefined, { type: 'switch_session' })).not.toThrow();
    });

    it('res.writableEnded 为 true 时不应写入', () => {
      const res = createMockResponse();
      res.writableEnded = true;
      sendSessionAction(res as any, { type: 'switch_session' });
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('sendContent', () => {
    it('应发送标准 SSE content 帧', () => {
      const res = createMockResponse();
      sendContent(res as any, '你好世界');

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      expect(frames).toHaveLength(1);
      expect(frames[0].eventType).toBe('content');

      // content 的 data 是 JSON.stringify 编码的字符串
      const text = JSON.parse(frames[0].eventData);
      expect(text).toBe('你好世界');
    });

    it('应正确处理含换行符的文本', () => {
      const res = createMockResponse();
      sendContent(res as any, '第一行\n第二行\n第三行');

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      const text = JSON.parse(frames[0].eventData);
      expect(text).toBe('第一行\n第二行\n第三行');
    });

    it('应正确处理含引号的文本', () => {
      const res = createMockResponse();
      sendContent(res as any, '他说："你好"');

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      const text = JSON.parse(frames[0].eventData);
      expect(text).toBe('他说："你好"');
    });

    it('应正确处理空字符串', () => {
      const res = createMockResponse();
      sendContent(res as any, '');

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      const text = JSON.parse(frames[0].eventData);
      expect(text).toBe('');
    });

    it('应正确处理含反斜杠的文本', () => {
      const res = createMockResponse();
      sendContent(res as any, '路径 C:\\Users\\test');

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      const text = JSON.parse(frames[0].eventData);
      expect(text).toBe('路径 C:\\Users\\test');
    });

    it('应正确处理含旧标记文本的内容（不会被误解析）', () => {
      const res = createMockResponse();
      sendContent(res as any, '[RAG_METADATA:{"usedKnowledgeBase":true}]这是AI的回复');

      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      // 应该只有一个 content 事件，旧标记文本只是普通字符串
      expect(frames).toHaveLength(1);
      expect(frames[0].eventType).toBe('content');
      const text = JSON.parse(frames[0].eventData);
      expect(text).toBe('[RAG_METADATA:{"usedKnowledgeBase":true}]这是AI的回复');
    });

    it('res 为 undefined 时不应写入', () => {
      expect(() => sendContent(undefined, 'test')).not.toThrow();
    });

    it('res.writableEnded 为 true 时不应写入', () => {
      const res = createMockResponse();
      res.writableEnded = true;
      sendContent(res as any, 'test');
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('startHeartbeat / stopHeartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('应定期发送 heartbeat 事件', () => {
      const res = createMockResponse();
      startHeartbeat(res as any, 1000);

      // 初始不应写入
      expect(res.write).not.toHaveBeenCalled();

      // 1 秒后应写入一次
      jest.advanceTimersByTime(1000);
      expect(res.write).toHaveBeenCalledTimes(1);
      const output = res.write.mock.calls[0][0];
      const frames = parseSSEFrame(output);
      expect(frames[0].eventType).toBe('heartbeat');

      // 再过 1 秒应写入第二次
      jest.advanceTimersByTime(1000);
      expect(res.write).toHaveBeenCalledTimes(2);
    });

    it('res 为 undefined 时应返回 null', () => {
      const timer = startHeartbeat(undefined, 1000);
      expect(timer).toBeNull();
    });

    it('stopHeartbeat 应停止心跳', () => {
      const res = createMockResponse();
      const timer = startHeartbeat(res as any, 1000);

      jest.advanceTimersByTime(1000);
      expect(res.write).toHaveBeenCalledTimes(1);

      stopHeartbeat(timer);

      jest.advanceTimersByTime(3000);
      // 停止后不应再写入
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('stopHeartbeat(null) 不应抛错', () => {
      expect(() => stopHeartbeat(null)).not.toThrow();
    });

    it('res.writableEnded 变为 true 后应停止写入', () => {
      const res = createMockResponse();
      startHeartbeat(res as any, 1000);

      jest.advanceTimersByTime(1000);
      expect(res.write).toHaveBeenCalledTimes(1);

      // 模拟连接关闭
      res.writableEnded = true;

      jest.advanceTimersByTime(3000);
      // writableEnded 后不应再写入
      expect(res.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseSSEFrame', () => {
    it('应解析单个 SSE 帧', () => {
      const input = 'event: metadata\ndata: {"usedKnowledgeBase":true}\n\n';
      const frames = parseSSEFrame(input);
      expect(frames).toHaveLength(1);
      expect(frames[0].eventType).toBe('metadata');
      expect(frames[0].eventData).toBe('{"usedKnowledgeBase":true}');
    });

    it('应解析多个连续 SSE 帧', () => {
      const input =
        'event: metadata\ndata: {"usedKnowledgeBase":true}\n\n' +
        'event: session_action\ndata: {"type":"switch_session"}\n\n' +
        'event: content\ndata: "你好"\n\n';

      const frames = parseSSEFrame(input);
      expect(frames).toHaveLength(3);
      expect(frames[0].eventType).toBe('metadata');
      expect(frames[1].eventType).toBe('session_action');
      expect(frames[2].eventType).toBe('content');
    });

    it('应跳过空帧', () => {
      const input = 'event: metadata\ndata: {}\n\n\n\n';
      const frames = parseSSEFrame(input);
      expect(frames).toHaveLength(1);
    });

    it('应跳过无 event 字段的帧', () => {
      const input = 'data: something\n\n';
      const frames = parseSSEFrame(input);
      expect(frames).toHaveLength(0);
    });

    it('应正确处理空字符串输入', () => {
      const frames = parseSSEFrame('');
      expect(frames).toHaveLength(0);
    });

    it('应正确处理只有 data 无 event 的帧', () => {
      const input = 'data: {"key":"value"}\n\n';
      const frames = parseSSEFrame(input);
      expect(frames).toHaveLength(0);
    });
  });
});
