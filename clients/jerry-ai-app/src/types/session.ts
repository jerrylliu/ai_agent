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
  /**
   * 用户消息携带的文档卡片（聊天里上传文档时附加）
   * UI 渲染时把它们展示成卡片，不在 message.content 里堆全文
   */
  documentCards?: MessageDocumentCard[];
  /**
   * @deprecated 请使用 documentCards
   * 历史字段：单一文档的 contentJson，保留兼容
   */
  documentContentJson?: unknown;
  /** @deprecated 请使用 documentCards */
  documentFileName?: string;
}

/**
 * 消息中附加的文档卡片
 * 用户上传文档发送后，文档以卡片形式展示在用户气泡里
 */
export interface MessageDocumentCard {
  /** 唯一 ID */
  id: string;
  /** 文件名 */
  fileName: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 提取后的字符数（截断后） */
  charCount: number;
  /** 是否被截断 */
  truncated: boolean;
  /** 文档原始总字符数（截断前） */
  totalChars?: number;
  /** 文件下载 URL */
  fileUrl: string;
  /** Tiptap JSONContent，用于"在编辑器中打开" */
  contentJson: unknown;
  /** 后端文档记录 ID（有值时编辑器走版本管理逻辑） */
  documentId?: number;
}

export interface HistoryItem {
  id: string;
  query: string;
  timestamp: Date;
}
