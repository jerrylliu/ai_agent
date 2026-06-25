import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('feishu_chat_session')
@Index('IDX_feishu_chat_session_identity', ['ownerUserId', 'chatType', 'chatId', 'senderOpenId'], { unique: true })
export class FeishuChatSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 64 })
  ownerUserId: string;

  @Column({ length: 16 })
  chatType: 'p2p' | 'group';

  @Column({ length: 128 })
  chatId: string;

  @Column({ length: 128 })
  senderOpenId: string;

  @Column({ length: 64 })
  sessionId: string;

  @Column({ type: 'datetime' })
  lastActiveAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
