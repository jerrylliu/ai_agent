import { create } from 'zustand';

interface ToastState {
  show: boolean;
  message: string;
  x: number;
  y: number;
}

interface FeedbackState {
  copyToast: ToastState;
  feedbackToast: ToastState;
  feedbackState: Record<string, 'positive' | 'negative' | null>;
  kbFeedback: {
    show: boolean;
    success: boolean;
    message: string;
  };

  // Actions
  showCopyToast: (message: string, x: number, y: number) => void;
  hideCopyToast: () => void;
  showFeedbackToast: (message: string, x: number, y: number) => void;
  hideFeedbackToast: () => void;
  setFeedbackState: (state: Record<string, 'positive' | 'negative' | null>) => void;
  setKbFeedback: (feedback: { show: boolean; success: boolean; message: string }) => void;
  hideKbFeedback: () => void;
}

const emptyToast: ToastState = { show: false, message: '', x: 0, y: 0 };

export const useToastStore = create<FeedbackState>()((set) => ({
  copyToast: { ...emptyToast },
  feedbackToast: { ...emptyToast },
  feedbackState: {},
  kbFeedback: { show: false, success: false, message: '' },

  showCopyToast: (message, x, y) => set({ copyToast: { show: true, message, x, y } }),
  hideCopyToast: () => set({ copyToast: { ...emptyToast } }),
  showFeedbackToast: (message, x, y) => set({ feedbackToast: { show: true, message, x, y } }),
  hideFeedbackToast: () => set({ feedbackToast: { ...emptyToast } }),
  setFeedbackState: (state) => set({ feedbackState: state }),
  setKbFeedback: (feedback) => set({ kbFeedback: feedback }),
  hideKbFeedback: () => set({ kbFeedback: { show: false, success: false, message: '' } }),
}));
