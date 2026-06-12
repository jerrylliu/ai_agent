import { describe, it, expect, beforeEach } from 'vitest';
import { useToastStore } from './toast-store';

describe('useToastStore', () => {
  beforeEach(() => {
    // 重置到初始状态
    useToastStore.setState({
      copyToast: { show: false, message: '', x: 0, y: 0 },
      feedbackToast: { show: false, message: '', x: 0, y: 0 },
      feedbackState: {},
      kbFeedback: { show: false, success: false, message: '' },
    });
  });

  describe('默认值', () => {
    it('copyToast 默认隐藏', () => {
      const toast = useToastStore.getState().copyToast;
      expect(toast.show).toBe(false);
      expect(toast.message).toBe('');
    });

    it('feedbackToast 默认隐藏', () => {
      const toast = useToastStore.getState().feedbackToast;
      expect(toast.show).toBe(false);
      expect(toast.message).toBe('');
    });

    it('feedbackState 默认为空', () => {
      expect(Object.keys(useToastStore.getState().feedbackState)).toHaveLength(0);
    });

    it('kbFeedback 默认隐藏', () => {
      const kb = useToastStore.getState().kbFeedback;
      expect(kb.show).toBe(false);
      expect(kb.success).toBe(false);
      expect(kb.message).toBe('');
    });
  });

  describe('copyToast', () => {
    it('showCopyToast 应显示复制提示', () => {
      useToastStore.getState().showCopyToast('已复制', 100, 200);
      const toast = useToastStore.getState().copyToast;
      expect(toast.show).toBe(true);
      expect(toast.message).toBe('已复制');
      expect(toast.x).toBe(100);
      expect(toast.y).toBe(200);
    });

    it('hideCopyToast 应隐藏复制提示', () => {
      useToastStore.getState().showCopyToast('已复制', 100, 200);
      expect(useToastStore.getState().copyToast.show).toBe(true);
      useToastStore.getState().hideCopyToast();
      const toast = useToastStore.getState().copyToast;
      expect(toast.show).toBe(false);
      expect(toast.message).toBe('');
    });
  });

  describe('feedbackToast', () => {
    it('showFeedbackToast 应显示反馈提示', () => {
      useToastStore.getState().showFeedbackToast('感谢反馈', 300, 400);
      const toast = useToastStore.getState().feedbackToast;
      expect(toast.show).toBe(true);
      expect(toast.message).toBe('感谢反馈');
      expect(toast.x).toBe(300);
      expect(toast.y).toBe(400);
    });

    it('hideFeedbackToast 应隐藏反馈提示', () => {
      useToastStore.getState().showFeedbackToast('感谢反馈', 300, 400);
      useToastStore.getState().hideFeedbackToast();
      const toast = useToastStore.getState().feedbackToast;
      expect(toast.show).toBe(false);
      expect(toast.message).toBe('');
    });
  });

  describe('feedbackState', () => {
    it('setFeedbackState 应更新反馈状态', () => {
      useToastStore.getState().setFeedbackState({ 'msg-1': 'positive' });
      expect(useToastStore.getState().feedbackState['msg-1']).toBe('positive');
    });

    it('应支持多条消息的反馈状态', () => {
      useToastStore.getState().setFeedbackState({
        'msg-1': 'positive',
        'msg-2': 'negative',
        'msg-3': null,
      });
      const state = useToastStore.getState().feedbackState;
      expect(state['msg-1']).toBe('positive');
      expect(state['msg-2']).toBe('negative');
      expect(state['msg-3']).toBeNull();
    });

    it('setFeedbackState 应替换而非合并', () => {
      useToastStore.getState().setFeedbackState({ 'msg-1': 'positive' });
      useToastStore.getState().setFeedbackState({ 'msg-2': 'negative' });
      const state = useToastStore.getState().feedbackState;
      expect(state['msg-1']).toBeUndefined();
      expect(state['msg-2']).toBe('negative');
    });
  });

  describe('kbFeedback', () => {
    it('setKbFeedback 应设置知识库反馈', () => {
      useToastStore.getState().setKbFeedback({ show: true, success: true, message: '操作成功' });
      const kb = useToastStore.getState().kbFeedback;
      expect(kb.show).toBe(true);
      expect(kb.success).toBe(true);
      expect(kb.message).toBe('操作成功');
    });

    it('setKbFeedback 应支持失败反馈', () => {
      useToastStore.getState().setKbFeedback({ show: true, success: false, message: '操作失败' });
      const kb = useToastStore.getState().kbFeedback;
      expect(kb.show).toBe(true);
      expect(kb.success).toBe(false);
      expect(kb.message).toBe('操作失败');
    });

    it('hideKbFeedback 应隐藏知识库反馈', () => {
      useToastStore.getState().setKbFeedback({ show: true, success: true, message: '操作成功' });
      useToastStore.getState().hideKbFeedback();
      const kb = useToastStore.getState().kbFeedback;
      expect(kb.show).toBe(false);
      expect(kb.success).toBe(false);
      expect(kb.message).toBe('');
    });
  });

  describe('状态独立性', () => {
    it('copyToast 和 feedbackToast 应独立', () => {
      useToastStore.getState().showCopyToast('复制', 1, 2);
      useToastStore.getState().showFeedbackToast('反馈', 3, 4);
      const state = useToastStore.getState();
      expect(state.copyToast.message).toBe('复制');
      expect(state.feedbackToast.message).toBe('反馈');
    });

    it('kbFeedback 不应影响 Toast 状态', () => {
      useToastStore.getState().showCopyToast('复制', 1, 2);
      useToastStore.getState().setKbFeedback({ show: true, success: true, message: '成功' });
      const state = useToastStore.getState();
      expect(state.copyToast.show).toBe(true);
      expect(state.kbFeedback.show).toBe(true);
    });
  });
});
