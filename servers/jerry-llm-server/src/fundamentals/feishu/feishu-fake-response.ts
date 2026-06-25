/**
 * 飞书 fakeResponse 适配器（D1/D2）
 *
 * 目的：让 promptTemplate / promptInvoke 这类"为 SSE 设计的函数"能复用到飞书入口。
 *
 * 实现原理：
 *   - 暴露一个鸭子类型的 Response（包含 write/setHeader/on/end/writableEnded/flushHeaders）
 *   - write 来的 SSE 帧用 parseSSEFrame 解析，只关心 event=content 的帧
 *   - content 帧的 data 是 JSON.stringify(text)，反解后追加到 FeishuStreamEditor
 *   - 其他事件（tool_status / metadata / workflow_* / confirmation_*）飞书侧不展示，直接丢弃
 *
 * 注意：
 *   - confirmation_request 在飞书侧没有 Web 弹框可承接，会卡死。MVP 直接忽略，
 *     上层（processIncomingMessage）通过把会话 source='feishu' 区分，
 *     未来可以演进成"在飞书里弹审批卡"。
 */
import type { Response } from 'express';
import { parseSSEFrame } from '../sse-writer';
import { logger } from '../logger';
import type { FeishuStreamEditor } from './feishu-message-throttle';

/** 飞书 fakeRes 创建结果：res 用来传给 promptTemplate，flush 用来收尾 */
export interface FeishuFakeResponse {
  res: Response;
  /** 流式结束后强制 flush，确保最终内容写回飞书 */
  finalize: () => Promise<void>;
}

/**
 * 创建 fakeRes 适配器
 *
 * @param editor   实际承接文本输出的节流编辑器
 * @param onConfirmationRequest  收到工具确认请求时的回调（默认 noop，飞书侧没法弹 Web 框）
 */
export function createFeishuFakeResponse(
  editor: FeishuStreamEditor,
  options?: {
    onConfirmationRequest?: (info: any) => void;
  },
): FeishuFakeResponse {
  let writableEnded = false;

  const fake: Partial<Response> & {
    write: (chunk: any) => boolean;
    writableEnded: boolean;
  } = {
    writableEnded: false,
    setHeader: () => fake as Response,
    on: () => fake as Response,
    once: () => fake as Response,
    flushHeaders: () => {},
    end: () => {
      writableEnded = true;
      (fake as any).writableEnded = true;
      return fake as Response;
    },
    write(chunk: any): boolean {
      if (writableEnded) return false;
      try {
        const raw = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const frames = parseSSEFrame(raw);
        for (const f of frames) {
          if (f.eventType === 'content') {
            try {
              const text = JSON.parse(f.eventData);
              if (typeof text === 'string' && text.length > 0) {
                editor.appendDelta(text);
              }
            } catch {
              /* 单帧解析失败不影响后续 */
            }
          } else if (f.eventType === 'confirmation_request') {
            try {
              const info = JSON.parse(f.eventData);
              options?.onConfirmationRequest?.(info);
              logger.info('飞书 fakeRes：忽略 confirmation_request（飞书侧暂不支持工具审批）', {
                module: 'FeishuFakeResponse',
                toolName: info?.toolName,
              });
            } catch {
              /* ignore */
            }
          }
          // 其他事件类型（tool_status / metadata / workflow_* / heartbeat / session_action）
          // 在飞书消息里没有承接位置，全部丢弃
        }
      } catch (e: any) {
        logger.warn('飞书 fakeRes：写入失败（忽略）', {
          module: 'FeishuFakeResponse',
          err: (e?.message || String(e)).slice(0, 200),
        });
      }
      return true;
    },
  };

  // status 链式调用 stub（appService 内部少数路径会用到）
  (fake as any).status = () => ({ json: () => fake });

  return {
    res: fake as Response,
    finalize: async () => {
      writableEnded = true;
      (fake as any).writableEnded = true;
      await editor.flush(true);
    },
  };
}
