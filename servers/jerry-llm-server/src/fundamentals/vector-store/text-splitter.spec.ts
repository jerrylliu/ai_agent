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
  getAdaptiveChunkingProfile,
  parentChildSplit,
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

  describe('getAdaptiveChunkingProfile', () => {
    it('Markdown 内容应使用 markdown 配置', () => {
      const profile = getAdaptiveChunkingProfile({ fileType: '.md', content: '# 标题\n\n- 列表' });
      expect(profile.documentType).toBe('markdown');
      expect(profile.chunkSize).toBeGreaterThan(500);
    });

    it('代码文件应使用更小的 child chunk', () => {
      const profile = getAdaptiveChunkingProfile({ fileType: '.ts', content: 'function main() { return true; }' });
      expect(profile.documentType).toBe('code');
      expect(profile.childChunkSize).toBeLessThan(300);
    });

    it('PDF 应使用更大的父块', () => {
      const profile = getAdaptiveChunkingProfile({ mimeType: 'application/pdf', content: 'plain text' });
      expect(profile.documentType).toBe('pdf');
      expect(profile.parentChunkSize).toBeGreaterThan(2000);
    });

    it('未知类型应使用默认配置', () => {
      const profile = getAdaptiveChunkingProfile({ fileType: '.unknown', content: 'plain text' });
      expect(profile.documentType).toBe('default');
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

  describe('parentChildSplit（Parent-Child 切分）', () => {
    // 构造一段带多个标题的 Markdown 文档，确保每个章节内容足够长以触发切分
    const markdownDoc = [
      '# 第一章 概述',
      '这是第一章的内容，' + '概述描述。'.repeat(50),
      '',
      '## 1.1 背景',
      '背景说明，' + '背景细节。'.repeat(50),
      '',
      '# 第二章 架构',
      '架构内容，' + '架构描述。'.repeat(50),
      '',
      '## 2.1 模块设计',
      '模块说明，' + '模块细节。'.repeat(50),
    ].join('\n');

    it('documentType=markdown 时父块应按标题切分', async () => {
      const result = await parentChildSplit(markdownDoc, {
        parentChunkSize: 800,
        parentChunkOverlap: 100,
        childChunkSize: 200,
        childChunkOverlap: 30,
        documentType: 'markdown',
      });

      // 至少切出多个父块
      expect(result.length).toBeGreaterThan(1);

      // Markdown 切分器会按标题边界切，父块文本应包含标题标记
      const parentTexts = result.map(pc => pc.parent.text);
      const hasHeading = parentTexts.some(t => /^#{1,6}\s/m.test(t));
      expect(hasHeading).toBe(true);

      // 每个父块都应有子块
      for (const pc of result) {
        expect(pc.children.length).toBeGreaterThan(0);
      }
    });

    it('documentType=default 时父块走通用切分', async () => {
      const result = await parentChildSplit(markdownDoc, {
        parentChunkSize: 800,
        parentChunkOverlap: 100,
        childChunkSize: 200,
        childChunkOverlap: 30,
        documentType: 'default',
      });

      expect(result.length).toBeGreaterThan(0);
      for (const pc of result) {
        expect(pc.children.length).toBeGreaterThan(0);
      }
    });

    it('documentType=code 时父块应按代码结构切分', async () => {
      const codeDoc = [
        'function foo() {',
        '  const a = 1;',
        '  ' + 'console.log(a);'.repeat(30),
        '}',
        '',
        'function bar() {',
        '  const b = 2;',
        '  ' + 'console.log(b);'.repeat(30),
        '}',
      ].join('\n');

      const result = await parentChildSplit(codeDoc, {
        parentChunkSize: 600,
        parentChunkOverlap: 80,
        childChunkSize: 200,
        childChunkOverlap: 30,
        documentType: 'code',
        fileType: '.js',
      });

      expect(result.length).toBeGreaterThan(0);
      for (const pc of result) {
        expect(pc.children.length).toBeGreaterThan(0);
      }
    });

    it('不传 documentType 时应降级为通用切分（向后兼容）', async () => {
      const result = await parentChildSplit(markdownDoc, {
        parentChunkSize: 800,
        parentChunkOverlap: 100,
        childChunkSize: 200,
        childChunkOverlap: 30,
      });

      expect(result.length).toBeGreaterThan(0);
      for (const pc of result) {
        expect(pc.children.length).toBeGreaterThan(0);
      }
    });
  });
});
