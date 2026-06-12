/**
 * components/Chat/ChatBubble.test.tsx
 *
 * ChatBubble 组件单元测试
 * - 用户消息渲染（文本 + 图片）
 * - AI 消息渲染（Markdown + 知识库标签）
 * - 反馈按钮（复制、点赞、点踩）
 * - 编辑/删除按钮
 * - 消息元信息（时间戳、已读标记、知识库来源）
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatBubble from './ChatBubble';

/* =====================================================================
 * Mock MarkdownRenderer — 简单透出 children
 * ==================================================================*/
vi.mock('../MarkdownRenderer', () => ({
  default: ({ children }: { children: string }) => <span data-testid="md">{children}</span>,
}));

/* =====================================================================
 * Mock lucide-react icons
 * ==================================================================*/
vi.mock('lucide-react', () => ({
  Database: () => <span data-testid="icon-db" />,
  ThumbsUp: () => <span data-testid="icon-up" />,
  ThumbsDown: () => <span data-testid="icon-down" />,
}));

/* =====================================================================
 * Mock submitFeedback API
 * ==================================================================*/
vi.mock('../../lib/api', () => ({
  submitFeedback: vi.fn(),
}));

const defaultProps = {
  message: {
    id: 'msg-1',
    content: 'Hello World',
    role: 'user' as const,
    timestamp: new Date('2025-06-01T12:00:00'),
  },
  prevMessage: undefined,
  currentSessionId: null,
  feedbackState: {},
  onFeedbackStateChange: vi.fn(),
  onCopyToast: vi.fn(),
  onFeedbackToast: vi.fn(),
  onUpdateMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
  onAlert: vi.fn(),
};

describe('ChatBubble', () => {
  /* ====================================================================
   * 用户消息
   * ==================================================================*/
  describe('用户消息', () => {
    it('应渲染用户消息内容', () => {
      render(<ChatBubble {...defaultProps} />);
      expect(screen.getByTestId('md')).toHaveTextContent('Hello World');
    });

    it('用户消息应显示已读标记', () => {
      render(<ChatBubble {...defaultProps} />);
      // 已读标记为 ✓ 字符
      expect(screen.getByText('✓')).toBeInTheDocument();
    });

    it('用户消息应显示编辑和删除按钮', () => {
      render(<ChatBubble {...defaultProps} />);
      // 有编辑和删除的 SVG 图标
      const svgs = document.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThanOrEqual(2);
    });

    it('应显示图片列表（如果有）', () => {
      const props = {
        ...defaultProps,
        message: {
          ...defaultProps.message,
          images: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
        },
      };

      render(<ChatBubble {...props} />);
      const imgs = document.querySelectorAll('img');
      expect(imgs).toHaveLength(2);
      expect(imgs[0]).toHaveAttribute('src', 'https://example.com/img1.jpg');
      expect(imgs[1]).toHaveAttribute('src', 'https://example.com/img2.jpg');
    });

    it('无图片时不应渲染 img 标签', () => {
      render(<ChatBubble {...defaultProps} />);
      const imgs = document.querySelectorAll('img');
      expect(imgs).toHaveLength(0);
    });
  });

  /* ====================================================================
   * AI 消息
   * ==================================================================*/
  describe('AI 消息', () => {
    const aiProps = {
      ...defaultProps,
      message: {
        ...defaultProps.message,
        role: 'assistant' as const,
        content: '你好，我是 AI 助手',
      },
    };

    it('应渲染 AI 消息内容', () => {
      render(<ChatBubble {...aiProps} />);
      expect(screen.getByTestId('md')).toHaveTextContent('你好，我是 AI 助手');
    });

    it('AI 消息应有反馈按钮（复制、点赞、点踩）', () => {
      render(<ChatBubble {...aiProps} />);
      // 应该有 3 个按钮：复制、点赞、点踩
      const buttons = screen.getAllByRole('button');
      const feedbackButtons = buttons.filter(
        (b) =>
          b.getAttribute('title') === '复制内容' ||
          b.getAttribute('title') === '有帮助' ||
          b.getAttribute('title') === '需改进',
      );
      expect(feedbackButtons).toHaveLength(3);
    });

    it('AI 消息不应有已读标记', () => {
      render(<ChatBubble {...aiProps} />);
      expect(screen.queryByText('✓')).toBeNull();
    });

    it('AI 消息不应有编辑/删除按钮', () => {
      render(<ChatBubble {...aiProps} />);
      const buttons = screen.getAllByRole('button');
      const editOrDelete = buttons.filter(
        (b) => !b.getAttribute('title'), // 编辑/删除没有 title 属性
      );
      expect(editOrDelete).toHaveLength(0);
    });
  });

  /* ====================================================================
   * 知识库来源标记
   * ==================================================================*/
  describe('知识库来源', () => {
    it('fromKnowledgeBase=true 时应显示知识库标签', () => {
      const props = {
        ...defaultProps,
        message: {
          ...defaultProps.message,
          role: 'assistant' as const,
          fromKnowledgeBase: true,
          contextCount: 5,
        },
      };

      render(<ChatBubble {...props} />);
      expect(screen.getByText('知识库')).toBeInTheDocument();
      expect(screen.getByText('(5条)')).toBeInTheDocument();
    });

    it('fromKnowledgeBase=false 时应不显示知识库标签', () => {
      const props = {
        ...defaultProps,
        message: {
          ...defaultProps.message,
          role: 'assistant' as const,
          fromKnowledgeBase: false,
        },
      };

      render(<ChatBubble {...props} />);
      expect(screen.queryByText('知识库')).toBeNull();
    });

    it('fromKnowledgeBase=true 但 contextCount 为 0 时应不显示数量', () => {
      const props = {
        ...defaultProps,
        message: {
          ...defaultProps.message,
          role: 'assistant' as const,
          fromKnowledgeBase: true,
          contextCount: 0,
        },
      };

      render(<ChatBubble {...props} />);
      // 知识库标签应出现
      expect(screen.getByTestId('icon-db')).toBeInTheDocument();
      // 但不应渲染数量 span（contextCount 为 0 时条件不满足）
      expect(screen.queryByText(/\(\d+条\)/)).toBeNull();
    });
  });

  /* ====================================================================
   * 时间戳
   * ==================================================================*/
  describe('时间戳', () => {
    it('应显示消息时间', () => {
      render(<ChatBubble {...defaultProps} />);
      // formatTime 使用 toLocaleTimeString，有具体的时间字符串
      const timeText = screen.getByText((_, el) => {
        return el?.tagName === 'P' && el.className.includes('text-xs');
      });
      expect(timeText).toBeInTheDocument();
    });
  });

  /* ====================================================================
   * 反馈状态
   * ==================================================================*/
  describe('反馈状态', () => {
    it('positive feedback 状态下点赞按钮应有绿色样式', () => {
      const props = {
        ...defaultProps,
        message: { ...defaultProps.message, role: 'assistant' as const },
        feedbackState: { 'msg-1': 'positive' as const },
      };

      render(<ChatBubble {...props} />);
      const upBtn = screen.getByTitle('有帮助');
      expect(upBtn.className).toContain('text-green-500');
    });

    it('negative feedback 状态下点踩按钮应有红色样式', () => {
      const props = {
        ...defaultProps,
        message: { ...defaultProps.message, role: 'assistant' as const },
        feedbackState: { 'msg-1': 'negative' as const },
      };

      render(<ChatBubble {...props} />);
      const downBtn = screen.getByTitle('需改进');
      expect(downBtn.className).toContain('text-red-500');
    });
  });
});
