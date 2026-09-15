import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { PeriodStatus } from '../constants/accounting';
import { AccountingSnapshot } from './accountingSnapshot';

@Entity('accounting_periods')
export class AccountingPeriod {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ length: 7, unique: true })
  period!: string; // 'YYYY-MM'

  @Column({ type: 'enum', enum: PeriodStatus, default: PeriodStatus.OPEN })
  status!: PeriodStatus;

  @Column({ name: 'current_version', type: 'int', default: 0 })
  currentVersion!: number;

  @Column({ name: 'closed_by', type: 'bigint', nullable: true })
  closedBy!: number | null;

  @Column({ name: 'closed_at', type: 'timestamp', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'reopen_reason', type: 'varchar', length: 255, nullable: true })
  reopenReason!: string | null;

  @Column({ name: 'reopened_by', type: 'bigint', nullable: true })
  reopenedBy!: number | null;

  @Column({ name: 'reopened_at', type: 'timestamp', nullable: true })
  reopenedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;

  @OneToMany(() => AccountingSnapshot, (snapshot) => snapshot.period)
  snapshots!: AccountingSnapshot[];
}
