import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ActivityCategory } from '../constants/activity';
import { AccountingPeriod } from './accountingPeriod';

export type SnapshotByCategory = Record<ActivityCategory, number>;

export interface SnapshotDetailRow {
  id: number;
  userId: number;
  factorId: number | null;
  category: ActivityCategory;
  subType: string;
  amount: string;
  unit: string;
  carbonValue: string;
  recordDate: string;
  note: string | null;
}

@Entity('accounting_snapshots')
export class AccountingSnapshot {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ name: 'period_id', type: 'bigint' })
  periodId!: number;

  @Column({ type: 'int' })
  version!: number;

  @Column({ name: 'user_id', type: 'bigint' })
  userId!: number;

  @Column({ length: 64 })
  region!: string;

  @Column({ name: 'activity_count', type: 'int', default: 0 })
  activityCount!: number;

  @Column({ name: 'total_carbon', type: 'decimal', precision: 12, scale: 2, default: 0 })
  totalCarbon!: string;

  @Column({ name: 'by_category', type: 'json' })
  byCategory!: SnapshotByCategory;

  @Column({ type: 'json' })
  detail!: SnapshotDetailRow[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @ManyToOne(() => AccountingPeriod, (period) => period.snapshots, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'period_id' })
  period!: AccountingPeriod;
}
