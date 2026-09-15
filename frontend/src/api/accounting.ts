import {
  AccountingPeriod,
  MyPeriodResult,
  PeriodSummariesResponse,
  PeriodVersionsResponse
} from '../types/entities';
import { request } from '../utils/request';

export function fetchPeriods(): Promise<AccountingPeriod[]> {
  return request.get('/accounting/periods');
}

export function closePeriod(period: string): Promise<{ message: string; period: string; status: string; version: number }> {
  return request.post(`/accounting/periods/${period}/close`);
}

export function reopenPeriod(period: string, reason: string): Promise<{ message: string; period: string; status: string }> {
  return request.patch(`/accounting/periods/${period}/reopen`, { reason });
}

export function fetchMyPeriodResult(period: string, version?: number): Promise<MyPeriodResult> {
  return request.get(`/accounting/periods/${period}/result`, { params: version ? { version } : undefined });
}

export function fetchPeriodSummaries(period: string, version?: number): Promise<PeriodSummariesResponse> {
  return request.get(`/accounting/periods/${period}/summaries`, { params: version ? { version } : undefined });
}

export function fetchPeriodVersions(period: string): Promise<PeriodVersionsResponse> {
  return request.get(`/accounting/periods/${period}/versions`);
}
