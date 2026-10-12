/**
 * FC 工具参数形态容错（共享层）
 *
 * 背景（2026-10-12 三起生产案例）：LLM 传参时偶发把结构化字段传错形态——
 * 1. send_notification 把整个 attachments 数组二次序列化为 JSON 字符串；
 * 2. create_plan 把 steps 数组传成 JSON 字符串、goal 字段误传为 title；
 * 3. create_document 把 content 传成对象而非字符串。
 *
 * 原则：在 schema 归一化层做兜底，"不赌模型永远传对参数"（与 send-notification
 * 既有容错同一风格）。归一化失败时保持原值，让 zod 给出清晰错误，
 * 绝不静默吞掉参数。
 */

/**
 * 尝试把疑似 JSON 的字符串解析还原（仅当以 [ 或 { 开头才尝试，避免误伤普通文本）。
 * 解析失败或非 JSON 形态返回 undefined，调用方按原字符串处理。
 */
export function tryParseJsonString(v: string): unknown | undefined {
  const s = v.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      // 非法 JSON：按原字符串走既有容错路径
    }
  }
  return undefined;
}

/**
 * 对象级字段归一化：
 * - 指定字段若为 JSON 字符串（'[...]' / '{...}'）则解析还原；
 * - fromField 到 toField 的别名兜底（如模型把 goal 传成 title）。
 * 返回浅拷贝后的新对象，原对象不被修改；入参非对象时原样返回。
 */
export function coerceToolParams(
  v: unknown,
  opts: {
    jsonFields?: string[];
    alias?: { from: string; to: string };
  },
): unknown {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
  const o: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  if (opts.alias) {
    const { from, to } = opts.alias;
    const toEmpty =
      o[to] === undefined || o[to] === null || o[to] === '';
    const fromVal = o[from];
    if (toEmpty && typeof fromVal === 'string' && fromVal.trim()) {
      o[to] = fromVal.trim();
    }
  }
  for (const field of opts.jsonFields ?? []) {
    const val = o[field];
    if (typeof val === 'string') {
      const parsed = tryParseJsonString(val);
      if (parsed !== undefined) o[field] = parsed;
    }
  }
  return o;
}

/**
 * 内容类字段归一化为字符串（create_document / update_document 的 content）：
 * - 字符串：原样；
 * - 数组：各元素字符串化后按空行拼接（模型把分段落传成数组的变体）；
 * - 对象：优先提取常见文本字段（content/text/markdown/body/summary/document），
 *   都没有则 JSON.stringify 美化输出（保留全部信息，绝不丢弃）；
 * - 其他类型（number/null 等）：原样返回，交给 zod 报清晰错误。
 */
export function coerceContentLikeToString(v: unknown): unknown {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((item) =>
        typeof item === 'string' ? item : JSON.stringify(item),
      )
      .join('\n\n');
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    for (const k of [
      'content',
      'text',
      'markdown',
      'body',
      'summary',
      'document',
    ]) {
      const val = o[k];
      if (typeof val === 'string' && val.trim()) return val;
    }
    return JSON.stringify(v, null, 2);
  }
  return v;
}
