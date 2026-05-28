import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, Index } from 'typeorm';
import { DocumentVersion } from './document-version.entity.js';
import { DocumentAuditLog } from './document-audit-log.entity.js';

@Entity('documents')
export class Document {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'simple-json', nullable: true })
  tags: string[];

  @Column({ nullable: true })
  currentVersionId: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => DocumentVersion, version => version.document)
  versions: DocumentVersion[];

  @OneToMany(() => DocumentAuditLog, log => log.document)
  auditLogs: DocumentAuditLog[];
}
