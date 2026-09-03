import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * 检索隐式反馈记录
 *
 * 收集用户在搜索/对话过程中的隐式行为信号，用于评估检索质量：
 * - regenerate：用户重新生成回答 → 检索结果可能不相关（负向信号）
 * - followup：用户追问 → 检索结果有一定参考价值（中性/正向信号）
 * - abandon：用户放弃当前会话 → 可能未找到所需信息（负向信号）
 * - positive / negative：与人工反馈交叉关联
 *
 * 与 MessageFeedback（人工反馈）互补：
 * - MessageFeedback：用户主动点赞/点踩，信号强但覆盖率低（< 5%）
 * - SearchFeedback：被动收集行为信号，覆盖率高但需统计分析
 */
@Entity()
export class SearchFeedback {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 'default' })
  @Index()
  userId: string;

  @Column()
  @Index()
  sessionId: string;

  /** 用户原始查询文本 */
  @Column({ type: 'text' })
  query: string;

  /** 检索到的文档 ID 列表（JSON 数组，按排名顺序） */
  @Column({ type: 'text' })
  retrievedDocIds: string;

  /**
   * 用户行为类型（隐式反馈信号）
   * - regenerate：重新生成（负向）
   * - followup：追问（中性/正向）
   * - abandon：放弃会话（负向）
   * - positive：点赞（正向，交叉关联 MessageFeedback）
   * - negative：点踩（负向，交叉关联 MessageFeedback）
   */
  @Column()
  @Index()
  action: 'regenerate' | 'followup' | 'abandon' | 'positive' | 'negative';

  /** 检索到回答的总耗时（ms） */
  @Column({ default: 0 })
  responseTimeMs: number;

  /** 检索结果数量 */
  @Column({ default: 0 })
  resultCount: number;

  /** 使用的模型 ID */
  @Column({ nullable: true })
  modelId: string;

  /** 检索方式：hybrid / vector / bm25 */
  @Column({ default: 'hybrid' })
  searchType: string;

  /** 额外元数据（JSON） */
  @Column({ type: 'text', nullable: true })
  metadata: string;

  @CreateDateColumn()
  @Index()
  createdAt: Date;
}
