import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * 会话摘要实体
 * 当会话消息超过阈值时，自动将早期对话压缩为摘要，
 * 以解决上下文窗口有限导致早期信息丢失的问题。
 *
 * 工作流程：
 * 1. 用户对话消息数 > SUMMARY_THRESHOLD（30条）时触发摘要生成
 * 2. 调用 DeepSeek-Flash 生成摘要（本地模型摘要质量不足）
 * 3. 摘要存入此表，与 sessionId 一一对应
 * 4. 后续对话时，将摘要注入 System Prompt，history 只传最近几条
 * 5. 每新增 20 条消息后，增量更新摘要
 */
@Entity()
export class SessionSummary {
  @PrimaryGeneratedColumn()
  id: number;

  /** 关联的会话 ID，与 Session 表的 sessionId 对应 */
  @Column({ unique: true })
  sessionId: string;

  /** 摘要内容：由 LLM 生成的对话压缩文本 */
  @Column('text')
  summaryContent: string;

  /** 当前摘要覆盖的消息数量，用于判断是否需要增量更新 */
  @Column({ default: 0 })
  coveredMessageCount: number;

  /** 用户 ID，预留字段，当前默认 'default' */
  @Column({ default: 'default' })
  userId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
