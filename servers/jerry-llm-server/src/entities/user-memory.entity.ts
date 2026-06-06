import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * 用户记忆实体
 *
 * 长期记忆的核心：跨会话持久化用户的关键信息
 *
 * 与中期记忆（SessionSummary）的区别：
 * - SessionSummary 是单个会话的对话压缩，会话结束后不再增长
 * - UserMemory 是从所有会话中提取的用户画像，跨会话积累
 *
 * 记忆分类（category）：
 * - preference: 用户偏好（喜欢/不喜欢什么）
 * - fact: 事实信息（姓名、职业、技术栈等）
 * - decision: 重要决策（选择了方案A而非方案B）
 * - context: 上下文信息（当前项目背景、工作目标等）
 * - skill: 技能水平（对某技术的熟悉程度）
 *
 * 触发策略：
 * - 每次对话结束时（assistant 消息保存后），从对话中提取新的记忆
 * - 与已有记忆去重/合并，避免冗余
 * - 使用 DeepSeek-Flash 提取，保证提取质量
 */
@Entity()
export class UserMemory {
  @PrimaryGeneratedColumn()
  id: number;

  /** 记忆内容：一条简洁的用户信息，如 "用户是前端开发者，主要使用 React" */
  @Column('text')
  content: string;

  /** 记忆分类：preference | fact | decision | context | skill */
  @Column({ default: 'fact' })
  category: string;

  /** 来源会话 ID，记录这条记忆是从哪个会话提取的 */
  @Column({ nullable: true })
  sourceSessionId: string;

  /** 用户 ID，预留字段，当前默认 'default' */
  @Column({ default: 'default' })
  userId: string;

  /** 重要性评分 1-5，影响注入优先级和过期策略 */
  @Column({ default: 3 })
  importance: number;

  /** 访问次数，每次被注入 System Prompt 时 +1，用于统计记忆活跃度 */
  @Column({ default: 0 })
  accessCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
