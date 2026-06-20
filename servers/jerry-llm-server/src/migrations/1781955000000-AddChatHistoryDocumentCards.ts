import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 给 chat_history 表新增 documentCards 列（longtext，可空）
 *
 * 用于持久化用户在聊天里上传的文档卡片信息（文件名、大小、contentJson 等）
 * 重启后仍能在用户消息里展示文档卡片
 *
 * 用 longtext 而非 text：contentJson 是 Tiptap 文档结构，
 * 大文档（5 万字截断后）序列化可能超过 text 的 64KB 限制
 *
 * 仅扩展字段，不影响存量数据：允许 NULL，老消息保持不变。
 */
export class AddChatHistoryDocumentCards1781955000000 implements MigrationInterface {
    name = 'AddChatHistoryDocumentCards1781955000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE \`chat_history\` ADD \`documentCards\` longtext NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE \`chat_history\` DROP COLUMN \`documentCards\``,
        );
    }
}
