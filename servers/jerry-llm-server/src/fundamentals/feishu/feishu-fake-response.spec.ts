/**
 * feishu-fake-response 单测
 *
 * 覆盖：
 *   1. SSE content 帧的 text 被解析并 forwarded 到 editor.appendDelta
 *   2. 非 content 帧（tool_status / metadata 等）被静默丢弃
 *   3. confirmation_request 调用 onConfirmationRequest 回调
 *   4. JSON 损坏的帧不抛错
 *   5. finalize 调 editor.flush(true) 并把 writableEnded 置 true
 *   6. setHeader / on / end / flushHeaders 是 noop（鸭子兼容 Response）
 */
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { createFeishuFakeResponse } from './feishu-fake-response';
import type { FeishuStreamEditor } from './feishu-message-throttle';

function makeEditor(): FeishuStreamEditor & {
  __chunks: string[];
  __flushCalls: boolean[];
} {
  const chunks: string[] = [];
  const flushCalls: boolean[] = [];
  return {
    appendDelta: jest.fn((delta: string) => {
      chunks.push(delta);
    }),
    flush: jest.fn(async (final?: boolean) => {
      flushCalls.push(!!final);
    }),
    getBuffer: () => chunks.join(''),
    __chunks: chunks,
    __flushCalls: flushCalls,
  };
}

function sseFrame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('feishu-fake-response', () => {
  it('content 帧的文本被转发到 editor.appendDelta', () => {
    const editor = makeEditor();
    const { res } = createFeishuFakeResponse(editor);

    res.write(sseFrame('content', '你好'));
    res.write(sseFrame('content', '世界'));

    expect(editor.__chunks).toEqual(['你好', '世界']);
  });

  it('非 content 事件被静默丢弃，不影响 editor', () => {
    const editor = makeEditor();
    const { res } = createFeishuFakeResponse(editor);

    res.write(sseFrame('tool_status', { tool: 'search_web', status: 'running' }));
    res.write(sseFrame('metadata', { foo: 1 }));
    res.write(sseFrame('heartbeat', {}));
    res.write(sseFrame('workflow_step_started', { stepId: 's1' }));

    expect(editor.appendDelta).not.toHaveBeenCalled();
  });

  it('confirmation_request 触发回调 + 不写入 editor', () => {
    const editor = makeEditor();
    const onConfirm = jest.fn();
    const { res } = createFeishuFakeResponse(editor, {
      onConfirmationRequest: onConfirm,
    });

    res.write(sseFrame('confirmation_request', { id: 'cf_1', toolName: 'send_notification' }));

    expect(onConfirm).toHaveBeenCalledWith({
      id: 'cf_1',
      toolName: 'send_notification',
    });
    expect(editor.appendDelta).not.toHaveBeenCalled();
  });

  it('content data JSON 损坏不抛错，且不影响后续帧', () => {
    const editor = makeEditor();
    const { res } = createFeishuFakeResponse(editor);

    expect(() => {
      res.write('event: content\ndata: {bad json}\n\n');
      res.write(sseFrame('content', 'good'));
    }).not.toThrow();

    expect(editor.__chunks).toEqual(['good']);
  });

  it('finalize 调用 editor.flush(true) 且置 writableEnded', async () => {
    const editor = makeEditor();
    const fake = createFeishuFakeResponse(editor);

    expect((fake.res as any).writableEnded).toBe(false);
    await fake.finalize();
    expect((fake.res as any).writableEnded).toBe(true);
    expect(editor.__flushCalls).toEqual([true]);
  });

  it('finalize 之后 write 不再处理新帧', async () => {
    const editor = makeEditor();
    const fake = createFeishuFakeResponse(editor);

    await fake.finalize();
    fake.res.write(sseFrame('content', '迟到了'));
    expect(editor.appendDelta).not.toHaveBeenCalled();
  });

  it('Response 兼容 stub 不抛错（setHeader/on/end/flushHeaders）', () => {
    const editor = makeEditor();
    const { res } = createFeishuFakeResponse(editor);

    expect(() => {
      res.setHeader('X-Foo', 'bar');
      res.on('close', () => {});
      (res as any).flushHeaders();
      res.end();
    }).not.toThrow();
  });

  it('Buffer 类型 chunk 也能解析', () => {
    const editor = makeEditor();
    const { res } = createFeishuFakeResponse(editor);

    res.write(Buffer.from(sseFrame('content', 'binary'), 'utf-8'));
    expect(editor.__chunks).toEqual(['binary']);
  });
});
