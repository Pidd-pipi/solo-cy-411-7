import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ErrorCodes } from '../constants/errorCodes';
import { RequireAuth } from '../middlewares/auth';
import { RoleGuard, Roles } from '../middlewares/roleCheck';
import { AccountingService } from '../services/accountingService';
import { AppError } from '../utils/AppError';
import { logTemplate } from '../utils/logger';

class ReopenBody {
  reason?: string;
}

@Controller('accounting/periods')
@UseGuards(RequireAuth, RoleGuard)
export class AccountingController {
  constructor(private readonly accountingService: AccountingService) {}

  // Any authenticated user may see period status (drives lock badges / picker).
  @Get()
  list() {
    return this.accountingService.listPeriods();
  }

  @Post(':period/close')
  @Roles('admin')
  async close(@Req() request: Request, @Param('period') period: string) {
    request.auditEntity = 'AccountingPeriod';
    request.auditAction = 'AccountingPeriod close';
    try {
      return await this.accountingService.close(period, request.user!.id);
    } catch (error: any) {
      logTemplate('error', 'PERIOD_CLOSE_FAILED', { period, field: 'AccountingPeriod.status', reason: error.message });
      throw new AppError(error.code || ErrorCodes.DATABASE_FAILED, `AccountingPeriod[period=${period}] controller close failed: ${error.message}`, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Patch(':period/reopen')
  @Roles('admin')
  async reopen(@Req() request: Request, @Param('period') period: string, @Body() body: ReopenBody) {
    request.auditEntity = 'AccountingPeriod';
    request.auditAction = 'AccountingPeriod reopen';
    try {
      return await this.accountingService.reopen(period, body?.reason, request.user!.id);
    } catch (error: any) {
      logTemplate('error', 'PERIOD_REOPEN_FAILED', { period, field: 'AccountingPeriod.reopen_reason', reason: error.message });
      throw new AppError(error.code || ErrorCodes.DATABASE_FAILED, `AccountingPeriod[period=${period}] controller reopen failed: ${error.message}`, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  // Member's OWN frozen result only. The service scopes by req.user.id; there is
  // no parameter to read another member's period result.
  @Get(':period/result')
  result(@Req() request: Request, @Param('period') period: string, @Query('version') version?: string) {
    return this.accountingService.myResult(period, request.user!.id, version);
  }

  @Get(':period/summaries')
  @Roles('admin')
  summaries(@Param('period') period: string, @Query('version') version?: string) {
    return this.accountingService.listSummaries(period, version);
  }

  @Get(':period/versions')
  @Roles('admin')
  versions(@Param('period') period: string) {
    return this.accountingService.listVersions(period);
  }
}
