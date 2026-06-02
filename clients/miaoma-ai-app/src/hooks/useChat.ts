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
  getKnowledgeBaseStatus,
  getModelInfo,
  switchModel as switchModelApi,
  setModelApiKey,
} from '../lib/api';
import type { AvailableModel } from '../lib/api';
import type { AppSettings } from '../components/Settings/SettingsDialog';
import { generateId, generateSessionId } from '../lib/utils';
import { DEFAULT_MESSAGE, ERROR_MESSAGE } from '../lib/constants';
import { Session, Message, HistoryItem } from '../types/session';

export function useChat(isAuthenticated?: boolean, appSettings?: AppSettings) {
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
    stats?: { documentCount: number; uploadedDocumentCount: number; knowledgeSourcePageCount: number; collectionName: string };
    hasContentUpdate?: boolean;
  }>({ status: 'unknown', message: '未检查知识库状态' });
  const [currentModelId, setCurrentModelId] = useState<string>('ollama:minicpm');
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [hasDeepseekApiKey, setHasDeepseekApiKey] = useState(false);
  const [supportsVision, setSupportsVision] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadModelInfo();
  }, []);

  const loadModelInfo = async () => {
    try {
      const info = await getModelInfo();
      if (info.success) {
        setCurrentModelId(info.currentModelId);
        setAvailableModels(info.availableModels);
        setHasDeepseekApiKey(info.hasDeepseekApiKey);
        setSupportsVision(info.supportsVision);
      }
    } catch (error) {
      console.error('加载模型信息失败:', error);
    }
  };

  const switchModel = async (modelId: string) => {
    try {
      const result = await switchModelApi(modelId);
      if (result.success) {
        setCurrentModelId(modelId);
        console.log(`✅ 已切换模型: ${modelId}`);
      } else {
        console.error('切换模型失败:', result.message);
      }
      return result;
    } catch (error) {
      console.error('切换模型失败:', error);
      return { success: false, message: '切换模型失败' };
    }
  };

  const configureApiKey = async (provider: string, apiKey: string) => {
    try {
      const result = await setModelApiKey(provider, apiKey);
      if (result.success && provider === 'deepseek') {
        setHasDeepseekApiKey(true);
      }
      return result;
    } catch (error) {
      console.error('设置 API Key 失败:', error);
      return { success: false, message: '设置 API Key 失败' };
    }
  };

  // 加载所有会话
  useEffect(() => {
    loadSessions();
  }, []);

  // 认证状态变化时重新加载会话（登录/登出/切换账号）
  useEffect(() => {
    if (isAuthenticated) {
      loadSessions();
    } else {
      // 登出时清空会话和消息
      setSessions([]);
      setMessages([DEFAULT_MESSAGE]);
      setHistory([]);
      setCurrentSessionId(generateSessionId());
    }
  }, [isAuthenticated]);

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

    if (images.length > 0 && !supportsVision) {
      const errorMessage: Message = {
        id: generateId(),
        content: `⚠️ 当前模型不支持图片输入，请切换到支持图片的模型（如 MiniCPM）后再试。`,
        role: 'assistant',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
      return;
    }

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

    // 创建 AbortController 用于取消请求
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

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

      // 处理流式响应（传入图片和 signal）
      const aiResponse = await getAIResponse(userInput, images, chatHistory, currentSessionId, abortController.signal, {
        memoryEnabled: appSettings?.memoryEnabled ?? true,
        summaryEnabled: appSettings?.summaryEnabled ?? true,
        injectMemory: appSettings?.injectMemoryOnNewSession ?? true,
      });
      
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

    } catch (error: any) {
      // 用户主动取消，不显示错误
      if (error.name === 'AbortError') {
        console.log('🛑 用户停止了生成');
      } else {
        console.error('发送消息失败:', error);
        const errorMessage: Message = {
          id: generateId(),
          content: ERROR_MESSAGE,
          role: 'assistant',
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, errorMessage]);
      }
    } finally {
      setIsTyping(false);
      abortControllerRef.current = null;
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

        // 创建 AbortController 用于取消请求
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

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

          const aiResponse = await getAIResponse(fileMessage.content, [], chatHistory, currentSessionId, abortController.signal, {
            memoryEnabled: appSettings?.memoryEnabled ?? true,
            summaryEnabled: appSettings?.summaryEnabled ?? true,
            injectMemory: appSettings?.injectMemoryOnNewSession ?? true,
          });
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
        } catch (error: any) {
          if (error.name === 'AbortError') {
            console.log('🛑 用户停止了生成');
          } else {
            console.error('处理文件消息失败:', error);
          }
        } finally {
          setIsTyping(false);
          abortControllerRef.current = null;
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

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
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

      setMessages(prev => {
        const index = prev.findIndex(msg => msg.id === messageId);
        const idsToRemove = [messageId];

        if (index !== -1 && index + 1 < prev.length && prev[index + 1].role === 'assistant') {
          idsToRemove.push(prev[index + 1].id);
          deleteMessageApi(prev[index + 1].id).catch(err =>
            console.error('删除关联AI回复失败:', err)
          );
        }

        return prev.filter(msg => !idsToRemove.includes(msg.id));
      });
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

  const renameSession = async (sessionId: string, newTitle: string) => {
    // 乐观更新：先更新本地状态
    const prevSessions = sessions;
    setSessions(prev => prev.map(s =>
      s.sessionId === sessionId ? { ...s, title: newTitle } : s
    ));
    try {
      await updateSessionTitle(sessionId, newTitle);
    } catch (error) {
      // 失败则回滚
      console.error('更新会话标题失败:', error);
      setSessions(prevSessions);
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
    stopGeneration,
    uploadToKnowledgeBase: uploadToKnowledgeBaseFromChat,
    checkKnowledgeBaseStatus,
    updateMessage,
    deleteMessage,
    clearHistory,
    createNewSession,
    switchSession,
    deleteSession: deleteSessionById,
    toggleSessionPin: toggleSessionPinById,
    renameSession,
    currentModelId,
    availableModels,
    hasDeepseekApiKey,
    supportsVision,
    switchModel,
    configureApiKey,
  };
}
