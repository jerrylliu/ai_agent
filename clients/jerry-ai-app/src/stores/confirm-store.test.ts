import { describe, it, expect, beforeEach } from 'vitest';
import { useConfirmStore } from './confirm-store';

describe('useConfirmStore', () => {
  beforeEach(() => {
    // 重置到初始状态
    useConfirmStore.setState({
      deleteMsgConfirmOpen: false,
      deleteMsgTargetId: null,
      alertOpen: false,
      alertMessage: '',
      toolConfirmationQueue: [],
    });
  });

  describe('默认值', () => {
    it('deleteMsgConfirmOpen 默认为 false', () => {
      expect(useConfirmStore.getState().deleteMsgConfirmOpen).toBe(false);
    });

    it('deleteMsgTargetId 默认为 null', () => {
      expect(useConfirmStore.getState().deleteMsgTargetId).toBeNull();
    });

    it('alertOpen 默认为 false', () => {
      expect(useConfirmStore.getState().alertOpen).toBe(false);
    });

    it('alertMessage 默认为空', () => {
      expect(useConfirmStore.getState().alertMessage).toBe('');
    });
  });

  describe('confirmDeleteMessage', () => {
    it('应打开确认弹窗并设置目标 ID', () => {
      useConfirmStore.getState().confirmDeleteMessage('msg-123');
      const state = useConfirmStore.getState();
      expect(state.deleteMsgConfirmOpen).toBe(true);
      expect(state.deleteMsgTargetId).toBe('msg-123');
    });

    it('多次调用应更新目标 ID', () => {
      useConfirmStore.getState().confirmDeleteMessage('msg-1');
      useConfirmStore.getState().confirmDeleteMessage('msg-2');
      expect(useConfirmStore.getState().deleteMsgTargetId).toBe('msg-2');
    });
  });

  describe('cancelDeleteMessage', () => {
    it('应关闭确认弹窗并清空目标 ID', () => {
      useConfirmStore.getState().confirmDeleteMessage('msg-123');
      useConfirmStore.getState().cancelDeleteMessage();
      const state = useConfirmStore.getState();
      expect(state.deleteMsgConfirmOpen).toBe(false);
      expect(state.deleteMsgTargetId).toBeNull();
    });
  });

  describe('closeDeleteConfirm', () => {
    it('应关闭确认弹窗但不清空目标 ID', () => {
      useConfirmStore.getState().confirmDeleteMessage('msg-123');
      useConfirmStore.getState().closeDeleteConfirm();
      const state = useConfirmStore.getState();
      expect(state.deleteMsgConfirmOpen).toBe(false);
      // closeDeleteConfirm 只关闭弹窗，不清空 targetId
      expect(state.deleteMsgTargetId).toBe('msg-123');
    });
  });

  describe('showAlert', () => {
    it('应打开错误提示弹窗并设置消息', () => {
      useConfirmStore.getState().showAlert('操作失败');
      const state = useConfirmStore.getState();
      expect(state.alertOpen).toBe(true);
      expect(state.alertMessage).toBe('操作失败');
    });

    it('多次调用应更新消息', () => {
      useConfirmStore.getState().showAlert('错误1');
      useConfirmStore.getState().showAlert('错误2');
      expect(useConfirmStore.getState().alertMessage).toBe('错误2');
    });
  });

  describe('closeAlert', () => {
    it('应关闭错误提示弹窗并清空消息', () => {
      useConfirmStore.getState().showAlert('操作失败');
      useConfirmStore.getState().closeAlert();
      const state = useConfirmStore.getState();
      expect(state.alertOpen).toBe(false);
      expect(state.alertMessage).toBe('');
    });
  });

  describe('状态独立性', () => {
    it('确认弹窗和错误提示弹窗应独立', () => {
      useConfirmStore.getState().confirmDeleteMessage('msg-1');
      useConfirmStore.getState().showAlert('出错了');
      const state = useConfirmStore.getState();
      expect(state.deleteMsgConfirmOpen).toBe(true);
      expect(state.deleteMsgTargetId).toBe('msg-1');
      expect(state.alertOpen).toBe(true);
      expect(state.alertMessage).toBe('出错了');
    });

    it('关闭确认弹窗不应影响错误提示', () => {
      useConfirmStore.getState().confirmDeleteMessage('msg-1');
      useConfirmStore.getState().showAlert('出错了');
      useConfirmStore.getState().cancelDeleteMessage();
      const state = useConfirmStore.getState();
      expect(state.deleteMsgConfirmOpen).toBe(false);
      expect(state.alertOpen).toBe(true);
    });
  });
});
