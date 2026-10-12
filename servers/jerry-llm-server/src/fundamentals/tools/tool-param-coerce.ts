/**
 * FC 工具参数形态容错（共享层）
 *
 * 背景（2026-10-12 四起生产案例）：LLM 传参时偶发把结构化字段传错形态——
 * 1. send_notification 把整个 attachments 数组二次序列化为 JSON 字符串；
 * 2. create_plan 把 steps 数组传成 JSON 字符串、goal 字段误传为 title；
 * 3. create_document 把 content 传成对象而非字符串；
 * 4. generate_chart 把 echartsOption / data 传成 JSON 字符串。
 *
 * 原则：在 schema 归一化层做兜底，"不赌模型永远传对参数"（与 send-notification
 * 既有容错同一风格）。归一化失败时保持原值，让 zod 给出清晰错误，
 * 绝不静默吞掉参数。
 *
 * 演进：前四起均为"逐工具打补丁"模式（每个工具自己包 z.preprocess），
 * 2026-10-12 重构为 schema 导向的全局归一化 coerceParamsBySchema——
 * 由 safeParseToolParams 统一调用，按工具自身 schema 期望的形态自动修复，
 * 新工具零配置即获防护，新增错误形态只需改这一处。
 */

import { ZodType } from 'zod';

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

// ==================== schema 导向的全局归一化 ====================

/** zod def.type 的宽松读取（仅做字符串比对，不依赖更多私有结构） */
function schemaDefType(schema: ZodType): string | undefined {
  const def = (schema as unknown as { def?: { type?: unknown } }).def;
  return typeof def?.type === 'string' ? def.type : undefined;
}

/** 解包 optional / nullable / default 包装（zod 4 统一提供 .unwrap()） */
function unwrapWrapper(schema: ZodType): ZodType {
  let s = schema;
  for (let i = 0; i < 5; i++) {
    const t = schemaDefType(s);
    if (t !== 'optional' && t !== 'nullable' && t !== 'default') break;
    const unwrap = (s as unknown as { unwrap?: () => ZodType }).unwrap;
    if (typeof unwrap !== 'function') break;
    s = unwrap.call(s);
  }
  return s;
}

/** ZodPipe 的输出端 schema（z.preprocess 包裹的对象形态，统一从 out 端内省） */
function pipeOutSchema(schema: ZodType): ZodType | null {
  const holder = schema as unknown as { out?: unknown; def?: { out?: unknown } };
  const candidate = holder.out ?? holder.def?.out;
  return candidate instanceof ZodType ? candidate : null;
}

/** ZodObject（含 looseObject/strictObject）的 shape 字典 */
function objectShape(schema: ZodType): Record<string, ZodType> | null {
  const shape = (schema as unknown as { shape?: unknown }).shape;
  if (shape && typeof shape === 'object') {
    return shape as Record<string, ZodType>;
  }
  return null;
}

/** ZodRecord 的值 schema（zod 4 存在 def.valueType） */
function recordValueSchema(schema: ZodType): ZodType | null {
  const valueType = (
    schema as unknown as { def?: { valueType?: unknown } }
  ).def?.valueType;
  return valueType instanceof ZodType ? valueType : null;
}

export interface SchemaCoerceResult {
  /** 归一化后的参数（无修正时与入参内容等价） */
  data: unknown;
  /** 每处修正的可读描述（含字段路径），用于打点观测 */
  fixes: string[];
}

/**
 * schema 导向的参数归一化（全局参数安检的引擎）：
 *
 * 沿着工具自身 zod schema 递归下钻，对照"每个字段期望的形态"修复实际传参：
 * - schema 期望 object/array/record，实际传 JSON 字符串 → 还原后继续下钻；
 * - schema 期望 string，实际传对象/数组 → 提取文本字段或 JSON.stringify
 *   （空对象/空数组不修，保留 zod 的清晰报错）；
 * - optional/nullable/default/pipe 包装自动解包，嵌套层级不设限。
 *
 * 每一刀都照着 schema 砍：类型已匹配的值绝不触碰，误伤面趋近于零。
 * 无法内省的 schema（union/tuple/enum 等叶子）原样通过，行为与旧版完全一致。
 */
export function coerceParamsBySchema(
  schema: ZodType,
  value: unknown,
): SchemaCoerceResult {
  const fixes: string[] = [];
  const data = coerceBySchemaNode(schema, value, fixes, '');
  return { data, fixes };
}

function coerceBySchemaNode(
  schema: ZodType,
  value: unknown,
  fixes: string[],
  path: string,
): unknown {
  // 解包装饰器后进入实际类型分支；pipe 取输出端（preprocess 的产物应符合 out 形态）
  let s = unwrapWrapper(schema);
  if (schemaDefType(s) === 'pipe') {
    const out = pipeOutSchema(s);
    if (out) return coerceBySchemaNode(out, value, fixes, path);
    return value;
  }

  const t = schemaDefType(s);

  // ---- 期望对象：JSON 字符串还原 + 逐字段下钻 ----
  if (t === 'object' || t === 'looseObject' || t === 'strictObject') {
    if (typeof value === 'string') {
      const parsed = tryParseJsonString(value);
      if (
        parsed !== undefined &&
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        fixes.push(`${path || '(root)'}: JSON 字符串已还原为对象`);
        return coerceBySchemaNode(s, parsed, fixes, path);
      }
      return value;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }
    const shape = objectShape(s);
    if (!shape) return value;
    const out: Record<string, unknown> = {
      ...(value as Record<string, unknown>),
    };
    for (const key of Object.keys(out)) {
      const fieldSchema = shape[key];
      if (!fieldSchema) continue;
      out[key] = coerceBySchemaNode(
        fieldSchema,
        out[key],
        fixes,
        path ? `${path}.${key}` : key,
      );
    }
    return out;
  }

  // ---- 期望数组：JSON 字符串还原 + 逐元素下钻 ----
  if (t === 'array') {
    if (typeof value === 'string') {
      const parsed = tryParseJsonString(value);
      if (Array.isArray(parsed)) {
        fixes.push(`${path || '(root)'}: JSON 字符串已还原为数组`);
        return coerceBySchemaNode(s, parsed, fixes, path);
      }
      return value;
    }
    if (!Array.isArray(value)) return value;
    const element = (
      s as unknown as { element?: unknown; def?: { element?: unknown } }
    ).element;
    if (!(element instanceof ZodType)) return value;
    return value.map((item, i) =>
      coerceBySchemaNode(element, item, fixes, `${path}[${i}]`),
    );
  }

  // ---- 期望字符串：对象/数组归一化为文本（空容器保留原值让 zod 报错） ----
  if (t === 'string') {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      if (value.length === 0) return value;
      fixes.push(`${path || '(root)'}: 数组已归一化为字符串`);
      return coerceContentLikeToString(value);
    }
    if (typeof value === 'object' && value !== null) {
      if (Object.keys(value).length === 0) return value;
      fixes.push(`${path || '(root)'}: 对象已归一化为字符串`);
      return coerceContentLikeToString(value);
    }
    return value;
  }

  // ---- 期望字典（record）：JSON 字符串还原 + 逐值下钻 ----
  if (t === 'record') {
    if (typeof value === 'string') {
      const parsed = tryParseJsonString(value);
      if (
        parsed !== undefined &&
        typeof parsed === 'object' &&
        parsed !== null
      ) {
        fixes.push(`${path || '(root)'}: JSON 字符串已还原为对象`);
        return coerceBySchemaNode(s, parsed, fixes, path);
      }
      return value;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }
    const valueSchema = recordValueSchema(s);
    if (!valueSchema) return value;
    const out: Record<string, unknown> = {
      ...(value as Record<string, unknown>),
    };
    for (const key of Object.keys(out)) {
      out[key] = coerceBySchemaNode(
        valueSchema,
        out[key],
        fixes,
        `${path}.${key}`,
      );
    }
    return out;
  }

  // 其他类型（number/enum/boolean/union 等）不做处理，交由 zod 给出清晰错误
  return value;
}
