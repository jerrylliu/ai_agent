import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/**
 * 自动评估记录
 *
 * 基于规则自动评估回答质量的记录，与人工评估互补。
 */
@Entity()
export class AutoEvaluation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 'default' })
  userId: string;

  @Column()
  sessionId: string;

  @Column({ type: 'text' })
  userMessage: string;

  @Column({ type: 'text' })
  assistantMessage: string;

  /** 0-1 的评分 */
  @Column({ type: 'float', default: 0 })
  score: number;

  /** 评分依据说明 */
  @Column({ nullable: true, type: 'text' })
  reason: string;

  /** 评估维度：relevance(相关性), completeness(完整性), accuracy(准确性) */
  @Column({ default: 'relevance' })
  dimension: string;

  @Column({ nullable: true })
  modelId: string;

  @Column({ default: false })
  usedKnowledgeBase: boolean;

  @Column({ default: 0 })
  responseTimeMs: number;

  @CreateDateColumn()
  createdAt: Date;
}
