/* ==================== 消息内容渲染兜底清洗 ==================== */
// 背景：部分模型会把工具调用以"文本协议"写进 content（DSML / 裸 XML 方言）。后端已有流式整块抑制
//      与落库/读取边界兜底清洗，但已落库的历史消息、极端链路漏网情况下仍可能残留控制标签。
//      前端渲染侧做最后一道兜底清洗，确保控制标签绝不透给用户。
// 容错规则与 servers/jerry-llm-server/src/fundamentals/dsml-tool-call.ts 保持一致：
//   - 装饰前缀（竖线 + DSML + 竖线，全角/半角竖线都接受）可选
//   - antml: 前缀（Anthropic 风格）可选
//   - 大小写不敏感、属性区任意
//   - 标签名含单复数与缩写（calls / call）

/** 装饰前缀源码：竖线 + DSML + 竖线（整体可选） */
const DSML_DECORATION_SOURCE = '(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?';
/** antml: 前缀源码（整体可选） */
const DSML_ANTML_SOURCE = '(?:antml\\s*:\\s*)?';
/** 控制标签名（捕获组，供闭标签反引用配对）：长名在前，避免 tool_call 抢先匹配 tool_calls */
const DSML_TAG_NAME_CAPTURE_SOURCE =
  '(tool_calls|tool_call|function_calls|function_call|invoke|parameter|calls|call)';
/** 控制标签名（非捕获形式，供残留开/闭标签匹配） */
const DSML_TAG_NAME_SOURCE =
  '(?:tool_calls|tool_call|function_calls|function_call|invoke|parameter|calls|call)';

/** 完整控制块（开标签 + 正文 + 同名闭标签）：整块删除，参数正文一并删除 */
const DSML_BLOCK_RE = new RegExp(
  `<\\s*${DSML_DECORATION_SOURCE}${DSML_ANTML_SOURCE}${DSML_TAG_NAME_CAPTURE_SOURCE}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${DSML_DECORATION_SOURCE}${DSML_ANTML_SOURCE}\\1\\s*>`,
  'gi',
);
/** 残留开控制标签（无闭标签配对）：从该处截断到文本末尾（与后端"未闭合块整体抑制"一致） */
const DSML_OPEN_TAG_RE = new RegExp(
  `<\\s*${DSML_DECORATION_SOURCE}${DSML_ANTML_SOURCE}${DSML_TAG_NAME_SOURCE}\\b[^>]*>`,
  'i',
);
/** 残留孤立闭控制标签：仅删除标签本身 */
const DSML_CLOSE_TAG_RE = new RegExp(
  `<\\s*/\\s*${DSML_DECORATION_SOURCE}${DSML_ANTML_SOURCE}${DSML_TAG_NAME_SOURCE}\\b[^>]*>`,
  'gi',
);
/** think 思考块（渲染与复制都不应包含） */
const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gs;

/**
 * 消息内容渲染兜底清洗：移除 think 块与残留的工具调用控制标签（DSML / 裸 XML 方言）
 *
 * 仅用于展示/复制文本，不修改原始消息数据。
 *
 * @param content 原始消息内容
 * @returns 清洗后可安全展示的内容
 */
export function sanitizeMessageContent(content: string): string {
  if (!content) return content;
  let text = content.replace(THINK_BLOCK_RE, '');
  // 整块删除：内层块删除后外层同名嵌套块才可能闭合完整，循环至稳定
  let prev: string;
  do {
    prev = text;
    text = text.replace(DSML_BLOCK_RE, '');
  } while (text !== prev);
  // 未闭合的开标签：其后内容均属泄漏块，整体截断
  const openIdx = text.search(DSML_OPEN_TAG_RE);
  if (openIdx !== -1) text = text.slice(0, openIdx);
  // 孤立闭标签：仅删除标签本身
  return text.replace(DSML_CLOSE_TAG_RE, '');
}

export function generateId(): string {
  return Date.now().toString();
}

export function generateSessionId(): string {
  return Date.now().toString();
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString();
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString();
}
