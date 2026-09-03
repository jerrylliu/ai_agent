-- ======================================================================
-- image_description 表建表 SQL
-- 用途：多模态入库（Slice 1-4）记录每张图片的 VLM 翻译状态、降级路径、原始信息
-- 关联：documents.id / document_versions.id（逻辑关联，不使用外键约束）
--
-- 执行方式：
--   mysql -u<user> -p <database> < scripts/image-description-schema.sql
--   或在 Navicat / DBeaver 中直接导入执行
--
-- 特性：
-- - 使用 IF NOT EXISTS，可重复执行不报错
-- - 字段类型与 image-description.entity.ts 完全对应
-- - 索引：doc_id（按文档查询）、status+retry_count（异步重试扫描）、image_hash（幂等去重）
-- ======================================================================

CREATE TABLE IF NOT EXISTS `image_description` (
  `id` CHAR(36) NOT NULL,
  `doc_id` VARCHAR(64) NOT NULL COMMENT '所属文档 ID（对应 documents.id 字符串化）',
  `version_id` VARCHAR(64) NULL COMMENT '所属版本 ID（对应 document_versions.id 字符串化）',
  `source_index` INT NOT NULL COMMENT '图片在文档中的索引（0-based）',
  `image_hash` VARCHAR(64) NOT NULL COMMENT '图片内容 SHA256，用于幂等去重',
  `image_path` VARCHAR(512) NOT NULL COMMENT '原图存储路径（相对 IMAGE_STORAGE_DIR）',
  `description` TEXT NULL COMMENT 'VLM 生成的描述（成功后填充）',
  `caption` VARCHAR(256) NULL COMMENT '原文图注（如"图1：系统架构图"）',
  `page` INT NULL COMMENT '所在页码（PDF 才有意义）',
  `section` VARCHAR(128) NULL COMMENT '所在章节（如"3.2 系统设计"）',
  `surrounding_text` TEXT NULL COMMENT '前后文摘要（最多 500 字，用于 VLM Prompt 和反查）',
  `source_type` ENUM('embedded', 'scanned_page') NOT NULL DEFAULT 'embedded' COMMENT '图片来源类型：内嵌图片 / 扫描件渲染页',
  `status` ENUM('pending', 'processing', 'completed', 'failed', 'skipped') NOT NULL DEFAULT 'pending' COMMENT '处理状态',
  `model_used` VARCHAR(64) NULL COMMENT '实际使用的模型（如 qwen3-vl-32b），用于降级路径追踪',
  `fallback_layer` INT NULL COMMENT '实际使用的降级层级（1=主模型, 2=备用模型, 3=OCR, 4=元数据兜底）',
  `retry_count` INT NOT NULL DEFAULT 0 COMMENT '已重试次数',
  `error_message` TEXT NULL COMMENT '失败原因（最后一次）',
  `chunk_id` VARCHAR(128) NULL COMMENT 'ChromaDB chunk ID（入库后回填，便于删除时联动）',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  INDEX `IDX_image_description_doc_id` (`doc_id`),
  INDEX `IDX_image_description_status_retry` (`status`, `retry_count`),
  INDEX `IDX_image_description_image_hash` (`image_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片描述记录（多模态入库）';

-- ======================================================================
-- 回滚 SQL（如需删除表，取消注释执行）
-- ======================================================================
-- DROP TABLE IF EXISTS `image_description`;
