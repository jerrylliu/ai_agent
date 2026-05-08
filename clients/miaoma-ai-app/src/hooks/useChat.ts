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
  uploadFile,
  uploadToKnowledgeBase,
  getKnowledgeBaseStatus
} from '../lib/api';
import { generateId, generateSessionId } from '../lib/utils';
import { DEFAULT_MESSAGE, ERROR_MESSAGE } from '../lib/constants';
import { Session, Message, HistoryItem } from '../types/session';

export function useChat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => generateSessionId());
  const [messages, setMessages] = useState<Message[]>([DEFAULT_MESSAGE]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [knowledgeBaseStatus, setKnowledgeBaseStatus] = useState<{
    status: 'ready' | 'empty' | 'error' | 'unknown';
    message: string;
    stats?: { documentCount: number; collectionName: string };
  }>({ status: 'unknown', message: '未检查知识库状态' });
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

  const sendMessage = async (userInput: string, images: string[] = []) => {
    if (!userInput.trim() && images.length === 0) return;

    const userMessage: Message = {
      id: generateId(),
      content: userInput,
      images: images.length > 0 ? images : undefined,
      role: 'user',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setIsTyping(true);
    setPendingImages([]);

    try {
      await saveChatHistory({
        sessionId: currentSessionId,
        role: 'user',
        content: userInput,
        images,
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

      // 准备历史消息（排除默认消息）
      const chatHistory = messages.filter(msg => msg.id !== DEFAULT_MESSAGE.id);

      // 创建一个临时的助手消息 ID
      const assistantMessageId = generateId();
      const tempAssistantMessage: Message = {
        id: assistantMessageId,
        content: '',
        role: 'assistant',
        timestamp: new Date(),
        fromKnowledgeBase: false,
      };
      setMessages(prev => [...prev, tempAssistantMessage]);

      // 处理流式响应（传入图片）
      const aiResponse = await getAIResponse(userInput, images, chatHistory);
      
      // 设置知识库来源标记
      const usedKnowledgeBase = aiResponse.usedKnowledgeBase;
      const contextCount = aiResponse.contextCount;
      
      setMessages(prev => prev.map(msg =>
        msg.id === assistantMessageId 
          ? { ...msg, fromKnowledgeBase: usedKnowledgeBase, contextCount } 
          : msg
      ));
      
      const reader = aiResponse.stream.getReader();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        fullResponse += value;
        setMessages(prev => prev.map(msg =>
          msg.id === assistantMessageId ? { ...msg, content: fullResponse } : msg
        ));
      }

      // 保存完整的响应
      await saveChatHistory({
        sessionId: currentSessionId,
        role: 'assistant',
        content: fullResponse,
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

  /**
   * 处理文件上传的核心函数
   * @param file 用户选择的文件（可以是图片或其他文件）
   *
   * 处理流程：
   * 1. 上传文件到服务器
   * 2. 如果是图片，加入待发送图片列表
   * 3. 如果是非图片文件，将其作为链接文本消息发送
   */
  const sendFile = async (file: File) => {
    try {
      const uploadResult = await uploadFile(file);

      if (file.type.startsWith('image/')) {
        setPendingImages(prev => [...prev, uploadResult.url]);
      } else {
        const fileMessage: Message = {
          id: generateId(),
          content: `[${file.name}](${uploadResult.url})`,
          role: 'user',
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, fileMessage]);
        setIsTyping(true);

        try {
          const chatHistory = messages.filter(msg => msg.id !== DEFAULT_MESSAGE.id);
          const assistantMessageId = generateId();
          const tempAssistantMessage: Message = {
            id: assistantMessageId,
            content: '',
            role: 'assistant',
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, tempAssistantMessage]);

          const aiResponse = await getAIResponse(fileMessage.content, [], chatHistory);
          const reader = aiResponse.stream.getReader();
          let fullResponse = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullResponse += value;
            setMessages(prev => prev.map(msg =>
              msg.id === assistantMessageId ? { ...msg, content: fullResponse } : msg
            ));
          }

          await saveChatHistory({
            sessionId: currentSessionId,
            role: 'assistant',
            content: fullResponse,
          });
        } catch (error) {
          console.error('处理文件消息失败:', error);
        } finally {
          setIsTyping(false);
        }
      }
    } catch (error) {
      console.error('上传文件失败:', error);
      const errorMessage: Message = {
        id: generateId(),
        content: '文件上传失败，请重试',
        role: 'assistant',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    }
  };

  const clearPendingImages = () => {
    setPendingImages([]);
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

  const checkKnowledgeBaseStatus = async () => {
    try {
      const status = await getKnowledgeBaseStatus();
      setKnowledgeBaseStatus(status);
      return status;
    } catch (error: any) {
      const errorStatus = {
        status: 'error' as const,
        message: `获取知识库状态失败: ${error.message}`,
      };
      setKnowledgeBaseStatus(errorStatus);
      return errorStatus;
    }
  };

  const uploadToKnowledgeBaseFromChat = async (file: File): Promise<{
    success: boolean;
    message: string;
    documentCount?: number;
  }> => {
    setIsTyping(true);
    try {
      const result = await uploadToKnowledgeBase(file);
      await checkKnowledgeBaseStatus();
      return result;
    } catch (error: any) {
      const errorResult = {
        success: false,
        message: `上传到知识库失败: ${error.message}`,
      };
      return errorResult;
    } finally {
      setIsTyping(false);
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
    knowledgeBaseStatus,
    pendingImages,
    sendMessage,
    sendFile,
    clearPendingImages,
    uploadToKnowledgeBase: uploadToKnowledgeBaseFromChat,
    checkKnowledgeBaseStatus,
    updateMessage,
    deleteMessage,
    clearHistory,
    createNewSession,
    switchSession,
    deleteSession: deleteSessionById,
    toggleSessionPin: toggleSessionPinById,
  };
}
