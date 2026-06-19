import { evaluate } from 'mathjs';
import { z } from 'zod';
import { logger } from '../logger';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== Zod Schema ====================

/**
 * calculate 工具入参 schema
 * 注意：每个字段的 `.describe()` 文案会被转换为 OpenAI Function Calling
 * 的 description，直接影响 LLM 调用准确率，必须保持中文且语义清晰
 */
export const calculateParamsSchema = z.object({
  expression: z
    .string()
    .min(1, '表达式不能为空')
    .describe(
      '数学表达式，如 "123456 * 789012"、"sqrt(2)"、"sin(pi/4)"、"log(100, 10)"、"2^64"',
    ),
});

export type CalculateParams = z.infer<typeof calculateParamsSchema>;

// ==================== OpenAI Function Calling Schema ====================

export const calculateSchema = buildToolJsonSchema(
  'calculate',
  '执行精确的数学计算。当用户需要进行复杂的数学运算（如大数乘除、浮点运算、科学计算、三角函数、对数、幂运算等）时，使用此工具确保计算结果精确无误。简单的加减乘除（如 1+1）可直接回答，无需调用此工具。',
  calculateParamsSchema,
);

// ==================== Result 类型 ====================

export interface CalculateResult {
  expression: string;
  result: string;
  summary?: string;
  error?: string;
}

// ==================== 安全校验：拦截危险表达式 ====================

const BLOCKED_PATTERNS = [
  /\b(require|import|eval|Function|process|child_process|fs|path|os|http|https|net|child_process)\b/i,
  /\b(__dirname|__filename|global|window|document)\b/i,
];

/**
 * 防止 mathjs 表达式中夹带 Node.js 模块名 / 全局对象名
 * 这一层是 Tool 自身的领域逻辑（"安全黑名单"），与 zod 的"形状校验"不同，
 * 因此保留在 executor 内
 */
function validateExpressionSafety(expression: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(expression)) {
      return `表达式包含不允许的内容: ${expression.match(pattern)![0]}`;
    }
  }
  return null;
}

// ==================== Executor ====================

export async function executeCalculate(
  params: unknown,
): Promise<CalculateResult> {
  const startTime = Date.now();

  // 1. zod 形状校验（替换原 if (!params.expression) 的样板代码）
  const parsed = safeParseToolParams(calculateParamsSchema, params);
  if (!parsed.success) {
    logger.warn('FC工具 [calculate] 参数校验失败', {
      module: 'Tool:Calculate',
      error: parsed.error,
    });
    return {
      expression: (params as { expression?: string })?.expression ?? '',
      result: '',
      error: `参数校验失败: ${parsed.error}`,
    };
  }

  const expression = parsed.data.expression.trim();

  logger.info('FC工具 [calculate] 开始执行', {
    module: 'Tool:Calculate',
    expression,
  });

  // 2. 业务安全校验
  const safetyError = validateExpressionSafety(expression);
  if (safetyError) {
    logger.warn('FC工具 [calculate] 表达式安全校验失败', {
      module: 'Tool:Calculate',
      expression,
      error: safetyError,
    });
    return {
      expression,
      result: '',
      error: safetyError,
    };
  }

  // 3. 执行计算
  try {
    const result = evaluate(expression);
    const resultStr =
      typeof result === 'object' && result !== null
        ? result.toString()
        : String(result);

    const duration = Date.now() - startTime;
    logger.info('FC工具 [calculate] 执行完成', {
      module: 'Tool:Calculate',
      expression,
      result: resultStr.substring(0, 200),
      duration,
    });

    return {
      expression,
      result: resultStr,
      summary: `计算结果：${expression} = ${resultStr}`,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error('FC工具 [calculate] 执行失败', {
      module: 'Tool:Calculate',
      expression,
      duration,
      error: error.message,
    });

    return {
      expression,
      result: '',
      error: `计算失败: ${error.message}`,
    };
  }
}
