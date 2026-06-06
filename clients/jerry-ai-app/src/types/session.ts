export interface Session {
  id: number;
  sessionId: string;
  title: string;
  userId: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  content: string;
  images?: string[];
  role: 'user' | 'assistant';
  timestamp: Date;
  fromKnowledgeBase?: boolean;
  contextCount?: number;
}

export interface HistoryItem {
  id: string;
  query: string;
  timestamp: Date;
}
