// ============================================================================
// 文件作用：模型把工具调用写成"文本协议"时的检测 / 过滤 / 解析 / 流式整块抑制（纯函数模块）。
//          单独提取成文件是为了可测试性--避免测试时加载整个 prompt.ts 的重依赖
//          （LLM 客户端、工具注册、SSE、缓存等），与 prompt-message-cleaner.ts 同一模式。
//
// 背景：部分模型（DeepSeek 某些版本 / 本地模型 / 中转站丢弃 tools 字段时）的 function calling
//      通道不可靠，会把工具调用以文本形式写在 content 里。各家方言不一致：
//        - DeepSeek DSML：<｜DSML｜tool_calls> + <｜DSML｜invoke name="x"> + <｜DSML｜parameter …>
//        - 裸 XML：DSML 特殊标记被链路丢弃、或 Anthropic 风格，只剩 <tool_calls> / <invoke> / <parameter>
//        - 单数标签：<tool_call> … </tool_call>（Qwen 等）
//
// 设计原则（P0 出口契约）：**不按精确字面量做白名单**，而按"控制标签名"识别，容忍
//   1) 装饰前缀（竖线 + DSML + 竖线）有无皆可
//   2) antml: 前缀（Anthropic 风格）
//   3) 属性区、空白、大小写差异
//   4) 单复数（tool_call(s) / function_call(s)）
//   5) 开闭标签不对称（只有开标签时，剩余内容整体抑制到流结束）
// 行为底线：宁可少显示，绝不把控制标记透给用户；同时把捕获到的块交给 parseDSMLToolCalls
//          真实执行工具，避免"只抑制不执行"导致功能静默丢失。
// ============================================================================

import { logger } from './logger.js';

// ==================== 控制标签识别 ====================

/** 控制标签名（全部小写）：模型把工具调用写成文本时用到的标签名集合 */
const CONTROL_TAG_NAMES: readonly string[] = [
  'tool_call',
  'tool_calls',
  'invoke',
  'parameter',
  'function_call',
  'function_calls',
];

/** 竖线字符（全角 ｜ 与 ASCII | 都接受） */
const PIPE_RE = /[|｜]/;
/** 标签名允许的字符 */
const NAME_CHAR_RE = /[A-Za-z0-9_]/;

/** 装饰前缀源码：竖线 + DSML + 竖线（整体可选） */
const DECORATION_SOURCE = '(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?';
/** antml: 前缀源码（整体可选） */
const ANTLM_SOURCE = '(?:antml\\s*:\\s*)?';
/** 控制标签名源码：长名在前，避免 tool_call 抢先匹配 tool_calls */
const TAG_NAME_SOURCE = '(?:tool_calls|tool_call|function_calls|function_call|invoke|parameter)';

/** 检测用正则（不带 /g，避免 .test() 的 lastIndex 副作用） */
const RAW_TOOL_CALL_DETECT_RE = new RegExp(
  `<\\s*/?\\s*${DECORATION_SOURCE}${ANTLM_SOURCE}${TAG_NAME_SOURCE}\\b`,
  'i',
);

/** 过滤用正则（带 /g）：逐个删除控制标签本身，保留标签之间的正文 */
const RAW_TOOL_CALL_REPLACE_RE = new RegExp(
  `<\\s*/?\\s*${DECORATION_SOURCE}${ANTLM_SOURCE}${TAG_NAME_SOURCE}\\b[^>]*>`,
  'gi',
);

/**
 * 检测文本是否包含原始工具调用格式
 */
export function containsRawToolCallFormat(text: string): boolean {
  return RAW_TOOL_CALL_DETECT_RE.test(text);
}

/**
 * 过滤文本中的原始工具调用格式标签（仅删标签，保留标签之间的正文）
 */
export function filterRawToolCalls(text: string): string {
  return text.replace(RAW_TOOL_CALL_REPLACE_RE, '').trim();
}

/**
 * 判断文本是否可能是原始工具调用格式的开头（用于流式缓冲决策）
 * 只检查常见的起始标记，避免对正常文本过度缓冲
 */
export function isPossibleRawToolCallStart(text: string): boolean {
  // 检查是否以 < 开头且可能是工具调用标签的起始
  return /^[<｜]/.test(text) || text.includes('<|') || text.includes('<｜');
}

// ==================== 文本协议工具调用解析 ====================

/**
 * 从模型输出的文本中解析工具调用（文本协议降级通道）
 *
 * 与其重试 10 轮赌模型改用原生 FC（不支持时永远失败），不如直接解析文本执行工具。
 * 标签形态按 parseControlTag 的同一套容错规则（装饰前缀 / antml: / 单复数 / 属性区都可省）。
 *
 * @param text 模型输出的原始文本
 * @param availableToolNames 可用工具名列表；非空时解析结果必须命中列表（防模型幻觉出不存在的工具），
 *                           空数组表示不校验（测试/宽松场景）
 * @returns 解析出的工具调用数组；格式不完整/无调用时返回空数组
 */
export function parseDSMLToolCalls(
  text: string,
  availableToolNames: string[] = [],
): Array<{ name: string; args: Record<string, unknown> }> {
  if (!text || !containsRawToolCallFormat(text)) return [];

  const results: Array<{ name: string; args: Record<string, unknown> }> = [];

  // invoke / parameter 的标签形态：装饰前缀与 antml: 前缀都可选，属性区任意
  const invokeBlockPattern = new RegExp(
    `<\\s*${DECORATION_SOURCE}${ANTLM_SOURCE}invoke\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)` +
      `<\\s*/\\s*${DECORATION_SOURCE}${ANTLM_SOURCE}invoke\\s*>`,
    'gi',
  );
  const paramPattern = new RegExp(
    `<\\s*${DECORATION_SOURCE}${ANTLM_SOURCE}parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)` +
      `<\\s*/\\s*${DECORATION_SOURCE}${ANTLM_SOURCE}parameter\\s*>`,
    'gi',
  );

  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = invokeBlockPattern.exec(text)) !== null) {
    const toolName = invokeMatch[1];
    const invokeBody = invokeMatch[2];

    // 工具名必须在可用列表中才信任（防止模型幻觉出不存在的工具名）
    if (availableToolNames.length > 0 && !availableToolNames.includes(toolName)) {
      logger.warn('DSML 解析：跳过不可用的工具名', { module: 'DsmlToolCall', toolName });
      continue;
    }

    const args: Record<string, unknown> = {};
    let paramMatch: RegExpExecArray | null;
    paramPattern.lastIndex = 0;
    while ((paramMatch = paramPattern.exec(invokeBody)) !== null) {
      const paramName = paramMatch[1];
      const rawValue = paramMatch[2].trim();
      // 尝试还原基本类型（数字/布尔），失败保持字符串（大多数工具参数如 query 本就是 string）
      if (rawValue === 'true') args[paramName] = true;
      else if (rawValue === 'false') args[paramName] = false;
      else if (/^-?\d+(\.\d+)?$/.test(rawValue)) args[paramName] = Number(rawValue);
      else args[paramName] = rawValue;
    }

    results.push({ name: toolName, args });
  }

  return results;
}

// ==================== 流式整块抑制器 ====================
//
// 为什么不能复用 filterRawToolCalls / isPossibleRawToolCallStart：
// 流式 chunk 边界会任意切碎标签（如 "<"、"｜"、"DSML" 分属多个 chunk），
// 基于"单个 chunk 是否像标签开头"的启发式必然被击穿，标签碎片会逐块泄漏给用户。
// 本抑制器为字符级三态机，对任意 chunk 切分安全：
//   - text：原样透出；遇到 "<" 进入 tag 候选态
//   - tag：缓冲候选；命中完整标签 → 进入 block；候选死亡 → 透出安全部分并回溯到最近的 "<"
//   - block：整块捕获（不吐出，供 parseDSMLToolCalls 解析执行）；按开/闭标签计数深度，归零结束
//
// 与旧实现的差异：旧版按"精确字面量标签"匹配（要求标签逐字符完全一致），白名单外的方言
// 会整段泄漏；新版按标签名匹配，普通正文里的 <div> / 1 < 2 / <title> 依然不会被误吞。

/** 识别出的控制标签 */
interface ControlTag {
  /** 标签名（小写，命中 CONTROL_TAG_NAMES 之一） */
  name: string;
  /** 开标签（进入块 / 深度 +1）还是闭标签（深度 -1 / 单独抑制） */
  isOpen: boolean;
}

/** 标签匹配结果：命中完整标签 / 仍可能是标签前缀 / 不是标签 */
type TagMatchResult = { tag: ControlTag } | 'prefix' | null;

/**
 * 尝试把缓冲区解析成一个控制标签（容错规则见文件头）。
 *
 * @param buffer 以 "<" 开头的候选缓冲（后续字符可能还没到达）
 * @returns 命中返回标签；"prefix" 表示还需要继续缓冲；null 表示不是控制标签（按普通文本处理）
 */
function parseControlTag(buffer: string): TagMatchResult {
  if (!buffer.startsWith('<')) return null;
  let i = 1;

  let isOpen = true;
  if (buffer[i] === '/') {
    isOpen = false;
    i += 1;
  }

  // ---------- 装饰前缀：竖线 + DSML + 竖线 ----------
  if (buffer[i] !== undefined && PIPE_RE.test(buffer[i])) {
    let p = i;
    while (p < buffer.length && PIPE_RE.test(buffer[p])) p += 1;
    if (p >= buffer.length) return 'prefix'; // 只到竖线，DSML 还没到
    const keyword = 'DSML';
    for (let k = 0; k < keyword.length; k++) {
      const ch = buffer[p + k];
      if (ch === undefined) return 'prefix';
      if (ch.toUpperCase() !== keyword[k]) return null; // 不是竖线装饰前缀
    }
    p += keyword.length;
    let q = p;
    while (q < buffer.length && PIPE_RE.test(buffer[q])) q += 1;
    if (q >= buffer.length) return 'prefix'; // 收尾竖线还没到
    if (q === p) return null; // DSML 后面没有竖线 → 不合法
    i = q;
  }

  // ---------- antml: 前缀（Anthropic 风格） ----------
  if (buffer[i] !== undefined && buffer[i].toLowerCase() === 'a') {
    const antml = 'antml:';
    for (let k = 0; k < antml.length; k++) {
      const ch = buffer[i + k];
      if (ch === undefined) return 'prefix';
      if (ch.toLowerCase() !== antml[k]) return null;
    }
    i += antml.length;
  }

  // ---------- 标签名 ----------
  let j = i;
  while (j < buffer.length && NAME_CHAR_RE.test(buffer[j])) j += 1;
  const rawName = buffer.slice(i, j).toLowerCase();
  const name = CONTROL_TAG_NAMES.find((n) => n === rawName);
  if (!name) {
    // 关键：区分"名字还没收集完"与"名字已被非名字符终结"。
    //   - j 仍在缓冲末尾（如 "<" / "</" / "<tool_cal"）→ 可能还是某个标签名的前缀，继续缓冲
    //   - 名字后面已出现非名字符（如 "<div "、"1 < 2"、"<to>"）→ 名字已终结且对不上，
    //     必须立刻判定为普通文本，否则 scanBuffer 会被永久毒化成 prefix，块永远收不了尾
    if (j < buffer.length) return null;
    return CONTROL_TAG_NAMES.some((n) => n.startsWith(rawName)) ? 'prefix' : null;
  }

  // ---------- 属性区 + 闭合尖括号 ----------
  // 属性区允许任意内容（单复数标签、带 string="true" 的 parameter、antml 自带的属性都走这里）
  if (buffer.indexOf('>', j) === -1) return 'prefix';
  return { tag: { name, isOpen } };
}

/**
 * 流式 DSML 整块抑制器
 *
 * 用法：流式 chunk 逐个调用 push(chunk)，返回值是"可原样输出的安全文本"；
 *      流结束时调用 flush() 处理残留。被抑制块的全量文本通过 getCaptured()
 *      获取，交给 parseDSMLToolCalls 解析并真实执行工具。
 */
export class StreamingDsmlSuppressor {
  /** 主状态：text = 正常透出；tag = 缓冲标签候选；block = 抑制块内部 */
  private state: 'text' | 'tag' | 'block' = 'text';
  /** tag 态候选缓冲 */
  private tagBuffer = '';
  /** block 态的标签扫描缓冲（仅用于匹配，不影响捕获） */
  private scanBuffer = '';
  /** block 态已打开的控制标签栈（按名字配对收尾，容忍子标签漏闭合） */
  private openStack: string[] = [];
  /** 被抑制块的全量捕获文本 */
  private captured = '';

  /** 喂入一个 chunk，返回可原样输出的安全文本（可能为空字符串） */
  push(chunk: string): string {
    let out = '';
    for (const ch of chunk) {
      out += this.consume(ch);
    }
    return out;
  }

  /** 流结束：处理残留（tag 态残留按内容决定吐出/抑制；未闭合块整体抑制） */
  flush(): string {
    if (this.state === 'tag') {
      const residue = this.tagBuffer;
      this.tagBuffer = '';
      this.state = 'text';
      // 仅抑制含装饰标记的残留；"1 <" / "<tool_cal" 这类普通文本残留原样吐出，避免误吞
      if (/DSML|｜|\|\|/.test(residue)) {
        this.captured += residue;
        return '';
      }
      return residue;
    }
    if (this.state === 'block') {
      // 未闭合块：剩余部分整体抑制（均已进入 captured，其中完整 invoke 仍可被解析）
      this.scanBuffer = '';
      this.openStack = [];
      this.state = 'text';
      return '';
    }
    return '';
  }

  /** 获取被抑制块的全量文本（供 parseDSMLToolCalls 使用） */
  getCaptured(): string {
    return this.captured;
  }

  hasCaptured(): boolean {
    return this.captured.length > 0;
  }

  /** 消费单个字符，返回应透出的文本 */
  private consume(c: string): string {
    if (this.state === 'text') {
      if (c === '<') {
        this.state = 'tag';
        this.tagBuffer = '<';
        return '';
      }
      return c;
    }

    if (this.state === 'tag') {
      this.tagBuffer += c;
      const match = parseControlTag(this.tagBuffer);
      if (match === 'prefix') return '';
      if (match !== null) {
        // 完整标签：整体抑制并进入对应状态
        this.captured += this.tagBuffer;
        this.tagBuffer = '';
        if (match.tag.isOpen) {
          this.state = 'block';
          this.openStack = [match.tag.name];
          this.scanBuffer = '';
        } else {
          // 孤立闭标签（前无开标签）：仅抑制该标签本身，不进块
          this.state = 'text';
        }
        return '';
      }
      // 死候选：透出安全部分，从最后一个 "<" 继续尝试（防止漏掉紧随的新标签）
      const lastLt = this.tagBuffer.lastIndexOf('<');
      if (lastLt > 0) {
        const emit = this.tagBuffer.slice(0, lastLt);
        this.tagBuffer = this.tagBuffer.slice(lastLt);
        return emit;
      }
      const emit = this.tagBuffer;
      this.tagBuffer = '';
      this.state = 'text';
      return emit;
    }

    // block 态：全部捕获，绝不透出
    this.captured += c;
    this.scanBlockTags(c);
    return '';
  }

  /**
   * block 态：按开/闭控制标签名配对维护标签栈
   *
   * 说明：块内正文（参数值是整篇文档时尤其长）可能含 < > 等字符，但它们只有构成
   * "控制标签名"才会被识别（<div>、1 < 2 都不算），因此不需要为参数正文单独开守卫。
   * 用栈而非纯计数，是为了容忍模型漏写子标签闭合：`<invoke><parameter>x</invoke>` 里
   * 闭合 invoke 时会连同未闭合的 parameter 一起出栈，不会把块之后的正常正文一起吞掉。
   */
  private scanBlockTags(c: string): void {
    if (this.scanBuffer === '') {
      if (c === '<') this.scanBuffer = '<';
      return;
    }
    this.scanBuffer += c;
    const match = parseControlTag(this.scanBuffer);
    if (match === 'prefix') return;
    if (match !== null) {
      this.scanBuffer = '';
      if (match.tag.isOpen) {
        this.openStack.push(match.tag.name);
      } else {
        const idx = this.openStack.lastIndexOf(match.tag.name);
        // 找得到开标签：连同其内部所有未闭合的子标签一起出栈；找不到（孤立闭标签）则忽略
        if (idx !== -1) this.openStack.length = idx;
        if (this.openStack.length === 0) this.state = 'text';
      }
      return;
    }
    const lastLt = this.scanBuffer.lastIndexOf('<');
    this.scanBuffer = lastLt > 0 ? this.scanBuffer.slice(lastLt) : '';
  }
}

/**
 * 同步整段抑制（非流式路径：fallback / invoke 等值于 push(全文) + flush()）
 */
export function suppressRawToolCallBlocks(text: string): { safeText: string; captured: string } {
  const suppressor = new StreamingDsmlSuppressor();
  const safeText = suppressor.push(text) + suppressor.flush();
  return { safeText, captured: suppressor.getCaptured() };
}
