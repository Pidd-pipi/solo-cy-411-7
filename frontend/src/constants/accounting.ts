import { PeriodStatus } from '../types/entities';

export { PeriodStatus };

export const PERIOD_STATUS_LABELS: Record<PeriodStatus, string> = {
  [PeriodStatus.OPEN]: '未结账',
  [PeriodStatus.CLOSED]: '已结账'
};

export const PERIOD_STATUS_COLORS: Record<PeriodStatus, string> = {
  [PeriodStatus.OPEN]: 'default',
  [PeriodStatus.CLOSED]: 'success'
};
