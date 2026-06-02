import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index, Unique } from 'typeorm';
import { KnowledgeSource } from './knowledge-source.entity.js';

@Entity('knowledge_source_pages')
@Unique(['sourceId', 'pageKey'])
export class KnowledgeSourcePage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  sourceId: number;

  @Column({ length: 500 })
  pageKey: string;

  @Column({ length: 500 })
  pageTitle: string;

  @Column({ length: 32 })
  contentHash: string;

  @Column({ type: 'text', nullable: true })
  pageUrl: string | null;

  @Column({ default: false })
  isDeleted: boolean;

  @Column({ type: 'timestamp', nullable: true })
  syncedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => KnowledgeSource, { onDelete: 'CASCADE' })
  source: KnowledgeSource;
}
