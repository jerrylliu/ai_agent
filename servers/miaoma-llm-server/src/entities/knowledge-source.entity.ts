import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, Index } from 'typeorm';
import { KnowledgeSourceSyncLog } from './knowledge-source-sync-log.entity.js';

export enum SourceType {
  WEB = 'web',
  FEISHU = 'feishu',
}

export enum SyncStatus {
  IDLE = 'idle',
  SYNCING = 'syncing',
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('knowledge_sources')
export class KnowledgeSource {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'enum', enum: SourceType })
  type: SourceType;

  @Column({ type: 'simple-json', nullable: true })
  config: Record<string, any>;

  @Column({ default: 60 })
  syncInterval: number;

  @Column({ type: 'enum', enum: SyncStatus, default: SyncStatus.IDLE })
  lastSyncStatus: SyncStatus;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastSyncError: string | null;

  @Column({ default: true })
  enabled: boolean;

  @Column({ default: false })
  hasContentUpdate: boolean;

  @Column({ default: 2 })
  maxDepth: number;

  @Column({ default: 50 })
  maxPages: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => KnowledgeSourceSyncLog, log => log.source)
  syncLogs: KnowledgeSourceSyncLog[];
}
