import { create } from 'zustand';

interface ToolConfirmation {
  id: string;
  toolName: string;
  paramsSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  message: string;
}

interface ConfirmState {
  // 删除消息确认弹窗
  deleteMsgConfirmOpen: boolean;
  deleteMsgTargetId: string | null;
  // 错误提示弹窗
  alertOpen: boolean;
  alertMessage: string;
  // 工具调用确认弹窗（队列模式，支持多个工具同时请求确认）
  toolConfirmationQueue: ToolConfirmation[];

  // Actions - 删除确认
  confirmDeleteMessage: (messageId: string) => void;
  cancelDeleteMessage: () => void;
  closeDeleteConfirm: () => void;
  // Actions - 错误提示
  showAlert: (message: string) => void;
  closeAlert: () => void;
  // Actions - 工具确认
  showToolConfirmation: (confirmation: ToolConfirmation) => void;
  closeToolConfirmation: () => void;
  /** 按 ID 从队列任意位置移除（用于飞书侧已解决后清掉对应弹窗） */
  removeToolConfirmationById: (id: string) => void;
  // 当前显示的确认（队列头部）
  currentToolConfirmation: () => ToolConfirmation | null;
}

export const useConfirmStore = create<ConfirmState>()((set, get) => ({
  deleteMsgConfirmOpen: false,
  deleteMsgTargetId: null,
  alertOpen: false,
  alertMessage: '',
  toolConfirmationQueue: [],

  confirmDeleteMessage: (messageId) =>
    set({ deleteMsgConfirmOpen: true, deleteMsgTargetId: messageId }),
  cancelDeleteMessage: () =>
    set({ deleteMsgConfirmOpen: false, deleteMsgTargetId: null }),
  closeDeleteConfirm: () =>
    set({ deleteMsgConfirmOpen: false }),

  showAlert: (message) =>
    set({ alertOpen: true, alertMessage: message }),
  closeAlert: () =>
    set({ alertOpen: false, alertMessage: '' }),

  showToolConfirmation: (confirmation) =>
    set((state) => ({ toolConfirmationQueue: [...state.toolConfirmationQueue, confirmation] })),
  closeToolConfirmation: () =>
    set((state) => ({ toolConfirmationQueue: state.toolConfirmationQueue.slice(1) })),
  removeToolConfirmationById: (id) =>
    set((state) => ({
      toolConfirmationQueue: state.toolConfirmationQueue.filter((c) => c.id !== id),
    })),
  currentToolConfirmation: () => get().toolConfirmationQueue[0] || null,
}));
