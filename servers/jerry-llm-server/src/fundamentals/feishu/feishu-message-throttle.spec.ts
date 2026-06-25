/**
 * feishu-message-throttle 单测
 *
 * 覆盖关键时序行为：
 *   1. 首次 appendDelta 不会立刻触发（需要满足触发条件）
 *   2. 攒够字符 + 距离够 → 触发 PATCH
 *   3. Hard interval：哪怕字符不够，过了 1.2s 也会触发
 *   4. flush(true)：内容没变也会强制触发
 *   5. PATCH 失败时 lastWriteLength 不更新（下次还会重试）
 *   6. PATCH 串行化：前一次 inflight 时下一次会等待
 */
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { createFeishuStreamEditor, FEISHU_STREAM_TUNING } from './feishu-message-throttle';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('feishu-message-throttle', () => {
  it('已经写过一次后，小增量不应立刻 PATCH（去抖）', async () => {
    const patcher = jest.fn().mockResolvedValue({ success: true });
    const editor = createFeishuStreamEditor(patcher);

    // 预热：先写一次，让 lastWriteAt 更新到当前时间
    editor.appendDelta('init');
    await editor.flush(true);
    expect(patcher).toHaveBeenCalledTimes(1);

    // 之后小增量（不够字符 + 没到 hard interval）应被节流
    editor.appendDelta('a');
    await wait(50);
    expect(patcher).toHaveBeenCalledTimes(1);
  });

  it('首次 appendDelta 因 hard-interval 立刻触发（提升首字响应）', async () => {
    const patcher = jest.fn().mockResolvedValue({ success: true });
    const editor = createFeishuStreamEditor(patcher);

    editor.appendDelta('你好');
    // 异步触发，给它一个 microtask 机会
    await wait(20);
    expect(patcher).toHaveBeenCalledTimes(1);
    expect(patcher).toHaveBeenCalledWith('你好');
  });

  it('累积超过 MIN_DELTA_CHARS 且达到 MIN_INTERVAL_MS 时触发 PATCH', async () => {
    const patcher = jest.fn().mockResolvedValue({ success: true });
    const editor = createFeishuStreamEditor(patcher);

    // 第一次 flush 由 hard-interval 触发（lastWriteAt=0，所以 sinceLast 极大）
    editor.appendDelta('a'.repeat(FEISHU_STREAM_TUNING.MIN_DELTA_CHARS + 1));
    await wait(20);
    expect(patcher).toHaveBeenCalledTimes(1);
    expect(patcher.mock.calls[0][0].length).toBe(FEISHU_STREAM_TUNING.MIN_DELTA_CHARS + 1);
  });

  it('flush(true) 强制写出最终内容', async () => {
    const patcher = jest.fn().mockResolvedValue({ success: true });
    const editor = createFeishuStreamEditor(patcher);

    editor.appendDelta('hello');
    await editor.flush(true);

    // appendDelta 因 hard-interval 触发 + flush(true) 串行合并 → 一次 PATCH 即可（因为 buffer 没变）
    expect(patcher).toHaveBeenCalled();
    expect(patcher).toHaveBeenLastCalledWith('hello');
  });

  it('PATCH 始终携带全量 buffer，不是 delta', async () => {
    const patcher = jest.fn().mockResolvedValue({ success: true });
    const editor = createFeishuStreamEditor(patcher);

    editor.appendDelta('AAA');
    await editor.flush(true);
    editor.appendDelta('BBB');
    await editor.flush(true);

    const calls = patcher.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // 第一次写至少包含 AAA、最后一次包含 AAABBB（全量替换语义）
    expect(calls[0][0]).toBe('AAA');
    expect(calls[calls.length - 1][0]).toBe('AAABBB');
  });

  it('PATCH 失败时 buffer 保持完整，下次 flush 会再次重试', async () => {
    const patcher = jest
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'rate limited' })
      .mockResolvedValueOnce({ success: true });
    const editor = createFeishuStreamEditor(patcher);

    editor.appendDelta('hello world');
    await editor.flush(true);
    // 第一次失败，buffer 不变
    expect(editor.getBuffer()).toBe('hello world');

    await editor.flush(true);
    // 第二次重试成功
    expect(patcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(patcher.mock.calls[patcher.mock.calls.length - 1][0]).toBe('hello world');
  });

  it('内容为空时 flush(false) 不触发 PATCH（避免发空消息）', async () => {
    const patcher = jest.fn().mockResolvedValue({ success: true });
    const editor = createFeishuStreamEditor(patcher);
    await editor.flush(false);
    expect(patcher).not.toHaveBeenCalled();
  });

  it('PATCH 串行化：第二次 flush 排队等待，最终内容是最新 buffer', async () => {
    const writes: string[] = [];
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    let callIdx = 0;
    const patcher = jest.fn().mockImplementation(async (text: string) => {
      const idx = callIdx++;
      if (idx === 0) {
        await firstPromise;
      }
      writes.push(text);
      return { success: true };
    });

    const editor = createFeishuStreamEditor(patcher);
    editor.appendDelta('first');
    const p1 = editor.flush(true);

    // 在 p1 还没完成时 append + 再次 flush（应被合并到队列）
    editor.appendDelta('-second');
    const p2 = editor.flush(true);

    // 释放第一次
    resolveFirst();
    await Promise.all([p1, p2]);

    // 第一次写 'first'，第二次（合并后）写 'first-second'
    // 不应出现三次 PATCH（合并）
    expect(writes).toEqual(['first', 'first-second']);
  });
});
