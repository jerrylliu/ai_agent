/**
 * Tool Schema 公共构建工具
 *
 * 设计目标：
 * - 把 zod 4 原生 `z.toJSONSchema()` 的输出包装成与项目历史手写
 *   `{ type: 'function', function: { name, description, parameters } }` 完全
 *   等价的 OpenAI Function Calling Schema
 * - 统一 `target: 'openapi-3.0'` + `io: 'input'`，确保：
 *   1. 顶层不带 $schema 杂质
 *   2. `.default()` 字段正确从 required 排除（与原手写行为一致）
 *
 * 用法：
 * ```ts
 * const ParamsSchema = z.object({
 *   query: z.string().describe('搜索查询'),
 * });
 * export const xxxSchema = buildToolJsonSchema(
 *   'xxx', 'XXX 的工具描述', ParamsSchema,
 * );
 * export type XxxParams = z.infer<typeof ParamsSchema>;
 * ```
 *
 * 使用约束（强制）：
 * - 每个字段必须 `.describe('中文说明')`，否则 LLM function calling 准确率会显著下降
 * - 不要直接 export ParamsSchema 出去给 LLM，LLM 拿到的是 buildToolJsonSchema 的结果
 * - 入参校验请在 executor 入口用 `ParamsSchema.safeParse(params)`，配合
 *   `formatZodIssues` 输出统一错误信息
 */

import { z, ZodObject, ZodType } from 'zod';

/** OpenAI Function Calling 风格的 Tool Schema */
export interface OpenAiFunctionToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 把 zod 对象 schema 转成 OpenAI Function Calling 风格的工具描述
 *
 * 注意：参数 schema 必须是 z.object，因为 OpenAI function calling
 * 要求 parameters 是 object 类型
 */
export function buildToolJsonSchema(
  name: string,
  description: string,
  paramsSchema: ZodObject<any>,
): OpenAiFunctionToolSchema {
  const parameters = z.toJSONSchema(paramsSchema, {
    target: 'openapi-3.0',
    io: 'input',
  }) as Record<string, unknown>;

  // zod v4 在 openapi-3.0 target 下，对 .positive() / .negative() 等约束
  // 仍会输出 Draft-4 风格的 boolean exclusiveMinimum/exclusiveMaximum，
  // 这与 OpenAI / DeepSeek 等使用的现代 JSON Schema（要求 number）不兼容，
  // 会触发 "true is not of type number" 报错。这里递归后处理统一转成 number。
  normalizeExclusiveBounds(parameters);

  return {
    type: 'function',
    function: {
      name,
      description,
      parameters,
    },
  };
}

/**
 * 递归把 Draft-4 风格的 exclusiveMinimum/exclusiveMaximum: true
 * 转成 Draft 2020-12 / OpenAPI 3.1 风格的 number 值，并删除冗余的
 * minimum/maximum，避免下游 LLM 严格校验失败。
 */
function normalizeExclusiveBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeExclusiveBounds(item);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;

  if (obj.exclusiveMinimum === true && typeof obj.minimum === 'number') {
    obj.exclusiveMinimum = obj.minimum;
    delete obj.minimum;
  } else if (obj.exclusiveMinimum === false) {
    delete obj.exclusiveMinimum;
  }

  if (obj.exclusiveMaximum === true && typeof obj.maximum === 'number') {
    obj.exclusiveMaximum = obj.maximum;
    delete obj.maximum;
  } else if (obj.exclusiveMaximum === false) {
    delete obj.exclusiveMaximum;
  }

  for (const key of Object.keys(obj)) {
    normalizeExclusiveBounds(obj[key]);
  }
}

/**
 * 把 zod 校验失败的 issues 拼成统一字符串
 * 用于 executor 入口校验失败时返回给 LLM 的错误消息
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * 统一的 Tool 入参校验：成功返回数据，失败返回包含错误信息的对象
 * 让各 Tool executor 入口少写样板代码
 */
export function safeParseToolParams<T extends ZodType>(
  schema: T,
  params: unknown,
):
  | { success: true; data: z.infer<T> }
  | { success: false; error: string } {
  const result = schema.safeParse(params);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: formatZodIssues(result.error) };
}
