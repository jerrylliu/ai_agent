/**
 * 图片描述记录实体
 *
 * 记录每张图片的 VLM 翻译状态、降级路径、原始信息。
 * 是降级重试、幂等去重、监控统计的基础。
 *
 * 关联：Document（多对一）
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * 图片来源类型
 * - embedded: 文档内嵌图片（普通图片/图表/图标）
 * - scanned_page: 扫描件渲染页（pdfjs 降级路径将整页渲染为图片，Slice 4 引入）
 */
export type ImageSourceType = 'embedded' | 'scanned_page';

/**
 * 处理状态
 * - pending: 待处理
 * - processing: 处理中
 * - completed: 翻译成功
 * - failed: 翻译失败（可重试）
 * - skipped: 跳过（重试达上限或内容违规）
 */
export type ImageDescriptionStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped';

/**
 * 图片描述记录实体
 *
 * 记录每张图片的 VLM 翻译状态、降级路径、原始信息。
 * 是降级重试、幂等去重、监控统计的基础。
 *
 * 索引：
 * - docId：按文档查询图片列表
 * - status + retryCount：异步重试任务扫描
 * - imageHash：幂等去重
 *
 * 关联：Document（多对一，逻辑关联，不使用外键约束以便迁移）
 */
@Entity('image_description')
@Index(['docId'])
@Index(['status', 'retryCount'])
@Index(['imageHash'])
@Unique(['docId', 'imageHash'])
export class ImageDescription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属文档 ID（对应 documents.id，字符串化） */
  @Column({ name: 'doc_id', type: 'varchar', length: 64 })
  docId: string;

  /** 所属版本 ID（对应 document_versions.id，字符串化） */
  @Column({ name: 'version_id', type: 'varchar', length: 64, nullable: true })
  versionId: string | null;

  /** 图片在文档中的索引（0-based） */
  @Column({ name: 'source_index', type: 'int' })
  sourceIndex: number;

  /** 图片内容 SHA256，用于幂等去重（同一图片不重复调用 VLM） */
  @Column({ name: 'image_hash', type: 'varchar', length: 64 })
  imageHash: string;

  /** 原图存储路径（相对路径，相对 IMAGE_STORAGE_DIR） */
  @Column({ name: 'image_path', type: 'varchar', length: 512 })
  imagePath: string;

  /** VLM 生成的描述（成功后填充） */
  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null;

  /** VLM 生成的关键词标签（用于检索匹配，JSON 数组） */
  @Column({ name: 'tags', type: 'json', nullable: true })
  tags: string[] | null;

  /** 原文图注（解析时从 Markdown 提取，如"图1：系统架构图"） */
  @Column({ name: 'caption', type: 'varchar', length: 256, nullable: true })
  caption: string | null;

  /** 所在页码（PDF 才有） */
  @Column({ name: 'page', type: 'int', nullable: true })
  page: number | null;

  /** 所在章节（如"3.2 系统设计"，能提取则填） */
  @Column({ name: 'section', type: 'varchar', length: 128, nullable: true })
  section: string | null;

  /** 前后文摘要（用于 VLM Prompt 和反查，最多 500 字） */
  @Column({ name: 'surrounding_text', type: 'text', nullable: true })
  surroundingText: string | null;

  /** 图片来源类型 */
  @Column({
    name: 'source_type',
    type: 'enum',
    enum: ['embedded', 'scanned_page'],
    default: 'embedded',
  })
  sourceType: ImageSourceType;

  /** 处理状态 */
  @Column({
    type: 'enum',
    enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
    default: 'pending',
  })
  status: ImageDescriptionStatus;

  /** 实际使用的模型（用于降级路径追踪，如 qwen3-vl-32b） */
  @Column({ name: 'model_used', type: 'varchar', length: 64, nullable: true })
  modelUsed: string | null;

  /** 实际使用的降级层级（1=主模型, 4=元数据兜底） */
  @Column({ name: 'fallback_layer', type: 'int', nullable: true })
  fallbackLayer: number | null;

  /** 已重试次数 */
  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  /** 失败原因（最后一次） */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  /** ChromaDB chunk ID（入库后回填，便于删除时联动） */
  @Column({ name: 'chunk_id', type: 'varchar', length: 128, nullable: true })
  chunkId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
