import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * 由 generate_document 工具生成的文档
 *
 * 替代旧的内存缓存方案：文件落盘到磁盘，元数据持久化到数据库，
 * 支持跨进程重启、按 userId 鉴权、定时清理过期/闲置文件。
 */
@Entity()
export class GeneratedDocument {
  @PrimaryGeneratedColumn()
  id: number;

  /** 短随机 key，用于构造 fc://document/{key} 与 GET /chat/documents/download/:key */
  @Column({ unique: true })
  key: string;

  /** 文档归属用户。'default' 表示未登录用户 */
  @Column({ default: 'default' })
  @Index()
  userId: string;

  /** 关联的会话 ID，方便会话被删除时一并清理 */
  @Column({ nullable: true })
  @Index()
  sessionId: string;

  /** 用户友好的文件名（含扩展名，如 "周报.pdf"） */
  @Column()
  filename: string;

  /** 输出格式：pdf / docx / html / md */
  @Column({ length: 16 })
  format: string;

  /** 标准 MIME 类型 */
  @Column()
  mimeType: string;

  /** 文件大小（字节） */
  @Column({ type: 'bigint', default: 0 })
  sizeBytes: number;

  /** 文件在磁盘上的相对路径（相对于 DOCUMENT_STORAGE_DIR） */
  @Column()
  filePath: string;

  /** 内容 SHA-256，便于秒传/去重 */
  @Column({ nullable: true, length: 64 })
  checksum: string;

  /** 最近一次访问（下载/预览/邮件附件读取）时间，用于"N 天未访问"清理 */
  @Column({ type: 'datetime', nullable: true })
  @Index()
  lastAccessedAt: Date | null;

  /** 硬过期时间（创建时间 + DOCUMENT_TTL_DAYS） */
  @Column({ type: 'datetime' })
  @Index()
  expiresAt: Date;

  /**
   * 用户收藏标记。收藏的文档不参与自动清理（TTL/idle 都不删除），
   * 直到用户主动取消收藏或主动删除。
   */
  @Column({ type: 'boolean', default: false })
  @Index()
  favorited: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
