import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * KG 实体行（文档维度）：一条 = 某文档抽取出的一个实体
 *
 * 设计说明：
 * - 采用「文档维度」而非「全局 key 维度」，使增量更新可以简化为
 *   "先删该文档旧行、再插新行"，内存索引重建时按 documentId 分组
 *   即可还原抽取时的 DocEntityRow 结构，buildIndex 算法零改动移植。
 * - key 为 normEntity(name) 归一化结果（小写 + 空白折叠），
 *   同一文档内按 key 合并（aliases 取并集），故 (documentId, key) 唯一。
 * - embedding 只为主名 key 生成（别名 key 与主名向量高度相近，
 *   且别名在词汇通道已按 1.0 精确命中，不嵌入对召回影响极小）。
 */
@Entity('kg_entity')
@Index(['documentId', 'key'], { unique: true })
export class KgEntity {
  @PrimaryGeneratedColumn()
  id: number;

  /** 来源文档 id（documents.id） */
  @Column({ type: 'int' })
  @Index()
  documentId: number;

  /** 来源文档版本 id（document_versions.id），增量重抽时用于判断版本是否变化 */
  @Column({ type: 'int' })
  versionId: number;

  /** 归一化实体键（normEntity(name)：小写 + 空白折叠） */
  @Column({ length: 255 })
  key: string;

  /** 实体在文档中的原始表述（展示用 label） */
  @Column({ length: 255 })
  name: string;

  /** 实体类型：person/team/org/product/model/project/location/event/plan/metric 等 */
  @Column({ length: 30, default: 'unknown' })
  type: string;

  /** 同一实体在文档中出现的其他表述（缩写、全称、代号），别名强化抽取是链接命中率的关键 */
  @Column({ type: 'simple-json' })
  aliases: string[];

  /** 主名 key 的语义向量（getEmbeddings() 产出；null = 嵌入失败降级纯词汇召回） */
  @Column({ type: 'json', nullable: true })
  embedding: number[] | null;

  /**
   * 生成 embedding 时使用的模型标识（嵌入配置变更后可据此判断是否需重嵌）
   *
   * 必须显式声明 type：`string | null` 联合类型经 emitDecoratorMetadata 反射为 Object，
   * TypeORM 无法推断列类型，会在 DataSource 初始化阶段抛 DataTypeNotSupportedError。
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  embeddingModel: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
