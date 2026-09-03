import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { Document } from './document.entity.js';

export enum AuditAction {
  UPLOAD = 'upload',
  ACTIVATE = 'activate',
  ARCHIVE = 'archive',
  ROLLBACK = 'rollback',
  DELETE = 'delete',
  /** 注入扫描挂起：发现可疑内容，版本被暂扣等待人工复核 */
  SCAN_HOLD = 'scan_hold',
  /** 注入扫描直接拒绝：命中高危签名，版本未入库 */
  SCAN_REJECT = 'scan_reject',
  /** 人工复核通过：放行并继续发布入库 */
  REVIEW_APPROVE = 'review_approve',
  /** 人工复核拒绝：版本不入库 */
  REVIEW_REJECT = 'review_reject',
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
