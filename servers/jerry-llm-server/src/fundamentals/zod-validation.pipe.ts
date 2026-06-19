/**
 * ZodValidationPipe —— 基于 zod 的 NestJS 校验管道
 *
 * 设计目的：
 * - 给希望"用 zod 取代 class-validator"的新接口提供统一入口，避免每个
 *   Controller 各写各的 safeParse + 异常映射
 * - 保留 NestJS 全局 ValidationPipe（class-validator）的现有体系不动，
 *   两者在不同接口上并存即可
 *
 * 使用约定：
 * - 仅用于 `@Body()` / `@Query()` / `@Param()` 等参数级校验
 * - schema 必须是 ZodType（z.object / z.union / z.discriminatedUnion 等）
 * - 校验失败统一抛 `BadRequestException`，错误体形状如下：
 *     {
 *       statusCode: 400,
 *       message: '请求参数校验失败',
 *       errors: [{ path: 'foo.bar', message: '必填字段缺失' }]
 *     }
 *
 * 典型用法：
 * ```ts
 * const CreatePostSchema = z.object({
 *   title: z.string().min(1).max(120),
 *   tags: z.array(z.string()).default([]),
 * });
 *
 * @Post()
 * create(@Body(new ZodValidationPipe(CreatePostSchema)) body: z.infer<typeof CreatePostSchema>) {
 *   return this.svc.create(body);
 * }
 * ```
 */

import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ZodType } from 'zod';

export interface ZodValidationError {
  /** 字段路径，使用点号拼接，如 `user.email` */
  path: string;
  /** 校验失败原因 */
  message: string;
}

@Injectable()
export class ZodValidationPipe<T extends ZodType> implements PipeTransform {
  /**
   * @param schema 用于校验入参的 zod schema
   * @param options.label 错误信息中可选的业务标签，便于日志中区分场景
   */
  constructor(
    private readonly schema: T,
    private readonly options: { label?: string } = {},
  ) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    const errors: ZodValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));

    throw new BadRequestException({
      statusCode: 400,
      message: this.options.label
        ? `请求参数校验失败 [${this.options.label}]`
        : '请求参数校验失败',
      errors,
    });
  }
}
