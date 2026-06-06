import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * 消息反馈（人工评估）
 *
 * 用户对 AI 回复的点赞/点踩反馈，用于量化回答准确率。
 */
@Entity()
export class MessageFeedback {
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

  /** positive=点赞, negative=点踩 */
  @Column()
  rating: 'positive' | 'negative';

  @Column({ nullable: true, type: 'text' })
  comment: string;

  @Column({ nullable: true })
  modelId: string;

  @Column({ default: false })
  usedKnowledgeBase: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
