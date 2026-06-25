import { splitMarkdownImages, stripMarkdownImages } from './feishu-markdown-image';

describe('feishu-markdown-image', () => {
  describe('splitMarkdownImages', () => {
    it('提取普通图片并返回去图后的文本', () => {
      const { text, imageUrls } = splitMarkdownImages(
        '骑士图片：\n![骑士](https://example.com/a.png)\n画面很有质感',
      );
      expect(imageUrls).toEqual(['https://example.com/a.png']);
      expect(text).toContain('骑士图片');
      expect(text).toContain('画面很有质感');
      expect(text).not.toContain('![');
    });

    it('兼容反引号包裹的图片链接', () => {
      const { text, imageUrls } = splitMarkdownImages('![星空](`https://example.com/b.png?Expires=1&Signature=x%3D`)');
      expect(imageUrls).toEqual(['https://example.com/b.png?Expires=1&Signature=x%3D']);
      expect(text).toBe('');
    });

    it('提取多张图片', () => {
      const { imageUrls } = splitMarkdownImages(
        '![a](https://e.com/1.png) 中间文字 ![b](https://e.com/2.png)',
      );
      expect(imageUrls).toEqual(['https://e.com/1.png', 'https://e.com/2.png']);
    });

    it('无图片时原样返回文本', () => {
      const { text, imageUrls } = splitMarkdownImages('纯文本回复');
      expect(imageUrls).toEqual([]);
      expect(text).toBe('纯文本回复');
    });
  });

  describe('stripMarkdownImages', () => {
    it('剥离图片但保留其余文本与空白', () => {
      expect(stripMarkdownImages('前缀 ![x](https://e.com/a.png) 后缀')).toBe('前缀  后缀');
    });

    it('剥离带签名 query 与反引号的图片', () => {
      const input = '![生成的图片](`https://oss.com/x.png?Expires=1782&Signature=McV%3D`)说明文字';
      expect(stripMarkdownImages(input)).toBe('说明文字');
    });

    it('剥离同一 URL 但 query 不同的重复图片', () => {
      const input =
        '![生成的图片](https://oss.com/uuid.png?Expires=1&Signature=A)\n' +
        '![骑士图片](https://oss.com/uuid.png?Expires=2&Signature=B)';
      expect(stripMarkdownImages(input).trim()).toBe('');
    });
  });
});
