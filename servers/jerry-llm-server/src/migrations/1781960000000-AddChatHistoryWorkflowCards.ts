import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 给 chat_history 表新增 workflowCards 列（longtext，可空）
 *
 * 用于持久化助手消息的工作流进度卡片（execute_workflow 执行摘要：
 * 工作流名称、各步骤状态/耗时、整体状态等），重启后仍能回看执行进度。
 *
 * 仅扩展字段，不影响存量数据：允许 NULL，老消息保持不变。
 */
export class AddChatHistoryWorkflowCards1781960000000 implements MigrationInterface {
    name = 'AddChatHistoryWorkflowCards1781960000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE \`chat_history\` ADD \`workflowCards\` longtext NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE \`chat_history\` DROP COLUMN \`workflowCards\``,
        );
    }
}
