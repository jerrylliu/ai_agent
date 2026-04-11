import { useState, useRef, useEffect } from 'react';
import { 
  saveChatHistory, 
  getAIResponse, 
  getSessions, 
  createSession, 
  deleteSession, 
  getSessionMessages, 
  updateSessionTitle, 
  toggleSessionPin,
  updateMessage as updateMessageApi,
  deleteMessage as deleteMessageApi,
  uploadFile
} from '../lib/api';
import { generateId, generateSessionId } from '../lib/utils';
import { DEFAULT_MESSAGE, ERROR_MESSAGE } from '../lib/constants';
import { Session, Message, HistoryItem } from '../types/session';
import { ChatHistoryRecord, UploadResponse } from '../lib/api';

export function useChat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => generateSessionId());
  const [messages, setMessages] = useState<Message[]>([DEFAULT_MESSAGE]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 加载所有会话
  useEffect(() => {
    loadSessions();
  }, []);

  // 切换会话时加载消息
  useEffect(() => {
    if (currentSessionId) {
      loadSessionMessages(currentSessionId);
    }
  }, [currentSessionId]);

  const loadSessions = async () => {
    try {
      setIsLoading(true);
      const sessionsData = await getSessions();
      setSessions(sessionsData);
      
      // 如果有会话，使用第一个会话作为当前会话
      if (sessionsData.length > 0) {
        setCurrentSessionId(sessionsData[0].sessionId);
      }
    } catch (error) {
      console.error('加载会话失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadSessionMessages = async (sessionId: string) => {
    try {
      const messagesData = await getSessionMessages(sessionId);
      if (messagesData.length > 0) {
        const formattedMessages: Message[] = messagesData.map((msg: any) => ({
          id: msg.id.toString(),
          content: msg.content,
          role: msg.role as 'user' | 'assistant',
          timestamp: new Date(msg.createdAt),
        }));
        setMessages(formattedMessages);
      } else {
        setMessages([DEFAULT_MESSAGE]);
      }
    } catch (error) {
      console.error('加载会话消息失败:', error);
      setMessages([DEFAULT_MESSAGE]);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const createNewSession = async () => {
    const newSessionId = generateSessionId();
    const sessionTitle = '新对话';
    
    try {
      await createSession(newSessionId, sessionTitle);
      await loadSessions();
      setCurrentSessionId(newSessionId);
      setMessages([DEFAULT_MESSAGE]);
      setHistory([]);
    } catch (error) {
      console.error('创建新会话失败:', error);
    }
  };

  const switchSession = (sessionId: string) => {
    setCurrentSessionId(sessionId);
  };

  const deleteSessionById = async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      await loadSessions();
      
      // 如果删除的是当前会话，切换到第一个会话
      if (sessionId === currentSessionId && sessions.length > 1) {
        const remainingSessions = sessions.filter(s => s.sessionId !== sessionId);
        if (remainingSessions.length > 0) {
          setCurrentSessionId(remainingSessions[0].sessionId);
        } else {
          createNewSession();
        }
      }
    } catch (error) {
      console.error('删除会话失败:', error);
    }
  };

  const sendMessage = async (userInput: string) => {
    if (!userInput.trim()) return;

    const userMessage: Message = {
      id: generateId(),
      content: userInput,
      role: 'user',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setIsTyping(true);

    try {
      await saveChatHistory({
        sessionId: currentSessionId,
        role: 'user',
        content: userInput,
      });

      // 检查是否是第一条消息（除了默认消息）
      const isFirstMessage = messages.length === 1 && messages[0].id === DEFAULT_MESSAGE.id;
      if (isFirstMessage) {
        // 更新会话标题为第一条消息内容
        const newTitle = userInput.substring(0, 50); // 限制标题长度
        await updateSessionTitle(currentSessionId, newTitle);
      }

      const newHistoryItem: HistoryItem = {
        id: generateId(),
        query: userInput,
        timestamp: new Date(),
      };
      setHistory(prev => [newHistoryItem, ...prev].slice(0, 10));

      const aiResponse = await getAIResponse(userInput);

      const assistantMessage: Message = {
        id: generateId(),
        content: aiResponse,
        role: 'assistant',
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, assistantMessage]);

      await saveChatHistory({
        sessionId: currentSessionId,
        role: 'assistant',
        content: aiResponse,
      });

      // 重新加载会话列表以更新会话标题和时间
      await loadSessions();

    } catch (error) {
      console.error('发送消息失败:', error);
      const errorMessage: Message = {
        id: generateId(),
        content: ERROR_MESSAGE,
        role: 'assistant',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsTyping(false);
    }
  };

  const sendFile = async (file: File) => {
    setIsTyping(true);

    try {
      const uploadResult = await uploadFile(file);
      const fileMessage = file.type.startsWith('image/') 
        ? `![图片](${uploadResult.url})` 
        : `[${file.name}](${uploadResult.url})`;

      await sendMessage(fileMessage);
    } catch (error) {
      console.error('上传文件失败:', error);
      const errorMessage: Message = {
        id: generateId(),
        content: '文件上传失败，请重试',
        role: 'assistant',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsTyping(false);
    }
  };

  const updateMessage = async (messageId: string, content: string) => {
    try {
      await updateMessageApi(messageId, content);
      // 更新本地消息列表
      setMessages(prev => prev.map(msg => 
        msg.id === messageId ? { ...msg, content } : msg
      ));
    } catch (error) {
      console.error('更新消息失败:', error);
      throw error;
    }
  };

  const deleteMessage = async (messageId: string) => {
    try {
      await deleteMessageApi(messageId);
      // 从本地消息列表中移除
      setMessages(prev => prev.filter(msg => msg.id !== messageId));
    } catch (error) {
      console.error('删除消息失败:', error);
      throw error;
    }
  };

  const clearHistory = () => {
    setHistory([]);
  };

  const toggleSessionPinById = async (sessionId: string) => {
    try {
      await toggleSessionPin(sessionId);
      await loadSessions();
    } catch (error) {
      console.error('切换会话置顶状态失败:', error);
    }
  };

  return {
    sessions,
    currentSessionId,
    messages,
    history,
    isTyping,
    isLoading,
    messagesEndRef,
    sendMessage,
    sendFile,
    updateMessage,
    deleteMessage,
    clearHistory,
    createNewSession,
    switchSession,
    deleteSession: deleteSessionById,
    toggleSessionPin: toggleSessionPinById,
  };
}
