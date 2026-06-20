import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity()
export class ChatHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: string; // 可用于用户标识

  @Column()
  sessionId: string; // 会话标识

  @Column()
  role: string; // user 或 assistant

  @Column('text')
  content: string;

  /**
   * 用户消息携带的文档卡片（JSON 数组）
   * 用户在聊天里上传文档时附加，UI 渲染为卡片
   * 仅 role=user 的消息会有此字段
   *
   * 用 longtext：contentJson 是 Tiptap 文档结构，
   * 大文档序列化可能超过 text 的 64KB 限制
   */
  @Column({ type: 'longtext', nullable: true })
  documentCards: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
