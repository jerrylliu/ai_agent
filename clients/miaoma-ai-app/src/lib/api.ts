import { API_ENDPOINTS } from './constants';
import { Session, Message } from '../types/session';

// 类型定义
export interface ChatHistoryItem {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatHistoryRecord extends ChatHistoryItem {
  id: number;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadResponse {
  url: string;
}

// 错误处理函数
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({
      message: '请求失败',
    }));
    throw new Error(errorData.message || `请求失败: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// API 调用函数
export async function saveChatHistory(data: ChatHistoryItem): Promise<void> {
  const response = await fetch(API_ENDPOINTS.CHAT_HISTORY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error('保存聊天记录失败');
  }
}

export async function getAIResponse(message: string): Promise<string> {
  const response = await fetch(`${API_ENDPOINTS.PROMPT}?message=${encodeURIComponent(message)}`);
  if (!response.ok) {
    throw new Error('获取 AI 响应失败');
  }
  return response.text();
}

export async function getSessionHistory(sessionId: string): Promise<ChatHistoryRecord[]> {
  const response = await fetch(`${API_ENDPOINTS.CHAT_HISTORY}?sessionId=${sessionId}`);
  return handleResponse<ChatHistoryRecord[]>(response);
}

export async function getAllChatHistory(): Promise<ChatHistoryRecord[]> {
  const response = await fetch(API_ENDPOINTS.ALL_CHAT_HISTORY);
  return handleResponse<ChatHistoryRecord[]>(response);
}

// 会话相关 API
export async function getSessions(): Promise<Session[]> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions`);
  return handleResponse<Session[]>(response);
}

export async function createSession(sessionId: string, title: string): Promise<Session> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, title }),
  });
  return handleResponse<Session>(response);
}

export async function getSession(sessionId: string): Promise<Session> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}`);
  return handleResponse<Session>(response);
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error('更新会话标题失败');
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('删除会话失败');
  }
}

export async function toggleSessionPin(sessionId: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}/pin`, {
    method: 'PATCH',
  });
  if (!response.ok) {
    throw new Error('切换会话置顶状态失败');
  }
}

export async function getSessionMessages(sessionId: string): Promise<ChatHistoryRecord[]> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}/messages`);
  return handleResponse<ChatHistoryRecord[]>(response);
}

export async function uploadFile(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/upload`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse<UploadResponse>(response);
}

export async function updateMessage(id: string, content: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/messages/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error('更新消息失败');
  }
}

export async function deleteMessage(id: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/messages/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('删除消息失败');
  }
}
