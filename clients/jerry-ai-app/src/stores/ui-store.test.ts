import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './ui-store';

describe('useUIStore', () => {
  beforeEach(() => {
    // 每个测试前重置到初始状态
    useUIStore.setState({
      showSidebar: true,
      showModelPanel: false,
      showAuthDialog: false,
      showApiKeyDialog: false,
      showSettings: false,
      showDocumentManager: false,
      showKnowledgeSourceManager: false,
      showMemorySummary: false,
      showTokenUsage: false,
      showEvaluation: false,
      showMoreMenu: false,
      showHistoryList: true,
      showRecentQuestions: true,
      inputValue: '',
      searchKeyword: '',
      apiKeyInput: '',
      apiKeyDialogProvider: 'deepseek',
      avatarUploading: false,
      inputMode: 'center',
    });
  });

  describe('默认值', () => {
    it('showSidebar 默认为 true', () => {
      expect(useUIStore.getState().showSidebar).toBe(true);
    });

    it('showHistoryList 默认为 true', () => {
      expect(useUIStore.getState().showHistoryList).toBe(true);
    });

    it('showRecentQuestions 默认为 true', () => {
      expect(useUIStore.getState().showRecentQuestions).toBe(true);
    });

    it('所有弹窗默认为 false', () => {
      const state = useUIStore.getState();
      expect(state.showModelPanel).toBe(false);
      expect(state.showAuthDialog).toBe(false);
      expect(state.showApiKeyDialog).toBe(false);
      expect(state.showSettings).toBe(false);
      expect(state.showDocumentManager).toBe(false);
      expect(state.showKnowledgeSourceManager).toBe(false);
      expect(state.showMemorySummary).toBe(false);
      expect(state.showTokenUsage).toBe(false);
      expect(state.showEvaluation).toBe(false);
      expect(state.showMoreMenu).toBe(false);
    });

    it('输入状态默认为空', () => {
      const state = useUIStore.getState();
      expect(state.inputValue).toBe('');
      expect(state.searchKeyword).toBe('');
      expect(state.apiKeyInput).toBe('');
    });

    it('apiKeyDialogProvider 默认为 deepseek', () => {
      expect(useUIStore.getState().apiKeyDialogProvider).toBe('deepseek');
    });

    it('inputMode 默认为 center', () => {
      expect(useUIStore.getState().inputMode).toBe('center');
    });
  });

  describe('布尔开关 setter', () => {
    it('setShowSidebar 应切换侧边栏', () => {
      useUIStore.getState().setShowSidebar(false);
      expect(useUIStore.getState().showSidebar).toBe(false);
      useUIStore.getState().setShowSidebar(true);
      expect(useUIStore.getState().showSidebar).toBe(true);
    });

    it('setShowModelPanel 应切换模型面板', () => {
      useUIStore.getState().setShowModelPanel(true);
      expect(useUIStore.getState().showModelPanel).toBe(true);
    });

    it('setShowAuthDialog 应切换认证弹窗', () => {
      useUIStore.getState().setShowAuthDialog(true);
      expect(useUIStore.getState().showAuthDialog).toBe(true);
    });

    it('setShowApiKeyDialog 应切换 API Key 弹窗', () => {
      useUIStore.getState().setShowApiKeyDialog(true);
      expect(useUIStore.getState().showApiKeyDialog).toBe(true);
    });

    it('setShowSettings 应切换设置弹窗', () => {
      useUIStore.getState().setShowSettings(true);
      expect(useUIStore.getState().showSettings).toBe(true);
    });

    it('setShowDocumentManager 应切换文档管理器', () => {
      useUIStore.getState().setShowDocumentManager(true);
      expect(useUIStore.getState().showDocumentManager).toBe(true);
    });

    it('setShowKnowledgeSourceManager 应切换知识源管理器', () => {
      useUIStore.getState().setShowKnowledgeSourceManager(true);
      expect(useUIStore.getState().showKnowledgeSourceManager).toBe(true);
    });

    it('setShowMemorySummary 应切换记忆摘要弹窗', () => {
      useUIStore.getState().setShowMemorySummary(true);
      expect(useUIStore.getState().showMemorySummary).toBe(true);
    });

    it('setShowTokenUsage 应切换 Token 用量面板', () => {
      useUIStore.getState().setShowTokenUsage(true);
      expect(useUIStore.getState().showTokenUsage).toBe(true);
    });

    it('setShowEvaluation 应切换评估面板', () => {
      useUIStore.getState().setShowEvaluation(true);
      expect(useUIStore.getState().showEvaluation).toBe(true);
    });

    it('setShowMoreMenu 应切换更多菜单', () => {
      useUIStore.getState().setShowMoreMenu(true);
      expect(useUIStore.getState().showMoreMenu).toBe(true);
    });

    it('setShowHistoryList 应切换历史列表', () => {
      useUIStore.getState().setShowHistoryList(false);
      expect(useUIStore.getState().showHistoryList).toBe(false);
    });

    it('setShowRecentQuestions 应切换最近问题', () => {
      useUIStore.getState().setShowRecentQuestions(false);
      expect(useUIStore.getState().showRecentQuestions).toBe(false);
    });

    it('setAvatarUploading 应切换头像上传状态', () => {
      useUIStore.getState().setAvatarUploading(true);
      expect(useUIStore.getState().avatarUploading).toBe(true);
    });
  });

  describe('输入状态 setter', () => {
    it('setInputValue 应更新输入值', () => {
      useUIStore.getState().setInputValue('你好');
      expect(useUIStore.getState().inputValue).toBe('你好');
    });

    it('setSearchKeyword 应更新搜索关键词', () => {
      useUIStore.getState().setSearchKeyword('机器学习');
      expect(useUIStore.getState().searchKeyword).toBe('机器学习');
    });

    it('setApiKeyInput 应更新 API Key 输入', () => {
      useUIStore.getState().setApiKeyInput('sk-xxx');
      expect(useUIStore.getState().apiKeyInput).toBe('sk-xxx');
    });

    it('setApiKeyDialogProvider 应切换提供商', () => {
      useUIStore.getState().setApiKeyDialogProvider('zhipu');
      expect(useUIStore.getState().apiKeyDialogProvider).toBe('zhipu');
      useUIStore.getState().setApiKeyDialogProvider('deepseek');
      expect(useUIStore.getState().apiKeyDialogProvider).toBe('deepseek');
    });
  });

  describe('inputMode setter', () => {
    it('setInputMode 应切换输入模式', () => {
      useUIStore.getState().setInputMode('bottom');
      expect(useUIStore.getState().inputMode).toBe('bottom');
      useUIStore.getState().setInputMode('center');
      expect(useUIStore.getState().inputMode).toBe('center');
    });
  });

  describe('状态独立性', () => {
    it('修改一个开关不应影响其他开关', () => {
      useUIStore.getState().setShowModelPanel(true);
      const state = useUIStore.getState();
      expect(state.showModelPanel).toBe(true);
      expect(state.showSidebar).toBe(true);
      expect(state.showAuthDialog).toBe(false);
      expect(state.showSettings).toBe(false);
    });

    it('修改输入值不应影响开关状态', () => {
      useUIStore.getState().setInputValue('测试');
      const state = useUIStore.getState();
      expect(state.inputValue).toBe('测试');
      expect(state.showSidebar).toBe(true);
      expect(state.showModelPanel).toBe(false);
    });
  });
});
