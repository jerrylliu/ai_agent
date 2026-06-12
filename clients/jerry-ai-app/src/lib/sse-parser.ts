/**
 * SSE 帧解析器
 *
 * 将服务端发送的 SSE 文本流解析为结构化事件。
 * 用于替代旧方案中用正则匹配文本标记（如 [RAG_METADATA:...]）的脆弱解析。
 *
 * SSE 帧格式：
 *   event: <事件类型>\n
 *   data: <JSON 数据>\n
 *   \n
 *
 * 事件类型：
 *   - metadata:              RAG 元数据
 *   - session_action:        会话操作指令
 *   - tool_status:           工具调用进度
 *   - confirmation_request:  工具调用人工确认请求
 *   - heartbeat:             保活心跳
 *   - content:               AI 回复文本
 */

import type { ToolStatusEvent, SessionAction } from './api';

export interface SSEEvent {
  eventType: string;
  eventData: string;
}

export interface SSEParseResult {
  /** 解析出的事件列表 */
  events: SSEEvent[];
  /** 剩余未完成帧的 buffer */
  remainingBuffer: string;
}

export interface ConfirmationRequestEvent {
  id: string;
  toolName: string;
  paramsSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  message: string;
}

/**
 * 从 buffer 中解析所有完整的 SSE 帧
 *
 * @param buffer 当前累积的文本 buffer
 * @returns 解析出的事件列表和剩余未完成的 buffer
 */
export function parseSSEFrames(buffer: string): SSEParseResult {
  const events: SSEEvent[] = [];
  let remaining = buffer;

  while (true) {
    const frameEnd = remaining.indexOf('\n\n');
    if (frameEnd === -1) break; // 帧不完整，等待更多数据

    const frame = remaining.substring(0, frameEnd);
    remaining = remaining.substring(frameEnd + 2);

    if (!frame.trim()) continue; // 跳过空帧

    // 解析 SSE 帧：提取 event 和 data 字段
    let eventType = '';
    let eventData = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        eventData = line.substring(5).trim();
      }
    }

    if (!eventType) continue; // 无 event 字段，跳过
    events.push({ eventType, eventData });
  }

  return { events, remainingBuffer: remaining };
}

/**
 * 处理解析出的 SSE 事件，分发到对应的回调
 */
export function handleSSEEvents(
  events: SSEEvent[],
  callbacks: {
    onMetadata?: (metadata: { usedKnowledgeBase: boolean; contextCount: number; [key: string]: any }) => void;
    onSessionAction?: (action: SessionAction) => void;
    onToolStatus?: (event: ToolStatusEvent) => void;
    onConfirmationRequest?: (event: ConfirmationRequestEvent) => void;
    onContent?: (text: string) => void;
    onHeartbeat?: () => void;
  },
) {
  for (const event of events) {
    switch (event.eventType) {
      case 'metadata': {
        try {
          const metadata = JSON.parse(event.eventData);
          callbacks.onMetadata?.(metadata);
        } catch (e) {
          console.warn('解析 metadata 事件失败:', e);
        }
        break;
      }
      case 'session_action': {
        try {
          const action = JSON.parse(event.eventData);
          callbacks.onSessionAction?.(action);
        } catch (e) {
          console.warn('解析 session_action 事件失败:', e);
        }
        break;
      }
      case 'tool_status': {
        try {
          const toolEvent: ToolStatusEvent = JSON.parse(event.eventData);
          callbacks.onToolStatus?.(toolEvent);
        } catch (e) {
          console.warn('解析 tool_status 事件失败:', e);
        }
        break;
      }
      case 'confirmation_request': {
        try {
          const confirmEvent: ConfirmationRequestEvent = JSON.parse(event.eventData);
          callbacks.onConfirmationRequest?.(confirmEvent);
        } catch (e) {
          console.warn('解析 confirmation_request 事件失败:', e);
        }
        break;
      }
      case 'heartbeat': {
        callbacks.onHeartbeat?.();
        break;
      }
      case 'content': {
        try {
          const text = JSON.parse(event.eventData);
          callbacks.onContent?.(text);
        } catch (e) {
          // JSON 解析失败时直接使用原始 data
          callbacks.onContent?.(event.eventData);
        }
        break;
      }
    }
  }
}
