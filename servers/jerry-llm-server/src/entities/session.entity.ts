import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

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
  
  @CreateDateColumn()
  createdAt: Date;
  
  @UpdateDateColumn()
  updatedAt: Date;
}
