import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum VectorOpType {
  REMOVE = 'remove',
  UPDATE_STATUS = 'update_status',
  REINDEX = 'reindex',
}

export enum VectorOpStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('pending_vector_ops')
export class PendingVectorOp {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  versionId: number;

  @Column({ type: 'enum', enum: VectorOpType })
  operation: VectorOpType;

  @Column({ type: 'enum', enum: VectorOpStatus, default: VectorOpStatus.PENDING })
  status: VectorOpStatus;

  @Column({ default: 0 })
  retryCount: number;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ type: 'simple-json', nullable: true })
  params: Record<string, any>;

  @CreateDateColumn()
  @Index()
  createdAt: Date;
}
