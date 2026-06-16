export interface Session {
  id: number;
  sessionId: string;
  title: string;
  userId: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAttachment {
  /** 文件 key（用于拼接下载/预览 URL，与后端 fc://document/{key} 对应） */
  key: string;
  filename: string;
  format: string;
  sizeBytes: number;
  /** 后端相对路径，前端拼接 baseUrl 使用 */
  downloadUrl: string;
  previewUrl: string;
  /** 过期时间戳（毫秒） */
  expiresAt: number;
  /** 用户收藏标记。收藏的文档不参与自动清理 */
  favorited?: boolean;
}

export interface Message {
  id: string;
  content: string;
  images?: string[];
  role: 'user' | 'assistant';
  timestamp: Date;
  fromKnowledgeBase?: boolean;
  contextCount?: number;
  /** AI 消息携带的文件附件（generate_document 等工具产物） */
  attachments?: MessageAttachment[];
}

export interface HistoryItem {
  id: string;
  query: string;
  timestamp: Date;
}
