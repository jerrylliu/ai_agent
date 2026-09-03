// ============================================================================
// 文件作用：DSML 原始工具调用文本的检测 / 过滤 / 解析 / 流式整块抑制（纯函数模块）。
//          单独提取成文件是为了可测试性--避免测试时加载整个 prompt.ts 的重依赖
//          （LLM 客户端、工具注册、SSE、缓存等），与 prompt-message-cleaner.ts 同一模式。
//
// 背景：部分模型（DeepSeek 某些版本 / 本地模型）在 function calling 通道不稳定，
//      会把工具调用以 DSML 文本格式写在 content 里，例如：
//        <｜｜DSML｜｜tool_calls>
//          <｜｜DSML｜｜invoke name="search_knowledge_base">
//            <｜｜DSML｜｜parameter name="query" string="true">液氮 杜瓦冷罐</｜｜DSML｜｜parameter>
//          </｜｜DSML｜｜invoke>
//        </｜｜DSML｜｜tool_calls>
// ============================================================================

import { logger } from './logger.js';

// 检测用正则（不带 /g，避免 .test() 的 lastIndex 副作用）
const RAW_TOOL_CALL_DETECT_PATTERNS = [
  /<｜｜DSML｜｜[^>]*>/,                     // DeepSeek DSML 标签
  /<\/｜｜DSML｜｜[^>]*>/,                    // DeepSeek DSML 闭合标签
  /<\|\|DSML\|\|[^>]*>/,                     // DeepSeek DSML 标签（ASCII 编码）
  /<\/\|\|DSML\|\|[^>]*>/,                   // DeepSeek DSML 闭合标签（ASCII 编码）
  /<tool_calls>[\s\S]*?<\/tool_calls>/,      // 通用 tool_calls 标签
  /<function_call>[\s\S]*?<\/function_call>/, // 通用 function_call 标签
];

// 过滤用正则（带 /g，用于全局替换）
const RAW_TOOL_CALL_REPLACE_PATTERNS = [
  /<｜｜DSML｜｜[^>]*>/g,
  /<\/｜｜DSML｜｜[^>]*>/g,
  /<\|\|DSML\|\|[^>]*>/g,
  /<\/\|\|DSML\|\|[^>]*>/g,
  /<tool_calls>[\s\S]*?<\/tool_calls>/g,
  /<function_call>[\s\S]*?<\/function_call>/g,
];

/**
 * 检测文本是否包含原始工具调用格式
 */
export function containsRawToolCallFormat(text: string): boolean {
  return RAW_TOOL_CALL_DETECT_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * 过滤文本中的原始工具调用格式标签
 */
export function filterRawToolCalls(text: string): string {
  let result = text;
  for (const pattern of RAW_TOOL_CALL_REPLACE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

/**
 * 判断文本是否可能是原始工具调用格式的开头（用于流式缓冲决策）
 * 只检查常见的起始标记，避免对正常文本过度缓冲
 */
export function isPossibleRawToolCallStart(text: string): boolean {
  // 检查是否以 < 开头且可能是工具调用标签的起始
  return /^[<｜]/.test(text) || text.includes('<|') || text.includes('<｜');
}

/**
 * 从模型输出的 DSML 文本中解析工具调用（文本协议降级通道）
 *
 * 与其重试 10 轮赌模型改用原生 FC（不支持时永远失败），不如直接解析文本执行工具。
 * 同时兼容 ASCII 竖线变体 <||DSML||...>。
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

  // 同时匹配全角 ｜ 和 ASCII | 两种竖线变体
  const invokeBlockPattern = /<[｜|]{2}DSML[｜|]{2}invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]{2}DSML[｜|]{2}invoke>/g;
  const paramPattern = /<[｜|]{2}DSML[｜|]{2}parameter\s+name="([^"]+)"(?:\s+string="[^"]*")?\s*>([\s\S]*?)<\/[｜|]{2}DSML[｜|]{2}parameter>/g;

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
// 流式 chunk 边界会任意切碎标签（如 "<"、"｜"、"｜"、"DSML" 分属四个 chunk），
// 基于"单个 chunk 是否像标签开头"的启发式必然被击穿，标签碎片会逐块泄漏给用户。
// 本抑制器为字符级三态机，对任意 chunk 切分安全：
//   - text：原样透出；遇到 "<" 进入 tag 候选态
//   - tag：缓冲候选；命中完整标签 → 进入 block；候选死亡 → 透出安全部分并回溯到最近的 "<"
//   - block：整块捕获（不吐出，供 parseDSMLToolCalls 解析执行）；按开/闭标签计数深度，归零结束
// parameter 内容守卫：参数正文（如待生成的文档）可能含 "<" / ">"（如 <div>、"1 < 2"），
// 在参数内容区只认 parameter 闭合标签作为终止符，防止正文中的其他尖括号干扰深度计数。

/** 竖线字符类：同时兼容全角 ｜ 与 ASCII | */
const PIPE_CLASS = '[｜|]';

/** 抑制器标签规格：用"字符类序列 + 可选属性区"描述一类标签 */
interface SuppressorTagSpec {
  /** 开标签（进入块 / 深度 +1）还是闭标签（深度 -1 / 单独抑制） */
  isOpen: boolean;
  /** DSML parameter 开标签：进入块后触发"参数内容"守卫 */
  isParamOpen: boolean;
  /** 匹配完整标签（^...$ 锚定） */
  completeRe: RegExp;
  /** 匹配标签的任意非空前缀（^...$ 锚定；不带 $ 会把 "<xyz" 误判为前缀） */
  prefixRe: RegExp;
}

/** 把字面字符串拆成单字符类（转义正则特殊字符） */
function literalClasses(word: string): string[] {
  return word.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * 构造"任意非空前缀"正则源码：嵌套可选组
 * 如 [a, b, c] → a(?:b(?:c)?)? 可匹配 a / ab / abc
 */
function buildPrefixSource(classes: string[]): string {
  let src = classes[0];
  for (let i = 1; i < classes.length; i++) {
    src += `(?:${classes[i]}`;
  }
  // 嵌套组必须可选（)?），否则只能匹配完整序列，成长中的前缀（如 "<｜"）会匹配失败
  src += ')?'.repeat(classes.length - 1);
  return src;
}

/** 构造单个标签规格 */
function buildSuppressorTagSpec(
  classes: string[],
  isOpen: boolean,
  attrRegion: boolean,
  isParamOpen = false,
): SuppressorTagSpec {
  const headSource = classes.join('');
  const completeRe = new RegExp(`^${headSource}${attrRegion ? '[^>]*' : ''}>$`);
  const prefixSource = attrRegion
    ? `^(?:${buildPrefixSource(classes)}|${headSource}[^>]*)$`
    : `^${buildPrefixSource(classes)}$`;
  return { isOpen, isParamOpen, completeRe, prefixRe: new RegExp(prefixSource) };
}

// DSML 标签头（开 / 闭），竖线位置同时兼容全角与 ASCII
const DSML_OPEN_HEAD: string[] = ['<', PIPE_CLASS, PIPE_CLASS, ...literalClasses('DSML'), PIPE_CLASS, PIPE_CLASS];
const DSML_CLOSE_HEAD: string[] = ['<', '/', PIPE_CLASS, PIPE_CLASS, ...literalClasses('DSML'), PIPE_CLASS, PIPE_CLASS];

// parameter 闭合标签：参数内容守卫下唯一识别的标签
const DSML_PARAM_CLOSE: SuppressorTagSpec = buildSuppressorTagSpec(
  [...DSML_CLOSE_HEAD, ...literalClasses('parameter')],
  false,
  false,
);

// 需抑制的全部标签规格：DSML 开/闭 x 3 + 泛型开/闭 x 2
const SUPPRESSOR_TAG_SPECS: SuppressorTagSpec[] = [
  buildSuppressorTagSpec([...DSML_OPEN_HEAD, ...literalClasses('tool_calls')], true, false),
  buildSuppressorTagSpec([...DSML_CLOSE_HEAD, ...literalClasses('tool_calls')], false, false),
  buildSuppressorTagSpec([...DSML_OPEN_HEAD, ...literalClasses('invoke')], true, true),
  buildSuppressorTagSpec([...DSML_CLOSE_HEAD, ...literalClasses('invoke')], false, false),
  buildSuppressorTagSpec([...DSML_OPEN_HEAD, ...literalClasses('parameter')], true, true, true),
  DSML_PARAM_CLOSE,
  buildSuppressorTagSpec(literalClasses('<tool_calls'), true, false),
  buildSuppressorTagSpec(literalClasses('</tool_calls'), false, false),
  buildSuppressorTagSpec(literalClasses('<function_call'), true, false),
  buildSuppressorTagSpec(literalClasses('</function_call'), false, false),
];

/** 尝试把缓冲区匹配为完整标签或标签前缀（完整优先） */
function matchSuppressorTag(buffer: string): { spec: SuppressorTagSpec } | 'prefix' | null {
  for (const spec of SUPPRESSOR_TAG_SPECS) {
    if (spec.completeRe.test(buffer)) return { spec };
  }
  for (const spec of SUPPRESSOR_TAG_SPECS) {
    if (spec.prefixRe.test(buffer)) return 'prefix';
  }
  return null;
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
  /** 块当前嵌套深度 */
  private depth = 0;
  /** 是否处于参数内容区（只匹配 parameter 闭合标签，忽略其他尖括号） */
  private inParamContent = false;
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
      // 仅抑制 DSML 残留；"1 <" 这类普通文本残留原样吐出，避免误吞
      if (/DSML|｜|\|\|/.test(residue)) {
        this.captured += residue;
        return '';
      }
      return residue;
    }
    if (this.state === 'block') {
      // 未闭合块：剩余部分整体抑制（均已进入 captured，其中完整 invoke 仍可被解析）
      this.scanBuffer = '';
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
      const match = matchSuppressorTag(this.tagBuffer);
      if (match === 'prefix') return '';
      if (match !== null) {
        // 完整标签：整体抑制并进入对应状态
        this.captured += this.tagBuffer;
        this.tagBuffer = '';
        if (match.spec.isOpen) {
          this.state = 'block';
          this.depth = 1;
          this.scanBuffer = '';
          this.inParamContent = match.spec.isParamOpen;
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
    if (this.inParamContent) {
      this.scanParamContent(c);
    } else {
      this.scanBlockTags(c);
    }
    return '';
  }

  /** block 态（非参数内容区）：按开/闭标签计数深度 */
  private scanBlockTags(c: string): void {
    if (this.scanBuffer === '') {
      if (c === '<') this.scanBuffer = '<';
      return;
    }
    this.scanBuffer += c;
    const match = matchSuppressorTag(this.scanBuffer);
    if (match === 'prefix') return;
    if (match !== null) {
      this.scanBuffer = '';
      if (match.spec.isOpen) {
        this.depth += 1;
        if (match.spec.isParamOpen) this.inParamContent = true;
      } else {
        this.depth -= 1;
        if (this.depth <= 0) {
          this.state = 'text';
          this.depth = 0;
        }
      }
      return;
    }
    const lastLt = this.scanBuffer.lastIndexOf('<');
    this.scanBuffer = lastLt > 0 ? this.scanBuffer.slice(lastLt) : '';
  }

  /** block 态（参数内容区）：只认 parameter 闭合标签，防文档正文尖括号误计深度 */
  private scanParamContent(c: string): void {
    if (this.scanBuffer === '') {
      if (c === '<') this.scanBuffer = '<';
      return;
    }
    this.scanBuffer += c;
    if (DSML_PARAM_CLOSE.completeRe.test(this.scanBuffer)) {
      this.scanBuffer = '';
      this.inParamContent = false;
      this.depth -= 1;
      if (this.depth <= 0) {
        this.state = 'text';
        this.depth = 0;
      }
      return;
    }
    if (DSML_PARAM_CLOSE.prefixRe.test(this.scanBuffer)) return;
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
