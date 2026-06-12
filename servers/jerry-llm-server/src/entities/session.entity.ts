import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity()
export class Session {
  @PrimaryGeneratedColumn()
  id: number;
  
  @Column({ unique: true })
  sessionId: string;
  
  @Column()
  title: string;
  
  @Column()
  userId: string;
  
  @Column({ default: false })
  isPinned: boolean;
  
  @Column({ type: 'simple-json', nullable: true })
  tags: string[];
  
  @Column({ nullable: true })
  category: string;
  
  @CreateDateColumn()
  createdAt: Date;
  
  @UpdateDateColumn()
  updatedAt: Date;
}
