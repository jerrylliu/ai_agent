import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { Document } from './document.entity.js';

export enum VersionStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

export enum ParsingStatus {
  PENDING = 'pending',
  PARSING = 'parsing',
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('document_versions')
@Index(['documentId', 'versionNumber'], { unique: true })
@Index(['status'])
@Index(['parsingStatus'])
export class DocumentVersion {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  documentId: number;

  @Column()
  versionNumber: number;

  @Column({ length: 500 })
  fileUrl: string;

  @Column({ type: 'bigint' })
  fileSize: string;

  @Column({ length: 50 })
  fileType: string;

  @Column({ length: 64, nullable: true })
  checksum: string;

  @Column({ type: 'enum', enum: VersionStatus, default: VersionStatus.DRAFT })
  status: VersionStatus;

  @Column({ type: 'enum', enum: ParsingStatus, default: ParsingStatus.PENDING })
  parsingStatus: ParsingStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ default: 0 })
  chunkCount: number;

  @Column({ length: 100, nullable: true })
  uploadedBy: string;

  @Column({ type: 'timestamp', nullable: true })
  archivedAt: Date | null;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @ManyToOne(() => Document, document => document.versions, { onDelete: 'CASCADE' })
  document: Document;
}
