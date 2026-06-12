import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * 工具调用使用记录
 *
 * 记录每次工具调用的详细信息，包括成功率、耗时、参数摘要等，
 * 用于工具使用分析和优化。
 */
@Entity()
export class ToolUsage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 'default' })
  @Index()
  userId: string;

  @Column({ nullable: true })
  @Index()
  sessionId: string;

  @Column()
  @Index()
  toolName: string;

  @Column({ default: true })
  success: boolean;

  @Column({ default: 0 })
  durationMs: number;

  @Column({ type: 'text', nullable: true })
  paramsSummary: string;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ nullable: true })
  modelId: string;

  @CreateDateColumn()
  @Index()
  createdAt: Date;
}
