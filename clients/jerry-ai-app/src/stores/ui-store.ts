import { create } from 'zustand';

interface UIState {
  // 面板/弹窗开关
  showSidebar: boolean;
  showModelPanel: boolean;
  showAuthDialog: boolean;
  showApiKeyDialog: boolean;
  showSettings: boolean;
  showDocumentManager: boolean;
  showKnowledgeSourceManager: boolean;
  showMemorySummary: boolean;
  showTokenUsage: boolean;
  showToolUsage: boolean;
  showEvaluation: boolean;
  showMoreMenu: boolean;
  showHistoryList: boolean;
  showRecentQuestions: boolean;
  // 输入状态
  inputValue: string;
  searchKeyword: string;
  apiKeyInput: string;
  apiKeyDialogProvider: 'deepseek' | 'zhipu';
  // 头像上传
  avatarUploading: boolean;
  // 输入框位置模式
  inputMode: 'center' | 'bottom';

  // 具名 setter
  setInputValue: (v: string) => void;
  setSearchKeyword: (v: string) => void;
  setShowMoreMenu: (v: boolean) => void;
  setShowApiKeyDialog: (v: boolean) => void;
  setApiKeyDialogProvider: (v: 'deepseek' | 'zhipu') => void;
  setApiKeyInput: (v: string) => void;
  setShowModelPanel: (v: boolean) => void;
  setShowSidebar: (v: boolean) => void;
  setShowHistoryList: (v: boolean) => void;
  setShowRecentQuestions: (v: boolean) => void;
  setShowAuthDialog: (v: boolean) => void;
  setShowMemorySummary: (v: boolean) => void;
  setShowTokenUsage: (v: boolean) => void;
  setShowToolUsage: (v: boolean) => void;
  setShowEvaluation: (v: boolean) => void;
  setShowSettings: (v: boolean) => void;
  setShowDocumentManager: (v: boolean) => void;
  setShowKnowledgeSourceManager: (v: boolean) => void;
  setAvatarUploading: (v: boolean) => void;
  setInputMode: (v: 'center' | 'bottom') => void;
}

export const useUIStore = create<UIState>()((set) => ({
  // 默认值
  showSidebar: true,
  showModelPanel: false,
  showAuthDialog: false,
  showApiKeyDialog: false,
  showSettings: false,
  showDocumentManager: false,
  showKnowledgeSourceManager: false,
  showMemorySummary: false,
  showTokenUsage: false,
  showToolUsage: false,
  showEvaluation: false,
  showMoreMenu: false,
  showHistoryList: true,
  showRecentQuestions: true,
  inputValue: '',
  searchKeyword: '',
  apiKeyInput: '',
  apiKeyDialogProvider: 'deepseek' as const,
  avatarUploading: false,
  inputMode: 'center' as const,

  // 具名 setter
  setInputValue: (v) => set({ inputValue: v }),
  setSearchKeyword: (v) => set({ searchKeyword: v }),
  setShowMoreMenu: (v) => set({ showMoreMenu: v }),
  setShowApiKeyDialog: (v) => set({ showApiKeyDialog: v }),
  setApiKeyDialogProvider: (v) => set({ apiKeyDialogProvider: v }),
  setApiKeyInput: (v) => set({ apiKeyInput: v }),
  setShowModelPanel: (v) => set({ showModelPanel: v }),
  setShowSidebar: (v) => set({ showSidebar: v }),
  setShowHistoryList: (v) => set({ showHistoryList: v }),
  setShowRecentQuestions: (v) => set({ showRecentQuestions: v }),
  setShowAuthDialog: (v) => set({ showAuthDialog: v }),
  setShowMemorySummary: (v) => set({ showMemorySummary: v }),
  setShowTokenUsage: (v) => set({ showTokenUsage: v }),
  setShowToolUsage: (v) => set({ showToolUsage: v }),
  setShowEvaluation: (v) => set({ showEvaluation: v }),
  setShowSettings: (v) => set({ showSettings: v }),
  setShowDocumentManager: (v) => set({ showDocumentManager: v }),
  setShowKnowledgeSourceManager: (v) => set({ showKnowledgeSourceManager: v }),
  setAvatarUploading: (v) => set({ avatarUploading: v }),
  setInputMode: (v) => set({ inputMode: v }),
}));
