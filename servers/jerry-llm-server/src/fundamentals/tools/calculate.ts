import { evaluate } from 'mathjs';
import { logger } from '../logger';

export const calculateSchema = {
  type: 'function' as const,
  function: {
    name: 'calculate',
    description: '执行精确的数学计算。当用户需要进行复杂的数学运算（如大数乘除、浮点运算、科学计算、三角函数、对数、幂运算等）时，使用此工具确保计算结果精确无误。简单的加减乘除（如 1+1）可直接回答，无需调用此工具。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '数学表达式，如 "123456 * 789012"、"sqrt(2)"、"sin(pi/4)"、"log(100, 10)"、"2^64"',
        },
      },
      required: ['expression'],
    },
  },
};

export interface CalculateParams {
  expression: string;
}

export interface CalculateResult {
  expression: string;
  result: string;
  summary?: string;
  error?: string;
}

const BLOCKED_PATTERNS = [
  /\b(require|import|eval|Function|process|child_process|fs|path|os|http|https|net|child_process)\b/i,
  /\b(__dirname|__filename|global|window|document)\b/i,
];

function validateExpression(expression: string): string | null {
  if (!expression || !expression.trim()) {
    return '表达式不能为空';
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(expression)) {
      return `表达式包含不允许的内容: ${expression.match(pattern)![0]}`;
    }
  }

  return null;
}

export async function executeCalculate(
  params: CalculateParams,
): Promise<CalculateResult> {
  const startTime = Date.now();
  const expression = params.expression?.trim();

  logger.info('FC工具 [calculate] 开始执行', {
    module: 'Tool:Calculate',
    expression,
  });

  if (!expression) {
    logger.warn('FC工具 [calculate] 参数校验失败：expression 为空', {
      module: 'Tool:Calculate',
    });
    return {
      expression: params.expression || '',
      result: '',
      error: '表达式不能为空',
    };
  }

  const validationError = validateExpression(expression);
  if (validationError) {
    logger.warn('FC工具 [calculate] 表达式安全校验失败', {
      module: 'Tool:Calculate',
      expression,
      error: validationError,
    });
    return {
      expression,
      result: '',
      error: validationError,
    };
  }

  try {
    const result = evaluate(expression);
    const resultStr = typeof result === 'object' && result !== null
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
