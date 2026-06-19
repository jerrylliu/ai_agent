/**
 * fundamentals/llm-json-parser.ts
 *
 * LLM 输出 → zod schema 的统一抽取工具。
 *
 * 背景：
 * 项目里多处让 LLM 返回 JSON 文本，再 `JSON.parse` 直接消费，导致：
 *   - LLM 加了 markdown 围栏 ```json ... ``` 时直接挂掉
 *   - LLM 多说了一句解释或 emoji 时直接挂掉
 *   - LLM 偶尔字段拼写错时无声漂移
 *
 * 规范第 7.2 节"LLM 结构化输出"要求：
 *   - 禁止裸 JSON.parse
 *   - 必须经 zod 校验
 *   - 解析失败时写结构化日志 + 走业务降级路径，不静默吞错
 *
 * 本 helper 不动 LLM 调用方式（不用 withStructuredOutput），
 * 仅替换"regex 抽 JSON + JSON.parse"这一段为"regex 抽 JSON + zod safeParse"，
 * 兼容所有 LLM Provider（包括不支持 function calling 的本地模型）。
 */

import type { ZodType } from 'zod';
import { logger } from './logger';

/**
 * 从 LLM 自由文本中尽可能抽出 JSON 子串。
 *
 * 策略：
 *   1. 优先匹配 ```json ... ``` 或 ``` ... ``` 围栏内容
 *   2. 否则定位第一个 `{` 与最后一个 `}`，或 `[` 与 `]`
 *   3. 失败返回 null（让上层走降级，不要再去硬试）
 */
export function extractJsonText(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();

  // 1) markdown 围栏
  const fenceMatch =
    text.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/) ||
    text.match(/`([\s\S]*?)`/);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }

  // 2) 直接定位第一个/最后一个 JSON 边界
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');

  // 谁起点更靠前用谁；都没找到返回 null
  let start = -1;
  let end = -1;
  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    start = objStart;
    end = objEnd;
  } else if (arrStart !== -1) {
    start = arrStart;
    end = arrEnd;
  }

  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** parse 结果：成功携带 data；失败携带可读 reason，方便日志和降级 */
export type LlmJsonParseResult<T> =
  | { success: true; data: T }
  | { success: false; reason: string; rawText: string };

/**
 * 抽取并用 zod schema 校验 LLM 返回值。
 *
 * @param rawText  LLM 的原始 message.content（已合并为 string）
 * @param schema   zod schema
 * @param context  日志上下文，至少应带 `module`，方便在 Loki 中检索
 * @returns        { success: true, data } 或 { success: false, reason }
 */
export function parseLlmJson<T>(
  rawText: string,
  schema: ZodType<T>,
  context: { module: string; [key: string]: unknown },
): LlmJsonParseResult<T> {
  const jsonText = extractJsonText(rawText);
  if (!jsonText) {
    logger.warn('LLM 输出未能抽出 JSON 片段', {
      ...context,
      rawTextPreview: rawText?.substring(0, 200) ?? '',
    });
    return {
      success: false,
      reason: 'no-json-found',
      rawText,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    logger.warn('LLM 输出 JSON.parse 失败', {
      ...context,
      jsonPreview: jsonText.substring(0, 200),
      error: (e as Error).message,
    });
    return {
      success: false,
      reason: 'invalid-json',
      rawText,
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    logger.warn('LLM 输出 zod 校验失败', {
      ...context,
      issues,
      jsonPreview: jsonText.substring(0, 300),
    });
    return {
      success: false,
      reason: `schema-mismatch: ${issues}`,
      rawText,
    };
  }

  return { success: true, data: result.data };
}

/**
 * 轻量版：解析 Tool 自身产出的 JSON 字符串（已是规整 JSON，不带 markdown 围栏）。
 *
 * 与 parseLlmJson 的区别：
 *   - 不做 extractJsonText 抽取（Tool 产出永远是合法 JSON 字符串）
 *   - 解析失败仅 debug 级日志（属于偶发的上游异常，不影响主流程）
 *
 * 用于 prompt.ts 在 FC 循环中读取 Tool 结果回填到 LLM 上下文。
 */
export function parseToolResultJson<T>(
  rawJson: string,
  schema: ZodType<T>,
  context: { module: string; toolName?: string; [key: string]: unknown },
): LlmJsonParseResult<T> {
  if (!rawJson || typeof rawJson !== 'string') {
    return { success: false, reason: 'empty-input', rawText: rawJson ?? '' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    logger.debug('Tool 结果 JSON.parse 失败', {
      ...context,
      preview: rawJson.substring(0, 200),
      error: (e as Error).message,
    });
    return { success: false, reason: 'invalid-json', rawText: rawJson };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    logger.debug('Tool 结果 zod 校验失败', {
      ...context,
      issues,
      preview: rawJson.substring(0, 300),
    });
    return { success: false, reason: `schema-mismatch: ${issues}`, rawText: rawJson };
  }

  return { success: true, data: result.data };
}
