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

  /* ====================================================================
   * 工具确认队列（toolConfirmationQueue）
   * 用于飞书双通道审批：Web 弹窗 + 飞书卡片
   * ==================================================================*/
  describe('toolConfirmationQueue 队列模式', () => {
    const makeConfirmation = (id: string, toolName = 'send_notification') => ({
      id,
      toolName,
      paramsSummary: `summary-${id}`,
      riskLevel: 'medium' as const,
      message: '请确认操作',
    });

    it('初始队列应为空，currentToolConfirmation 返回 null', () => {
      expect(useConfirmStore.getState().toolConfirmationQueue).toEqual([]);
      expect(useConfirmStore.getState().currentToolConfirmation()).toBeNull();
    });

    it('showToolConfirmation 应入队', () => {
      const conf = makeConfirmation('c-1');
      useConfirmStore.getState().showToolConfirmation(conf);
      const state = useConfirmStore.getState();
      expect(state.toolConfirmationQueue).toHaveLength(1);
      expect(state.toolConfirmationQueue[0]).toEqual(conf);
      expect(state.currentToolConfirmation()).toEqual(conf);
    });

    it('多次入队应按 FIFO 顺序排列', () => {
      useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-1'));
      useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-2'));
      useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-3'));
      const queue = useConfirmStore.getState().toolConfirmationQueue;
      expect(queue.map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3']);
      // current 总是队列头部
      expect(useConfirmStore.getState().currentToolConfirmation()?.id).toBe('c-1');
    });

    it('closeToolConfirmation 应移除队首', () => {
      useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-1'));
      useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-2'));
      useConfirmStore.getState().closeToolConfirmation();
      const queue = useConfirmStore.getState().toolConfirmationQueue;
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe('c-2');
      expect(useConfirmStore.getState().currentToolConfirmation()?.id).toBe('c-2');
    });

    it('空队列时调用 closeToolConfirmation 不应抛错', () => {
      expect(() =>
        useConfirmStore.getState().closeToolConfirmation(),
      ).not.toThrow();
      expect(useConfirmStore.getState().toolConfirmationQueue).toEqual([]);
    });

    /* ---- removeToolConfirmationById：飞书侧已解决时使用 ---- */
    describe('removeToolConfirmationById', () => {
      it('应按 ID 移除队列中任意位置的确认项', () => {
        useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-1'));
        useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-2'));
        useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-3'));

        // 移除中间的 c-2
        useConfirmStore.getState().removeToolConfirmationById('c-2');
        const queue = useConfirmStore.getState().toolConfirmationQueue;
        expect(queue.map((c) => c.id)).toEqual(['c-1', 'c-3']);
      });

      it('移除头部应让 current 切换到下一个', () => {
        useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-1'));
        useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-2'));
        useConfirmStore.getState().removeToolConfirmationById('c-1');
        expect(useConfirmStore.getState().currentToolConfirmation()?.id).toBe('c-2');
      });

      it('移除不存在的 ID 应不报错且队列不变', () => {
        useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-1'));
        useConfirmStore.getState().removeToolConfirmationById('not-exist');
        expect(useConfirmStore.getState().toolConfirmationQueue).toHaveLength(1);
        expect(
          useConfirmStore.getState().toolConfirmationQueue[0].id,
        ).toBe('c-1');
      });

      it('空队列调用 removeToolConfirmationById 应不报错', () => {
        expect(() =>
          useConfirmStore.getState().removeToolConfirmationById('any'),
        ).not.toThrow();
      });

      it('移除最后一项后 current 应为 null', () => {
        useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-1'));
        useConfirmStore.getState().removeToolConfirmationById('c-1');
        expect(useConfirmStore.getState().currentToolConfirmation()).toBeNull();
      });
    });

    it('工具确认队列与删除/Alert 弹窗状态相互独立', () => {
      useConfirmStore.getState().showToolConfirmation(makeConfirmation('c-1'));
      useConfirmStore.getState().confirmDeleteMessage('msg-1');
      useConfirmStore.getState().showAlert('error');
      // 任一独立 action 不应影响其他
      const state = useConfirmStore.getState();
      expect(state.toolConfirmationQueue).toHaveLength(1);
      expect(state.deleteMsgConfirmOpen).toBe(true);
      expect(state.alertOpen).toBe(true);
    });
  });
});
