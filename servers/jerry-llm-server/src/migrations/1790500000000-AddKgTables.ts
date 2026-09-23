import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新建知识图谱（KG）三张表：kg_entity / kg_triple / kg_extract_op
 *
 * - kg_entity：文档维度的实体行（key 归一化 + aliases 别名强化 + 主名 embedding）
 * - kg_triple：文档维度的三元组行（head/relation/tail 原始表述）
 * - kg_extract_op：抽取操作队列（照抄 pending_vector_ops 状态机：pending/processing/completed/failed + retryCount）
 *
 * 幂等保护：开发库 synchronize:true 会先于迁移自动建表，
 * 直接 CREATE TABLE 会报表已存在(1050)，故先 hasTable 判断。
 */
export class AddKgTables1790500000000 implements MigrationInterface {
  name = 'AddKgTables1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('kg_entity'))) {
      await queryRunner.query(
        `CREATE TABLE \`kg_entity\` (
                    \`id\` int NOT NULL AUTO_INCREMENT,
                    \`documentId\` int NOT NULL,
                    \`versionId\` int NOT NULL,
                    \`key\` varchar(255) NOT NULL,
                    \`name\` varchar(255) NOT NULL,
                    \`type\` varchar(30) NOT NULL DEFAULT 'unknown',
                    \`aliases\` text NOT NULL,
                    \`embedding\` json NULL,
                    \`embeddingModel\` varchar(64) NULL,
                    \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                    INDEX \`IDX_kg_entity_documentId\` (\`documentId\`),
                    UNIQUE INDEX \`IDX_kg_entity_doc_key\` (\`documentId\`, \`key\`),
                    PRIMARY KEY (\`id\`)
                ) ENGINE=InnoDB`,
      );
    }

    if (!(await queryRunner.hasTable('kg_triple'))) {
      await queryRunner.query(
        `CREATE TABLE \`kg_triple\` (
                    \`id\` int NOT NULL AUTO_INCREMENT,
                    \`documentId\` int NOT NULL,
                    \`versionId\` int NOT NULL,
                    \`head\` varchar(255) NOT NULL,
                    \`relation\` varchar(60) NOT NULL,
                    \`tail\` varchar(255) NOT NULL,
                    \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                    INDEX \`IDX_kg_triple_documentId\` (\`documentId\`),
                    PRIMARY KEY (\`id\`)
                ) ENGINE=InnoDB`,
      );
    }

    if (!(await queryRunner.hasTable('kg_extract_op'))) {
      await queryRunner.query(
        `CREATE TABLE \`kg_extract_op\` (
                    \`id\` int NOT NULL AUTO_INCREMENT,
                    \`documentId\` int NOT NULL,
                    \`versionId\` int NULL,
                    \`operation\` enum ('extract', 'remove_doc') NOT NULL,
                    \`status\` enum ('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
                    \`retryCount\` int NOT NULL DEFAULT '0',
                    \`errorMessage\` text NULL,
                    \`params\` text NULL,
                    \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                    \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                    INDEX \`IDX_kg_extract_op_documentId\` (\`documentId\`),
                    INDEX \`IDX_kg_extract_op_createdAt\` (\`createdAt\`),
                    INDEX \`IDX_kg_extract_op_status_createdAt\` (\`status\`, \`createdAt\`),
                    PRIMARY KEY (\`id\`)
                ) ENGINE=InnoDB`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 与 up 对称：表不存在（迁移被幂等跳过）时不再 DROP
    if (await queryRunner.hasTable('kg_extract_op')) {
      await queryRunner.query(`DROP TABLE \`kg_extract_op\``);
    }
    if (await queryRunner.hasTable('kg_triple')) {
      await queryRunner.query(`DROP TABLE \`kg_triple\``);
    }
    if (await queryRunner.hasTable('kg_entity')) {
      await queryRunner.query(`DROP TABLE \`kg_entity\``);
    }
  }
}
