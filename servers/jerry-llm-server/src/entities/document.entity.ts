import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
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

  /**
   * 富文本编辑器内容（Tiptap JSONContent 序列化为 JSON 字符串）
   * 仅当文档由富文本编辑器创建/编辑时使用，传统上传文档可为 null
   */
  @Column({ type: 'longtext', nullable: true })
  contentJson: string | null;

  /**
   * 编辑器内容的纯文本提取，供 RAG 分块使用，避免每次重复序列化
   */
  @Column({ type: 'longtext', nullable: true })
  contentText: string | null;

  /**
   * 编辑器内容最后更新时间
   * 与 updatedAt 区分：updatedAt 包含元信息变更（如 title），contentUpdatedAt 仅在内容真正变化时更新
   */
  @Column({ type: 'timestamp', nullable: true })
  contentUpdatedAt: Date | null;

  /**
   * 文档中的图片总数（解析阶段统计）
   * 用于前端展示图片处理进度
   */
  @Column({ name: 'image_total', type: 'int', default: 0 })
  imageTotal: number;

  /**
   * 已成功翻译的图片数量（VLM 处理完成 + 兜底成功的累计值）
   * imageProcessed / imageTotal 即处理完成比例
   */
  @Column({ name: 'image_processed', type: 'int', default: 0 })
  imageProcessed: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => DocumentVersion, (version) => version.document)
  versions: DocumentVersion[];

  @OneToMany(() => DocumentAuditLog, (log) => log.document)
  auditLogs: DocumentAuditLog[];
}
