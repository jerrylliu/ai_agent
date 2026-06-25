import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFeishuChatSession1782361000000 implements MigrationInterface {
    name = 'AddFeishuChatSession1782361000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE \`feishu_chat_session\` (` +
            `\`id\` int NOT NULL AUTO_INCREMENT, ` +
            `\`ownerUserId\` varchar(64) NOT NULL, ` +
            `\`chatType\` varchar(16) NOT NULL, ` +
            `\`chatId\` varchar(128) NOT NULL, ` +
            `\`senderOpenId\` varchar(128) NOT NULL, ` +
            `\`sessionId\` varchar(64) NOT NULL, ` +
            `\`lastActiveAt\` datetime NOT NULL, ` +
            `\`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ` +
            `\`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), ` +
            `UNIQUE INDEX \`IDX_feishu_chat_session_identity\` (\`ownerUserId\`, \`chatType\`, \`chatId\`, \`senderOpenId\`), ` +
            `INDEX \`IDX_feishu_chat_session_session\` (\`sessionId\`), ` +
            `PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`IDX_feishu_chat_session_session\` ON \`feishu_chat_session\``);
        await queryRunner.query(`DROP INDEX \`IDX_feishu_chat_session_identity\` ON \`feishu_chat_session\``);
        await queryRunner.query(`DROP TABLE \`feishu_chat_session\``);
    }
}
