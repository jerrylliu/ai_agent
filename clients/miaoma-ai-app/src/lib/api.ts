// API 端点常量导入
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

/**
 * 保存聊天记录
 * @param data 聊天历史项数据
 * @throws 保存失败时抛出错误
 */
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

/**
 * 获取 AI 响应流
 * @param message 用户消息
 * @param history 历史消息列表
 * @returns 可读流，包含 AI 响应文本
 * @throws 获取失败时抛出错误
 */
export async function getAIResponse(message: string, history: Message[] = []): Promise<ReadableStream<string>> {
  const response = await fetch(`${API_ENDPOINTS.PROMPT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
  });
  if (!response.ok) {
    throw new Error('获取 AI 响应失败');
  }
  return response.body!.pipeThrough(new TextDecoderStream());
}

/**
 * 获取指定会话的历史记录
 * @param sessionId 会话 ID
 * @returns 聊天记录列表
 */
export async function getSessionHistory(sessionId: string): Promise<ChatHistoryRecord[]> {
  const response = await fetch(`${API_ENDPOINTS.CHAT_HISTORY}?sessionId=${sessionId}`);
  return handleResponse<ChatHistoryRecord[]>(response);
}

/**
 * 获取所有聊天记录
 * @returns 所有聊天记录列表
 */
export async function getAllChatHistory(): Promise<ChatHistoryRecord[]> {
  const response = await fetch(API_ENDPOINTS.ALL_CHAT_HISTORY);
  return handleResponse<ChatHistoryRecord[]>(response);
}

// 会话相关 API

/**
 * 获取所有会话列表
 * @returns 会话列表
 */
export async function getSessions(): Promise<Session[]> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions`);
  return handleResponse<Session[]>(response);
}

/**
 * 创建新会话
 * @param sessionId 会话 ID
 * @param title 会话标题
 * @returns 创建的会话对象
 */
export async function createSession(sessionId: string, title: string): Promise<Session> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, title }),
  });
  return handleResponse<Session>(response);
}

/**
 * 获取指定会话详情
 * @param sessionId 会话 ID
 * @returns 会话对象
 */
export async function getSession(sessionId: string): Promise<Session> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}`);
  return handleResponse<Session>(response);
}

/**
 * 更新会话标题
 * @param sessionId 会话 ID
 * @param title 新标题
 * @throws 更新失败时抛出错误
 */
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

/**
 * 删除会话
 * @param sessionId 会话 ID
 * @throws 删除失败时抛出错误
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('删除会话失败');
  }
}

/**
 * 切换会话置顶状态
 * @param sessionId 会话 ID
 * @throws 操作失败时抛出错误
 */
export async function toggleSessionPin(sessionId: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}/pin`, {
    method: 'PATCH',
  });
  if (!response.ok) {
    throw new Error('切换会话置顶状态失败');
  }
}

/**
 * 获取指定会话的消息列表
 * @param sessionId 会话 ID
 * @returns 消息记录列表
 */
export async function getSessionMessages(sessionId: string): Promise<ChatHistoryRecord[]> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/sessions/${sessionId}/messages`);
  return handleResponse<ChatHistoryRecord[]>(response);
}

/**
 * 上传文件
 * @param file 要上传的文件
 * @returns 包含文件 URL 的响应
 */
export async function uploadFile(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/upload`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse<UploadResponse>(response);
}

/**
 * 更新消息内容
 * @param id 消息 ID
 * @param content 新内容
 * @throws 更新失败时抛出错误
 */
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

/**
 * 删除消息
 * @param id 消息 ID
 * @throws 删除失败时抛出错误
 */
export async function deleteMessage(id: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/messages/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('删除消息失败');
  }
}

// ============================================
// 知识库相关 API
// ============================================

/**
 * 上传文档到知识库
 * @param file 要上传的文档文件
 * @returns 上传结果，包含是否成功、消息和文档数量
 */
export async function uploadToKnowledgeBase(file: File): Promise<{
  success: boolean;
  message: string;
  documentCount?: number;
}> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(API_ENDPOINTS.KNOWLEDGE_UPLOAD, {
    method: 'POST',
    body: formData,
  });

  return handleResponse<{
    success: boolean;
    message: string;
    documentCount?: number;
  }>(response);
}

/**
 * 获取知识库状态
 * @returns 知识库状态信息
 */
export async function getKnowledgeBaseStatus(): Promise<{
  status: 'ready' | 'empty' | 'error';
  message: string;
  stats?: {
    documentCount: number;
    collectionName: string;
  };
}> {
  const response = await fetch(API_ENDPOINTS.KNOWLEDGE_STATUS, {
    method: 'GET',
  });

  return handleResponse<{
    status: 'ready' | 'empty' | 'error';
    message: string;
    stats?: {
      documentCount: number;
      collectionName: string;
    };
  }>(response);
}

/**
 * 搜索知识库
 * @param query 搜索查询
 * @param topK 返回结果数量（默认3）
 * @returns 搜索结果
 */
export async function searchKnowledgeBase(
  query: string,
  topK: number = 3
): Promise<{
  success: boolean;
  query: string;
  results: Array<{
    content: string;
    metadata: any;
    score: number;
  }>;
  context: string;
}> {
  const response = await fetch(API_ENDPOINTS.KNOWLEDGE_SEARCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK }),
  });

  return handleResponse<{
    success: boolean;
    query: string;
    results: Array<{
      content: string;
      metadata: any;
      score: number;
    }>;
    context: string;
  }>(response);
}
