import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 给 chat_history 表新增 citations 列（longtext，可空）
 *
 * 用于持久化助手消息的引用来源（可验证生成）：服务端从回答中的
 * （【文档 X】）标注解析出的引用条目数组（ref/documentId/title/snippet），
 * 前端随消息保存，历史加载后"参考来源"卡片可恢复。
 *
 * 仅扩展字段，不影响存量数据：允许 NULL，老消息保持不变。
 */
export class AddChatHistoryCitations1782000000000 implements MigrationInterface {
  name = 'AddChatHistoryCitations1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 幂等保护：开发库 synchronize:true 会先于迁移自动建列，
    // 直接 ADD 会报 Duplicate column(1060) 并卡住同批后续迁移，故先查列是否存在
    const hasColumn = await queryRunner.hasColumn('chat_history', 'citations');
    if (!hasColumn) {
      await queryRunner.query(
        `ALTER TABLE \`chat_history\` ADD \`citations\` longtext NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 与 up 对称：列不存在（迁移被幂等跳过）时不再 DROP
    const hasColumn = await queryRunner.hasColumn('chat_history', 'citations');
    if (hasColumn) {
      await queryRunner.query(
        `ALTER TABLE \`chat_history\` DROP COLUMN \`citations\``,
      );
    }
  }
}
