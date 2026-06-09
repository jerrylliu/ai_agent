/**
 * SSE 流式输出工具函数
 *
 * 将元数据和正文通过标准 SSE event/data 帧分离传输，
 * 避免旧方案中用文本标记（如 [RAG_METADATA:...]）混在正文里导致的解析脆弱问题。
 *
 * SSE 帧格式：
 *   event: <事件类型>\n
 *   data: <JSON 数据>\n
 *   \n
 *
 * 事件类型：
 *   - metadata:       RAG 元数据（usedKnowledgeBase, contextCount 等）
 *   - session_action: 会话操作指令
 *   - tool_status:    工具调用进度
 *   - heartbeat:      保活心跳
 *   - content:        AI 回复文本（JSON.stringify 编码）
 */

import type { Response } from 'express';

// 工具名称到中文标签的映射
const TOOL_LABELS: Record<string, string> = {
  thinking: '思考中',
  search_knowledge_base: '搜索知识库',
  search_web: '搜索网页',
  get_weather: '查询天气',
  calculate: '计算',
  manage_session: '管理会话',
};

/**
 * 向客户端发送工具调用进度事件
 */
export function sendToolStatus(
  res: Response | undefined,
  toolName: string,
  status: 'calling' | 'executing' | 'done',
  extra?: Record<string, any>,
) {
  if (!res || res.writableEnded) return;
  const label = TOOL_LABELS[toolName] || toolName;
  const data = JSON.stringify({ toolName, label, status, ...extra });
  res.write(`event: tool_status\ndata: ${data}\n\n`);
}

/**
 * 定期发送 SSE 心跳，防止长时间无数据导致连接断开
 */
export function startHeartbeat(
  res: Response | undefined,
  intervalMs: number = 5000,
): NodeJS.Timeout | null {
  if (!res) return null;
  return setInterval(() => {
    if (!res.writableEnded) {
      res.write(`event: heartbeat\ndata: {}\n\n`);
    }
  }, intervalMs);
}

export function stopHeartbeat(timer: NodeJS.Timeout | null) {
  if (timer) clearInterval(timer);
}

/**
 * 发送 metadata 事件
 */
export function sendMetadata(res: Response | undefined, metadata: Record<string, any>) {
  if (!res || res.writableEnded) return;
  res.write(`event: metadata\ndata: ${JSON.stringify(metadata)}\n\n`);
}

/**
 * 发送 session_action 事件
 */
export function sendSessionAction(res: Response | undefined, action: Record<string, any>) {
  if (!res || res.writableEnded) return;
  res.write(`event: session_action\ndata: ${JSON.stringify(action)}\n\n`);
}

/**
 * 发送 content 事件（AI 回复文本）
 * 文本通过 JSON.stringify 编码，确保多行文本和特殊字符安全传输
 */
export function sendContent(res: Response | undefined, text: string) {
  if (!res || res.writableEnded) return;
  res.write(`event: content\ndata: ${JSON.stringify(text)}\n\n`);
}

/**
 * 解析 SSE 帧文本，提取 event 和 data 字段
 * 用于客户端测试
 */
export function parseSSEFrame(frame: string): { eventType: string; eventData: string }[] {
  const results: { eventType: string; eventData: string }[] = [];
  const frames = frame.split('\n\n').filter(f => f.trim());

  for (const f of frames) {
    let eventType = '';
    let eventData = '';
    for (const line of f.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        eventData = line.substring(5).trim();
      }
    }
    if (eventType) {
      results.push({ eventType, eventData });
    }
  }

  return results;
}
