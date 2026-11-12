import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新建表格规则器表：table_rules（EXCEL_GRID_EDITOR_PLAN.md 功能 5"表格的 ESLint"）
 *
 * - 一条规则一行，绑定 documentId（删除文档级联清理由服务层处理）
 * - paramsJson / fixActionJson 存 JSON 字符串，结构由 fundamentals/table-ops/rules.ts 的 zod schema 校验
 * - enabled / source / targetSheet 对应实体 table-rule.entity.ts 的默认值
 *
 * 幂等保护：开发库 synchronize:true 会先于迁移自动建表，
 * 直接 CREATE TABLE 会报表已存在(1050)，故先 hasTable 判断。
 */
export class AddTableRules1792156800000 implements MigrationInterface {
  name = 'AddTableRules1792156800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('table_rules'))) {
      await queryRunner.query(
        `CREATE TABLE \`table_rules\` (
                    \`id\` int NOT NULL AUTO_INCREMENT,
                    \`documentId\` int NOT NULL,
                    \`name\` varchar(200) NOT NULL,
                    \`type\` varchar(30) NOT NULL,
                    \`paramsJson\` text NOT NULL,
                    \`fixActionJson\` text NULL,
                    \`enabled\` tinyint NOT NULL DEFAULT 1,
                    \`source\` varchar(10) NOT NULL DEFAULT 'manual',
                    \`targetSheet\` varchar(200) NULL,
                    \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                    \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                    INDEX \`IDX_table_rules_documentId\` (\`documentId\`),
                    PRIMARY KEY (\`id\`)
                ) ENGINE=InnoDB`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 与 up 对称：表不存在（迁移被幂等跳过）时不再 DROP
    if (await queryRunner.hasTable('table_rules')) {
      await queryRunner.query(`DROP TABLE \`table_rules\``);
    }
  }
}
