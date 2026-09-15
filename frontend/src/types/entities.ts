import { ActivityCategory } from '../constants/activity';
import { GoalStatus } from '../constants/goal';

export interface User {
  id: number;
  username: string;
  email: string;
  avatar?: string | null;
  region: string;
  createdAt?: string;
  roles?: string[];
}

export interface CarbonFactor {
  id: number;
  category: ActivityCategory;
  subType: string;
  factorValue: string;
  unit: string;
  region: string;
  updatedAt: string;
}

export interface Activity {
  id: number;
  userId: number;
  factorId?: number | null;
  category: ActivityCategory;
  subType: string;
  amount: string;
  unit: string;
  carbonValue: string;
  recordDate: string;
  note?: string | null;
  factor?: CarbonFactor | null;
}

export interface Goal {
  id: number;
  userId: number;
  title: string;
  targetValue: string;
  periodType: string;
  startDate: string;
  endDate: string;
  status: GoalStatus;
  currentValue?: number;
  progress?: number;
}

export interface AuditLog {
  id: number;
  userId?: number | null;
  action: string;
  entity: string;
  entityId?: number | null;
  detail: string;
  ip?: string | null;
  createdAt: string;
}

export interface RankingItem {
  rank: number;
  userId: number;
  username: string;
  region: string;
  avatar?: string | null;
  totalCarbon: number;
}

export enum PeriodStatus {
  OPEN = 'open',
  CLOSED = 'closed'
}

export interface AccountingPeriod {
  id: number;
  period: string;
  status: PeriodStatus;
  currentVersion: number;
  closedBy?: number | null;
  closedAt?: string | null;
  reopenReason?: string | null;
  reopenedBy?: number | null;
  reopenedAt?: string | null;
  createdAt?: string;
}

export type SnapshotByCategory = Partial<Record<ActivityCategory, number>>;

export interface MyPeriodResult {
  period: string;
  status: PeriodStatus;
  closed: boolean;
  version: number;
  start: string;
  end: string;
  region?: string;
  activityCount: number;
  totalCarbon: number;
  byCategory: SnapshotByCategory;
  detail: Activity[];
}

export interface PeriodMemberSummary {
  userId: number;
  region: string;
  activityCount: number;
  totalCarbon: number;
  byCategory: SnapshotByCategory;
}

export interface PeriodSummariesResponse {
  period: string;
  status: PeriodStatus;
  version: number;
  members: PeriodMemberSummary[];
}

export interface PeriodVersion {
  version: number;
  createdAt: string;
  memberCount: number;
}

export interface PeriodVersionsResponse {
  period: string;
  currentVersion: number;
  versions: PeriodVersion[];
}

