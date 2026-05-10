export const API_BASE_URL = 'http://localhost:3000';

export const API_ENDPOINTS = {
  BASE_URL: API_BASE_URL,
  PROMPT: `${API_BASE_URL}/prompt`,
  CHAT_HISTORY: `${API_BASE_URL}/chat-history`,
  ALL_CHAT_HISTORY: `${API_BASE_URL}/all-chat-history`,
  KNOWLEDGE_UPLOAD: `${API_BASE_URL}/knowledge/upload`,
  KNOWLEDGE_STATUS: `${API_BASE_URL}/knowledge/status`,
  KNOWLEDGE_SEARCH: `${API_BASE_URL}/knowledge/search`,
  MODELS: `${API_BASE_URL}/models`,
  MODELS_SWITCH: `${API_BASE_URL}/models/switch`,
  MODELS_APIKEY: `${API_BASE_URL}/models/apikey`,
  AUTH_REGISTER: `${API_BASE_URL}/auth/register`,
  AUTH_LOGIN: `${API_BASE_URL}/auth/login`,
  AUTH_PROFILE: `${API_BASE_URL}/auth/profile`,
  AUTH_VERIFY: `${API_BASE_URL}/auth/verify`,
  AUTH_CHANGE_PASSWORD: `${API_BASE_URL}/auth/password`,
  AUTH_AVATAR: `${API_BASE_URL}/auth/avatar`,
} as const;

export const MAX_HISTORY_ITEMS = 10;

export const DEFAULT_MESSAGE = {
  id: '1',
  content: '你好！我是你的智能助手，有什么可以帮助你的吗？',
  role: 'assistant' as const,
  timestamp: new Date(),
};

export const ERROR_MESSAGE = '抱歉，发生了错误，请稍后重试。';
