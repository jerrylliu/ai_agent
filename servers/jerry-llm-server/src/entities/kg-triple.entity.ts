import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * KG 三元组行（文档维度）：一条 = 某文档抽取出的一个 head/relation/tail 事实
 *
 * head/tail 存原始表述（构建内存索引时经 registerKey 归一化并建无向邻接边），
 * 与 kg_entity 一样按 documentId 组织，增量更新走"删旧插新"。
 */
@Entity('kg_triple')
export class KgTriple {
  @PrimaryGeneratedColumn()
  id: number;

  /** 来源文档 id（documents.id） */
  @Column({ type: 'int' })
  @Index()
  documentId: number;

  /** 来源文档版本 id（document_versions.id） */
  @Column({ type: 'int' })
  versionId: number;

  /** 头实体（文档中的原始表述） */
  @Column({ length: 255 })
  head: string;

  /** 小写下划线关系短语（如 works_on / located_in / depends_on） */
  @Column({ length: 60 })
  relation: string;

  /** 尾实体（文档中的原始表述） */
  @Column({ length: 255 })
  tail: string;

  @CreateDateColumn()
  createdAt: Date;
}
