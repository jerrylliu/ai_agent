import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum KgOpType {
  /** 抽取（含重抽）：解析文档正文 → LLM 抽实体/三元组 → 落库 → 嵌入 → 重建内存索引 */
  EXTRACT = 'extract',
  /** 文档移除：文档不再有 ACTIVE 版本时，删除其全部 KG 行并重建索引 */
  REMOVE_DOC = 'remove_doc',
}

export enum KgOpStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * KG 抽取操作队列（照抄 pending_vector_ops 状态机范式）
 *
 * 由 KgExtractService 的 @Interval 调度消费：
 * - 扫描 ACTIVE 版本与已完成 op 的差集自动入队（天然覆盖存量回填 + 增量更新）
 * - retryCount < maxRetries 时失败回 pending 重试，超限置 failed 留 errorMessage
 */
@Entity('kg_extract_op')
@Index(['status', 'createdAt'])
export class KgExtractOp {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  @Index()
  documentId: number;

  /** 目标版本 id（EXTRACT 必填；REMOVE_DOC 为 null） */
  @Column({ type: 'int', nullable: true })
  versionId: number | null;

  @Column({ type: 'enum', enum: KgOpType })
  operation: KgOpType;

  @Column({ type: 'enum', enum: KgOpStatus, default: KgOpStatus.PENDING })
  status: KgOpStatus;

  @Column({ default: 0 })
  retryCount: number;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ type: 'simple-json', nullable: true })
  params: Record<string, any>;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
