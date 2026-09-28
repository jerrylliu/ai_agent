import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 在线回答质量评估基础设施（两件事）：
 *
 * 1. llm_usage 加检索上下文存档列：
 *    - retrievedDocumentIds：本次回答参考的知识库文档 ID 集合（JSON 数组）
 *    - retrievedContexts：本次回答实际参与生成的检索上下文原文（JSON 数组，与上面对应）
 *    此前 fcRetrievedContexts 只在内存回调里传递、落库时被丢弃，
 *    导致线上回答无法做事后 faithfulness（忠实度）核对——依据文本必须先存下来。
 *
 * 2. auto_evaluation 加在线 judge 判分列：
 *    - judgeFaithful / judgeRelevant：忠实度、切题度判定（null = 未评）
 *    - unfaithfulClaims：judge 摘出的编造原句（JSON 数组字符串）
 *    - judgeReason / judgeModel：判分理由与 judge 模型 id
 *
 * 幂等保护：开发库 synchronize:true 会先于迁移自动建列，
 * 直接 ADD COLUMN 会报重复列(1060)，故先 hasColumn 判断。
 */
export class AddRagContextsAndJudgeColumns1790600000000 implements MigrationInterface {
  name = 'AddRagContextsAndJudgeColumns1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ===== llm_usage：检索上下文存档 =====
    if (!(await queryRunner.hasColumn('llm_usage', 'retrievedDocumentIds'))) {
      await queryRunner.query(
        `ALTER TABLE \`llm_usage\` ADD \`retrievedDocumentIds\` longtext NULL`,
      );
    }
    if (!(await queryRunner.hasColumn('llm_usage', 'retrievedContexts'))) {
      await queryRunner.query(
        `ALTER TABLE \`llm_usage\` ADD \`retrievedContexts\` longtext NULL`,
      );
    }

    // ===== auto_evaluation：在线 judge 判分 =====
    if (!(await queryRunner.hasColumn('auto_evaluation', 'judgeFaithful'))) {
      await queryRunner.query(
        `ALTER TABLE \`auto_evaluation\` ADD \`judgeFaithful\` tinyint NULL`,
      );
    }
    if (!(await queryRunner.hasColumn('auto_evaluation', 'judgeRelevant'))) {
      await queryRunner.query(
        `ALTER TABLE \`auto_evaluation\` ADD \`judgeRelevant\` tinyint NULL`,
      );
    }
    if (!(await queryRunner.hasColumn('auto_evaluation', 'unfaithfulClaims'))) {
      await queryRunner.query(
        `ALTER TABLE \`auto_evaluation\` ADD \`unfaithfulClaims\` longtext NULL`,
      );
    }
    if (!(await queryRunner.hasColumn('auto_evaluation', 'judgeReason'))) {
      await queryRunner.query(
        `ALTER TABLE \`auto_evaluation\` ADD \`judgeReason\` text NULL`,
      );
    }
    if (!(await queryRunner.hasColumn('auto_evaluation', 'judgeModel'))) {
      await queryRunner.query(
        `ALTER TABLE \`auto_evaluation\` ADD \`judgeModel\` varchar(120) NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const columns: Array<[string, string]> = [
      ['llm_usage', 'retrievedDocumentIds'],
      ['llm_usage', 'retrievedContexts'],
      ['auto_evaluation', 'judgeFaithful'],
      ['auto_evaluation', 'judgeRelevant'],
      ['auto_evaluation', 'unfaithfulClaims'],
      ['auto_evaluation', 'judgeReason'],
      ['auto_evaluation', 'judgeModel'],
    ];
    for (const [table, column] of columns) {
      if (await queryRunner.hasColumn(table, column)) {
        await queryRunner.query(
          `ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``,
        );
      }
    }
  }
}
