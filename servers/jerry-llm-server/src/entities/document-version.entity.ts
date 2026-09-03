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

/**
 * 注入扫描门禁状态（发布请求时触发，异步状态机）
 * - PENDING：尚未扫描（历史版本默认值）
 * - SCANNING：静态扫描 / LLM 判定进行中
 * - PASSED：扫描通过，已自动发布入库
 * - NEEDS_REVIEW：发现可疑内容，挂起等待人工复核
 * - APPROVED：人工复核通过，已发布入库
 * - REJECTED：人工复核拒绝，未入库
 */
export enum ScanStatus {
  PENDING = 'pending',
  SCANNING = 'scanning',
  PASSED = 'passed',
  NEEDS_REVIEW = 'needs_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * 注入扫描发现项（单条签名命中或模型判定结果）
 * 定义在实体文件中，供扫描服务 / 复核接口 / 前端序列化共用，避免循环依赖
 */
export interface ScanFinding {
  /** 产生阶段：静态签名扫描 / LLM chunk 级判定 */
  stage: 'static' | 'llm';
  /** 严重级别：拦截（直接拒绝）/ 可疑（需人工复核）/ 仅记录（不影响裁决） */
  severity: 'blocked' | 'suspicious' | 'info';
  /** 发现项类型标识（如 block-pattern / zero-width / llm-judge / llm-judge-error） */
  type: string;
  /** 发现项描述（中文，供复核界面展示） */
  detail: string;
  /** 命中 chunk 的序号（LLM 判定阶段才有，从 0 开始） */
  chunkIndex?: number;
  /** 命中位置附近的原文片段（复核界面溯源用） */
  evidence?: string;
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

  /**
   * 文件内容 SHA-256（文件级去重键：跨文档识别重复上传的同一文件）
   */
  @Column({ length: 64, nullable: true })
  @Index()
  checksum: string;

  @Column({ type: 'enum', enum: VersionStatus, default: VersionStatus.DRAFT })
  status: VersionStatus;

  @Column({ type: 'enum', enum: ParsingStatus, default: ParsingStatus.PENDING })
  parsingStatus: ParsingStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ default: 0 })
  chunkCount: number;

  /**
   * 注入扫描门禁状态（发布请求时写入）
   * 与 status / parsingStatus 正交：扫描只决定"能否入库"，不改变版本自身的生命周期
   */
  @Column({ type: 'enum', enum: ScanStatus, default: ScanStatus.PENDING })
  @Index()
  scanStatus: ScanStatus;

  /** 注入扫描发现项列表（复核界面展示 + 审计溯源） */
  @Column({ type: 'simple-json', nullable: true })
  scanFindings: ScanFinding[] | null;

  /** 扫描完成时间（无论通过还是挂起都记录） */
  @Column({ type: 'timestamp', nullable: true })
  scannedAt: Date | null;

  /**
   * 被扫描文本的 SHA-256 哈希。
   * 用于人工复核通过时的一致性校验（TOCTOU 防护）：
   * 若复核期间文档内容被修改，哈希不一致则拒绝通过并要求重新扫描。
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  scannedTextHash: string | null;

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
