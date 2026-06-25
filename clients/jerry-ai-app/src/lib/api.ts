// API 端点常量导入
import { API_ENDPOINTS, API_BASE_URL } from './constants';
import { Session, Message } from '../types/session';
import { parseSSEFrames, handleSSEEvents, type ConfirmationRequestEvent, type FileCardEvent } from './sse-parser';

// 重新导出 SSE 类型，供其他模块使用
export type { ConfirmationRequestEvent, FileCardEvent } from './sse-parser';

// 类型定义
export interface ChatHistoryItem {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  /** 用户消息携带的文档卡片（聊天上传文档时附加） */
  documentCards?: unknown[];
}

export interface ChatHistoryRecord extends ChatHistoryItem {
  id: number;
  userId: string;
  createdAt: string;
  updatedAt: string;
  /** 后端 getSessionHistory 关联的文件附件（generate_document 产物） */
  attachments?: Array<{
    key: string;
    filename: string;
    format: string;
    sizeBytes: number;
    downloadUrl: string;
    previewUrl: string;
    expiresAt: number;
    favorited: boolean;
  }>;
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
    const msg = Array.isArray(errorData.message)
      ? errorData.message.join('; ')
      : errorData.message || `请求失败: ${response.status}`;
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

// ==================== 认证相关辅助函数 ====================

const TOKEN_KEY = 'miaoma_auth_token';

/**
 * 获取认证请求头
 * 如果本地存储中有 token，自动添加 Authorization header
 */
function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// API 调用函数

/** chat_history 实时事件（与后端 chat-event-bus 对应） */
export interface ChatHistoryRealtimeEvent {
  ownerUserId: string;
  sessionId: string;
  role: string;
  source: 'web' | 'feishu';
  at: number;
}

/**
 * 订阅 chat_history 实时事件（SSE）。
 *
 * 用于双端实时同步：飞书入站回复 / Web→飞书回流等任意来源写库后，
 * Web 端立即收到信号并刷新，无需依赖 5 秒轮询。
 *
 * EventSource 无法自定义请求头，token 通过 query 传入（与后端 /chat/events 约定一致）。
 * 返回关闭函数，组件卸载时调用以释放连接。
 */
export function subscribeChatEvents(
  onEvent: (event: ChatHistoryRealtimeEvent) => void,
  onStatusChange?: (connected: boolean) => void,
): () => void {
  const token = localStorage.getItem(TOKEN_KEY);
  const url = `${API_ENDPOINTS.BASE_URL}/chat/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const source = new EventSource(url);

  source.addEventListener('open', () => onStatusChange?.(true));
  source.addEventListener('ready', () => onStatusChange?.(true));
  source.addEventListener('chat_history', (e) => {
    try {
      onEvent(JSON.parse((e as MessageEvent).data));
    } catch {
      /* 单条事件解析失败忽略，等待下一条 */
    }
  });
  source.addEventListener('error', () => {
    // EventSource 会自动重连；这里只同步状态，交给轮询兜底
    onStatusChange?.(false);
  });

  return () => {
    source.close();
    onStatusChange?.(false);
  };
}

/**
 * 保存聊天记录
 * @param data 聊天历史项数据
 * @throws 保存失败时抛出错误
 */
export async function saveChatHistory(data: ChatHistoryItem): Promise<{ id: number }> {
  const response = await fetch(API_ENDPOINTS.CHAT_HISTORY, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error('保存聊天记录失败');
  }
  return response.json();
}

export interface ToolStatusEvent {
  toolName: string;
  label: string;
  status: 'calling' | 'executing' | 'done';
  iteration?: number;
  error?: boolean;
}

export interface SessionAction {
  type: 'switch_session' | 'create_session' | 'delete_session' | 'refresh_sessions';
  payload: any;
}

export interface AIStreamResponse {
  stream: ReadableStream<string>;
  usedKnowledgeBase: boolean;
  contextCount: number;
  sessionAction: SessionAction | null;
  onToolStatus: ((event: ToolStatusEvent) => void) | null;
  /** 本轮 SSE 推送的文件卡片（generate_document 生成） */
  fileCards: FileCardEvent[];
}

/**
 * 获取 AI 响应流
 * @param message 用户消息
 * @param images 用户消息中的图片URL数组
 * @param history 历史消息列表
 * @returns 包含流和RAG元数据的对象
 * @throws 获取失败时抛出错误
 */
export async function getAIResponse(
  message: string,
  images: string[] = [],
  history: Message[] = [],
  sessionId?: string,
  signal?: AbortSignal,
  options?: { memoryEnabled?: boolean; summaryEnabled?: boolean; injectMemory?: boolean; imageModel?: string; onToolStatus?: ((event: ToolStatusEvent) => void) | null; onConfirmationRequest?: ((event: ConfirmationRequestEvent) => void) | null; onConfirmationResolved?: ((event: { id: string; confirmed: boolean; source: 'web' | 'feishu' }) => void) | null; onFileCard?: ((event: FileCardEvent) => void) | null }
): Promise<AIStreamResponse> {
  const response = await fetch(`${API_ENDPOINTS.PROMPT}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ message, images, history, sessionId, ...options }),
    signal,
  });
  if (!response.ok) {
    throw new Error('获取 AI 响应失败');
  }

  const stream = response.body!.pipeThrough(new TextDecoderStream());
  let usedKnowledgeBase = false;
  let contextCount = 0;
  let sessionAction: SessionAction | null = null;
  const toolStatusCallback = options?.onToolStatus ?? null;
  const confirmationCallback = options?.onConfirmationRequest ?? null;
  const confirmationResolvedCallback = options?.onConfirmationResolved ?? null;
  const fileCardCallback = options?.onFileCard ?? null;
  const fileCards: FileCardEvent[] = [];

  const modifiedStream = new ReadableStream<string>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += value;

          const { events, remainingBuffer } = parseSSEFrames(buffer);
          buffer = remainingBuffer;

          handleSSEEvents(events, {
            onMetadata: (metadata) => {
              usedKnowledgeBase = metadata.usedKnowledgeBase || false;
              contextCount = metadata.contextCount || 0;
            },
            onSessionAction: (action) => {
              sessionAction = action;
            },
            onToolStatus: (event) => {
              if (toolStatusCallback) {
                toolStatusCallback(event);
              }
            },
            onConfirmationRequest: (event) => {
              if (confirmationCallback) {
                confirmationCallback(event);
              }
            },
            onConfirmationResolved: (event) => {
              if (confirmationResolvedCallback) {
                confirmationResolvedCallback(event);
              }
            },
            onFileCard: (event) => {
              fileCards.push(event);
              if (fileCardCallback) {
                fileCardCallback(event);
              }
            },
            onContent: (text) => {
              controller.enqueue(text);
            },
          });
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return {
    stream: modifiedStream,
    usedKnowledgeBase,
    contextCount,
    sessionAction,
    onToolStatus: toolStatusCallback,
    fileCards,
  };
}

/**
 * 获取指定会话的历史记录
 * @param sessionId 会话 ID
 * @returns 聊天记录列表
 */
export async function getSessionHistory(sessionId: string): Promise<ChatHistoryRecord[]> {
  const response = await fetch(`${API_ENDPOINTS.CHAT_HISTORY}?sessionId=${sessionId}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<ChatHistoryRecord[]>(response);
}

/**
 * 获取所有聊天记录
 * @returns 所有聊天记录列表
 */
export async function getAllChatHistory(): Promise<ChatHistoryRecord[]> {
  const response = await fetch(API_ENDPOINTS.ALL_CHAT_HISTORY, {
    headers: getAuthHeaders(),
  });
  return handleResponse<ChatHistoryRecord[]>(response);
}

// 会话相关 API

/**
 * 获取所有会话列表
 * @returns 会话列表
 */
export async function getSessions(): Promise<Session[]> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<Session[]>(response);
}

/**
 * 创建新会话
 * @param sessionId 会话 ID
 * @param title 会话标题
 * @returns 创建的会话对象
 */
export async function createSession(sessionId: string, title: string): Promise<Session> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions`, {
    method: 'POST',
    headers: getAuthHeaders(),
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
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions/${sessionId}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<Session>(response);
}

/**
 * 更新会话标题
 * @param sessionId 会话 ID
 * @param title 新标题
 * @throws 更新失败时抛出错误
 */
export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions/${sessionId}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
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
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
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
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions/${sessionId}/pin`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error('切换会话置顶状态失败');
  }
}

/**
 * 复制会话：创建一个新会话，复制原会话的所有消息
 * @param sessionId 原会话 ID
 * @returns 新创建的会话对象
 */
export async function duplicateSession(sessionId: string): Promise<Session> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions/${sessionId}/duplicate`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleResponse<Session>(response);
}

/**
 * 导出会话：返回会话信息和所有消息
 * @param sessionId 会话 ID
 * @param format 导出格式 (json / markdown / text)
 * @returns 导出内容（包含 content 和 filename）
 */
export async function exportSession(
  sessionId: string,
  format: 'json' | 'markdown' | 'text' = 'json',
): Promise<{
  content?: string;
  filename: string;
  session?: any;
  messages?: any[];
  exportedAt?: string;
}> {
  const response = await fetch(
    `${API_ENDPOINTS.BASE_URL}/chat/sessions/${sessionId}/export?format=${format}`,
    { headers: getAuthHeaders() },
  );
  return handleResponse<{
    content?: string;
    filename: string;
    session?: any;
    messages?: any[];
    exportedAt?: string;
  }>(response);
}

/**
 * 获取指定会话的消息列表
 * @param sessionId 会话 ID
 * @returns 消息记录列表
 */
export async function getSessionMessages(sessionId: string): Promise<ChatHistoryRecord[]> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/sessions/${sessionId}/messages`, {
    headers: getAuthHeaders(),
  });
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

/** 文档提取响应（POST /upload/extract） */
export interface ExtractDocumentResponse {
  /** 提取的纯文本 */
  text: string;
  /** 转换为 Tiptap JSONContent 格式，可直接喂给编辑器 */
  contentJson: unknown;
  /** 原始文件名 */
  fileName: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 文件下载 URL */
  fileUrl: string;
  /** 是否被截断（超过 5 万字符） */
  truncated: boolean;
  /** 截断阈值 */
  maxChars: number;
  /** 文档原始总字符数（截断前） */
  totalChars?: number;
  /** 后端创建的文档记录 ID（已废弃：输入框上传不再入库，此字段恒为 undefined） */
  documentId?: number;
}

/**
 * 上传文档并提取纯文本内容
 * 与 uploadFile 的区别：这个接口会解析文档内容，让 AI 能真正读到
 *
 * @param file 要提取的文档文件（docx/pdf/xlsx/txt/md 等）
 * @returns 提取结果，包含 text / contentJson / fileUrl 等
 */
export async function extractDocument(file: File): Promise<ExtractDocumentResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/upload/extract`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse<ExtractDocumentResponse>(response);
}

/**
 * 更新消息内容
 * @param id 消息 ID
 * @param content 新内容
 * @throws 更新失败时抛出错误
 */
export async function updateMessage(id: string, content: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/messages/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
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
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/messages/${id}`, {
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

// ============================================
// 模型管理 API
// ============================================

export interface AvailableModel {
  id: string;
  provider: 'ollama' | 'deepseek' | 'zhipu';
  name: string;
  description: string;
  requiresApiKey: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
}

export interface ModelInfoResponse {
  success: boolean;
  currentModelId: string;
  availableModels: AvailableModel[];
  hasDeepseekApiKey: boolean;
  hasZhipuApiKey: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
}

export async function getModelInfo(): Promise<ModelInfoResponse> {
  const response = await fetch(API_ENDPOINTS.MODELS);
  return handleResponse<ModelInfoResponse>(response);
}

export async function switchModel(modelId: string): Promise<{
  success: boolean;
  message: string;
  currentModel?: any;
}> {
  const response = await fetch(API_ENDPOINTS.MODELS_SWITCH, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ modelId }),
  });
  return handleResponse<{
    success: boolean;
    message: string;
    currentModel?: any;
  }>(response);
}

export async function setModelApiKey(
  provider: string,
  apiKey: string
): Promise<{
  success: boolean;
  message: string;
}> {
  const response = await fetch(API_ENDPOINTS.MODELS_APIKEY, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ provider, apiKey }),
  });
  return handleResponse<{
    success: boolean;
    message: string;
  }>(response);
}

// ============================================
// 认证相关 API
// ============================================

export interface UserInfo {
  id: number;
  email: string | null;
  phone: string | null;
  username: string | null;
  avatar: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  user: UserInfo;
  token: string;
}

export async function register(body: {
  email?: string;
  phone?: string;
  password: string;
  username?: string;
}): Promise<AuthResponse> {
  const response = await fetch(API_ENDPOINTS.AUTH_REGISTER, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  return handleResponse<AuthResponse>(response);
}

export async function login(body: {
  account: string;
  password: string;
}): Promise<AuthResponse> {
  const response = await fetch(API_ENDPOINTS.AUTH_LOGIN, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  return handleResponse<AuthResponse>(response);
}

export async function getProfile(token: string): Promise<UserInfo> {
  const headers = getAuthHeaders();
  headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(API_ENDPOINTS.AUTH_PROFILE, {
    method: 'GET',
    headers,
  });
  return handleResponse<UserInfo>(response);
}

export async function updateProfile(
  token: string,
  body: { username?: string; avatar?: string },
): Promise<{ success: boolean; message: string; user: UserInfo }> {
  const headers = getAuthHeaders();
  headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(API_ENDPOINTS.AUTH_PROFILE, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  return handleResponse<{ success: boolean; message: string; user: UserInfo }>(response);
}

export async function verifyToken(token: string): Promise<{
  success: boolean;
  valid: boolean;
  user: UserInfo;
}> {
  const headers = getAuthHeaders();
  headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(API_ENDPOINTS.AUTH_VERIFY, {
    method: 'GET',
    headers,
  });
  return handleResponse<{ success: boolean; valid: boolean; user: UserInfo }>(response);
}

export async function changePassword(
  token: string,
  body: { oldPassword: string; newPassword: string },
): Promise<{ success: boolean; message: string }> {
  const headers = getAuthHeaders();
  headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(API_ENDPOINTS.AUTH_CHANGE_PASSWORD, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}

// ============================================
// 语音识别 API
// ============================================

export interface TranscribeResult {
  taskId: string;
  status: 'pending' | 'success' | 'failed';
  text?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  message?: string;
}

/** 提交长音频转写任务 */
export async function submitTranscribe(file: File, format?: string): Promise<{ taskId: string; status: string }> {
  const formData = new FormData();
  formData.append('file', file);
  if (format) formData.append('format', format);

  const token = localStorage.getItem('miaoma_auth_token');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(API_ENDPOINTS.SPEECH_TRANSCRIBE, {
    method: 'POST',
    headers,
    body: formData,
  });
  return handleResponse<{ taskId: string; status: string }>(response);
}

/** 查询长音频转写结果 */
export async function queryTranscribe(taskId: string): Promise<TranscribeResult> {
  const response = await fetch(`${API_ENDPOINTS.SPEECH_TRANSCRIBE}/${taskId}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<TranscribeResult>(response);
}

// ============================================
// 生成文档管理 API（下载/预览/删除/收藏）
// ============================================

/**
 * 用户主动删除生成的文档
 */
export async function deleteGeneratedDocument(key: string): Promise<{ success: boolean; message?: string }> {
  const response = await fetch(`${API_BASE_URL}/chat/documents/${key}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; message?: string }>(response);
}

/**
 * 切换文档收藏状态
 * 收藏的文档不参与自动清理（TTL/idle 都不删除）
 */
export async function setDocumentFavorite(
  key: string,
  favorited: boolean,
): Promise<{ success: boolean; favorited: boolean; message?: string }> {
  const response = await fetch(`${API_BASE_URL}/chat/documents/${key}/favorite`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify({ favorited }),
  });
  return handleResponse<{ success: boolean; favorited: boolean; message?: string }>(response);
}

/** 收藏文档的 API 返回类型（与 MessageAttachment 对齐） */
export interface FavoriteDocument {
  key: string;
  filename: string;
  format: string;
  sizeBytes: number;
  downloadUrl: string;
  previewUrl: string;
  expiresAt: number;
  favorited: boolean;
}

/**
 * 获取当前用户所有收藏且未过期的文档清单
 * 用于"我的收藏"面板跨会话展示
 */
export async function fetchFavoriteDocuments(): Promise<FavoriteDocument[]> {
  const response = await fetch(`${API_BASE_URL}/chat/documents/favorites`, {
    method: 'GET',
    headers: getAuthHeaders(),
  });
  const result = await handleResponse<{ success: boolean; data: FavoriteDocument[] }>(response);
  return result.data || [];
}

export async function uploadAvatar(
  token: string,
  file: File,
): Promise<{ success: boolean; message: string; user: UserInfo }> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(API_ENDPOINTS.AUTH_AVATAR, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });
  return handleResponse<{ success: boolean; message: string; user: UserInfo }>(response);
}

/**
 * 获取知识库状态
 * @returns 知识库状态信息
 */
export async function getKnowledgeBaseStatus(): Promise<{
  status: 'ready' | 'empty' | 'error';
  message: string;
  hasContentUpdate?: boolean;
  stats?: {
    documentCount: number;
    uploadedDocumentCount: number;
    knowledgeSourcePageCount: number;
    collectionName: string;
    activeVersionCount?: number;
    totalVersionCount?: number;
    totalChunkCount?: number;
    lastUpdatedAt?: string | null;
  };
}> {
  const response = await fetch(API_ENDPOINTS.KNOWLEDGE_STATUS, {
    method: 'GET',
  });

  const data = await handleResponse<any>(response);

  const documentCount = data.documentCount ?? data.stats?.documentCount ?? 0;
  const uploadedDocumentCount = data.uploadedDocumentCount ?? 0;
  const knowledgeSourcePageCount = data.knowledgeSourcePageCount ?? 0;
  const isEmpty = documentCount === 0;

  return {
    status: isEmpty ? 'empty' : (data.status || 'ready'),
    message: data.message || '',
    hasContentUpdate: data.hasContentUpdate || false,
    stats: {
      documentCount,
      uploadedDocumentCount,
      knowledgeSourcePageCount,
      collectionName: data.collectionName || data.stats?.collectionName || '',
      activeVersionCount: data.activeVersionCount,
      totalVersionCount: data.totalVersionCount,
      totalChunkCount: data.totalChunkCount,
      lastUpdatedAt: data.lastUpdatedAt,
    },
  };
}

/**
 * 搜索知识库
 * @param query 搜索查询
 * @param topK 返回结果数量（默认3）
 * @param filter 元数据过滤条件（如 { documentId: "42" } 只搜当前文档）
 * @param signal AbortSignal，用于中断请求
 * @returns 搜索结果
 */
export async function searchKnowledgeBase(
  query: string,
  topK: number = 3,
  filter?: Record<string, unknown>,
  signal?: AbortSignal,
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
    headers: getAuthHeaders(),
    body: JSON.stringify({ query, topK, filter }),
    signal,
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

export async function clearKnowledgeBase(): Promise<{
  success: boolean;
  message: string;
}> {
  const response = await fetch(API_ENDPOINTS.KNOWLEDGE_SEARCH.replace('/search', '/clear'), {
    method: 'DELETE',
  });

  return handleResponse<{
    success: boolean;
    message: string;
  }>(response);
}

// ============================================
// 摘要相关 API
// ============================================

export interface SessionSummaryData {
  id?: number;
  sessionId: string;
  summaryContent: string;
  coveredMessageCount: number;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 获取指定会话的摘要
 * @param sessionId 会话 ID
 * @returns 摘要数据
 */
export async function getSessionSummary(sessionId: string): Promise<SessionSummaryData> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/memory/sessions/${sessionId}/summary`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<SessionSummaryData>(response);
}

/**
 * 手动触发摘要生成/更新
 * @param sessionId 会话 ID
 * @returns 生成的摘要数据
 */
export async function generateSessionSummary(sessionId: string): Promise<SessionSummaryData> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/memory/sessions/${sessionId}/summary`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleResponse<SessionSummaryData>(response);
}

// ============================================
// 用户记忆相关 API
// ============================================

export interface UserMemoryData {
  id: number;
  content: string;
  category: string;
  sourceSessionId: string | null;
  userId: string;
  importance: number;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserMemoriesResponse {
  success: boolean;
  memories: UserMemoryData[];
  count: number;
}

/**
 * 获取用户的所有记忆
 * @param userId 用户 ID（默认 'default'）
 * @returns 记忆列表
 */
export async function getUserMemories(userId?: string): Promise<UserMemoriesResponse> {
  const url = userId
    ? `${API_ENDPOINTS.BASE_URL}/memory/memories?userId=${userId}`
    : `${API_ENDPOINTS.BASE_URL}/memory/memories`;
  const response = await fetch(url, {
    headers: getAuthHeaders(),
  });
  return handleResponse<UserMemoriesResponse>(response);
}

/**
 * 手动添加一条用户记忆
 * @param content 记忆内容
 * @param category 分类（preference | fact | decision | context | skill）
 * @param importance 重要性（1-5）
 * @returns 新增的记忆
 */
export async function addUserMemory(
  content: string,
  category: string = 'fact',
  importance: number = 3,
): Promise<{ success: boolean; memory: UserMemoryData }> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/memory/memories`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ content, category, importance }),
  });
  return handleResponse<{ success: boolean; memory: UserMemoryData }>(response);
}

/**
 * 删除一条用户记忆
 * @param id 记忆 ID
 */
export async function deleteUserMemory(id: number): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/memory/memories/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}

/**
 * 更新一条用户记忆
 * @param id 记忆 ID
 * @param content 新内容
 * @param category 新分类
 * @param importance 新重要性
 */
export async function updateUserMemory(
  id: number,
  content: string,
  category?: string,
  importance?: number,
): Promise<{ success: boolean; memory: UserMemoryData }> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/memory/memories/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify({ content, category, importance }),
  });
  return handleResponse<{ success: boolean; memory: UserMemoryData }>(response);
}

/**
 * 清空用户所有记忆
 * @param userId 用户 ID
 */
export async function clearUserMemories(userId?: string): Promise<{ success: boolean; message: string }> {
  const url = userId
    ? `${API_ENDPOINTS.BASE_URL}/memory/memories?userId=${userId}`
    : `${API_ENDPOINTS.BASE_URL}/memory/memories`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}

/**
 * 手动触发记忆提取
 * @param sessionId 会话 ID
 */
export async function extractMemories(sessionId: string): Promise<UserMemoriesResponse> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/memory/memories/extract/${sessionId}`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleResponse<UserMemoriesResponse>(response);
}

// ============================================
// 文档版本管理 API
// ============================================

export interface DocumentItem {
  id: number;
  title: string;
  description: string | null;
  tags: string[] | null;
  currentVersionId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersionItem {
  id: number;
  documentId: number;
  versionNumber: number;
  fileUrl: string;
  fileSize: number;
  fileType: string;
  checksum: string | null;
  status: 'draft' | 'active' | 'archived';
  parsingStatus: 'pending' | 'parsing' | 'success' | 'failed';
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentAuditLogItem {
  id: number;
  documentId: number;
  versionId: number | null;
  action: 'upload' | 'activate' | 'archive' | 'rollback' | 'delete';
  operator: string;
  detail: string | null;
  createdAt: string;
}

export interface DiffLine {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/** 获取文档列表 */
export async function getDocuments(): Promise<DocumentItem[]> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ success: boolean; documents: DocumentItem[] }>(response);
  return data.documents ?? [];
}

/** 获取单个文档详情 */
export async function getDocument(id: number): Promise<DocumentItem> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${id}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<DocumentItem>(response);
}

/** 按标题查找文档（用于编辑器草稿模式按文件名匹配已有文档） */
export async function getDocumentByTitle(title: string): Promise<DocumentItem | null> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/by-title?title=${encodeURIComponent(title)}`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ success: boolean; document: DocumentItem | null }>(response);
  return data.document ?? null;
}

/** 富文本编辑器内容响应 */
export interface DocumentContentResponse {
  success: boolean;
  contentJson: unknown | null;
  contentText: string | null;
  contentUpdatedAt: string | null;
}

/** 获取文档的富文本编辑器内容 */
export async function getDocumentContent(id: number): Promise<DocumentContentResponse> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${id}/content`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<DocumentContentResponse>(response);
}

/** 保存文档的富文本编辑器内容 */
export async function saveDocumentContent(
  id: number,
  payload: { contentJson: unknown; contentText: string },
): Promise<{ success: boolean; contentUpdatedAt: string | null }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${id}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(payload),
  });
  return handleResponse<{ success: boolean; contentUpdatedAt: string | null }>(response);
}

/**
 * 草稿保存：按文件名匹配创建文档或新增版本
 *
 * 用于聊天输入框上传的文件：上传时仅解析不入库，
 * 用户在编辑器中编辑保存时调用此接口，按文件名决定是新建文档还是新增版本。
 *
 * @param fileName 原始文件名（用于匹配已有文档）
 * @param contentJson Tiptap JSONContent 编辑器内容
 * @param contentText 纯文本内容（用于 RAG 分块）
 * @returns 创建/更新的文档和版本信息
 */
export async function saveDocumentDraft(
  fileName: string,
  contentJson: unknown,
  contentText: string,
): Promise<{
  success: boolean;
  message: string;
  document: DocumentItem;
  version: DocumentVersionItem | null;
  isNew: boolean;
}> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/save-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ fileName, contentJson, contentText }),
  });
  return handleResponse<{
    success: boolean;
    message: string;
    document: DocumentItem;
    version: DocumentVersionItem | null;
    isNew: boolean;
  }>(response);
}

/**
 * 发布文档版本到知识库（向量化 + 激活）
 * - DRAFT 版本：向量化 → 激活
 * - ACTIVE 版本：删除旧向量 → 重新向量化（重新发布）
 */
export async function publishToVectorStore(
  documentId: number,
  versionId: number,
): Promise<{ success: boolean; version: DocumentVersionItem }> {
  const response = await fetch(
    `${API_ENDPOINTS.DOCUMENTS}/${documentId}/versions/${versionId}/publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    },
  );
  return handleResponse<{ success: boolean; version: DocumentVersionItem }>(response);
}

/** 上传文档（新建或新增版本） */
export async function uploadDocument(
  file: File,
  options?: { documentId?: number; title?: string; description?: string; tags?: string[] },
): Promise<{ success: boolean; document: DocumentItem; version: DocumentVersionItem }> {
  const formData = new FormData();
  formData.append('file', file);
  if (options?.documentId) formData.append('documentId', String(options.documentId));
  if (options?.title) formData.append('title', options.title);
  if (options?.description) formData.append('description', options.description);
  if (options?.tags) formData.append('tags', JSON.stringify(options.tags));

  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/upload`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse<{ success: boolean; document: DocumentItem; version: DocumentVersionItem }>(response);
}

/** 获取文档版本列表 */
export async function getDocumentVersions(documentId: number): Promise<DocumentVersionItem[]> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${documentId}/versions`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ success: boolean; versions: DocumentVersionItem[] }>(response);
  return data.versions ?? [];
}

/** 导出指定版本内容到 md/txt/docx 格式，返回 Blob */
export async function exportVersion(
  documentId: number,
  versionId: number,
  format: 'md' | 'txt' | 'docx',
): Promise<Blob> {
  const response = await fetch(
    `${API_ENDPOINTS.DOCUMENTS}/${documentId}/versions/${versionId}/export?format=${format}`,
    { headers: getAuthHeaders() },
  );
  if (!response.ok) {
    throw new Error(`导出失败：${response.status}`);
  }
  return response.blob();
}

/** 激活版本 */
export async function activateVersion(documentId: number, versionId: number): Promise<{ success: boolean; version: DocumentVersionItem }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${documentId}/versions/${versionId}`, {
    method: 'PATCH',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'active' }),
  });
  return handleResponse<{ success: boolean; version: DocumentVersionItem }>(response);
}

/** 归档版本 */
export async function archiveVersion(documentId: number, versionId: number): Promise<{ success: boolean; version: DocumentVersionItem }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${documentId}/versions/${versionId}`, {
    method: 'PATCH',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'archived' }),
  });
  return handleResponse<{ success: boolean; version: DocumentVersionItem }>(response);
}

/** 回滚到指定版本 */
export async function rollbackVersion(
  documentId: number,
  versionId: number,
): Promise<{ success: boolean; document: DocumentItem; activatedVersion: DocumentVersionItem }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${documentId}/rollback`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionId }),
  });
  return handleResponse<{ success: boolean; document: DocumentItem; activatedVersion: DocumentVersionItem }>(response);
}

/** 删除版本 */
export async function deleteVersion(documentId: number, versionId: number): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${documentId}/versions/${versionId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}

/** 删除文档 */
export async function deleteDocument(id: number): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}

/** 对比两个版本 */
export async function diffVersions(
  documentId: number,
  v1: number,
  v2: number,
): Promise<{ success: boolean; diff: DiffLine[] }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${documentId}/diff?v1=${v1}&v2=${v2}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; diff: DiffLine[] }>(response);
}

/** 获取审计日志 */
export async function getDocumentAuditLogs(
  documentId: number,
): Promise<DocumentAuditLogItem[]> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/${documentId}/audit-log`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ success: boolean; logs: DocumentAuditLogItem[] }>(response);
  return data.logs ?? [];
}

export interface PendingVectorOpItem {
  id: number;
  versionId: number;
  operation: 'remove' | 'update_status' | 'reindex';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retryCount: number;
  errorMessage: string | null;
  params: Record<string, any> | null;
  createdAt: string;
}

export async function getPendingVectorOps(): Promise<PendingVectorOpItem[]> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/pending-ops`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ success: boolean; ops: PendingVectorOpItem[] }>(response);
  return data.ops ?? [];
}

export async function retrySingleVectorOp(opId: number): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/pending-ops/${opId}/retry`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; error?: string }>(response);
}

export async function deletePendingVectorOp(opId: number): Promise<{ success: boolean }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/pending-ops/${opId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean }>(response);
}

export async function retryAllFailedOps(): Promise<{ success: boolean; retried: number; total: number }> {
  const response = await fetch(`${API_ENDPOINTS.DOCUMENTS}/scheduler/retry-failed-ops`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; retried: number; total: number }>(response);
}

// ============================================
// 知识源管理 API
// ============================================

export interface KnowledgeSourceItem {
  id: number;
  name: string;
  type: 'web' | 'feishu';
  config: Record<string, any>;
  syncInterval: number;
  lastSyncStatus: 'idle' | 'syncing' | 'success' | 'failed';
  lastSyncAt: string | null;
  lastSyncError: string | null;
  enabled: boolean;
  hasContentUpdate: boolean;
  maxDepth: number;
  maxPages: number;
  preferMarkdown: boolean;
  enableJsRendering: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSourceStats {
  total: number;
  enabled: number;
  syncing: number;
  failed: number;
  success: number;
}

export interface KnowledgeSourceSyncLog {
  id: number;
  sourceId: number;
  status: 'running' | 'success' | 'failed';
  pagesFetched: number;
  chunksAdded: number;
  chunksUpdated: number;
  pagesNew: number;
  pagesUpdated: number;
  pagesDeleted: number;
  updatedPageDetails: Array<{ title: string; url: string }> | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export async function getKnowledgeSources(): Promise<KnowledgeSourceItem[]> {
  const response = await fetch(API_ENDPOINTS.KNOWLEDGE_SOURCES, { headers: getAuthHeaders() });
  const data = await handleResponse<{ success: boolean; data: KnowledgeSourceItem[] }>(response);
  return data.data;
}

export async function getKnowledgeSource(id: number): Promise<KnowledgeSourceItem> {
  const response = await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/${id}`, { headers: getAuthHeaders() });
  const data = await handleResponse<{ success: boolean; data: KnowledgeSourceItem }>(response);
  return data.data;
}

export async function createKnowledgeSource(body: {
  name: string;
  type: string;
  config: Record<string, any>;
  syncInterval?: number;
  maxDepth?: number;
  maxPages?: number;
  preferMarkdown?: boolean;
  enableJsRendering?: boolean;
}): Promise<KnowledgeSourceItem> {
  const response = await fetch(API_ENDPOINTS.KNOWLEDGE_SOURCES, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  const data = await handleResponse<{ success: boolean; data: KnowledgeSourceItem }>(response);
  return data.data;
}

export async function updateKnowledgeSource(
  id: number,
  body: Partial<{ name: string; config: Record<string, any>; syncInterval: number; maxDepth: number; maxPages: number; preferMarkdown: boolean; enableJsRendering: boolean; enabled: boolean }>,
): Promise<KnowledgeSourceItem> {
  const response = await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  const data = await handleResponse<{ success: boolean; data: KnowledgeSourceItem }>(response);
  return data.data;
}

export async function deleteKnowledgeSource(id: number): Promise<void> {
  await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
}

export async function syncKnowledgeSource(id: number): Promise<KnowledgeSourceSyncLog> {
  const response = await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/${id}/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ success: boolean; data: KnowledgeSourceSyncLog }>(response);
  return data.data;
}

export async function resetKnowledgeSourceStatus(id: number): Promise<void> {
  await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/${id}/reset-status`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
}

export async function acknowledgeKnowledgeSourceUpdate(id: number): Promise<void> {
  await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/${id}/acknowledge-update`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
}

export async function getKnowledgeSourceStats(): Promise<KnowledgeSourceStats> {
  const response = await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/stats`, { headers: getAuthHeaders() });
  const data = await handleResponse<{ success: boolean; data: KnowledgeSourceStats }>(response);
  return data.data;
}

export async function getKnowledgeSourceSyncLogs(id: number, limit: number = 20): Promise<KnowledgeSourceSyncLog[]> {
  const response = await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/${id}/logs?limit=${limit}`, { headers: getAuthHeaders() });
  const data = await handleResponse<{ success: boolean; data: KnowledgeSourceSyncLog[] }>(response);
  return data.data;
}

export async function batchSyncKnowledgeSources(sourceIds: number[]): Promise<Array<{ sourceId: number; success: boolean; message: string }>> {
  const response = await fetch(`${API_ENDPOINTS.KNOWLEDGE_SOURCES}/batch/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ sourceIds }),
  });
  const data = await handleResponse<{ success: boolean; data: Array<{ sourceId: number; success: boolean; message: string }> }>(response);
  return data.data;
}

// ============================================
// LLM 用量统计 API
// ============================================

export interface LlmUsageStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  avgResponseTimeMs: number;
  knowledgeBaseHitRate: number;
  dailyStats: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  recentRecords: Array<{
    id: number;
    userId: string;
    sessionId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    historyCount: number;
    usedKnowledgeBase: boolean;
    imageCount: number;
    responseTimeMs: number;
    userMessage: string;
    createdAt: string;
  }>;
}

/**
 * 获取 LLM 用量统计
 * @param days 统计最近多少天（默认 7 天）
 */
export async function getLlmUsageStats(days: number = 7): Promise<LlmUsageStats> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/llm-usage?days=${days}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<LlmUsageStats>(response);
}

// ============================================
// 准确率评估 API
// ============================================

/**
 * 提交消息反馈（点赞/点踩）
 */
export async function submitFeedback(params: {
  sessionId: string;
  userMessage: string;
  assistantMessage: string;
  rating: 'positive' | 'negative';
  comment?: string;
  modelId?: string;
  usedKnowledgeBase?: boolean;
}): Promise<{ action: 'created' | 'removed'; rating?: string }> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/feedback`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(params),
  });
  return handleResponse<{ action: 'created' | 'removed'; rating?: string }>(response);
}

export interface EvaluationStats {
  humanEvaluation: {
    totalFeedbacks: number;
    positiveCount: number;
    negativeCount: number;
    satisfactionRate: number;
    recentFeedbacks: Array<{
      id: number;
      userId: string;
      sessionId: string;
      userMessage: string;
      assistantMessage: string;
      rating: 'positive' | 'negative';
      comment: string;
      modelId: string;
      usedKnowledgeBase: boolean;
      createdAt: string;
    }>;
  };
  autoEvaluation: {
    totalEvaluations: number;
    avgScore: number;
    recentEvaluations: Array<{
      id: number;
      userId: string;
      sessionId: string;
      userMessage: string;
      assistantMessage: string;
      score: number;
      reason: string;
      dimension: string;
      modelId: string;
      usedKnowledgeBase: boolean;
      responseTimeMs: number;
      createdAt: string;
    }>;
  };
  dailyFeedback: Record<string, { positive: number; negative: number }>;
}

/**
 * 获取准确率评估统计
 */
export async function getEvaluationStats(days: number = 7): Promise<EvaluationStats> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/evaluation-stats?days=${days}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<EvaluationStats>(response);
}

// ============================================
// 工具调用统计 API
// ============================================

export interface ToolUsageStats {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  successRate: number;
  avgDurationMs: number;
  byTool: Record<string, {
    calls: number;
    successRate: number;
    avgDurationMs: number;
  }>;
  dailyStats: Record<string, {
    calls: number;
    successCalls: number;
  }>;
  recentRecords: Array<{
    id: number;
    userId: string;
    sessionId: string;
    toolName: string;
    success: boolean;
    durationMs: number;
    paramsSummary: string;
    errorMessage: string;
    modelId: string;
    createdAt: string;
  }>;
}

/**
 * 获取工具调用统计
 * @param days 统计最近多少天（默认 7 天）
 */
export async function getToolUsageStats(days: number = 7): Promise<ToolUsageStats> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/tool-usage?days=${days}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<ToolUsageStats>(response);
}

/**
 * 响应工具调用确认请求
 */
export async function respondToConfirmation(
  confirmationId: string,
  confirmed: boolean,
): Promise<{ success: boolean; confirmationId: string }> {
  const response = await fetch(`${API_ENDPOINTS.BASE_URL}/chat/confirm`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ confirmationId, confirmed }),
  });
  return handleResponse<{ success: boolean; confirmationId: string }>(response);
}

// ============================================
// 缓存与限流管理 API
// ============================================

export interface CacheConfig {
  maxEntries: number;
  maxItemSizeKB: number;
  defaultTTLMinutes: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
  memoryUsageKB: number;
}

export interface RateLimiterConfig {
  fastPoolMax: number;
  streamingPoolMax: number;
  tokenWaitTimeout: number;
}

export interface RateLimiterStatus {
  fastPool: { running: number; max: number; queueLength: number };
  streamingPool: { running: number; max: number; queueLength: number };
  tokenBuckets: Record<string, number>;
}

/** 获取缓存统计 */
export async function getCacheStats(): Promise<CacheStats> {
  const response = await fetch(API_ENDPOINTS.CACHE_STATS, { headers: getAuthHeaders() });
  return handleResponse<CacheStats>(response);
}

/** 获取缓存配置 */
export async function getCacheConfig(): Promise<CacheConfig> {
  const response = await fetch(API_ENDPOINTS.CACHE_CONFIG, { headers: getAuthHeaders() });
  return handleResponse<CacheConfig>(response);
}

/** 更新缓存配置 */
export async function updateCacheConfig(config: Partial<CacheConfig>): Promise<{ success: boolean; message: string }> {
  const response = await fetch(API_ENDPOINTS.CACHE_CONFIG, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(config),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}

// ============================================
// AI 写作补全 API（编辑器幽灵补全 / 续写 / 改写）
// ============================================

/** 补全模式 */
export type CompletionMode = 'autocomplete' | 'continue' | 'rewrite';

/**
 * 请求 AI 写作补全（SSE 流式）
 *
 * 复用 sse-parser 解析 SSE 帧，通过 onDelta 回调实时推送文本片段。
 *
 * @param payload.mode      补全模式
 * @param payload.context   光标前文本或选中文本
 * @param payload.instruction 改写指令（仅 rewrite）
 * @param onDelta           每收到一个文本片段的回调
 * @param signal            AbortSignal，用于取消
 */
export async function requestCompletionStream(
  payload: { mode: CompletionMode; context: string; instruction?: string },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/ai/completion`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw new Error(`AI 补全请求失败 (HTTP ${response.status})`);
  }

  const stream = response.body!.pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buffer = '';

  // 监听 abort 信号：主动 cancel reader 中断流读取
  // 仅靠 fetch signal 无法中断已开始的流式读取，必须手动 cancel
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  // 超时保护：12 秒无数据视为连接 hang，自动中断
  // 后端心跳间隔 5 秒，正常情况每 5 秒内有数据；12 秒 = 2 个心跳周期 + 余量
  // 防止 SSE 流异常时 reader.read() 永远不返回，导致 finally 不执行、状态卡死
  const IDLE_TIMEOUT_MS = 12000;
  const readWithIdleTimeout = (): Promise<ReadableStreamDefaultReader<string>['read'] extends Promise<infer R> ? R : never> => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('AI 补全超时（30秒无响应）')), IDLE_TIMEOUT_MS);
    });
    return Promise.race([
      reader.read().then(result => {
        clearTimeout(timeoutId);
        return result;
      }),
      timeout,
    ]) as any;
  };

  try {
    while (true) {
      // 保险：abort 后即使 reader.read() 没立即 reject 也主动跳出
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await readWithIdleTimeout();
      if (done) break;

      buffer += value;
      const { events, remainingBuffer } = parseSSEFrames(buffer);
      buffer = remainingBuffer;

      for (const event of events) {
        if (event.eventType === 'content') {
          try {
            const text = JSON.parse(event.eventData);
            onDelta(text);
          } catch {
            onDelta(event.eventData);
          }
        } else if (event.eventType === 'error') {
          try {
            const data = JSON.parse(event.eventData);
            throw new Error(data.message || 'AI 补全出错');
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unexpected') throw e;
            throw new Error('AI 补全出错');
          }
        }
        // done / heartbeat 事件忽略
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/**
 * 请求 AI 补全（非流式，一次性返回完整结果）
 *
 * 用于自动补全场景：短文本、abort 100% 可靠、无流式 hang 风险
 *
 * @param payload.mode      补全模式
 * @param payload.context   光标前文本或选中文本
 * @param payload.instruction 改写指令（仅 rewrite）
 * @param signal            AbortSignal，用于取消
 * @returns 补全文本
 */
export async function requestCompletion(
  payload: { mode: CompletionMode; context: string; instruction?: string },
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/ai/complete`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw new Error(`AI 补全请求失败 (HTTP ${response.status})`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.message || 'AI 补全失败');
  }
  return data.suggestion || '';
}

/** 清空缓存 */
export async function clearCache(): Promise<{ success: boolean; message: string }> {
  const response = await fetch(API_ENDPOINTS.CACHE_CLEAR, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}

/** 获取限流器状态 */
export async function getRateLimiterStatus(): Promise<RateLimiterStatus> {
  const response = await fetch(API_ENDPOINTS.RATE_LIMITER_STATUS, { headers: getAuthHeaders() });
  return handleResponse<RateLimiterStatus>(response);
}

/** 获取限流器配置 */
export async function getRateLimiterConfig(): Promise<RateLimiterConfig> {
  const response = await fetch(API_ENDPOINTS.RATE_LIMITER_CONFIG, { headers: getAuthHeaders() });
  return handleResponse<RateLimiterConfig>(response);
}

/** 更新限流器配置 */
export async function updateRateLimiterConfig(config: Partial<RateLimiterConfig>): Promise<{ success: boolean; message: string }> {
  const response = await fetch(API_ENDPOINTS.RATE_LIMITER_CONFIG, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(config),
  });
  return handleResponse<{ success: boolean; message: string }>(response);
}
