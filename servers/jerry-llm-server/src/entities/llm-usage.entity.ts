import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

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

  /**
   * 本次回答参考的知识库文档 ID 集合（JSON 数组字符串，null = 未用知识库）
   * 与 retrievedContexts 一一对应，benchmark 与在线 faithfulness 评估的存档依据
   */
  @Column({ type: 'longtext', nullable: true })
  retrievedDocumentIds: string | null;

  /**
   * 本次回答实际参与生成的检索上下文原文（JSON 数组字符串）
   * 回答一生成完内存即释放，不落库则事后无法核对答案论断是否有依据（幻觉检测的米）
   */
  @Column({ type: 'longtext', nullable: true })
  retrievedContexts: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
