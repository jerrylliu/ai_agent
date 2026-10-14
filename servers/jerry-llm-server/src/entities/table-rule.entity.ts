/**
 * entities/table-rule.entity.ts
 *
 * 表格规则器实体（EXCEL_GRID_EDITOR_PLAN.md 功能 5"表格的 ESLint"）。
 *
 * 设计要点：
 *   - 一条规则一行（而非文档列 JSON），便于单条启停/修改/删除；
 *   - 规则存数据库，不塞表格 contentText（防污染 RAG，方案设计原则 3）；
 *   - 绑定文档（documentId）：删除文档时级联删除规则，不留孤儿数据；
 *   - 参数/修复动作存 JSON 字符串：结构由 fundamentals/table-ops/rules.ts 的
 *     zod schema 定义，写入前统一校验，读取时 safeParse 兜底（脏数据跳过并标失效）。
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('table_rules')
@Index(['documentId'])
export class TableRule {
  @PrimaryGeneratedColumn()
  id: number;

  /** 所属文档 ID（document 表） */
  @Column({ type: 'int' })
  documentId: number;

  /** 规则名（如"区域不能留空"），面板与违规报告展示用 */
  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** 规则类型：notEmpty / allowedValues / numericRange / unique / formula */
  @Column({ type: 'varchar', length: 30 })
  type: string;

  /** 规则参数 JSON（按 type 不同结构，见 rules.ts） */
  @Column({ type: 'text' })
  paramsJson: string;

  /** 修复动作 JSON（可选：固定值 / 公式 / 删除该行；NULL = 只标记不修复） */
  @Column({ type: 'text', nullable: true })
  fixActionJson: string | null;

  /** 启停状态（停用的规则不参与检查） */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** 来源：manual 用户手写 / ai AI 提议（用户确认后入库） */
  @Column({ type: 'varchar', length: 10, default: 'manual' })
  source: string;

  /**
   * 规则作用的工作表名（可选；NULL = 文档第一个工作表，向后兼容旧规则）。
   * 多 sheet 文档里 AI 提议的规则会绑定列所在的工作表，检查/修复据此定位。
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  targetSheet: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
