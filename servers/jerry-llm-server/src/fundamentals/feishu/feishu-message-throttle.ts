/**
 * 飞书流式编辑节流器（D1/D2）
 *
 * 背景：
 *   飞书 `PATCH /im/v1/messages/{id}` 没有"增量追加"语义，每次都是全量替换。
 *   LLM 输出按 token 级 chunk 推送，如果每个 chunk 都直接调一次 API：
 *     - 飞书侧 update QPS 限制 ≈ 50（个人租户更紧），瞬间会被限流；
 *     - 用户手机上一秒一抖，体验很差；
 *     - 带宽和服务端 CPU 也浪费。
 *
 * 策略：双触发条件 + 强制 flush 节奏
 *   - MIN_INTERVAL_MS：两次 PATCH 之间至少间隔多少毫秒
 *   - MIN_DELTA_CHARS：相比上次写入累计字符增量超过多少才触发
 *   - HARD_INTERVAL_MS：哪怕字符不够，也至少这么久写一次（让用户看到进度）
 *   - flush(true)：流式结束时强制再写一次最终全量内容
 *
 * 全量写入策略：buffer 始终是"全量"而不是 delta，任何一次 PATCH 失败都不会破坏内容
 * （下一次写入仍然是完整文本）。
 */
import { logger } from '../logger';

const MIN_INTERVAL_MS = 350;
const MIN_DELTA_CHARS = 40;
const HARD_INTERVAL_MS = 1200;

export interface FeishuStreamEditor {
  /** 追加一段 LLM 输出 */
  appendDelta: (delta: string) => void;
  /**
   * 立即把当前 buffer 写到飞书。
   * final=true 时表示流式结束，会跳过去抖判断（强制写出最终态）。
   */
  flush: (final?: boolean) => Promise<void>;
  /** 当前累积的全量内容（测试 / 调试用） */
  getBuffer: () => string;
}

/** PATCH 飞书消息文本内容的回调，由调用方注入（避免循环依赖） */
export type FeishuTextPatcher = (text: string) => Promise<{ success: boolean; error?: string }>;

/**
 * 创建一个流式编辑器
 *
 * @param patcher  实际调飞书 PATCH 接口的函数（注入，便于测试 mock 和避免循环依赖）
 */
export function createFeishuStreamEditor(
  patcher: FeishuTextPatcher,
): FeishuStreamEditor {
  let buffer = '';
  let lastWriteAt = 0;
  let lastWriteLength = 0;
  let pendingTimer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> | null = null;
  /**
   * 排队的下一次 flush：上一次 PATCH 还在飞、又来了新的 flush 时，
   * 不重复发起多次 PATCH，而是合并成一次"下一轮"PATCH，
   * 等 inflight 结束后用最新 buffer 再写一次。
   */
  let queuedFlush: Promise<void> | null = null;

  const doPatch = async (text: string): Promise<void> => {
    try {
      const result = await patcher(text);
      if (!result.success) {
        logger.warn('飞书流式编辑：PATCH 失败（保留 buffer，等待下次重试）', {
          module: 'FeishuStreamEditor',
          err: result.error,
          bufferLength: text.length,
        });
        return;
      }
      lastWriteAt = Date.now();
      lastWriteLength = text.length;
    } catch (e: any) {
      logger.warn('飞书流式编辑：PATCH 异常', {
        module: 'FeishuStreamEditor',
        err: (e?.message || String(e)).slice(0, 200),
      });
    }
  };

  const flushNow = async (final = false): Promise<void> => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    void final; // 当前实现 final 不影响行为（buffer 变化时一定写）

    if (inflight) {
      // 已有 PATCH 在飞：把"下一次 flush"合并成同一个排队 Promise
      if (queuedFlush) return queuedFlush;
      queuedFlush = (async () => {
        try {
          await inflight;
        } catch {
          /* ignore */
        }
        queuedFlush = null;
        // 排队的这一轮真正执行：用最新 buffer
        if (buffer.length === 0 || buffer.length === lastWriteLength) return;
        inflight = doPatch(buffer);
        try {
          await inflight;
        } finally {
          inflight = null;
        }
      })();
      return queuedFlush;
    }

    if (buffer.length === 0 || buffer.length === lastWriteLength) return;
    inflight = doPatch(buffer);
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  };

  const appendDelta = (delta: string): void => {
    if (!delta) return;
    buffer += delta;

    const now = Date.now();
    const sinceLast = now - lastWriteAt;
    const deltaSize = buffer.length - lastWriteLength;

    // 触发条件 A：累积字符够 + 距离上次写入够久
    // 触发条件 B：距离上次写入已经很久（hard interval），无视字符数
    if (
      (deltaSize >= MIN_DELTA_CHARS && sinceLast >= MIN_INTERVAL_MS) ||
      sinceLast >= HARD_INTERVAL_MS
    ) {
      // fire-and-forget，外部不阻塞推送
      void flushNow().catch(() => {});
      return;
    }

    // 否则确保有一个 pending 定时器兜底
    if (!pendingTimer) {
      const wait = Math.max(MIN_INTERVAL_MS, HARD_INTERVAL_MS - sinceLast);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void flushNow().catch(() => {});
      }, wait);
    }
  };

  return {
    appendDelta,
    flush: flushNow,
    getBuffer: () => buffer,
  };
}

/** 节流参数（导出常量，方便测试 / 文档引用） */
export const FEISHU_STREAM_TUNING = {
  MIN_INTERVAL_MS,
  MIN_DELTA_CHARS,
  HARD_INTERVAL_MS,
};
