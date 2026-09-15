import { AccountingController } from '../controllers/accountingController';
import { PeriodStatus } from '../constants/accounting';
import { logTemplate } from '../utils/logger';

export const accountingRoutes = [
  'GET /accounting/periods requireAuth',
  'POST /accounting/periods/:period/close requireAuth requireRole=admin audit',
  'PATCH /accounting/periods/:period/reopen requireAuth requireRole=admin audit',
  'GET /accounting/periods/:period/result requireAuth',
  'GET /accounting/periods/:period/summaries requireAuth requireRole=admin',
  'GET /accounting/periods/:period/versions requireAuth requireRole=admin'
];

logTemplate('info', 'PERIOD_LIST_START', { values: Object.values(PeriodStatus).join(',') });
export const accountingRouteControllers = [AccountingController];
