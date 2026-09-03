import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { KnowledgeSource } from './knowledge-source.entity.js';

export enum SyncLogStatus {
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('knowledge_source_sync_logs')
export class KnowledgeSourceSyncLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  sourceId: number;

  @Column({ type: 'enum', enum: SyncLogStatus })
  status: SyncLogStatus;

  @Column({ default: 0 })
  pagesFetched: number;

  @Column({ default: 0 })
  chunksAdded: number;

  @Column({ default: 0 })
  chunksUpdated: number;

  @Column({ default: 0 })
  pagesNew: number;

  @Column({ default: 0 })
  pagesUpdated: number;

  @Column({ default: 0 })
  pagesDeleted: number;

  @Column({ type: 'simple-json', nullable: true })
  updatedPageDetails: Array<{ title: string; url: string }> | null;

  /** 本次同步中被注入扫描拦截（跳过向量化入库）的页面数 */
  @Column({ default: 0 })
  pagesSkippedByScan: number;

  /** 被注入扫描拦截的页面明细（追溯拦截原因用；页面仍会持久化 hash，内容不变则持续拒绝） */
  @Column({ type: 'simple-json', nullable: true })
  skippedPageDetails: Array<{ title: string; url: string; reason: string }> | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @ManyToOne(() => KnowledgeSource, source => source.syncLogs, { onDelete: 'CASCADE' })
  source: KnowledgeSource;
}
