/**
 * 飞书消息图片处理工具
 *
 * 飞书的 text 消息和互动卡片 lark_md 都不会把 Markdown 图片 `![](url)`
 * 渲染成原生图片，必须把图片单独上传素材后用 image 消息发送。
 * Web→飞书同步（chat.controller）和飞书入站回复（feishu-event-processor）
 * 共用这里的提取逻辑，避免两处正则不一致。
 */

/**
 * Markdown 图片语法正则。
 * 兼容飞书/部分模型把 url 包在反引号或空格里的情况：![alt](`url`) / ![alt]( url )。
 * 单一来源，供提取和剥离共用，避免多处正则漂移。
 */
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\(\s*`?([^)`\s]+)`?(?:\s+"[^"]*")?\s*\)/g;

/** 从 Markdown 文本中提取图片 URL，并返回去掉图片后的纯文本 */
export function splitMarkdownImages(content: string): {
  text: string;
  imageUrls: string[];
} {
  const imageUrls: string[] = [];
  const text = content
    .replace(MARKDOWN_IMAGE_REGEX, (_match, url: string) => {
      imageUrls.push(url);
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, imageUrls };
}

/**
 * 仅剥离图片 Markdown，不做 trim/换行折叠。
 * 用于流式输出按 chunk 剥离，避免误删跨 chunk 的空格。
 */
export function stripMarkdownImages(content: string): string {
  return content.replace(MARKDOWN_IMAGE_REGEX, '');
}

