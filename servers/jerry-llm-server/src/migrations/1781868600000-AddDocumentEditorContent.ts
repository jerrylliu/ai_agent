import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 给 documents 表新增富文本编辑器相关字段：
 *   - contentJson:        Tiptap JSONContent 序列化字符串（longtext）
 *   - contentText:        提取的纯文本，供 RAG 分块使用（longtext）
 *   - contentUpdatedAt:   编辑器内容最后更新时间（timestamp，可空）
 *
 * 仅扩展字段，不影响存量数据：所有字段允许 NULL，老文档保持不变。
 */
export class AddDocumentEditorContent1781868600000 implements MigrationInterface {
    name = 'AddDocumentEditorContent1781868600000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE \`documents\` ADD \`contentJson\` longtext NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE \`documents\` ADD \`contentText\` longtext NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE \`documents\` ADD \`contentUpdatedAt\` timestamp NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE \`documents\` DROP COLUMN \`contentUpdatedAt\``,
        );
        await queryRunner.query(
            `ALTER TABLE \`documents\` DROP COLUMN \`contentText\``,
        );
        await queryRunner.query(
            `ALTER TABLE \`documents\` DROP COLUMN \`contentJson\``,
        );
    }
}
