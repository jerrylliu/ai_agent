import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { Document } from './document.entity.js';

export enum AuditAction {
  UPLOAD = 'upload',
  ACTIVATE = 'activate',
  ARCHIVE = 'archive',
  ROLLBACK = 'rollback',
  DELETE = 'delete',
}

@Entity('document_audit_logs')
export class DocumentAuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  documentId: number;

  @Column({ nullable: true })
  versionId: number;

  @Column({ type: 'enum', enum: AuditAction })
  action: AuditAction;

  @Column({ length: 100, default: 'anonymous' })
  operator: string;

  @Column({ type: 'text', nullable: true })
  detail: string;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @ManyToOne(() => Document, document => document.auditLogs, { onDelete: 'CASCADE' })
  document: Document;
}
