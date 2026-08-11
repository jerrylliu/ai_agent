/**
 * 公式解释模块
 *
 * 职责：
 * 1. 从 Markdown 文本中识别 LaTeX 公式（$$...$$ / \[...\] / $...$ / \(...\)）
 * 2. 调用 LLM 为每个公式生成自然语言描述（提高公式检索质量）
 * 3. 将解释以 blockquote 形式追加到公式后面
 *
 * 触发条件：
 * - FORMULA_ENABLED=true 时启用
 * - 仅在 MinerU 路径的 PDF 解析后调用（MinerU 已将公式转为 LaTeX）
 *
 * 成本控制：
 * - 单文档公式解释调用上限 FORMULA_MAX_CALLS_PER_DOC（默认 30）
 * - 超出的公式保留原样，不生成解释
 *
 * 失败处理：
 * - 单个公式解释失败不影响其他公式
 * - 失败时保留原公式，不追加解释
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from './logger.js';
import { config } from './config.js';
import { createLLM, buildModelConfig } from './model-provider.js';

// ==================== 类型定义 ====================

/** 识别到的公式信息 */
interface FormulaMatch {
  /** 公式 LaTeX 源码（不含定界符） */
  latex: string;
  /** 在原文中的起始位置 */
  start: number;
  /** 在原文中的结束位置 */
  end: number;
  /** 公式类型：block（块级）/ inline（行内） */
  type: 'block' | 'inline';
  /** 原始定界符（$$ / \[ / $ / \( ） */
  rawDelimiter: string;
}

/** 公式解释结果 */
export interface FormulaExplainResult {
  /** 处理后的 Markdown（含解释） */
  text: string;
  /** 识别到的公式总数 */
  totalFormulas: number;
  /** 成功生成解释的数量 */
  explainedCount: number;
  /** 因上限跳过的数量 */
  skippedCount: number;
  /** 失败的数量 */
  failedCount: number;
}

// ==================== 主入口 ====================

/**
 * 为 Markdown 中的 LaTeX 公式生成自然语言解释
 *
 * 流程：
 * 1. 扫描 markdown，识别所有 block 和 inline 公式
 * 2. 对前 maxCallsPerDoc 个公式调用 LLM 生成解释
 * 3. 将解释以 blockquote 形式追加到公式后
 *
 * @param text MinerU 解析后的 markdown 文本
 * @param documentTitle 文档标题（用于 LLM Prompt 上下文）
 * @returns 处理结果（含统计信息）
 */
export async function explainFormulas(
  text: string,
  documentTitle: string,
): Promise<FormulaExplainResult> {
  if (!config.formula.enabled) {
    return {
      text,
      totalFormulas: 0,
      explainedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  }

  // 1. 识别所有公式
  const formulas = extractFormulas(text);
  if (formulas.length === 0) {
    return {
      text,
      totalFormulas: 0,
      explainedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  }

  logger.info('识别到 LaTeX 公式', {
    module: 'FormulaExplainer',
    documentTitle,
    totalFormulas: formulas.length,
    blockCount: formulas.filter((f) => f.type === 'block').length,
    inlineCount: formulas.filter((f) => f.type === 'inline').length,
  });

  // 2. 成本控制：超出上限的公式跳过
  const maxCalls = config.formula.maxCallsPerDoc;
  const toExplain = formulas.slice(0, maxCalls);
  const skipped = formulas.slice(maxCalls);

  // 3. 创建 LLM 实例（单文档内复用，避免每个公式都重新构造实例）
  let llm: BaseChatModel;
  try {
    llm = createFormulaLLM();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('创建公式解释 LLM 失败，跳过所有公式解释', {
      module: 'FormulaExplainer',
      documentTitle,
      error: errMsg,
    });
    return {
      text,
      totalFormulas: formulas.length,
      explainedCount: 0,
      skippedCount: skipped.length,
      failedCount: toExplain.length,
    };
  }

  // 4. 逐个调用 LLM 生成解释（复用同一 LLM 实例）
  const explanations = new Map<number, string>();
  let failedCount = 0;

  for (let i = 0; i < toExplain.length; i++) {
    const formula = toExplain[i];
    try {
      const explanation = await explainSingleFormula(
        llm,
        formula.latex,
        formula.type,
        documentTitle,
      );
      if (explanation) {
        explanations.set(i, explanation);
      } else {
        failedCount++;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('公式解释失败', {
        module: 'FormulaExplainer',
        documentTitle,
        formulaIndex: i,
        latexPreview: formula.latex.slice(0, 50),
        error: errMsg,
      });
      failedCount++;
    }
  }

  // 5. 将解释插入回 markdown
  const resultText = insertExplanations(text, toExplain, explanations);

  const explainedCount = explanations.size;
  logger.info('公式解释完成', {
    module: 'FormulaExplainer',
    documentTitle,
    totalFormulas: formulas.length,
    explainedCount,
    skippedCount: skipped.length,
    failedCount,
  });

  return {
    text: resultText,
    totalFormulas: formulas.length,
    explainedCount,
    skippedCount: skipped.length,
    failedCount,
  };
}

// ==================== 公式识别 ====================

/**
 * 从 Markdown 文本中提取所有 LaTeX 公式
 *
 * 识别的定界符格式（按优先级）：
 * 1. 块级公式：$$...$$ 或 \[...\]
 * 2. 行内公式：$...$ 或 \(...\)
 *
 * 注意：$$ 必须在 $ 之前匹配，避免块级被误判为行内
 */
function extractFormulas(text: string): FormulaMatch[] {
  const matches: FormulaMatch[] = [];

  // 块级公式 $$...$$（跨行）
  const blockDollarRegex = /\$\$([\s\S]+?)\$\$/g;
  let m: RegExpExecArray | null;
  while ((m = blockDollarRegex.exec(text)) !== null) {
    matches.push({
      latex: m[1].trim(),
      start: m.index,
      end: m.index + m[0].length,
      type: 'block',
      rawDelimiter: '$$',
    });
  }

  // 块级公式 \[...\]
  const blockBracketRegex = /\\\[([\s\S]+?)\\\]/g;
  while ((m = blockBracketRegex.exec(text)) !== null) {
    matches.push({
      latex: m[1].trim(),
      start: m.index,
      end: m.index + m[0].length,
      type: 'block',
      rawDelimiter: '\\[',
    });
  }

  // 行内公式 $...$（不跨行，且不是 $$ 的一部分）
  // 使用 negative lookbehind/lookahead 避免 $$ 被匹配
  const inlineDollarRegex = /(?<!\$)\$(?!\$)([^\n$]+?)\$/g;
  while ((m = inlineDollarRegex.exec(text)) !== null) {
    // 跳过与块级公式重叠的匹配
    if (overlapsWithExisting(matches, m.index, m.index + m[0].length)) {
      continue;
    }
    // S3-4 修复：过滤价格符号误匹配
    // 要求 $...$ 内容中至少包含一个 LaTeX 特征字符或数学运算符，
    // 否则认为是价格/货币符号（如 "$100 优惠后 $"）而非公式
    const content = m[1].trim();
    if (!/[\\^_{}=+\-*/]/.test(content)) {
      continue;
    }
    matches.push({
      latex: content,
      start: m.index,
      end: m.index + m[0].length,
      type: 'inline',
      rawDelimiter: '$',
    });
  }

  // 行内公式 \(...\)（S3-5 修复：不允许跨行，与 $...$ 保持一致）
  const inlineParenRegex = /\\\(([^\n]+?)\\\)/g;
  while ((m = inlineParenRegex.exec(text)) !== null) {
    if (overlapsWithExisting(matches, m.index, m.index + m[0].length)) {
      continue;
    }
    matches.push({
      latex: m[1].trim(),
      start: m.index,
      end: m.index + m[0].length,
      type: 'inline',
      rawDelimiter: '\\(',
    });
  }

  // 按位置排序，便于后续插入解释
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

/** 检查新匹配是否与已有匹配重叠 */
function overlapsWithExisting(
  existing: FormulaMatch[],
  start: number,
  end: number,
): boolean {
  return existing.some((e) => start < e.end && end > e.start);
}

// ==================== LLM 调用 ====================

/**
 * 创建公式解释用的 LLM 实例
 *
 * 单文档内复用同一实例，避免每个公式都重新构造（构造会创建 HTTP 客户端、
 * 加载配置等开销，对一篇文档可能有 30 个公式来说浪费明显）。
 */
function createFormulaLLM(): BaseChatModel {
  const modelConfig = buildModelConfig(config.formula.modelId, {
    isFCMode: false,
  });

  // 覆盖 temperature：解释任务用低温度保证稳定
  modelConfig.temperature = 0.2;

  return createLLM(modelConfig);
}

/**
 * 调用 LLM 为单个公式生成自然语言解释
 *
 * @param llm 已创建的 LLM 实例（由调用方复用）
 * @returns 解释文本（失败返回 null）
 */
async function explainSingleFormula(
  llm: BaseChatModel,
  latex: string,
  type: 'block' | 'inline',
  documentTitle: string,
): Promise<string | null> {
  const prompt = buildFormulaPrompt(latex, type, documentTitle);
  const message = new HumanMessage(prompt);

  // S3-2 修复：使用 config.formula.timeoutMs 为 LLM 调用添加超时保护
  // 超时后返回 null，由上层计数为 failed，不阻塞其他公式解释
  const timeoutMs = config.formula.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invokePromise = llm.invoke([message]);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`公式解释 LLM 调用超时（${timeoutMs / 1000}s）`)),
      timeoutMs,
    );
  });

  let response;
  try {
    response = await Promise.race([invokePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text =
    typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((c: unknown) => (c as { text?: string }).text || '')
            .join('')
        : '';

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

/**
 * 构造公式解释 Prompt
 *
 * 要求 LLM 输出简洁的中文描述：
 * - 公式的数学含义
 * - 变量含义（如能识别）
 * - 在文档中的作用（结合标题）
 */
function buildFormulaPrompt(
  latex: string,
  type: 'block' | 'inline',
  documentTitle: string,
): string {
  const formulaTypeLabel = type === 'block' ? '块级公式' : '行内公式';
  return `你正在为知识库系统生成公式检索描述。请严格按以下要求输出。

## 上下文
- 文档标题：${documentTitle}
- 公式类型：${formulaTypeLabel}

## LaTeX 源码
${latex}

## 输出要求
请输出一段 50-150 字的中文描述，包含：
1. 公式的数学含义（如：这是欧拉公式 / 二次方程求根公式 / 正态分布概率密度函数）
2. 主要变量含义（如能从公式和上下文识别）
3. 公式在文档中可能的用途（结合文档标题推测）

## 输出格式
直接输出描述文本，不要任何前缀、解释、Markdown 标记或 LaTeX 代码。`;
}

// ==================== 解释插入 ====================

/**
 * 将解释以 blockquote 形式插入回 markdown
 *
 * 插入规则：
 * - 块级公式：在公式后插入空行 + blockquote
 * - 行内公式：在公式所在行末尾插入 blockquote
 *
 * 从后往前插入，避免位置偏移
 */
function insertExplanations(
  text: string,
  formulas: FormulaMatch[],
  explanations: Map<number, string>,
): string {
  if (explanations.size === 0) {
    return text;
  }

  let result = text;

  // 从后往前插入，避免位置偏移
  for (let i = formulas.length - 1; i >= 0; i--) {
    const explanation = explanations.get(i);
    if (!explanation) continue;

    const formula = formulas[i];
    const insertText =
      formula.type === 'block'
        ? `\n\n> 📐 公式解释：${explanation}`
        : `\n> 📐 公式解释：${explanation}`;

    // S3-3 修复：行内公式的解释插入到当前行末尾（下一个换行符处），
    // 而非公式后立即插入，避免截断同行后续文本
    let insertPos = formula.end;
    if (formula.type === 'inline') {
      const nextNewline = result.indexOf('\n', formula.end);
      insertPos = nextNewline >= 0 ? nextNewline : result.length;
    }

    result =
      result.slice(0, insertPos) + insertText + result.slice(insertPos);
  }

  return result;
}
