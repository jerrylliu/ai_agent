import { MigrationInterface, QueryRunner } from "typeorm";

export class SyncMissingSchema1788867884977 implements MigrationInterface {
    name = 'SyncMissingSchema1788867884977'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`IDX_feishu_chat_session_session\` ON \`feishu_chat_session\``);
        await queryRunner.query(`CREATE TABLE \`search_feedback\` (\`id\` int NOT NULL AUTO_INCREMENT, \`userId\` varchar(255) NOT NULL DEFAULT 'default', \`sessionId\` varchar(255) NOT NULL, \`query\` text NOT NULL, \`retrievedDocIds\` text NOT NULL, \`action\` varchar(255) NOT NULL, \`responseTimeMs\` int NOT NULL DEFAULT '0', \`resultCount\` int NOT NULL DEFAULT '0', \`modelId\` varchar(255) NULL, \`searchType\` varchar(255) NOT NULL DEFAULT 'hybrid', \`metadata\` text NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`IDX_f43aabfd4725767bfbe8fead8d\` (\`userId\`), INDEX \`IDX_369b1fe6819afc6fdc0b6fe956\` (\`sessionId\`), INDEX \`IDX_c0468062b855f269745965f2c5\` (\`action\`), INDEX \`IDX_3d3d3dcbac2aff51de8c6393d8\` (\`createdAt\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`image_description\` (\`id\` varchar(36) NOT NULL, \`doc_id\` varchar(64) NOT NULL, \`version_id\` varchar(64) NULL, \`source_index\` int NOT NULL, \`image_hash\` varchar(64) NOT NULL, \`image_path\` varchar(512) NOT NULL, \`description\` text NULL, \`tags\` json NULL, \`caption\` varchar(256) NULL, \`page\` int NULL, \`section\` varchar(128) NULL, \`surrounding_text\` text NULL, \`source_type\` enum ('embedded', 'scanned_page') NOT NULL DEFAULT 'embedded', \`status\` enum ('pending', 'processing', 'completed', 'failed', 'skipped') NOT NULL DEFAULT 'pending', \`model_used\` varchar(64) NULL, \`fallback_layer\` int NULL, \`retry_count\` int NOT NULL DEFAULT '0', \`error_message\` text NULL, \`chunk_id\` varchar(128) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_b4a5c8dce08424121cd02d4e20\` (\`image_hash\`), INDEX \`IDX_10f633950c5ddd082dc69c92be\` (\`status\`, \`retry_count\`), INDEX \`IDX_5f92649ed7eb09a22e2c47a3b0\` (\`doc_id\`), UNIQUE INDEX \`IDX_f79f08414942a01a92582994a8\` (\`doc_id\`, \`image_hash\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`knowledge_source_sync_logs\` ADD \`pagesSkippedByScan\` int NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE \`knowledge_source_sync_logs\` ADD \`skippedPageDetails\` text NULL`);
        await queryRunner.query(`ALTER TABLE \`document_versions\` ADD \`scanStatus\` enum ('pending', 'scanning', 'passed', 'needs_review', 'approved', 'rejected') NOT NULL DEFAULT 'pending'`);
        await queryRunner.query(`ALTER TABLE \`document_versions\` ADD \`scanFindings\` text NULL`);
        await queryRunner.query(`ALTER TABLE \`document_versions\` ADD \`scannedAt\` timestamp NULL`);
        await queryRunner.query(`ALTER TABLE \`document_versions\` ADD \`scannedTextHash\` varchar(64) NULL`);
        await queryRunner.query(`ALTER TABLE \`documents\` ADD \`content_hash\` varchar(64) NULL`);
        await queryRunner.query(`ALTER TABLE \`documents\` ADD \`image_total\` int NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE \`documents\` ADD \`image_processed\` int NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE \`document_audit_logs\` CHANGE \`action\` \`action\` enum ('upload', 'activate', 'archive', 'rollback', 'delete', 'scan_hold', 'scan_reject', 'review_approve', 'review_reject') NOT NULL`);
        await queryRunner.query(`CREATE INDEX \`IDX_bcf37dbea3229c3a2df2ec55e6\` ON \`document_versions\` (\`checksum\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_cade3ed26c2af5d73a4d80914b\` ON \`document_versions\` (\`scanStatus\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_2176081aa7c1abf200e1c0d4ab\` ON \`documents\` (\`content_hash\`)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`IDX_2176081aa7c1abf200e1c0d4ab\` ON \`documents\``);
        await queryRunner.query(`DROP INDEX \`IDX_cade3ed26c2af5d73a4d80914b\` ON \`document_versions\``);
        await queryRunner.query(`DROP INDEX \`IDX_bcf37dbea3229c3a2df2ec55e6\` ON \`document_versions\``);
        await queryRunner.query(`ALTER TABLE \`document_audit_logs\` CHANGE \`action\` \`action\` enum ('upload', 'activate', 'archive', 'rollback', 'delete') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`documents\` DROP COLUMN \`image_processed\``);
        await queryRunner.query(`ALTER TABLE \`documents\` DROP COLUMN \`image_total\``);
        await queryRunner.query(`ALTER TABLE \`documents\` DROP COLUMN \`content_hash\``);
        await queryRunner.query(`ALTER TABLE \`document_versions\` DROP COLUMN \`scannedTextHash\``);
        await queryRunner.query(`ALTER TABLE \`document_versions\` DROP COLUMN \`scannedAt\``);
        await queryRunner.query(`ALTER TABLE \`document_versions\` DROP COLUMN \`scanFindings\``);
        await queryRunner.query(`ALTER TABLE \`document_versions\` DROP COLUMN \`scanStatus\``);
        await queryRunner.query(`ALTER TABLE \`knowledge_source_sync_logs\` DROP COLUMN \`skippedPageDetails\``);
        await queryRunner.query(`ALTER TABLE \`knowledge_source_sync_logs\` DROP COLUMN \`pagesSkippedByScan\``);
        await queryRunner.query(`DROP INDEX \`IDX_f79f08414942a01a92582994a8\` ON \`image_description\``);
        await queryRunner.query(`DROP INDEX \`IDX_5f92649ed7eb09a22e2c47a3b0\` ON \`image_description\``);
        await queryRunner.query(`DROP INDEX \`IDX_10f633950c5ddd082dc69c92be\` ON \`image_description\``);
        await queryRunner.query(`DROP INDEX \`IDX_b4a5c8dce08424121cd02d4e20\` ON \`image_description\``);
        await queryRunner.query(`DROP TABLE \`image_description\``);
        await queryRunner.query(`DROP INDEX \`IDX_3d3d3dcbac2aff51de8c6393d8\` ON \`search_feedback\``);
        await queryRunner.query(`DROP INDEX \`IDX_c0468062b855f269745965f2c5\` ON \`search_feedback\``);
        await queryRunner.query(`DROP INDEX \`IDX_369b1fe6819afc6fdc0b6fe956\` ON \`search_feedback\``);
        await queryRunner.query(`DROP INDEX \`IDX_f43aabfd4725767bfbe8fead8d\` ON \`search_feedback\``);
        await queryRunner.query(`DROP TABLE \`search_feedback\``);
        await queryRunner.query(`CREATE INDEX \`IDX_feishu_chat_session_session\` ON \`feishu_chat_session\` (\`sessionId\`)`);
    }

}
