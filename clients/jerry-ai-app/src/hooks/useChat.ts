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
  duplicateSession as duplicateSessionApi,
  exportSession as exportSessionApi,
  updateMessage as updateMessageApi,
  deleteMessage as deleteMessageApi,
  uploadFile,
  uploadToKnowledgeBase,
  extractDocument,
  getKnowledgeBaseStatus,
  getModelInfo,
  switchModel as switchModelApi,
  setModelApiKey,
} from '../lib/api';
import type { AvailableModel, ToolStatusEvent, ConfirmationRequestEvent } from '../lib/api';
import type { AppSettings } from '../stores/settings-store';
import { generateId, generateSessionId } from '../lib/utils';
import { ERROR_MESSAGE } from '../lib/constants';
import { Session, Message, HistoryItem } from '../types/session';

/**
 * 待发送文档：上传后未实际发出的文档
 * 输入框上方显示预览卡片，用户可移除或点【发送】触发实际发送
 */
export interface PendingDocument {
  /** 唯一 ID（用于列表 key 和移除） */
  id: string;
  /** 文件名 */
  fileName: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 提取出的纯文本（用于发送给 AI） */
  text: string;
  /** Tiptap JSONContent（用于"在编辑器中打开"） */
  contentJson: unknown;
  /** 文件下载 URL */
  fileUrl: string;
  /** 是否被截断 */
  truncated: boolean;
  /** 文档原始总字符数（截断前） */
  totalChars?: number;
  /** 后端文档记录 ID */
  documentId?: number;
}

export function useChat(isAuthenticated?: boolean, appSettings?: AppSettings, onConfirmationRequest?: (event: ConfirmationRequestEvent) => void) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => generateSessionId());
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  /**
   * 待发送的文档列表
   * 用户上传文档后先放进这里，输入框上方显示预览卡片
   * 用户点【发送】按钮时才把内容拼接到消息里实际发出
   */
  const [pendingDocuments, setPendingDocuments] = useState<PendingDocument[]>([]);
  /**
   * 正在解析的文档信息（用于显示进度条）
   * 非图片文档上传解析期间设为 { fileName }，解析完成后置 null
   */
  const [parsingFile, setParsingFile] = useState<{ fileName: string } | null>(null);
  const [knowledgeBaseStatus, setKnowledgeBaseStatus] = useState<{
    status: 'ready' | 'empty' | 'error' | 'unknown';
    message: string;
    stats?: { documentCount: number; uploadedDocumentCount: number; knowledgeSourcePageCount: number; collectionName: string };
    hasContentUpdate?: boolean;
  }>({ status: 'unknown', message: '未检查知识库状态' });
  const [currentModelId, setCurrentModelId] = useState<string>('ollama:minicpm');
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [hasDeepseekApiKey, setHasDeepseekApiKey] = useState(false);
  const [hasZhipuApiKey, setHasZhipuApiKey] = useState(false);
  const [supportsVision, setSupportsVision] = useState(true);
  const [toolStatuses, setToolStatuses] = useState<ToolStatusEvent[]>([]);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  // 记录哪些会话曾经有过内容（卸载所有消息后也不回欢迎页）
  const [sessionHasContent, setSessionHasContent] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('session-has-content');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  // 消息加载的 AbortController，切换会话时取消旧请求
  const messageLoadAbortRef = useRef<AbortController | null>(null);
  // 消息内存缓存：sessionId → Message[]，切换会话时先读缓存避免空白页
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());

  // 辅助: 标记会话有内容 + 持久化
  const markSessionHasContent = (sessionId: string) => {
    setSessionHasContent((prev: Set<string>) => {
      if (prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.add(sessionId);
      localStorage.setItem('session-has-content', JSON.stringify([...next]));
      return next;
    });
  };

  // 辅助: 移除会话的内容标记
  const unmarkSessionContent = (sessionId: string) => {
    setSessionHasContent((prev: Set<string>) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      localStorage.setItem('session-has-content', JSON.stringify([...next]));
      return next;
    });
  };

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
        setHasZhipuApiKey(info.hasZhipuApiKey);
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
        // 从 availableModels 中查找当前模型的 supportsVision
        const model = availableModels.find(m => m.id === modelId);
        if (model) {
          setSupportsVision(model.supportsVision);
        }
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
      if (result.success && provider === 'zhipu') {
        setHasZhipuApiKey(true);
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
      setMessages([]);
      setHistory([]);
      setSessionHasContent(new Set());
      localStorage.removeItem('session-has-content');
      setCurrentSessionId(generateSessionId());
    }
  }, [isAuthenticated]);

  // 同步 currentSessionId 到 ref，供异步回调中读取最新值
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // 切换会话时加载消息
  useEffect(() => {
    if (currentSessionId) {
      loadSessionMessages(currentSessionId);
    }
  }, [currentSessionId]);

  const loadSessions = async (skipAutoSwitch = false) => {
    try {
      setIsLoading(true);
      const sessionsData = await getSessions();
      setSessions(sessionsData);

      if (!skipAutoSwitch && sessionsData.length > 0) {
        setCurrentSessionId(sessionsData[0].sessionId);
      }
      return sessionsData;
    } catch (error) {
      console.error('加载会话失败:', error);
      return [];
    } finally {
      setIsLoading(false);
    }
  };

  const loadSessionMessages = async (sessionId: string) => {
    // 先读缓存，有则直接使用，不发请求
    const cached = messagesCacheRef.current.get(sessionId);
    if (cached) {
      setMessages(cached);
      setIsMessagesLoading(false);
      return;
    }

    // 无缓存，从服务器加载
    messageLoadAbortRef.current?.abort();
    const controller = new AbortController();
    messageLoadAbortRef.current = controller;

    setMessages([]);
    setIsMessagesLoading(true);

    try {
      const messagesData = await getSessionMessages(sessionId);
      if (controller.signal.aborted) return;
      if (currentSessionIdRef.current !== sessionId) return;
      if (messagesData.length > 0) {
        const formattedMessages: Message[] = messagesData.map((msg: any) => ({
          id: msg.id.toString(),
          content: msg.content,
          role: msg.role as 'user' | 'assistant',
          timestamp: new Date(msg.createdAt),
          attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
          // 还原持久化的文档卡片（后端以 JSON 字符串存储，已由 service 反序列化为数组）
          documentCards: Array.isArray(msg.documentCards) ? msg.documentCards : undefined,
        }));
        setMessages(formattedMessages);
        messagesCacheRef.current.set(sessionId, formattedMessages);
        markSessionHasContent(sessionId);
      } else {
        setMessages([]);
        messagesCacheRef.current.set(sessionId, []);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      console.error('加载会话消息失败:', error);
      if (currentSessionIdRef.current !== sessionId) return;
      // 出错时不清空消息，保留当前显示状态
    } finally {
      if (currentSessionIdRef.current === sessionId) {
        setIsMessagesLoading(false);
      }
    }
  };

  // 注意：自动滚动已移至 ChatAgent.tsx 中通过虚拟滚动 virtualizer 处理

  const createNewSession = async () => {
    const newSessionId = generateSessionId();
    const sessionTitle = '新对话';

    try {
      await createSession(newSessionId, sessionTitle);
      await loadSessions(true);
      setCurrentSessionId(newSessionId);
      setMessages([]);
      setHistory([]);
      // 新会话缓存空消息
      messagesCacheRef.current.set(newSessionId, []);
    } catch (error) {
      console.error('创建新会话失败:', error);
    }
  };

  const switchSession = (sessionId: string) => {
    if (sessionId === currentSessionId) return;
    // 先从缓存读取，避免切换瞬间空白
    const cached = messagesCacheRef.current.get(sessionId);
    if (cached) {
      setMessages(cached);
      setIsMessagesLoading(false);
    } else {
      setMessages([]);
      setIsMessagesLoading(true);
    }
    setHistory([]);
    setCurrentSessionId(sessionId);
  };

  const deleteSessionById = async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      // 清理该会话的内容标记和缓存
      unmarkSessionContent(sessionId);
      messagesCacheRef.current.delete(sessionId);
      const sessionsData = await loadSessions(true);

      // 如果删除的是当前会话，切换到第一个剩余会话或创建新会话
      if (sessionId === currentSessionId) {
        if (sessionsData.length > 0) {
          setCurrentSessionId(sessionsData[0].sessionId);
        } else {
          createNewSession();
        }
      }
    } catch (error) {
      console.error('删除会话失败:', error);
    }
  };

  const sendMessage = async (userInput: string, images: string[] = [], documents: PendingDocument[] = []) => {
    if (!userInput.trim() && images.length === 0 && documents.length === 0) return;

    // 发消息即标记该会话有内容
    markSessionHasContent(currentSessionId);

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

    // 拼装"发给 AI"的内容：用户输入文字 + 文档全文（含截断标记）
    // 这部分是 AI 实际看到的，包括所有文档原文
    let aiInputContent = userInput.trim();
    if (documents.length > 0) {
      const docSections = documents.map(doc => {
        const truncationNote = doc.truncated
          ? `\n[注：文档过长，原文共 ${doc.totalChars ?? '?'} 字符，已截取前 ${doc.text.length} 字符。如需回答后半部分内容，请将文档上传到文档管理并发布到知识库]`
          : '';
        if (doc.text) {
          return `【文档：${doc.fileName}】\n${doc.text}${truncationNote}`;
        }
        return `【文档：${doc.fileName}】(${doc.fileUrl})`;
      });
      aiInputContent = aiInputContent
        ? `${aiInputContent}\n\n${docSections.join('\n\n')}`
        : docSections.join('\n\n');
    }

    // "展示给用户"的内容：只放用户输入的文字（不含文档全文）
    // 文档以卡片形式渲染在气泡里，不污染聊天界面
    const displayContent = userInput.trim();

    const userMessage: Message = {
      id: generateId(),
      content: displayContent,
      images: images.length > 0 ? images : undefined,
      role: 'user',
      timestamp: new Date(),
      // 把所有文档的轻量元信息附加到消息上，供 ChatBubble 渲染卡片
      documentCards: documents.length > 0
        ? documents.map(d => ({
            id: d.id,
            fileName: d.fileName,
            sizeBytes: d.sizeBytes,
            charCount: d.text.length,
            truncated: d.truncated,
            totalChars: d.totalChars,
            fileUrl: d.fileUrl,
            contentJson: d.contentJson,
            documentId: d.documentId,
          }))
        : undefined,
    };

    setMessages(prev => [...prev, userMessage]);
    setIsTyping(true);
    setPendingImages([]);
    setPendingDocuments([]);

    // 创建 AbortController 用于取消请求
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const savedUserMsg = await saveChatHistory({
        sessionId: currentSessionId,
        role: 'user',
        content: displayContent,
        images,
        // 文档卡片随消息一起持久化，重启后仍可显示
        documentCards: userMessage.documentCards,
      });

      // 用数据库返回的 ID 更新前端消息 ID，确保删除时能匹配
      if (savedUserMsg?.id) {
        setMessages(prev => prev.map(msg =>
          msg.id === userMessage.id ? { ...msg, id: savedUserMsg.id.toString() } : msg
        ));
      }

      // 检查是否是第一条消息
      const isFirstMessage = messages.length === 0;
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
      const chatHistory = messages;

      // 创建一个临时的助手消息 ID
      const assistantMessageId = generateId();
      const tempAssistantMessage: Message = {
        id: assistantMessageId,
        content: '',
        role: 'assistant',
        timestamp: new Date(),
        fromKnowledgeBase: false,
        attachments: [],
      };
      setMessages(prev => [...prev, tempAssistantMessage]);

      // 处理流式响应（传入图片和 signal）
      const aiResponse = await getAIResponse(aiInputContent, images, chatHistory, currentSessionId, abortController.signal, {
        memoryEnabled: appSettings?.memoryEnabled ?? true,
        summaryEnabled: appSettings?.summaryEnabled ?? true,
        injectMemory: appSettings?.injectMemoryOnNewSession ?? true,
        imageModel: appSettings?.imageModel ?? 'wan2.7-image-pro',
        onToolStatus: (event) => {
          setToolStatuses(prev => {
            // 更新同名工具的状态，或追加新工具
            const idx = prev.findIndex(e => e.toolName === event.toolName);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = event;
              return updated;
            }
            return [...prev, event];
          });
        },
        onConfirmationRequest: onConfirmationRequest || undefined,
        onFileCard: (event) => {
          // 实时把文件卡片挂到正在生成的 AI 消息上
          setMessages(prev => prev.map(msg =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  attachments: [
                    ...(msg.attachments || []),
                    {
                      key: event.key,
                      filename: event.filename,
                      format: event.format,
                      sizeBytes: event.sizeBytes,
                      downloadUrl: event.downloadUrl,
                      previewUrl: event.previewUrl,
                      expiresAt: event.expiresAt,
                      favorited: event.favorited,
                    },
                  ],
                }
              : msg
          ));
        },
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

      // 流式响应完成，清除工具状态
      setToolStatuses([]);

      // 保存完整的响应
      const savedAssistantMsg = await saveChatHistory({
        sessionId: currentSessionId,
        role: 'assistant',
        content: fullResponse,
      });

      // 用数据库返回的 ID 更新前端消息 ID，确保删除时能匹配
      if (savedAssistantMsg?.id) {
        setMessages(prev => prev.map(msg =>
          msg.id === assistantMessageId ? { ...msg, id: savedAssistantMsg.id.toString() } : msg
        ));
      }

      // 重新加载会话列表以更新会话标题和时间
      await loadSessions(true);

      // 处理 manage_session 工具返回的前端操作指令
      if (aiResponse.sessionAction) {
        handleSessionAction(aiResponse.sessionAction);
      }

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
      setToolStatuses([]);
      abortControllerRef.current = null;

      // 清理空的 AI 回复（连接断开或取消时，AI 可能没有输出任何内容）
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        const cleaned = (lastMsg && lastMsg.role === 'assistant' && !lastMsg.content.trim())
          ? prev.slice(0, -1)
          : prev;
        // 更新缓存（使用 ref 确保即使会话已切换也能写入正确的会话）
        messagesCacheRef.current.set(currentSessionIdRef.current, cleaned);
        return cleaned;
      });
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
      // 图片仍走原 uploadFile 接口（只需 URL），加到 pendingImages
      if (file.type.startsWith('image/')) {
        const uploadResult = await uploadFile(file);
        setPendingImages(prev => [...prev, uploadResult.url]);
        return;
      }

      // 非图片文档：走 extractDocument 提取内容，加到 pendingDocuments
      // 用户点【发送】时才实际拼接到消息里发送给 AI
      setParsingFile({ fileName: file.name });
      try {
        const result = await extractDocument(file);
        const pending: PendingDocument = {
          id: generateId(),
          fileName: result.fileName,
          sizeBytes: result.sizeBytes,
          text: result.text,
          contentJson: result.contentJson,
          fileUrl: result.fileUrl,
          truncated: result.truncated,
          totalChars: result.totalChars,
          documentId: result.documentId,
        };
        setPendingDocuments(prev => [...prev, pending]);
      } catch (err) {
        // 提取失败：用旧逻辑兜底（上传得到 URL，加到 pendingDocuments 仅作链接用）
        console.warn('文档内容提取失败，作为链接附件附加', err);
        const uploadResult = await uploadFile(file);
        const pending: PendingDocument = {
          id: generateId(),
          fileName: file.name,
          sizeBytes: file.size,
          text: '',
          contentJson: null,
          fileUrl: uploadResult.url,
          truncated: false,
        };
        setPendingDocuments(prev => [...prev, pending]);
      } finally {
        setParsingFile(null);
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

  const removePendingImage = (index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  };

  const clearPendingDocuments = () => {
    setPendingDocuments([]);
  };

  const removePendingDocument = (id: string) => {
    setPendingDocuments(prev => prev.filter(d => d.id !== id));
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
      setMessages(prev => {
        const updated = prev.map(msg =>
          msg.id === messageId ? { ...msg, content } : msg
        );
        // 同步更新缓存，防止切换会话后修改丢失
        messagesCacheRef.current.set(currentSessionId, updated);
        return updated;
      });
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

        const updated = prev.filter(msg => !idsToRemove.includes(msg.id));
        // 同步更新缓存，防止切换会话后已删除消息从旧缓存恢复
        messagesCacheRef.current.set(currentSessionId, updated);
        return updated;
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
      await loadSessions(true);
    } catch (error) {
      console.error('切换会话置顶状态失败:', error);
    }
  };

  const handleSessionAction = (action: { type: string; payload: any }) => {
    switch (action.type) {
      case 'switch_session':
        if (action.payload?.sessionId) {
          switchSession(action.payload.sessionId);
        }
        break;
      case 'create_session':
        // 创建会话已在后端完成，刷新列表并切换
        loadSessions(true);
        if (action.payload?.sessionId) {
          switchSession(action.payload.sessionId);
        }
        break;
      case 'delete_session':
        // 删除已在后端完成，刷新列表
        loadSessions(true);
        break;
      case 'refresh_sessions':
        loadSessions(true);
        break;
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

  const duplicateSessionById = async (sessionId: string) => {
    try {
      await duplicateSessionApi(sessionId);
      await loadSessions(true);
    } catch (error) {
      console.error('复制会话失败:', error);
      throw error;
    }
  };

  const exportSessionById = async (sessionId: string, format: 'json' | 'markdown' | 'text' = 'markdown') => {
    console.log('[导出] 开始导出会话:', sessionId, format);
    try {
      const result = await exportSessionApi(sessionId, format);
      console.log('[导出] API 返回成功:', result.filename);

      let content: string;
      let mimeType: string;
      const ext = format === 'markdown' ? 'md' : format === 'text' ? 'txt' : 'json';
      const filename = result.filename || `session_export.${ext}`;

      if (format === 'json') {
        content = JSON.stringify({
          session: result.session,
          messages: result.messages,
          exportedAt: result.exportedAt,
        }, null, 2);
        mimeType = 'application/json';
      } else {
        content = result.content || '';
        mimeType = format === 'markdown' ? 'text/markdown' : 'text/plain';
      }

      // 尝试使用 Tauri 原生文件保存对话框
      let saved = false;
      try {
        const isTauri = !!(window as any).__TAURI_INTERNALS__;
        if (isTauri) {
          const { save } = await import('@tauri-apps/plugin-dialog');
          const { writeTextFile } = await import('@tauri-apps/plugin-fs');
          const filePath = await save({
            defaultPath: filename,
            filters: [{
              name: format === 'markdown' ? 'Markdown' : format === 'json' ? 'JSON' : 'Text',
              extensions: [ext],
            }],
          });
          if (filePath) {
            console.log('[导出] Tauri 保存路径:', filePath);
            await writeTextFile(filePath, content);
            saved = true;
          }
        }
      } catch (e) {
        console.warn('[导出] Tauri 保存失败，降级为浏览器下载:', e);
      }

      if (!saved) {
        // 浏览器 / Tauri WebView 通用下载方式
        const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('[导出] 导出会话失败:', error);
      throw error;
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
    isMessagesLoading,
    toolStatuses,
    messagesEndRef,
    knowledgeBaseStatus,
    pendingImages,
    pendingDocuments,
    parsingFile,
    sessionHasContent,
    sendMessage,
    sendFile,
    clearPendingImages,
    removePendingImage,
    clearPendingDocuments,
    removePendingDocument,
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
    duplicateSession: duplicateSessionById,
    exportSession: exportSessionById,
    currentModelId,
    availableModels,
    hasDeepseekApiKey,
    hasZhipuApiKey,
    supportsVision,
    switchModel,
    configureApiKey,
  };
}
