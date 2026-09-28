import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

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

  // ==================== 在线 judge 判分（异步追加，null = 未评） ====================

  /**
   * 忠实度：答案论断是否都有检索上下文依据（幻觉检测）。
   * 与规则分互补——规则分量"长短快慢"，judge 量"有没有编造"
   */
  @Column({ type: 'boolean', nullable: true })
  judgeFaithful: boolean | null;

  /** 切题度：答案是否回答了问题本身（答非所问检测） */
  @Column({ type: 'boolean', nullable: true })
  judgeRelevant: boolean | null;

  /** judge 摘出的编造原句清单（JSON 数组字符串，faithful=true 时为 null） */
  @Column({ type: 'longtext', nullable: true })
  unfaithfulClaims: string | null;

  /** judge 一句话判分理由（中文） */
  @Column({ nullable: true, type: 'text' })
  judgeReason: string;

  /** 执行判分的 judge 模型 id（如 zhipu:glm-4.7，可观测判分来源；长度与迁移 1790600000000 对齐） */
  @Column({ nullable: true, length: 120 })
  judgeModel: string;

  @CreateDateColumn()
  createdAt: Date;
}
