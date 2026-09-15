import dayjs from 'dayjs';
import { create } from 'zustand';
import { closePeriod, fetchPeriods, reopenPeriod } from '../api/accounting';
import { AccountingPeriod } from '../types/entities';

interface PeriodStore {
  periods: AccountingPeriod[];
  loading: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  close: (period: string) => Promise<void>;
  reopen: (period: string, reason: string) => Promise<void>;
  isMonthClosed: (month: string) => boolean;
  isDateClosed: (date: string) => boolean;
  closedMonthSet: () => Set<string>;
}

export const usePeriodStore = create<PeriodStore>((set, get) => ({
  periods: [],
  loading: false,
  loaded: false,
  async load() {
    set({ loading: true });
    try {
      const periods = await fetchPeriods();
      set({ periods, loading: false, loaded: true });
    } catch {
      set({ loading: false, loaded: true });
    }
  },
  async close(period) {
    await closePeriod(period);
    await get().load();
  },
  async reopen(period, reason) {
    await reopenPeriod(period, reason);
    await get().load();
  },
  closedMonthSet() {
    return new Set(get().periods.filter((item) => item.status === 'closed').map((item) => item.period));
  },
  isMonthClosed(month) {
    return get().closedMonthSet().has(month);
  },
  isDateClosed(date) {
    return get().isMonthClosed(dayjs(date).format('YYYY-MM'));
  }
}));
