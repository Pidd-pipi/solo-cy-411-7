export enum PeriodStatus {
  OPEN = 'open',
  CLOSED = 'closed'
}

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const PERIOD_STATUS_LABELS: Record<PeriodStatus, string> = {
  [PeriodStatus.OPEN]: 'Open',
  [PeriodStatus.CLOSED]: 'Closed'
};

export const PERIOD_ERROR_FIELDS = {
  PERIOD: 'AccountingPeriod.period',
  STATUS: 'AccountingPeriod.status',
  ACTIVITY_VERSION: 'AccountingPeriod.activity_version',
  REOPEN_REASON: 'AccountingPeriod.reopen_reason',
  VERSION: 'AccountingSnapshot.version'
};
