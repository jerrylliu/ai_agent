import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/**
 * LLM 调用用量记录
 *
 * 记录每次 LLM 调用的 token 消耗和上下文信息，
 * 用于成本分析和策略优化。
 */
@Entity()
export class LlmUsage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 'default' })
  userId: string;

  @Column({ nullable: true })
  sessionId: string;

  @Column()
  modelId: string;

  @Column({ default: 0 })
  inputTokens: number;

  @Column({ default: 0 })
  outputTokens: number;

  @Column({ default: 0 })
  historyCount: number;

  @Column({ default: false })
  usedKnowledgeBase: boolean;

  @Column({ default: 0 })
  imageCount: number;

  @Column({ nullable: true })
  responseTimeMs: number;

  @Column({ nullable: true, type: 'text' })
  userMessage: string;

  @CreateDateColumn()
  createdAt: Date;
}
