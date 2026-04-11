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
  role: 'user' | 'assistant';
  timestamp: Date;
}

export interface HistoryItem {
  id: string;
  query: string;
  timestamp: Date;
}
