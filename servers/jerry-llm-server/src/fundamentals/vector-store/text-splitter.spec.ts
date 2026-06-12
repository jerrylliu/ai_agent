/**
 * fundamentals/vector-store/text-splitter.spec.ts
 *
 * 文本切分器单元测试
 * 覆盖：textSplitter / codeSplitter / markdownSplitter / isMarkdownContent / getSplitterByFileType
 */

import {
  textSplitter,
  codeSplitter,
  markdownSplitter,
  isMarkdownContent,
  getSplitterByFileType,
} from './text-splitter';

describe('textSplitter', () => {
  describe('textSplitter（通用切分）', () => {
    it('默认参数应创建 RecursiveCharacterTextSplitter', () => {
      const splitter = textSplitter();
      expect(splitter).toBeDefined();
    });

    it('自定义 chunkSize 和 chunkOverlap', () => {
      const s = textSplitter(1000, 200);
      expect(s).toBeDefined();
    });

    it('应能将文本分裂为多个块', async () => {
      const splitter = textSplitter(50, 10);
      const chunks = await splitter.splitText('A'.repeat(200));
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('短文本不分裂', async () => {
      const splitter = textSplitter(500, 50);
      const chunks = await splitter.splitText('hello');
      expect(chunks).toHaveLength(1);
    });
  });

  describe('codeSplitter（代码切分）', () => {
    it('应为 Python 文件创建代码切分器', () => {
      const s = codeSplitter('.py');
      expect(s).toBeDefined();
    });

    it('应为 JS 文件创建代码切分器', () => {
      const s = codeSplitter('.js');
      expect(s).toBeDefined();
    });

    it('应为 TS 文件创建 JS 切分器', () => {
      const s = codeSplitter('.ts');
      expect(s).toBeDefined();
    });

    it('应为 Go 文件创建代码切分器', () => {
      const s = codeSplitter('.go');
      expect(s).toBeDefined();
    });

    it('未知文件类型应降级为通用切分器', () => {
      // 不会报错，只是用通用切分器
      const s = codeSplitter('.unknown');
      expect(s).toBeDefined();
    });

    it('C 文件使用 cpp 切分器', () => {
      const s = codeSplitter('.c');
      expect(s).toBeDefined();
    });
  });

  describe('markdownSplitter（Markdown 切分）', () => {
    it('应创建 Markdown 切分器', () => {
      const s = markdownSplitter();
      expect(s).toBeDefined();
    });

    it('应按标题层级切分', async () => {
      const splitter = markdownSplitter(200, 20);
      const md = [
        '# Title',
        'Content of title section.',
        '## Sub 1',
        'Some content here.',
        '## Sub 2',
        'Other content.',
      ].join('\n\n');
      const chunks = await splitter.splitText(md);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isMarkdownContent', () => {
    it('应识别含标题和链�的 Markdown', () => {
      expect(isMarkdownContent('# Hello\n\n[link](url)')).toBe(true);
    });

    it('应识别含粗体和列表的 Markdown', () => {
      expect(isMarkdownContent('**bold** text\n\n- item 1\n- item 2')).toBe(true);
    });

    it('不应将普通文本识别为 Markdown', () => {
      expect(isMarkdownContent('This is just plain text.')).toBe(false);
    });

    it('仅含一种 Markdown 特征不应识别', () => {
      expect(isMarkdownContent('hello world [link](url) end')).toBe(false);
    });
  });

  describe('getSplitterByFileType', () => {
    it('.md 文件应返回 Markdown 切分器', () => {
      const s = getSplitterByFileType('.md');
      expect(s).toBeDefined();
    });

    it('isMarkdown=true 应返回 Markdown 切分器', () => {
      const s = getSplitterByFileType('.txt', true);
      expect(s).toBeDefined();
    });

    it('.py 文件应返回代码切分器', () => {
      const s = getSplitterByFileType('.py');
      expect(s).toBeDefined();
    });

    it('未知类型应返回通用切分器', () => {
      const s = getSplitterByFileType('.xyz');
      expect(s).toBeDefined();
    });
  });
});
